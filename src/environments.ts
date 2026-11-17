import * as vscode from 'vscode';
import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * Environments, compatible with
 *  - VS Code REST Client: setting `rest-client.environmentVariables` (also `restWorkbench.environmentVariables`)
 *      { "$shared": { "version": "v1" }, "local": { "host": "localhost:8080" }, "prod": { ... } }
 *  - JetBrains HTTP Client: `http-client.env.json` + `http-client.private.env.json`, searched in the
 *    folder of the .http file and its parents up to the workspace folder.
 */
export type EnvTable = Record<string, Record<string, string>>;

export interface EnvironmentData {
  /** all known environment names (without $shared) */
  names: string[];
  /** $shared variables */
  shared: Map<string, string>;
  /** variables of the selected environment (not including $shared) */
  current: Map<string, string>;
  /** the selected environment name */
  selected?: string;
  /** where the env files were found (for the hover/status bar tooltip) */
  sources: string[];
}

const ENV_FILES = ['http-client.env.json', 'http-client.private.env.json'];

function toStringRecord(o: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (o && typeof o === 'object') {
    for (const [k, v] of Object.entries(o as Record<string, unknown>)) {
      out[k] = typeof v === 'string' ? v : JSON.stringify(v);
    }
  }
  return out;
}

function merge(target: EnvTable, src: unknown) {
  if (!src || typeof src !== 'object') return;
  for (const [env, vars] of Object.entries(src as Record<string, unknown>)) {
    target[env] = { ...(target[env] ?? {}), ...toStringRecord(vars) };
  }
}

function readJson(file: string): unknown {
  try {
    // tolerate comments (JSONC) like VS Code settings
    const text = fs.readFileSync(file, 'utf8').replace(/^\s*\/\/.*$/gm, '');
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/** Folders from the .http file's folder up to (and including) its workspace folder. */
function searchFolders(docUri: vscode.Uri | undefined): string[] {
  if (!docUri || docUri.scheme !== 'file') {
    return (vscode.workspace.workspaceFolders ?? []).map((f) => f.uri.fsPath);
  }
  const ws = vscode.workspace.getWorkspaceFolder(docUri)?.uri.fsPath;
  const out: string[] = [];
  let dir = path.dirname(docUri.fsPath);
  for (let i = 0; i < 20; i++) {
    out.push(dir);
    if (!ws || dir === ws) break;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return out.reverse(); // workspace root first, nearest folder last (wins)
}

export class Environments {
  private readonly emitter = new vscode.EventEmitter<void>();
  readonly onDidChange = this.emitter.event;

  constructor(private readonly state: vscode.Memento) {}

  get selected(): string | undefined {
    return this.state.get<string>('restWorkbench.environment');
  }

  async select(name: string | undefined) {
    await this.state.update('restWorkbench.environment', name);
    this.emitter.fire();
  }

  load(docUri?: vscode.Uri): EnvironmentData {
    const table: EnvTable = {};
    const sources: string[] = [];
    const scope = docUri ? vscode.workspace.getConfiguration(undefined, docUri) : vscode.workspace.getConfiguration();
    for (const key of ['rest-client.environmentVariables', 'restWorkbench.environmentVariables']) {
      const v = scope.get<unknown>(key);
      if (v && typeof v === 'object' && Object.keys(v).length) {
        merge(table, v);
        sources.push(`setting ${key}`);
      }
    }
    for (const dir of searchFolders(docUri)) {
      for (const f of ENV_FILES) {
        const file = path.join(dir, f);
        if (!fs.existsSync(file)) continue;
        merge(table, readJson(file));
        sources.push(file);
      }
    }
    const shared = new Map(Object.entries(table['$shared'] ?? {}));
    const names = Object.keys(table).filter((n) => n !== '$shared').sort();
    const selected = this.selected && names.includes(this.selected) ? this.selected : undefined;
    const current = new Map(Object.entries(selected ? table[selected] : {}));
    return { names, shared, current, selected, sources };
  }

  dispose() {
    this.emitter.dispose();
  }
}
