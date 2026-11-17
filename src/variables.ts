import * as fs from 'node:fs';
import * as path from 'node:path';
import { randomUUID, randomInt } from 'node:crypto';
import * as xpath from 'xpath';
import { DOMParser } from '@xmldom/xmldom';

/**
 * Full {{variable}} resolution for .http files.
 *
 * Lookup order (first match wins):
 *   1. request-local variables: prompt values, request.variables.set(...) of pre-request scripts
 *   2. system variables ({{$guid}}, {{$timestamp -1 d}}, {{$dotenv KEY}}, {{$random.integer(1,10)}} ...)
 *   3. request variables ({{login.response.body.$.token}}, {{login.request.headers.Host}})
 *   4. global variables set by response handler scripts (client.global.set)
 *   5. file variables (@name = value)
 *   6. environment variables of the selected environment, then $shared ({{$shared.x}} explicitly)
 * Values are resolved recursively.
 */

export interface Exchange {
  request: { method: string; url: string; headers: [string, string][]; body: string };
  response: { status: number; headers: [string, string][]; body: string };
  time: Date;
}

export type VarState = 'ok' | 'pending' | 'missing';
export type VarSource = 'local' | 'system' | 'request' | 'global' | 'file' | 'environment' | 'shared';

export interface ResolverContext {
  fileVars: Map<string, string>;
  env: Map<string, string>;
  envName?: string;
  shared: Map<string, string>;
  exchanges: Map<string, Exchange>;
  globals: Map<string, string>;
  locals?: Map<string, string>;
  /** folder of the .http file (for {{$dotenv}}) */
  baseDir?: string;
}

const PLACEHOLDER = /\{\{\s*([^{}]+?)\s*\}\}/g;
const REQUEST_REF = /^([\w-]+)\.(request|response)\.(body|headers)(?:\.(.*))?$/;
const UNSUPPORTED = new Set(['$aadToken', '$aadV2Token', '$oidcAccessToken']);

export class Resolver {
  constructor(private readonly ctx: ResolverContext) {}

  /** Replaces all placeholders; unresolved names are added to `missing` and left untouched. */
  resolve(text: string, missing: Set<string> = new Set(), depth = 0): string {
    return text.replace(PLACEHOLDER, (all, expr: string) => this.lookup(expr, missing, depth)?.value ?? all);
  }

  lookup(expr: string, missing: Set<string> = new Set(), depth = 0): { value: string; source: VarSource } | undefined {
    const fail = () => {
      missing.add(expr);
      return undefined;
    };
    if (depth > 10) return fail();
    const c = this.ctx;

    const local = c.locals?.get(expr);
    if (local !== undefined) return { value: local, source: 'local' };

    if (expr.startsWith('$shared.')) {
      const v = c.shared.get(expr.slice(8));
      return v === undefined ? fail() : { value: this.resolve(v, missing, depth + 1), source: 'shared' };
    }
    if (expr.startsWith('$')) {
      const v = this.system(expr, missing, depth);
      return v === undefined ? fail() : { value: v, source: 'system' };
    }

    const m = REQUEST_REF.exec(expr);
    if (m) {
      const ex = c.exchanges.get(m[1]);
      if (!ex) return fail();
      const part = m[2] === 'request' ? ex.request : ex.response;
      const v = m[3] === 'headers' ? headerValue(part.headers, m[4]) : bodyPath(part.body, m[4], part.headers);
      return v === undefined ? fail() : { value: v, source: 'request' };
    }

    const g = c.globals.get(expr);
    if (g !== undefined) return { value: g, source: 'global' };

    const fv = c.fileVars.get(expr);
    if (fv !== undefined) return { value: this.resolve(fv, missing, depth + 1), source: 'file' };

    const ev = c.env.get(expr);
    if (ev !== undefined) return { value: this.resolve(ev, missing, depth + 1), source: 'environment' };

    const sv = c.shared.get(expr);
    if (sv !== undefined) return { value: this.resolve(sv, missing, depth + 1), source: 'shared' };

    return fail();
  }

  /**
   * For highlighting/diagnostics: 'pending' = will become available (named request not sent yet,
   * global set by a response handler, prompt variable), 'missing' = can't be resolved.
   */
  state(expr: string, pending: { requests: Set<string>; globals: Set<string>; prompts: Set<string> }): VarState {
    const missing = new Set<string>();
    this.lookup(expr, missing);
    if (missing.size === 0) return 'ok';
    const allPending = [...missing].every((x) => {
      const m = REQUEST_REF.exec(x);
      if (m) return pending.requests.has(m[1]) && !this.ctx.exchanges.has(m[1]);
      return pending.globals.has(x) || pending.prompts.has(x);
    });
    return allPending ? 'pending' : 'missing';
  }

  // ---------- system variables ----------

  private system(expr: string, missing: Set<string>, depth: number): string | undefined {
    // JetBrains style: $random.integer(1, 10)
    const fn = /^\$([\w.]+)\s*(?:\((.*)\))?$/.exec(expr);
    const name = fn ? fn[1] : '';
    const fnArgs = fn?.[2] !== undefined ? fn[2].split(',').map((a) => a.trim().replace(/^["']|["']$/g, '')) : [];
    const [head, ...args] = splitArgs(expr);

    switch (name) {
      case 'random.uuid':
        return randomUUID();
      case 'random.integer': {
        const [from = '0', to = '1000'] = fnArgs;
        return String(randomInt(Number(from), Number(to)));
      }
      case 'random.float': {
        const [from = '0', to = '1000'] = fnArgs;
        return String(Number(from) + Math.random() * (Number(to) - Number(from)));
      }
      case 'random.alphabetic':
        return randomString(Number(fnArgs[0] ?? 10), 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ');
      case 'random.alphanumeric':
        return randomString(Number(fnArgs[0] ?? 10), 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_');
      case 'random.hexadecimal':
        return randomString(Number(fnArgs[0] ?? 10), '0123456789abcdef');
      case 'random.email':
        return `${randomString(8, 'abcdefghijklmnopqrstuvwxyz')}@example.com`;
    }

    switch (head) {
      case '$guid':
      case '$uuid':
        return randomUUID();
      case '$randomInt': {
        const min = Number(args[0] ?? 0);
        const max = Number(args[1] ?? 1000);
        return String(Math.floor(min + Math.random() * (max - min)));
      }
      case '$timestamp': {
        const d = applyOffset(new Date(), args[0], args[1]);
        return d ? String(Math.floor(d.getTime() / 1000)) : undefined;
      }
      case '$isoTimestamp':
        return new Date().toISOString();
      case '$datetime':
      case '$localDatetime': {
        const local = head === '$localDatetime';
        const d = applyOffset(new Date(), args[1], args[2]);
        if (!d) return undefined;
        const fmt = args[0] ?? 'iso8601';
        if (fmt === 'rfc1123') return local ? formatDate(d, 'ddd, DD MMM YYYY HH:mm:ss ZZ', true) : d.toUTCString();
        if (fmt === 'iso8601') return local ? formatDate(d, 'YYYY-MM-DDTHH:mm:ss.SSSZ', true) : d.toISOString();
        return formatDate(d, fmt, local);
      }
      case '$processEnv': {
        const key = this.indirect(args[0], missing, depth);
        return key === undefined ? undefined : process.env[key];
      }
      case '$dotenv': {
        const key = this.indirect(args[0], missing, depth);
        return key === undefined ? undefined : readDotenv(this.ctx.baseDir)?.get(key);
      }
    }
    if (UNSUPPORTED.has(head)) return undefined;
    return undefined;
  }

  /** `%name` = look up the name in the current environment first */
  private indirect(arg: string | undefined, missing: Set<string>, depth: number): string | undefined {
    if (!arg) return undefined;
    if (!arg.startsWith('%')) return arg;
    return this.lookup(arg.slice(1), missing, depth + 1)?.value;
  }
}

export function isUnsupportedSystemVariable(expr: string): boolean {
  return UNSUPPORTED.has(expr.split(/\s+/)[0]);
}

export const SYSTEM_VARIABLES: [string, string][] = [
  ['$guid', 'random UUID v4'],
  ['$uuid', 'random UUID v4'],
  ['$randomInt min max', 'random integer, min inclusive, max exclusive'],
  ['$timestamp', 'Unix timestamp (seconds); optional offset, e.g. `$timestamp -1 d`'],
  ['$isoTimestamp', 'current time in ISO 8601 (UTC)'],
  ['$datetime iso8601', 'UTC date: rfc1123 | iso8601 | "custom format" [offset unit]'],
  ['$localDatetime iso8601', 'local date: rfc1123 | iso8601 | "custom format" [offset unit]'],
  ['$processEnv NAME', 'environment variable of the VS Code process (`%name` = name from environment)'],
  ['$dotenv NAME', 'variable from the .env file next to the .http file'],
  ['$random.uuid', 'random UUID'],
  ['$random.integer(0, 100)', 'random integer'],
  ['$random.float(0, 1)', 'random float'],
  ['$random.alphabetic(10)', 'random letters'],
  ['$random.alphanumeric(10)', 'random letters, digits and _'],
  ['$random.hexadecimal(10)', 'random hex string'],
  ['$random.email', 'random e-mail address'],
];

// ---------- helpers ----------

function splitArgs(s: string): string[] {
  const out: string[] = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s))) out.push(m[1] ?? m[2] ?? m[3]);
  return out;
}

function randomString(len: number, alphabet: string): string {
  let s = '';
  for (let i = 0; i < Math.max(0, Math.min(len, 10000)); i++) s += alphabet[randomInt(alphabet.length)];
  return s;
}

/** REST Client offsets: `{{$timestamp -3 h}}` units y M w d h m s ms */
function applyOffset(d: Date, amount?: string, unit?: string): Date | undefined {
  if (amount === undefined) return d;
  const n = Number(amount);
  if (!Number.isFinite(n) || !unit) return undefined;
  const r = new Date(d);
  switch (unit) {
    case 'y': r.setFullYear(r.getFullYear() + n); break;
    case 'M': r.setMonth(r.getMonth() + n); break;
    case 'w': r.setDate(r.getDate() + 7 * n); break;
    case 'd': r.setDate(r.getDate() + n); break;
    case 'h': r.setTime(r.getTime() + n * 3600_000); break;
    case 'm': r.setTime(r.getTime() + n * 60_000); break;
    case 's': r.setTime(r.getTime() + n * 1000); break;
    case 'ms': r.setTime(r.getTime() + n); break;
    default: return undefined;
  }
  return r;
}

const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

/** day.js compatible format tokens (as used by REST Client); text in [brackets] is literal */
export function formatDate(d: Date, fmt: string, local: boolean): string {
  const get = {
    Y: local ? d.getFullYear() : d.getUTCFullYear(),
    M: local ? d.getMonth() : d.getUTCMonth(),
    D: local ? d.getDate() : d.getUTCDate(),
    W: local ? d.getDay() : d.getUTCDay(),
    H: local ? d.getHours() : d.getUTCHours(),
    m: local ? d.getMinutes() : d.getUTCMinutes(),
    s: local ? d.getSeconds() : d.getUTCSeconds(),
    S: local ? d.getMilliseconds() : d.getUTCMilliseconds(),
  };
  const off = local ? -d.getTimezoneOffset() : 0;
  const tz = (sep: string) =>
    `${off >= 0 ? '+' : '-'}${String(Math.floor(Math.abs(off) / 60)).padStart(2, '0')}${sep}${String(Math.abs(off) % 60).padStart(2, '0')}`;
  const p = (n: number, l = 2) => String(n).padStart(l, '0');
  const h12 = get.H % 12 || 12;
  const tokens: Record<string, () => string> = {
    YYYY: () => String(get.Y),
    YY: () => String(get.Y).slice(-2),
    MMMM: () => MONTHS[get.M],
    MMM: () => MONTHS[get.M].slice(0, 3),
    MM: () => p(get.M + 1),
    M: () => String(get.M + 1),
    DD: () => p(get.D),
    D: () => String(get.D),
    dddd: () => DAYS[get.W],
    ddd: () => DAYS[get.W].slice(0, 3),
    dd: () => DAYS[get.W].slice(0, 2),
    d: () => String(get.W),
    HH: () => p(get.H),
    H: () => String(get.H),
    hh: () => p(h12),
    h: () => String(h12),
    mm: () => p(get.m),
    m: () => String(get.m),
    ss: () => p(get.s),
    s: () => String(get.s),
    SSS: () => p(get.S, 3),
    A: () => (get.H < 12 ? 'AM' : 'PM'),
    a: () => (get.H < 12 ? 'am' : 'pm'),
    ZZ: () => tz(''),
    Z: () => tz(':'),
    X: () => String(Math.floor(d.getTime() / 1000)),
    x: () => String(d.getTime()),
  };
  return fmt.replace(/\[([^\]]*)]|YYYY|YY|MMMM|MMM|MM|M|DD|D|dddd|ddd|dd|d|HH|H|hh|h|mm|m|ss|s|SSS|A|a|ZZ|Z|X|x/g, (t, lit) =>
    lit !== undefined ? lit : tokens[t](),
  );
}

let dotenvCache: { file: string; mtime: number; vars: Map<string, string> } | undefined;

function readDotenv(dir?: string): Map<string, string> | undefined {
  if (!dir) return undefined;
  const file = path.join(dir, '.env');
  let stat: fs.Stats;
  try {
    stat = fs.statSync(file);
  } catch {
    return undefined;
  }
  if (dotenvCache && dotenvCache.file === file && dotenvCache.mtime === stat.mtimeMs) return dotenvCache.vars;
  const vars = new Map<string, string>();
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = /^\s*(?:export\s+)?([\w.-]+)\s*=\s*(.*?)\s*$/.exec(line);
    if (!m || line.trim().startsWith('#')) continue;
    let v = m[2];
    if (/^".*"$/.test(v)) v = v.slice(1, -1).replace(/\\n/g, '\n');
    else if (/^'.*'$/.test(v)) v = v.slice(1, -1);
    else v = v.replace(/\s+#.*$/, '');
    vars.set(m[1], v);
  }
  dotenvCache = { file, mtime: stat.mtimeMs, vars };
  return vars;
}

function headerValue(headers: [string, string][], name?: string): string | undefined {
  if (!name) return undefined;
  if (name === '*') return headers.map(([k, v]) => `${k}: ${v}`).join('\n');
  const values = headers.filter(([k]) => k.toLowerCase() === name.toLowerCase()).map(([, v]) => v);
  return values.length ? values.join(', ') : undefined;
}

function bodyPath(body: string, expr: string | undefined, headers: [string, string][]): string | undefined {
  if (!expr || expr === '*') return body;
  const ct = headerValue(headers, 'content-type') ?? '';
  if (expr.startsWith('$')) {
    let value: unknown;
    try {
      value = JSON.parse(body);
    } catch {
      return undefined;
    }
    const r = jsonPath(value, expr);
    if (!r.length) return undefined;
    const v = r[0];
    return typeof v === 'string' ? v : JSON.stringify(v);
  }
  if (expr.startsWith('/') || /xml/i.test(ct)) return xpathQuery(body, expr);
  // REST Client style without $: name.response.body.id
  try {
    const r = jsonPath(JSON.parse(body), '$.' + expr);
    if (r.length) return typeof r[0] === 'string' ? (r[0] as string) : JSON.stringify(r[0]);
  } catch {
    /* not JSON */
  }
  return undefined;
}

/**
 * JSONPath subset: $, .name, ['name'], [n], [-n], [*], .*, ..name (recursive descent),
 * [start:end] slices and simple filters [?(@.x == 'y')], [?(@.x > 1)], [?(@.x)].
 */
export function jsonPath(root: unknown, expr: string): unknown[] {
  let nodes: unknown[] = [root];
  const re = /^(?:\.\.([\w$-]+|\*)|\.([\w$-]+|\*)|\[\s*(-?\d+)\s*]|\[\s*'([^']*)'\s*]|\[\s*"([^"]*)"\s*]|\[\s*\*\s*]|\[\s*(-?\d*)\s*:\s*(-?\d*)\s*]|\[\s*\?\((.*?)\)\s*])/;
  let rest = expr.trim().replace(/^\$/, '');
  const children = (n: unknown): unknown[] =>
    Array.isArray(n) ? n : n && typeof n === 'object' ? Object.values(n as Record<string, unknown>) : [];
  const prop = (n: unknown, k: string): unknown[] =>
    n && typeof n === 'object' && k in (n as Record<string, unknown>) ? [(n as Record<string, unknown>)[k]] : [];
  const descendants = (n: unknown): unknown[] => [n, ...children(n).flatMap(descendants)];

  while (rest) {
    const m = re.exec(rest);
    if (!m) return [];
    rest = rest.slice(m[0].length);
    if (m[1] !== undefined) {
      const all = nodes.flatMap(descendants);
      nodes = m[1] === '*' ? all.flatMap(children) : all.flatMap((n) => prop(n, m[1]));
    } else if (m[2] !== undefined) {
      nodes = m[2] === '*' ? nodes.flatMap(children) : nodes.flatMap((n) => prop(n, m[2]));
    } else if (m[3] !== undefined) {
      const i = Number(m[3]);
      nodes = nodes.flatMap((n) => (Array.isArray(n) ? (i < 0 ? [n[n.length + i]] : [n[i]]) : prop(n, m[3]))).filter((x) => x !== undefined);
    } else if (m[4] !== undefined || m[5] !== undefined) {
      const k = (m[4] ?? m[5])!;
      nodes = nodes.flatMap((n) => prop(n, k));
    } else if (m[6] !== undefined || m[7] !== undefined) {
      nodes = nodes.flatMap((n) => {
        if (!Array.isArray(n)) return [];
        const s = m[6] ? Number(m[6]) : 0;
        const e = m[7] ? Number(m[7]) : n.length;
        return n.slice(s, e);
      });
    } else if (m[8] !== undefined) {
      const f = /^@((?:\.[\w$-]+)*)\s*(?:(==|!=|<=|>=|<|>)\s*(.+))?$/.exec(m[8].trim());
      if (!f) return [];
      const test = (item: unknown) => {
        const v = f[1] ? jsonPath(item, '$' + f[1])[0] : item;
        if (!f[2]) return v !== undefined && v !== null && v !== false;
        let rhs: unknown = f[3].trim();
        if (/^'.*'$|^".*"$/.test(rhs as string)) rhs = (rhs as string).slice(1, -1);
        else if (rhs === 'true' || rhs === 'false' || rhs === 'null') rhs = JSON.parse(rhs as string);
        else if (!Number.isNaN(Number(rhs))) rhs = Number(rhs);
        switch (f[2]) {
          case '==': return v === rhs;
          case '!=': return v !== rhs;
          case '<': return (v as number) < (rhs as number);
          case '>': return (v as number) > (rhs as number);
          case '<=': return (v as number) <= (rhs as number);
          case '>=': return (v as number) >= (rhs as number);
        }
        return false;
      };
      nodes = nodes.flatMap(children).filter(test);
    } else {
      nodes = nodes.flatMap(children); // [*]
    }
  }
  return nodes;
}

function xpathQuery(body: string, expr: string): string | undefined {
  try {
    const doc = new DOMParser({ onError: () => undefined }).parseFromString(body, 'text/xml');
    const r = xpath.select(expr, doc as unknown as Node);
    if (Array.isArray(r)) {
      if (!r.length) return undefined;
      const n = r[0] as Node;
      return n.nodeType === 2 /* attribute */ ? (n as Attr).value : (n.textContent ?? undefined);
    }
    return String(r);
  } catch {
    return undefined;
  }
}
