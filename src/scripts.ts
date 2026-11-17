import * as vm from 'node:vm';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';

/**
 * JetBrains HTTP Client compatible scripting (subset of the API):
 *
 *   > {%
 *     client.test("status is 200", () => client.assert(response.status === 200, "unexpected status"));
 *     client.global.set("token", response.body.token);
 *     client.log("got", response.headers.valueOf("Content-Type"));
 *   %}
 *
 *   < {% request.variables.set("now", Date.now()) %}
 *
 * The script runs with node:vm in its own context (a timeout of 5 s applies). Note: node:vm is
 * not a security sandbox - only run scripts from .http files you trust (same as in IntelliJ).
 */

export interface TestResult {
  name: string;
  passed: boolean;
  error?: string;
}

export interface ScriptOutcome {
  tests: TestResult[];
  logs: string[];
  error?: string;
}

export interface ScriptResponse {
  status: number;
  headers: [string, string][];
  body: string;
  contentType?: string;
}

export interface ScriptEnv {
  globals: Map<string, string>;
  /** request-local variables (pre-request scripts) */
  locals: Map<string, string>;
  /** resolves a variable of the current environment / file (request.environment.get) */
  lookup: (name: string) => string | undefined;
  baseDir?: string;
}

const EXIT = Symbol('client.exit');

function stringify(v: unknown): string {
  if (typeof v === 'string') return v;
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

export function loadScript(ref: { inline?: string; file?: string }, baseDir?: string): { code: string; filename: string } {
  if (ref.inline !== undefined) return { code: ref.inline, filename: 'inline-script.js' };
  const file = path.resolve(baseDir ?? process.cwd(), ref.file!);
  return { code: fs.readFileSync(file, 'utf8'), filename: file };
}

function makeClient(env: ScriptEnv, out: ScriptOutcome) {
  return {
    global: {
      set: (name: string, value: unknown) => void env.globals.set(String(name), stringify(value)),
      get: (name: string) => env.globals.get(String(name)),
      isEmpty: () => env.globals.size === 0,
      clear: (name: string) => void env.globals.delete(String(name)),
      clearAll: () => env.globals.clear(),
    },
    test: (name: string, fn: () => void) => {
      try {
        fn();
        out.tests.push({ name: String(name), passed: true });
      } catch (e) {
        if (e === EXIT) throw e;
        out.tests.push({ name: String(name), passed: false, error: e instanceof Error ? e.message : String(e) });
      }
    },
    assert: (condition: unknown, message?: string) => {
      if (!condition) throw new Error(message ?? 'Assertion failed');
    },
    log: (...args: unknown[]) => void out.logs.push(args.map(stringify).join(' ')),
    exit: () => {
      throw EXIT;
    },
  };
}

function run(code: string, filename: string, sandbox: Record<string, unknown>, out: ScriptOutcome) {
  const context = vm.createContext({
    ...sandbox,
    console: {
      log: (...a: unknown[]) => out.logs.push(a.map(stringify).join(' ')),
      info: (...a: unknown[]) => out.logs.push(a.map(stringify).join(' ')),
      warn: (...a: unknown[]) => out.logs.push('WARN ' + a.map(stringify).join(' ')),
      error: (...a: unknown[]) => out.logs.push('ERROR ' + a.map(stringify).join(' ')),
    },
    crypto: { randomUUID },
    $random: { uuid: randomUUID },
  });
  try {
    vm.runInContext(code, context, { filename, timeout: 5000 });
  } catch (e) {
    if (e !== EXIT) out.error = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
  }
}

export function runPreRequestScript(
  ref: { inline?: string; file?: string },
  env: ScriptEnv,
  request: { method: string; url: string },
): ScriptOutcome {
  const out: ScriptOutcome = { tests: [], logs: [] };
  let code: string, filename: string;
  try {
    ({ code, filename } = loadScript(ref, env.baseDir));
  } catch (e) {
    return { ...out, error: `Cannot read script: ${(e as Error).message}` };
  }
  run(
    code,
    filename,
    {
      client: makeClient(env, out),
      request: {
        method: request.method,
        url: { tryGetSubstituted: () => request.url },
        variables: {
          set: (name: string, value: unknown) => void env.locals.set(String(name), stringify(value)),
          get: (name: string) => env.locals.get(String(name)),
        },
        environment: { get: (name: string) => env.lookup(String(name)) },
      },
    },
    out,
  );
  return out;
}

export function runResponseHandler(ref: { inline?: string; file?: string }, env: ScriptEnv, res: ScriptResponse): ScriptOutcome {
  const out: ScriptOutcome = { tests: [], logs: [] };
  let code: string, filename: string;
  try {
    ({ code, filename } = loadScript(ref, env.baseDir));
  } catch (e) {
    return { ...out, error: `Cannot read script: ${(e as Error).message}` };
  }
  const [mimeType, ...params] = (res.contentType ?? '').split(';').map((s) => s.trim());
  const charset = params.find((p) => p.toLowerCase().startsWith('charset='))?.slice(8);
  let body: unknown = res.body;
  if (/json/i.test(mimeType) || /^\s*[[{]/.test(res.body)) {
    try {
      body = JSON.parse(res.body);
    } catch {
      /* keep text */
    }
  }
  const values = (name: string) => res.headers.filter(([k]) => k.toLowerCase() === String(name).toLowerCase()).map(([, v]) => v);
  run(
    code,
    filename,
    {
      client: makeClient(env, out),
      response: {
        status: res.status,
        body,
        headers: { valueOf: (n: string) => values(n)[0] ?? null, valuesOf: (n: string) => values(n) },
        contentType: { mimeType, charset: charset ?? null },
      },
      request: {
        variables: { get: (name: string) => env.locals.get(String(name)) },
        environment: { get: (name: string) => env.lookup(String(name)) },
      },
    },
    out,
  );
  return out;
}
