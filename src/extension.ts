import * as vscode from 'vscode';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawn } from 'node:child_process';
import {
  blockAtLine,
  escapeHtml,
  formatCurl,
  highlightJson,
  parseCurlCommand,
  parseHttpFile,
  runCurl,
  type CurlProcess,
  type CurlResult,
  type HttpBlock,
  type ParsedFile,
} from './core.js';
import { ResponsePanel, type PanelMessage, type PanelUpdate } from './panel.js';
import { Environments } from './environments.js';
import { Resolver, SYSTEM_VARIABLES, isUnsupportedSystemVariable, type Exchange, type VarSource } from './variables.js';
import { buildRequest, resolvePath, type BuilderOptions } from './requestBuilder.js';
import { runPreRequestScript, runResponseHandler, type ScriptEnv, type ScriptOutcome, type TestResult } from './scripts.js';

const PLACEHOLDER = /\{\{\s*([^{}]+?)\s*\}\}/g;
const MAX_RENDER = 2 * 1024 * 1024;
const HISTORY_KEY = 'restWorkbench.history';
const GLOBALS_KEY = 'restWorkbench.globals';

let ctx: vscode.ExtensionContext;
let environments: Environments;
let output: vscode.OutputChannel;
let statusItem: vscode.StatusBarItem;
let envItem: vscode.StatusBarItem;
let diagnostics: vscode.DiagnosticCollection;
const codeLensChanged = new vscode.EventEmitter<void>();

const parseCache = new Map<string, { version: number; parsed: ParsedFile }>();
/** request/response of named requests (# @name foo), per document */
const exchanges = new Map<string, Map<string, Exchange>>();
/** client.global variables of response handler scripts (persisted per workspace) */
let globals = new Map<string, string>();
let running: CurlProcess | undefined;
let lastResult: CurlResult | undefined;

/** what the curl command in the panel belongs to */
interface RunContext {
  title: string;
  docUri?: vscode.Uri;
  block?: HttpBlock;
  locals: Map<string, string>;
  request?: Exchange['request'];
}
let panelContext: RunContext | undefined;

interface HistoryEntry {
  title: string;
  curl: string;
  method: string;
  url: string;
  status?: number;
  time: string;
  file?: string;
}

// ---------- helpers ----------

function parse(doc: vscode.TextDocument): ParsedFile {
  const key = doc.uri.toString();
  const c = parseCache.get(key);
  if (c && c.version === doc.version) return c.parsed;
  const parsed = parseHttpFile(doc.getText());
  parseCache.set(key, { version: doc.version, parsed });
  return parsed;
}

function exchangesFor(uri: vscode.Uri | undefined): Map<string, Exchange> {
  const key = uri?.toString() ?? '';
  let m = exchanges.get(key);
  if (!m) exchanges.set(key, (m = new Map()));
  return m;
}

function docDir(uri: vscode.Uri | undefined): string | undefined {
  return uri?.scheme === 'file' ? path.dirname(uri.fsPath) : undefined;
}

function workspaceDir(uri: vscode.Uri | undefined): string | undefined {
  return (uri && vscode.workspace.getWorkspaceFolder(uri)?.uri.fsPath) ?? vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
}

function resolverFor(doc: vscode.TextDocument, locals?: Map<string, string>): Resolver {
  const env = environments.load(doc.uri);
  return new Resolver({
    fileVars: parse(doc).variables,
    env: env.current,
    envName: env.selected,
    shared: env.shared,
    exchanges: exchangesFor(doc.uri),
    globals,
    locals,
    baseDir: docDir(doc.uri),
  });
}

/** names that will become resolvable later: named requests, script globals, prompts */
function pendingNames(doc: vscode.TextDocument) {
  const parsed = parse(doc);
  const requests = new Set(parsed.blocks.map((b) => b.name).filter((n): n is string => !!n));
  const prompts = new Set(parsed.blocks.flatMap((b) => b.settings.prompts.map((p) => p.name)));
  const scriptGlobals = new Set<string>();
  const text = doc.getText();
  for (const m of text.matchAll(/client\.global\.set\(\s*["'`]([\w.-]+)["'`]/g)) scriptGlobals.add(m[1]);
  for (const m of text.matchAll(/request\.variables\.set\(\s*["'`]([\w.-]+)["'`]/g)) prompts.add(m[1]);
  return { requests, globals: scriptGlobals, prompts };
}

function cfg(uri?: vscode.Uri) {
  const rw = vscode.workspace.getConfiguration('restWorkbench', uri);
  const rc = vscode.workspace.getConfiguration('rest-client', uri);
  const explicit = <T>(key: string): T | undefined => {
    const i = rw.inspect<T>(key);
    return i?.workspaceFolderValue ?? i?.workspaceValue ?? i?.globalValue;
  };
  return {
    curlPath: rw.get<string>('curlPath') || 'curl',
    timeoutSeconds: Math.max(1, rw.get<number>('timeoutSeconds', 60)),
    followRedirects: explicit<boolean>('followRedirects') ?? rc.get<boolean>('followredirect') ?? true,
    rememberCookies: explicit<boolean>('rememberCookies') ?? rc.get<boolean>('rememberCookiesForSubsequentRequests') ?? true,
    defaultHeaders: { ...(rc.get<Record<string, string>>('defaultHeaders') ?? {}), ...(rw.get<Record<string, string>>('defaultHeaders') ?? {}) },
    certificates: { ...(rc.get<BuilderOptions['certificates']>('certificates') ?? {}), ...(rw.get<BuilderOptions['certificates']>('certificates') ?? {}) },
    allowInsecureTLS: rw.get<boolean>('allowInsecureTLS', false),
    proxy: vscode.workspace.getConfiguration('http').get<string>('proxy') || undefined,
    appPath: rw.get<string>('appPath', '').trim(),
  };
}

const cookieJar = () => path.join(ctx.globalStorageUri.fsPath, 'cookies.txt');
const tempDir = () => path.join(os.tmpdir(), 'rest-workbench');

async function targetRequest(uri?: unknown, index?: unknown) {
  let doc: vscode.TextDocument | undefined;
  if (uri instanceof vscode.Uri) doc = await vscode.workspace.openTextDocument(uri);
  else doc = vscode.window.activeTextEditor?.document;
  if (!doc || doc.languageId !== 'http') {
    void vscode.window.showWarningMessage('REST Workbench: open an .http or .rest file first.');
    return undefined;
  }
  const parsed = parse(doc);
  let block: HttpBlock | undefined;
  if (typeof index === 'number') block = parsed.blocks[index];
  else {
    const editor = vscode.window.visibleTextEditors.find((e) => e.document === doc);
    block = blockAtLine(parsed, editor?.selection.active.line ?? 0);
  }
  if (!block || block.kind === 'none') {
    void vscode.window.showWarningMessage('REST Workbench: no request at the cursor. Requests start with ### followed by a line like "GET http://…".');
    return undefined;
  }
  return { doc, block };
}

// ---------- sending ----------

function panel() {
  return ResponsePanel.show(ctx.extensionUri, onPanelMessage);
}

function post(update: PanelUpdate) {
  panel().post(update);
}

interface SendOutcome {
  result: CurlResult;
  tests: TestResult[];
  scriptErrors: string[];
}

async function sendRequest(uri?: unknown, index?: unknown): Promise<SendOutcome | undefined> {
  const t = await targetRequest(uri, index);
  if (!t) return undefined;
  return sendBlock(t.doc, t.block);
}

async function sendBlock(doc: vscode.TextDocument, block: HttpBlock): Promise<SendOutcome | undefined> {
  const s = block.settings;
  if (s.note) {
    const ok = await vscode.window.showWarningMessage(`Send request “${block.title}”?`, { modal: true, detail: 'This request is marked with @note.' }, 'Send');
    if (ok !== 'Send') return undefined;
  }

  // prompt variables
  const locals = new Map<string, string>();
  for (const p of s.prompts) {
    const v = await vscode.window.showInputBox({
      title: `${block.title}: ${p.name}`,
      prompt: p.description ?? `Value for {{${p.name}}}`,
      password: /pass|pwd|secret|token|apikey|api-key/i.test(p.name),
      ignoreFocusOut: true,
    });
    if (v === undefined) return undefined;
    locals.set(p.name, v);
  }

  // pre-request scripts
  const scriptEnv = makeScriptEnv(doc, locals);
  const preOutcomes: ScriptOutcome[] = block.preRequestScripts.map((ref) =>
    runPreRequestScript(ref, scriptEnv, { method: block.method, url: resolverFor(doc, locals).resolve(block.url) }),
  );

  const c = cfg(doc.uri);
  const built = buildRequest(block, resolverFor(doc, locals), {
    baseDir: docDir(doc.uri),
    workspaceDir: workspaceDir(doc.uri),
    tempDir: tempDir(),
    followRedirects: c.followRedirects,
    defaultHeaders: c.defaultHeaders,
    certificates: c.certificates,
  });

  panelContext = {
    title: block.title,
    docUri: doc.uri,
    block,
    locals,
    request: { method: built.method, url: built.url, headers: built.headers, body: built.body },
  };
  panel().setTitle(block.title);
  const warnings = [...built.missing].map((m) => (m.startsWith('file ') || m.startsWith('GraphQL') ? m : `{{${m}}}`));
  post({ type: 'request', title: block.title, curl: built.display, missing: warnings });
  return execute(built.args, panelContext, preOutcomes, built.tempFiles);
}

function makeScriptEnv(doc: vscode.TextDocument | undefined, locals: Map<string, string>): ScriptEnv {
  return {
    globals,
    locals,
    lookup: (n) => (doc ? resolverFor(doc, locals).lookup(n)?.value : undefined),
    baseDir: docDir(doc?.uri),
  };
}

async function execute(args: string[], rc: RunContext, preOutcomes: ScriptOutcome[] = [], tempFiles: string[] = []): Promise<SendOutcome | undefined> {
  if (!args.length) {
    post({ type: 'error', message: 'Nothing to run.' });
    return undefined;
  }
  running?.kill();
  const c = cfg(rc.docUri);
  const infra = ['--max-time', String(c.timeoutSeconds)];
  if (c.rememberCookies && !rc.block?.settings.noCookieJar) infra.push('-b', cookieJar(), '-c', cookieJar());
  if (c.proxy) infra.push('-x', c.proxy);
  if (c.allowInsecureTLS) infra.push('-k');
  const cwd = docDir(rc.docUri) ?? workspaceDir(rc.docUri) ?? os.homedir();

  const proc = runCurl([...infra, ...args], cwd, c.curlPath);
  running = proc;
  setRunning(true);
  post({ type: 'running' });
  const res = await proc.result;
  for (const f of tempFiles) fs.rm(f, { force: true }, () => undefined);
  if (running !== proc) return undefined; // superseded by a newer request
  running = undefined;
  setRunning(false);
  lastResult = res;

  const block = rc.block;
  // store request + response of named requests
  if (block?.name && res.status) {
    exchangesFor(rc.docUri).set(block.name, {
      request: rc.request ?? { method: '', url: '', headers: [], body: '' },
      response: { status: res.status, headers: res.headers, body: res.body },
      time: new Date(),
    });
  }

  // response handler scripts
  const outcomes = [...preOutcomes];
  if (block && res.status !== undefined) {
    const doc = rc.docUri ? vscode.workspace.textDocuments.find((d) => d.uri.toString() === rc.docUri!.toString()) : undefined;
    const env = makeScriptEnv(doc, rc.locals);
    for (const ref of block.responseHandlers) {
      outcomes.push(runResponseHandler(ref, env, { status: res.status, headers: res.headers, body: res.body, contentType: res.contentType }));
    }
    if (block.responseHandlers.length) void ctx.workspaceState.update(GLOBALS_KEY, Object.fromEntries(globals));
  }
  const tests = outcomes.flatMap((o) => o.tests);
  const logs = outcomes.flatMap((o) => o.logs);
  const scriptErrors = outcomes.map((o) => o.error).filter((e): e is string => !!e);

  // >> output redirect
  let savedTo: string | undefined;
  if (block?.outputFile && res.status !== undefined) {
    try {
      savedTo = writeOutputFile(block.outputFile, rc, res);
    } catch (e) {
      scriptErrors.push(`Could not save response: ${(e as Error).message}`);
    }
  }

  if (!block?.settings.noLog) {
    await addHistory({
      title: rc.title,
      curl: formatCurl(args),
      method: rc.request?.method ?? '',
      url: rc.request?.url ?? '',
      status: res.status,
      time: new Date().toISOString(),
      file: rc.docUri?.fsPath,
    });
  }

  logToOutput(rc.title, res, tests, logs, scriptErrors);
  post(resultUpdate(res, { tests, logs, scriptErrors, savedTo, storedAs: block?.name && res.status ? block.name : undefined }));
  codeLensChanged.fire();
  refreshAllDiagnostics();
  return { result: res, tests, scriptErrors };
}

function writeOutputFile(out: NonNullable<HttpBlock['outputFile']>, rc: RunContext, res: CurlResult): string {
  const doc = rc.docUri ? vscode.workspace.textDocuments.find((d) => d.uri.toString() === rc.docUri!.toString()) : undefined;
  const p = doc ? resolverFor(doc, rc.locals).resolve(out.path) : out.path;
  let file = resolvePath(p, docDir(rc.docUri), workspaceDir(rc.docUri));
  if (!out.overwrite && fs.existsSync(file)) {
    const ext = path.extname(file);
    const base = file.slice(0, file.length - ext.length);
    let n = 1;
    while (fs.existsSync(`${base}-${n}${ext}`)) n++;
    file = `${base}-${n}${ext}`;
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, res.bodyBase64 ? Buffer.from(res.bodyBase64, 'base64') : Buffer.from(res.body, 'utf8'));
  return file;
}

function resultUpdate(
  res: CurlResult,
  extra: { tests: TestResult[]; logs: string[]; scriptErrors: string[]; savedTo?: string; storedAs?: string },
): PanelUpdate {
  return {
    type: 'result',
    summary: {
      status: res.status,
      statusText: res.statusText,
      timeMs: res.timeMs,
      sizeBytes: res.sizeBytes,
      contentType: res.contentType,
      error: res.error,
      cancelled: res.cancelled,
    },
    headers: res.headers,
    bodyHtml: !res.status && res.error ? '' : prettyBody(res),
    image: res.bodyBase64 && /^image\//i.test(res.contentType ?? '') ? `data:${res.contentType!.split(';')[0]};base64,${res.bodyBase64}` : undefined,
    raw: (res.rawHeaders ? res.rawHeaders + '\n\n' : '') + (res.bodyBase64 ? `(binary content, ${res.sizeBytes} bytes)` : res.body.slice(0, MAX_RENDER)),
    log: [
      `$ cd ${res.cwd}`,
      `$ ${formatCurl(res.args)}`,
      '',
      `exit code: ${res.exitCode ?? '–'}`,
      res.effectiveUrl ? `effective URL: ${res.effectiveUrl}` : '',
      res.error ? `error: ${res.error}` : '',
      res.stderr ? `\nstderr:\n${res.stderr}` : '',
    ]
      .filter((l) => l !== '')
      .join('\n'),
    ...extra,
  };
}

function prettyBody(res: CurlResult): string {
  if (res.bodyBase64) {
    return /^image\//i.test(res.contentType ?? '')
      ? ''
      : `<span class="muted">(binary content, ${res.sizeBytes} bytes – use “Save body”)</span>`;
  }
  let body = res.body;
  if (!body) return '<span class="muted">(empty body)</span>';
  const truncated = body.length > MAX_RENDER;
  if (truncated) body = body.slice(0, MAX_RENDER);
  if (!truncated && (/json/i.test(res.contentType ?? '') || /^\s*[[{]/.test(body))) {
    try {
      return highlightJson(JSON.stringify(JSON.parse(body), null, 2));
    } catch {
      /* not JSON */
    }
  }
  return escapeHtml(body) + (truncated ? '\n\n<span class="muted">… truncated for display (use Save body)</span>' : '');
}

function logToOutput(title: string, res: CurlResult, tests: TestResult[], logs: string[], errors: string[]) {
  const status = res.status ? `${res.status} ${res.statusText ?? ''}`.trim() : res.error ?? 'error';
  output.appendLine(`[${new Date().toLocaleTimeString()}] ${title} → ${status} (${res.timeMs} ms)`);
  for (const t of tests) output.appendLine(`    ${t.passed ? '✓' : '✗'} ${t.name}${t.error ? ` – ${t.error}` : ''}`);
  for (const l of logs) output.appendLine(`    log: ${l}`);
  for (const e of errors) output.appendLine(`    script error: ${e}`);
}

function setRunning(isRunning: boolean) {
  void vscode.commands.executeCommand('setContext', 'restWorkbench.running', isRunning);
  if (isRunning) statusItem.show();
  else statusItem.hide();
}

async function onPanelMessage(m: PanelMessage) {
  switch (m.type) {
    case 'run': {
      let args: string[];
      try {
        args = parseCurlCommand(m.text);
      } catch (e) {
        post({ type: 'error', message: (e as Error).message });
        return;
      }
      void execute(args, panelContext ?? { title: 'curl', locals: new Map() });
      break;
    }
    case 'cancel':
      running?.kill();
      break;
    case 'copy':
      await vscode.env.clipboard.writeText(m.text);
      vscode.window.setStatusBarMessage('curl command copied', 3000);
      break;
    case 'copyBody':
      if (lastResult) {
        await vscode.env.clipboard.writeText(lastResult.body);
        vscode.window.setStatusBarMessage('Response body copied', 3000);
      }
      break;
    case 'saveBody':
    case 'saveResponse': {
      if (!lastResult) return;
      const r = lastResult;
      const ext = extensionFor(r.contentType);
      const name = (r.effectiveUrl ? path.basename(new URL(r.effectiveUrl).pathname) : '') || 'response';
      const target = await vscode.window.showSaveDialog({
        defaultUri: vscode.Uri.file(path.join(docDir(panelContext?.docUri) ?? os.homedir(), m.type === 'saveBody' && !path.extname(name) ? name + ext : m.type === 'saveBody' ? name : name + '.http-response')),
      });
      if (!target) return;
      const data =
        m.type === 'saveBody'
          ? r.bodyBase64
            ? Buffer.from(r.bodyBase64, 'base64')
            : Buffer.from(r.body)
          : Buffer.from(`${r.rawHeaders}\r\n\r\n${r.bodyBase64 ? `(binary content, ${r.sizeBytes} bytes)` : r.body}`);
      await vscode.workspace.fs.writeFile(target, data);
      vscode.window.setStatusBarMessage(`Saved ${target.fsPath}`, 4000);
      break;
    }
  }
}

function extensionFor(ct?: string): string {
  const t = (ct ?? '').split(';')[0].trim().toLowerCase();
  const map: Record<string, string> = {
    'application/json': '.json', 'application/xml': '.xml', 'text/xml': '.xml', 'text/html': '.html',
    'text/plain': '.txt', 'text/csv': '.csv', 'image/png': '.png', 'image/jpeg': '.jpg', 'image/gif': '.gif',
    'image/svg+xml': '.svg', 'image/webp': '.webp', 'application/pdf': '.pdf', 'application/zip': '.zip',
  };
  return map[t] ?? (t.endsWith('+json') ? '.json' : t.endsWith('+xml') ? '.xml' : '.txt');
}

async function sendAll(uri?: unknown) {
  const doc = uri instanceof vscode.Uri ? await vscode.workspace.openTextDocument(uri) : vscode.window.activeTextEditor?.document;
  if (!doc || doc.languageId !== 'http') return undefined;
  const blocks = parse(doc).blocks.filter((b) => b.kind !== 'none');
  output.appendLine(`\n=== Run all: ${path.basename(doc.uri.fsPath)} (${blocks.length} requests) ===`);
  output.show(true);
  const summary: { title: string; status?: number; tests: TestResult[]; error?: string }[] = [];
  for (const b of blocks) {
    // re-parse: earlier requests may have changed nothing in the text, but block objects stay valid
    const r = await sendBlock(doc, b);
    if (!r) {
      summary.push({ title: b.title, tests: [], error: 'skipped' });
      continue;
    }
    summary.push({ title: b.title, status: r.result.status, tests: r.tests, error: r.result.error });
    if (r.result.cancelled) break;
  }
  const failed = summary.filter((s) => !s.status || s.status >= 400 || s.tests.some((t) => !t.passed)).length;
  const testCount = summary.reduce((n, s) => n + s.tests.length, 0);
  const passed = summary.reduce((n, s) => n + s.tests.filter((t) => t.passed).length, 0);
  const msg = `Run all: ${summary.length} requests, ${failed} with errors/failed tests, tests ${passed}/${testCount} passed`;
  output.appendLine(msg);
  void (failed ? vscode.window.showWarningMessage(msg, 'Show Log') : vscode.window.showInformationMessage(msg, 'Show Log')).then(
    (p) => p && output.show(),
  );
  return summary;
}

async function copyAsCurl(uri?: unknown, index?: unknown) {
  const t = await targetRequest(uri, index);
  if (!t) return;
  const c = cfg(t.doc.uri);
  const built = buildRequest(t.block, resolverFor(t.doc), {
    baseDir: docDir(t.doc.uri),
    workspaceDir: workspaceDir(t.doc.uri),
    tempDir: tempDir(),
    followRedirects: c.followRedirects,
    defaultHeaders: c.defaultHeaders,
    certificates: c.certificates,
  });
  await vscode.env.clipboard.writeText(built.display);
  if (built.missing.size) {
    void vscode.window.showWarningMessage(`curl command copied, but these could not be resolved: ${[...built.missing].join(', ')}`);
  } else vscode.window.setStatusBarMessage('curl command copied', 3000);
}

// ---------- history ----------

async function addHistory(e: HistoryEntry) {
  const list = ctx.globalState.get<HistoryEntry[]>(HISTORY_KEY, []);
  list.unshift(e);
  await ctx.globalState.update(HISTORY_KEY, list.slice(0, 50));
}

async function showHistory() {
  const list = ctx.globalState.get<HistoryEntry[]>(HISTORY_KEY, []);
  if (!list.length) {
    void vscode.window.showInformationMessage('REST Workbench: no requests in the history yet.');
    return;
  }
  const pick = await vscode.window.showQuickPick(
    list.map((h) => ({
      label: `${h.method ? h.method + ' ' : ''}${h.url || h.title}`,
      description: `${h.status ?? 'error'} · ${new Date(h.time).toLocaleString()}`,
      detail: h.title + (h.file ? ` — ${path.basename(h.file)}` : ''),
      entry: h,
    })),
    { placeHolder: 'Select a request to send again', matchOnDetail: true },
  );
  if (!pick) return;
  const h = pick.entry;
  panelContext = { title: h.title, locals: new Map(), docUri: h.file ? vscode.Uri.file(h.file) : undefined };
  panel().setTitle(h.title);
  post({ type: 'request', title: `${h.title} (history)`, curl: h.curl, missing: [] });
  try {
    await execute(parseCurlCommand(h.curl), panelContext);
  } catch (e) {
    post({ type: 'error', message: (e as Error).message });
  }
}

// ---------- environments ----------

function updateEnvItem() {
  const ed = vscode.window.activeTextEditor;
  if (ed?.document.languageId !== 'http') {
    envItem.hide();
    return;
  }
  const env = environments.load(ed.document.uri);
  envItem.text = `$(server-environment) ${env.selected ?? 'No Environment'}`;
  envItem.tooltip = env.names.length
    ? `REST Workbench environment – click to switch\nSources:\n${env.sources.join('\n')}`
    : 'No environments defined (http-client.env.json or setting rest-client.environmentVariables)';
  envItem.show();
}

async function switchEnvironment() {
  const doc = vscode.window.activeTextEditor?.document;
  const env = environments.load(doc?.languageId === 'http' ? doc.uri : undefined);
  if (!env.names.length) {
    const pick = await vscode.window.showInformationMessage(
      'No environments found. Create an http-client.env.json next to your .http file or use the setting "rest-client.environmentVariables".',
      'Create http-client.env.json',
    );
    if (pick && doc?.uri.scheme === 'file') {
      const file = path.join(path.dirname(doc.uri.fsPath), 'http-client.env.json');
      if (!fs.existsSync(file)) {
        fs.writeFileSync(file, JSON.stringify({ $shared: {}, local: { baseUrl: 'http://localhost:8080' }, production: { baseUrl: 'https://api.example.com' } }, null, 2) + '\n');
      }
      await vscode.window.showTextDocument(vscode.Uri.file(file));
    }
    return;
  }
  const pick = await vscode.window.showQuickPick(
    [{ label: 'No Environment', name: undefined as string | undefined }, ...env.names.map((n) => ({ label: n, name: n as string | undefined, description: n === env.selected ? 'current' : undefined }))],
    { placeHolder: 'Select REST Workbench environment' },
  );
  if (!pick) return;
  await environments.select(pick.name);
}

// ---------- desktop app ----------

async function openInApp(uri?: unknown) {
  const doc = uri instanceof vscode.Uri ? await vscode.workspace.openTextDocument(uri) : vscode.window.activeTextEditor?.document;
  if (!doc || doc.uri.scheme !== 'file') {
    void vscode.window.showWarningMessage('REST Workbench: save the file to disk first.');
    return;
  }
  if (doc.isDirty) await doc.save();
  const file = doc.uri.fsPath;
  const configured = cfg(doc.uri).appPath;
  const notFound = async () => {
    const pick = await vscode.window.showErrorMessage('REST Workbench app not found. Install it or set "restWorkbench.appPath".', 'Open Settings');
    if (pick) void vscode.commands.executeCommand('workbench.action.openSettings', 'restWorkbench.appPath');
  };
  let cmd: string;
  let args: string[];
  if (process.platform === 'darwin') {
    cmd = 'open';
    args = ['-a', configured || 'REST Workbench', file];
  } else {
    const exe =
      configured ||
      (process.platform === 'win32' && process.env.LOCALAPPDATA
        ? path.join(process.env.LOCALAPPDATA, 'Programs', 'REST Workbench', 'REST Workbench.exe')
        : '');
    if (!exe || !fs.existsSync(exe)) return notFound();
    cmd = exe;
    args = [file];
  }
  // VS Code's extension host sets ELECTRON_RUN_AS_NODE, which would turn the app into plain Node.js
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(cmd, args, { detached: true, stdio: 'ignore', env });
  child.on('error', () => void notFound());
  child.on('exit', (code) => {
    if (cmd === 'open' && code) void notFound();
  });
  child.unref();
}

// ---------- editor features ----------

class RequestCodeLensProvider implements vscode.CodeLensProvider {
  onDidChangeCodeLenses = codeLensChanged.event;

  provideCodeLenses(doc: vscode.TextDocument): vscode.CodeLens[] {
    const parsed = parse(doc);
    const store = exchangesFor(doc.uri);
    const lenses: vscode.CodeLens[] = [];
    const requests = parsed.blocks.filter((b) => b.kind !== 'none');
    if (requests.length > 1) {
      lenses.push(new vscode.CodeLens(new vscode.Range(0, 0, 0, 0), { title: `$(run-all) Run All (${requests.length})`, command: 'restWorkbench.sendAll', arguments: [doc.uri] }));
    }
    for (const b of requests) {
      const range = new vscode.Range(b.requestLine, 0, b.requestLine, 0);
      lenses.push(
        new vscode.CodeLens(range, { title: '$(play) Send Request', command: 'restWorkbench.sendRequest', arguments: [doc.uri, b.index] }),
        new vscode.CodeLens(range, { title: 'Copy as curl', command: 'restWorkbench.copyAsCurl', arguments: [doc.uri, b.index] }),
      );
      if (b.name) {
        const r = store.get(b.name);
        lenses.push(
          new vscode.CodeLens(range, {
            title: r ? `@${b.name} → ${r.response.status} (${r.time.toLocaleTimeString()})` : `@${b.name} (not sent yet)`,
            command: '',
          }),
        );
      }
    }
    return lenses;
  }
}

const SOURCE_LABEL: Record<VarSource, string> = {
  local: 'prompt / pre-request variable',
  system: 'system variable',
  request: 'request variable',
  global: 'global (set by a response handler)',
  file: 'file variable',
  environment: 'environment',
  shared: '$shared environment',
};

function placeholderAt(doc: vscode.TextDocument, pos: vscode.Position) {
  const line = doc.lineAt(pos.line).text;
  for (const m of line.matchAll(PLACEHOLDER)) {
    const start = m.index!;
    const end = start + m[0].length;
    if (pos.character >= start && pos.character <= end) return { expr: m[1], range: new vscode.Range(pos.line, start, pos.line, end) };
  }
  return undefined;
}

class PlaceholderHoverProvider implements vscode.HoverProvider {
  provideHover(doc: vscode.TextDocument, pos: vscode.Position): vscode.Hover | undefined {
    const ph = placeholderAt(doc, pos);
    if (!ph) return undefined;
    const { expr } = ph;
    const r = resolverFor(doc);
    const md = new vscode.MarkdownString();
    const found = r.lookup(expr);
    if (found) {
      const envName = environments.load(doc.uri).selected;
      md.appendMarkdown(`**\`{{${expr}}}\`** — ${SOURCE_LABEL[found.source]}${found.source === 'environment' && envName ? ` *${envName}*` : ''}`);
      const v = found.value;
      md.appendCodeblock(v.length > 2000 ? v.slice(0, 2000) + '…' : v, v.trim().startsWith('{') || v.trim().startsWith('[') ? 'json' : 'text');
      if (found.source === 'system') md.appendMarkdown('*(new value on every request)*');
      return new vscode.Hover(md, ph.range);
    }
    const state = r.state(expr, pendingNames(doc));
    if (isUnsupportedSystemVariable(expr)) {
      md.appendMarkdown(`⚠️ \`{{${expr}}}\` (Azure AD / OIDC tokens) is not supported by REST Workbench.`);
    } else if (state === 'pending') {
      const missing = new Set<string>();
      r.lookup(expr, missing);
      md.appendMarkdown(`⏳ **\`{{${expr}}}\`** is not available yet – it is set by ${[...missing].map((x) => `\`${x}\``).join(', ')} (send the named request / run its script, or it is asked when sending).`);
    } else {
      const env = environments.load(doc.uri);
      md.appendMarkdown(
        `⚠️ **\`{{${expr}}}\`** cannot be resolved${env.selected ? ` in environment *${env.selected}*` : env.names.length ? ' (no environment selected)' : ''}. ` +
          `Define it with \`@${expr} = …\`, in an environment, or reference a named request.`,
      );
    }
    return new vscode.Hover(md, ph.range);
  }
}

class VariableDefinitionProvider implements vscode.DefinitionProvider {
  provideDefinition(doc: vscode.TextDocument, pos: vscode.Position): vscode.Location | undefined {
    const ph = placeholderAt(doc, pos);
    if (!ph) return undefined;
    const parsed = parse(doc);
    const line = parsed.variableLines.get(ph.expr);
    if (line !== undefined) return new vscode.Location(doc.uri, new vscode.Position(line, 0));
    const req = /^([\w-]+)\.(request|response)\./.exec(ph.expr);
    const b = req && parsed.blocks.find((x) => x.name === req[1]);
    if (b) {
      const nameLine = parsed.lines.findIndex((l, i) => i >= b.startLine && i <= b.endLine && /@name\s/.test(l));
      return new vscode.Location(doc.uri, new vscode.Position(nameLine >= 0 ? nameLine : b.requestLine, 0));
    }
    return undefined;
  }
}

const COMMON_HEADERS = [
  'Accept', 'Accept-Encoding', 'Accept-Language', 'Authorization', 'Cache-Control', 'Connection', 'Content-Length',
  'Content-Type', 'Cookie', 'Host', 'If-Match', 'If-Modified-Since', 'If-None-Match', 'Origin', 'Referer', 'User-Agent',
  'X-Request-Type', 'X-Requested-With',
];

class HttpCompletionProvider implements vscode.CompletionItemProvider {
  provideCompletionItems(doc: vscode.TextDocument, pos: vscode.Position): vscode.CompletionItem[] | undefined {
    const prefix = doc.lineAt(pos.line).text.slice(0, pos.character);
    const parsed = parse(doc);

    // {{ variables
    const open = prefix.lastIndexOf('{{');
    if (open >= 0 && !prefix.slice(open).includes('}}')) {
      const range = new vscode.Range(pos.line, open + 2, pos.line, pos.character);
      const items: vscode.CompletionItem[] = [];
      const add = (label: string, kind: vscode.CompletionItemKind, detail: string, insert?: string) => {
        const it = new vscode.CompletionItem(label, kind);
        it.detail = detail;
        it.range = range;
        if (insert) it.insertText = insert;
        items.push(it);
      };
      for (const [k, v] of parsed.variables) add(k, vscode.CompletionItemKind.Variable, `file variable = ${v}`);
      const env = environments.load(doc.uri);
      for (const [k, v] of env.current) add(k, vscode.CompletionItemKind.Variable, `environment ${env.selected}: ${v}`);
      for (const [k, v] of env.shared) add(k, vscode.CompletionItemKind.Variable, `$shared: ${v}`);
      for (const [k, v] of globals) add(k, vscode.CompletionItemKind.Variable, `global: ${v}`);
      for (const b of parsed.blocks) {
        if (!b.name) continue;
        add(`${b.name}.response.body.$`, vscode.CompletionItemKind.Reference, `JSONPath into the response of "${b.title}"`);
        add(`${b.name}.response.headers.`, vscode.CompletionItemKind.Reference, `response header of "${b.title}"`);
        add(`${b.name}.request.body.$`, vscode.CompletionItemKind.Reference, `request body of "${b.title}"`);
      }
      for (const [k, d] of SYSTEM_VARIABLES) add(k, vscode.CompletionItemKind.Function, d);
      return items;
    }

    // header names
    const b = blockAtLine(parsed, pos.line);
    if (b && b.kind === 'http' && pos.line > b.requestLine && /^[\w-]*$/.test(prefix)) {
      const kinds = parsed.lineKinds;
      let inHeaders = true;
      for (let i = b.requestLine + 1; i < pos.line; i++) if (kinds[i] === 'blank' || kinds[i] === 'body') inHeaders = false;
      if (inHeaders) {
        return COMMON_HEADERS.map((h) => {
          const it = new vscode.CompletionItem(h, vscode.CompletionItemKind.Property);
          it.insertText = `${h}: `;
          return it;
        });
      }
    }
    return undefined;
  }
}

function refreshDiagnostics(doc: vscode.TextDocument) {
  if (doc.languageId !== 'http') return;
  const parsed = parse(doc);
  const r = resolverFor(doc);
  const pending = pendingNames(doc);
  const result: vscode.Diagnostic[] = [];
  const warn = (range: vscode.Range, msg: string, severity = vscode.DiagnosticSeverity.Warning) => {
    const d = new vscode.Diagnostic(range, msg, severity);
    d.source = 'REST Workbench';
    result.push(d);
  };
  parsed.lines.forEach((line, i) => {
    const kind = parsed.lineKinds[i];
    if (kind === 'comment' || kind === 'separator') return;
    for (const m of line.matchAll(PLACEHOLDER)) {
      const range = new vscode.Range(i, m.index!, i, m.index! + m[0].length);
      if (isUnsupportedSystemVariable(m[1])) warn(range, `{{${m[1]}}} is not supported by REST Workbench`);
      else if (r.state(m[1], pending) === 'missing') warn(range, `Unresolved variable {{${m[1]}}}`);
    }
  });
  const base = docDir(doc.uri);
  if (base) {
    for (const b of parsed.blocks) {
      const files: [string, number][] = [];
      if (b.bodyFile && !b.bodyFile.includes('{{')) files.push([b.bodyFile, b.bodyLine]);
      for (const s of [...b.preRequestScripts, ...b.responseHandlers]) if (s.file) files.push([s.file, s.line]);
      for (const [f, line] of files) {
        if (line < 0) continue;
        if (!fs.existsSync(resolvePath(f, base, workspaceDir(doc.uri)))) {
          warn(new vscode.Range(line, 0, line, parsed.lines[line].length), `File not found: ${f}`);
        }
      }
    }
  }
  diagnostics.set(doc.uri, result);
}

function refreshAllDiagnostics() {
  for (const d of vscode.workspace.textDocuments) refreshDiagnostics(d);
}

// ---------- activation ----------

export function activate(context: vscode.ExtensionContext) {
  ctx = context;
  environments = new Environments(context.workspaceState);
  globals = new Map(Object.entries(context.workspaceState.get<Record<string, string>>(GLOBALS_KEY, {})));
  fs.mkdirSync(context.globalStorageUri.fsPath, { recursive: true });
  if (!fs.existsSync(cookieJar())) fs.writeFileSync(cookieJar(), '# Netscape HTTP Cookie File\n');

  output = vscode.window.createOutputChannel('REST Workbench');
  statusItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
  statusItem.text = '$(sync~spin) Sending request…';
  statusItem.tooltip = 'Click to cancel';
  statusItem.command = 'restWorkbench.cancelRequest';
  envItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  envItem.command = 'restWorkbench.switchEnvironment';
  diagnostics = vscode.languages.createDiagnosticCollection('restWorkbench');

  const selector: vscode.DocumentSelector = { language: 'http' };
  let diagTimer: NodeJS.Timeout | undefined;
  const envWatcher = vscode.workspace.createFileSystemWatcher('**/{http-client.env.json,http-client.private.env.json,.env}');
  const onEnvChange = () => {
    updateEnvItem();
    refreshAllDiagnostics();
  };

  context.subscriptions.push(
    output,
    statusItem,
    envItem,
    diagnostics,
    codeLensChanged,
    environments,
    envWatcher,
    envWatcher.onDidChange(onEnvChange),
    envWatcher.onDidCreate(onEnvChange),
    envWatcher.onDidDelete(onEnvChange),
    environments.onDidChange(onEnvChange),
    vscode.commands.registerCommand('restWorkbench.sendRequest', sendRequest),
    vscode.commands.registerCommand('restWorkbench.sendAll', sendAll),
    vscode.commands.registerCommand('restWorkbench.copyAsCurl', copyAsCurl),
    vscode.commands.registerCommand('restWorkbench.cancelRequest', () => running?.kill()),
    vscode.commands.registerCommand('restWorkbench.switchEnvironment', switchEnvironment),
    vscode.commands.registerCommand('restWorkbench.showHistory', showHistory),
    vscode.commands.registerCommand('restWorkbench.clearHistory', () => ctx.globalState.update(HISTORY_KEY, [])),
    vscode.commands.registerCommand('restWorkbench.clearCookies', () => {
      fs.writeFileSync(cookieJar(), '# Netscape HTTP Cookie File\n');
      vscode.window.setStatusBarMessage('Cookies cleared', 3000);
    }),
    vscode.commands.registerCommand('restWorkbench.clearResponses', async () => {
      exchanges.clear();
      globals.clear();
      await ctx.workspaceState.update(GLOBALS_KEY, {});
      codeLensChanged.fire();
      refreshAllDiagnostics();
    }),
    vscode.commands.registerCommand('restWorkbench.openInApp', openInApp),
    vscode.languages.registerCodeLensProvider(selector, new RequestCodeLensProvider()),
    vscode.languages.registerHoverProvider(selector, new PlaceholderHoverProvider()),
    vscode.languages.registerDefinitionProvider(selector, new VariableDefinitionProvider()),
    vscode.languages.registerCompletionItemProvider(selector, new HttpCompletionProvider(), '{', '$', '.'),
    vscode.window.onDidChangeActiveTextEditor(updateEnvItem),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('restWorkbench') || e.affectsConfiguration('rest-client')) onEnvChange();
    }),
    vscode.workspace.onDidOpenTextDocument(refreshDiagnostics),
    vscode.workspace.onDidChangeTextDocument((e) => {
      clearTimeout(diagTimer);
      diagTimer = setTimeout(() => refreshDiagnostics(e.document), 300);
    }),
    vscode.workspace.onDidCloseTextDocument((d) => {
      parseCache.delete(d.uri.toString());
      diagnostics.delete(d.uri);
    }),
  );
  updateEnvItem();
  refreshAllDiagnostics();

  // API used by the integration test
  return {
    exchanges,
    globals,
    getLastResult: () => lastResult,
    sendAll: (uri: vscode.Uri) => sendAll(uri),
    selectEnvironment: (name: string | undefined) => environments.select(name),
  };
}

export function deactivate() {
  running?.kill();
}
