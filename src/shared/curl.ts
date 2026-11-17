import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

// ---------- command line formatting / parsing ----------

const SAFE_ARG = /^[\w@%+=:,./~-]+$/;

/** POSIX shell quoting */
export function shellQuote(arg: string): string {
  if (arg === '') return "''";
  if (SAFE_ARG.test(arg)) return arg;
  return `'${arg.replace(/'/g, `'\\''`)}'`;
}

/** Readable command line "curl …"; long commands are split before each option. */
export function formatCurl(args: string[]): string {
  const quoted = args.map(shellQuote);
  const oneLine = ['curl', ...quoted].join(' ');
  if (oneLine.length <= 100) return oneLine;
  let out = 'curl';
  quoted.forEach((q, i) => {
    out += args[i].startsWith('-') && i > 0 ? ' \\\n  ' + q : ' ' + q;
  });
  return out;
}

/**
 * Splits a shell command line into arguments (single/double quotes, $'…', backslash escapes and
 * line continuations). A leading "curl" is removed. Throws on unterminated quotes.
 */
export function parseCurlCommand(text: string): string[] {
  const args: string[] = [];
  let cur = '';
  let inArg = false;
  let i = 0;
  const s = text;
  const fail = (what: string) => {
    throw new Error(`Invalid curl command: unterminated ${what}`);
  };
  while (i < s.length) {
    const c = s[i];
    if (c === '\\') {
      const n = s[i + 1];
      if (n === '\n') i += 2;
      else if (n === '\r' && s[i + 2] === '\n') i += 3;
      else {
        if (n !== undefined) cur += n;
        inArg = true;
        i += 2;
      }
      continue;
    }
    if (/\s/.test(c)) {
      if (inArg) args.push(cur);
      cur = '';
      inArg = false;
      i++;
      continue;
    }
    inArg = true;
    if (c === "'") {
      const close = s.indexOf("'", i + 1);
      if (close < 0) fail('single quote');
      cur += s.slice(i + 1, close);
      i = close + 1;
    } else if (c === '$' && s[i + 1] === "'") {
      // ANSI-C quoting, e.g. from "Copy as cURL" in browsers
      i += 2;
      let closed = false;
      while (i < s.length) {
        const d = s[i];
        if (d === "'") {
          closed = true;
          i++;
          break;
        }
        if (d === '\\' && i + 1 < s.length) {
          const e = s[i + 1];
          const map: Record<string, string> = { n: '\n', t: '\t', r: '\r', '\\': '\\', "'": "'", '"': '"', '0': '\0' };
          if (e === 'x' || e === 'u') {
            const len = e === 'x' ? 2 : 4;
            const hex = s.slice(i + 2, i + 2 + len);
            cur += String.fromCharCode(parseInt(hex, 16));
            i += 2 + len;
          } else {
            cur += map[e] ?? '\\' + e;
            i += 2;
          }
          continue;
        }
        cur += d;
        i++;
      }
      if (!closed) fail('$\'…\' quote');
    } else if (c === '"') {
      i++;
      let closed = false;
      while (i < s.length) {
        const d = s[i];
        if (d === '"') {
          closed = true;
          i++;
          break;
        }
        if (d === '\\' && /["\\$`\n]/.test(s[i + 1] ?? '')) {
          if (s[i + 1] !== '\n') cur += s[i + 1];
          i += 2;
          continue;
        }
        cur += d;
        i++;
      }
      if (!closed) fail('double quote');
    } else {
      cur += c;
      i++;
    }
  }
  if (inArg) args.push(cur);
  if (args.length && /(^|[\\/])curl(\.exe)?$/i.test(args[0])) args.shift();
  return args;
}

// ---------- execution ----------

export interface CurlResult {
  /** HTTP status of the final response (undefined if no response was received) */
  status?: number;
  statusText?: string;
  headers: [string, string][];
  /** status line + headers of the final response */
  rawHeaders: string;
  /** body as text ('' for binary content, see bodyBase64) */
  body: string;
  /** set for binary content */
  bodyBase64?: string;
  contentType?: string;
  sizeBytes: number;
  timeMs: number;
  effectiveUrl?: string;
  exitCode?: number;
  stderr: string;
  error?: string;
  cancelled: boolean;
  /** arguments curl was called with (without the internal output options) */
  args: string[];
  cwd: string;
}

export interface CurlProcess {
  result: Promise<CurlResult>;
  kill(): void;
}

const WRITE_OUT = '\n__RW__%{http_code}|%{time_total}|%{url_effective}';

function isText(contentType: string | undefined, buf: Buffer): boolean {
  const ct = (contentType ?? '').toLowerCase();
  if (/^text\/|json|xml|javascript|ecmascript|x-www-form-urlencoded|graphql|yaml|csv|html/.test(ct)) return true;
  if (ct && !/^application\/octet-stream/.test(ct)) return false;
  // no or generic content type: text if it is valid UTF-8 without NUL bytes
  if (buf.includes(0)) return false;
  return !new TextDecoder('utf-8', { fatal: false }).decode(buf).includes('\uFFFD');
}

function decode(buf: Buffer, contentType?: string): string {
  const charset = /charset\s*=\s*"?([\w-]+)/i.exec(contentType ?? '')?.[1];
  try {
    return new TextDecoder(charset ?? 'utf-8').decode(buf);
  } catch {
    return buf.toString('utf8');
  }
}

/** Parses the header dump of curl -D (one block per response, e.g. redirects); returns the last one. */
function lastHeaderBlock(dump: string) {
  const blocks = dump
    .split(/\r?\n\r?\n/)
    .map((b) => b.trim())
    .filter((b) => /^HTTP\//.test(b));
  const raw = blocks[blocks.length - 1] ?? '';
  const [statusLine = '', ...rest] = raw.split(/\r?\n/);
  const m = /^HTTP\/[\d.]+\s+(\d{3})(?:\s+(.*))?$/.exec(statusLine.trim());
  const headers: [string, string][] = [];
  for (const l of rest) {
    const c = l.indexOf(':');
    if (c > 0) headers.push([l.slice(0, c).trim(), l.slice(c + 1).trim()]);
  }
  return { raw, status: m ? Number(m[1]) : undefined, statusText: m?.[2]?.trim() || undefined, headers };
}

/** Runs curl with the given arguments; response headers and body are captured in temp files. */
export function runCurl(args: string[], cwd: string, curlPath = 'curl'): CurlProcess {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rw-curl-'));
  const headerFile = path.join(dir, 'headers');
  const bodyFile = path.join(dir, 'body');
  const internal = ['-s', '-S', '-D', headerFile, '-o', bodyFile, '-w', WRITE_OUT];
  const started = Date.now();
  let cancelled = false;
  let child: ReturnType<typeof spawn> | undefined;

  const result = new Promise<CurlResult>((resolve) => {
    let stdout = '';
    let stderr = '';
    let spawnError: string | undefined;
    const finish = (exitCode: number | undefined) => {
      const read = (f: string) => {
        try {
          return fs.readFileSync(f);
        } catch {
          return Buffer.alloc(0);
        }
      };
      const dump = read(headerFile).toString('latin1');
      const buf = read(bodyFile);
      fs.rm(dir, { recursive: true, force: true }, () => undefined);

      const meta = /__RW__(\d*)\|([\d.]*)\|(.*)$/.exec(stdout.trim());
      const h = lastHeaderBlock(dump);
      const code = meta?.[1] ? Number(meta[1]) : h.status;
      const status = code ? code : undefined;
      const contentType = h.headers.find(([k]) => k.toLowerCase() === 'content-type')?.[1];
      const text = isText(contentType, buf);
      const errText = stderr.trim().split(/\r?\n/).pop();
      resolve({
        status,
        statusText: status ? h.statusText : undefined,
        headers: h.headers,
        rawHeaders: h.raw,
        body: text ? decode(buf, contentType) : '',
        bodyBase64: text ? undefined : buf.toString('base64'),
        contentType,
        sizeBytes: buf.length,
        timeMs: meta?.[2] ? Math.round(Number(meta[2]) * 1000) : Date.now() - started,
        effectiveUrl: meta?.[3] || undefined,
        exitCode,
        stderr: stderr.trim(),
        error: cancelled ? 'Cancelled' : spawnError ?? (exitCode ? errText || `curl exited with code ${exitCode}` : undefined),
        cancelled,
        args,
        cwd,
      });
    };

    try {
      child = spawn(curlPath, [...internal, ...args], { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (e) {
      spawnError = `Cannot start ${curlPath}: ${(e as Error).message}`;
      finish(undefined);
      return;
    }
    child.stdout!.on('data', (d: Buffer) => (stdout += d.toString('utf8')));
    child.stderr!.on('data', (d: Buffer) => (stderr += d.toString('utf8')));
    child.on('error', (e) => {
      spawnError = `Cannot start ${curlPath}: ${e.message}`;
    });
    child.on('close', (code) => finish(code ?? undefined));
  });

  return {
    result,
    kill() {
      if (child && child.exitCode === null && !child.killed) {
        cancelled = true;
        child.kill();
      }
    },
  };
}
