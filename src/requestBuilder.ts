import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { formatCurl, parseCurlCommand, type HttpBlock } from './core.js';
import type { Resolver } from './variables.js';

export interface BuilderOptions {
  /** folder of the .http file - relative file paths are resolved against it */
  baseDir?: string;
  workspaceDir?: string;
  /** folder for temporary request bodies (multipart with files) */
  tempDir: string;
  followRedirects: boolean;
  defaultHeaders: Record<string, string>;
  certificates: Record<string, { cert?: string; key?: string; pfx?: string; passphrase?: string }>;
}

export interface BuiltRequest {
  /** request specific curl arguments (shown in the panel) */
  args: string[];
  /** readable command line */
  display: string;
  missing: Set<string>;
  tempFiles: string[];
  /** resolved request (for {{name.request.*}} references and history) */
  method: string;
  url: string;
  headers: [string, string][];
  body: string;
}

const hasHeader = (headers: [string, string][], name: string) => headers.some(([k]) => k.toLowerCase() === name.toLowerCase());
const getHeader = (headers: [string, string][], name: string) => headers.find(([k]) => k.toLowerCase() === name.toLowerCase())?.[1];
const removeHeader = (headers: [string, string][], name: string) => headers.filter(([k]) => k.toLowerCase() !== name.toLowerCase());

export function resolvePath(p: string, baseDir?: string, workspaceDir?: string): string {
  if (p.startsWith('~/') || p === '~') return path.join(os.homedir(), p.slice(1));
  if (path.isAbsolute(p)) return p;
  const fromBase = path.resolve(baseDir ?? workspaceDir ?? process.cwd(), p);
  if (fs.existsSync(fromBase) || !workspaceDir) return fromBase;
  const fromWs = path.resolve(workspaceDir, p);
  return fs.existsSync(fromWs) ? fromWs : fromBase;
}

/** Percent-encodes characters curl does not accept in URLs, keeps existing %XX escapes. */
export function encodeUrl(url: string): string {
  return url.replace(/%(?![0-9a-fA-F]{2})|[^\x21-\x7e]|["<>\\^`{|}]/g, (c) => encodeURIComponent(c));
}

export function buildRequest(block: HttpBlock, r: Resolver, opts: BuilderOptions): BuiltRequest {
  const missing = new Set<string>();
  const tempFiles: string[] = [];
  const res = (s: string) => r.resolve(s, missing);

  // ----- raw curl block -----
  if (block.kind === 'curl') {
    const text = res(block.curl ?? '');
    let args: string[] = [];
    try {
      args = parseCurlCommand(text);
    } catch {
      /* reported when executed */
    }
    const headers: [string, string][] = [];
    let method = 'GET';
    let url = '';
    let body = '';
    for (let i = 0; i < args.length; i++) {
      const a = args[i];
      if ((a === '-H' || a === '--header') && args[i + 1]) {
        const h = args[++i];
        const c = h.indexOf(':');
        if (c > 0) headers.push([h.slice(0, c).trim(), h.slice(c + 1).trim()]);
      } else if ((a === '-X' || a === '--request') && args[i + 1]) method = args[++i];
      else if (/^(-d|--data|--data-raw|--data-binary)$/.test(a) && args[i + 1] !== undefined) {
        body = args[++i];
        if (method === 'GET') method = 'POST';
      } else if (/^https?:\/\//i.test(a) && !url) url = a;
      else if (a === '--url' && args[i + 1]) url = args[++i];
    }
    return { args, display: text, missing, tempFiles, method, url, headers, body };
  }

  // ----- regular request -----
  const args: string[] = [];
  let headers: [string, string][] = block.headers.map(([k, v]) => [res(k), res(v)]);
  for (const [k, v] of Object.entries(opts.defaultHeaders)) if (!hasHeader(headers, k)) headers.push([k, res(v)]);

  // URL: absolute, scheme-less ("localhost:8080/x") or origin-form with Host header ("/x" + Host: ...)
  let url = res(block.url).trim();
  if (url.startsWith('/')) {
    const host = getHeader(headers, 'host');
    if (host) url = `${/:443$/.test(host) ? 'https' : 'http'}://${host}${url}`;
  }
  if (!/^[a-z][\w+.-]*:\/\//i.test(url)) url = 'http://' + url;
  url = encodeUrl(url);

  const method = block.method;
  const ver = block.httpVersion;
  if (ver === 'HTTP/1.0') args.push('--http1.0');
  else if (ver === 'HTTP/1.1') args.push('--http1.1');
  else if (ver === 'HTTP/2' || ver === 'HTTP/2.0') args.push('--http2');
  else if (ver === 'HTTP/3' || ver === 'HTTP/3.0') args.push('--http3');

  // ----- authentication helpers (REST Client syntax) -----
  const auth = getHeader(headers, 'authorization');
  if (auth) {
    const basic = /^Basic\s+(\S+?)(?::(\S*)|\s+(\S+))?\s*$/i.exec(auth);
    const digest = /^Digest\s+(\S+)\s+(\S+)\s*$/i.exec(auth);
    const aws = /^AWS\s+(\S+)\s+(\S+)((?:\s+\w+:\S+)*)\s*$/i.exec(auth);
    if (basic && (basic[2] !== undefined || basic[3] !== undefined)) {
      const user = basic[1];
      const pass = basic[2] ?? basic[3] ?? '';
      headers = removeHeader(headers, 'authorization');
      headers.push(['Authorization', 'Basic ' + Buffer.from(`${user}:${pass}`).toString('base64')]);
    } else if (digest) {
      headers = removeHeader(headers, 'authorization');
      args.push('--digest', '-u', `${digest[1]}:${digest[2]}`);
    } else if (aws) {
      const opt = Object.fromEntries([...aws[3].matchAll(/(\w+):(\S+)/g)].map((m) => [m[1].toLowerCase(), m[2]]));
      headers = removeHeader(headers, 'authorization');
      const sig = ['aws', 'amz', opt.region, opt.service].filter((x) => x !== undefined).join(':');
      args.push('--aws-sigv4', sig, '-u', `${aws[1]}:${aws[2]}`);
      if (opt.token) headers.push(['X-Amz-Security-Token', opt.token]);
    }
  }

  // ----- body -----
  let body = '';
  let bodyArgs: string[] = [];
  const contentType = getHeader(headers, 'content-type') ?? '';

  if (block.bodyFile) {
    const file = resolvePath(res(block.bodyFile), opts.baseDir, opts.workspaceDir);
    if (block.bodyFileProcessVariables) {
      try {
        const enc = (block.bodyFileEncoding || 'utf8') as BufferEncoding;
        body = res(fs.readFileSync(file).toString(Buffer.isEncoding(enc) ? enc : 'utf8'));
        bodyArgs = ['--data-raw', body];
      } catch (e) {
        missing.add(`file ${file}: ${(e as Error).message}`);
      }
    } else {
      bodyArgs = ['--data-binary', '@' + file];
      body = `<file ${file}>`;
    }
  } else if (block.body) {
    const isGraphQL = (getHeader(headers, 'x-request-type') ?? '').toLowerCase() === 'graphql';
    if (isGraphQL) {
      // query, blank line, optional variables JSON
      headers = removeHeader(headers, 'x-request-type');
      const raw = res(block.body);
      const split = /\r?\n\s*\r?\n(?=\s*\{)/.exec(raw);
      const query = split ? raw.slice(0, split.index) : raw;
      const varsText = split ? raw.slice(split.index + split[0].length) : '';
      const payload: Record<string, unknown> = { query: query.trim() };
      const opName = /^\s*(?:query|mutation|subscription)\s+(\w+)/.exec(query);
      if (opName) payload.operationName = opName[1];
      if (varsText.trim()) {
        try {
          payload.variables = JSON.parse(varsText);
        } catch {
          missing.add('GraphQL variables are not valid JSON');
        }
      }
      body = JSON.stringify(payload);
      if (!hasHeader(headers, 'content-type')) headers.push(['Content-Type', 'application/json']);
      bodyArgs = ['--data-raw', body];
    } else if (/x-www-form-urlencoded/i.test(contentType)) {
      // lines are joined: "name=foo\n&age=20" -> "name=foo&age=20"
      body = res(block.body)
        .split(/\r?\n/)
        .map((l) => l.trim())
        .join('');
      bodyArgs = ['--data-raw', body];
    } else if (/^multipart\//i.test(contentType)) {
      // CRLF line endings; lines "< ./file" / "<@ ./file" include file content
      const parts: Buffer[] = [];
      const lines = block.body.split(/\r?\n/);
      lines.forEach((line, i) => {
        const fileRef = /^<(@(\w*))?\s+(.+?)\s*$/.exec(line);
        if (fileRef) {
          const file = resolvePath(res(fileRef[3]), opts.baseDir, opts.workspaceDir);
          try {
            const buf = fs.readFileSync(file);
            const enc = (fileRef[2] || 'utf8') as BufferEncoding;
            parts.push(fileRef[1] ? Buffer.from(res(buf.toString(Buffer.isEncoding(enc) ? enc : 'utf8'))) : buf);
          } catch (e) {
            missing.add(`file ${file}: ${(e as Error).message}`);
          }
        } else parts.push(Buffer.from(res(line)));
        if (i < lines.length - 1) parts.push(Buffer.from('\r\n'));
      });
      // a multipart body must end with CRLF after the closing boundary
      parts.push(Buffer.from('\r\n'));
      const data = Buffer.concat(parts);
      const tmp = path.join(opts.tempDir, `multipart-${Date.now()}-${Math.random().toString(36).slice(2)}.bin`);
      fs.mkdirSync(opts.tempDir, { recursive: true });
      fs.writeFileSync(tmp, data);
      tempFiles.push(tmp);
      body = data.toString('utf8');
      bodyArgs = ['--data-binary', '@' + tmp];
    } else {
      body = res(block.body);
      bodyArgs = ['--data-raw', body];
    }
  }

  // ----- method -----
  if (method === 'HEAD') args.push('--head');
  else if (method !== 'GET' || bodyArgs.length) args.push('-X', method);
  args.push(url);

  for (const [k, v] of headers) args.push('-H', v === '' ? `${k};` : `${k}: ${v}`);
  args.push(...bodyArgs);

  // ----- request settings -----
  if (/[[\]]/.test(url)) args.push('-g'); // brackets are literal, not curl URL globbing
  if (opts.followRedirects && !block.settings.noRedirect) args.push('-L');
  if (block.settings.timeout !== undefined) args.push('--max-time', String(block.settings.timeout));
  if (block.settings.connectionTimeout !== undefined) args.push('--connect-timeout', String(block.settings.connectionTimeout));

  // ----- client certificates (rest-client.certificates: { "host[:port]": { cert, key, pfx, passphrase } }) -----
  try {
    const u = new URL(url);
    const cert = opts.certificates[u.host] ?? opts.certificates[u.hostname];
    if (cert) {
      const p = (f: string) => resolvePath(f, opts.workspaceDir ?? opts.baseDir);
      if (cert.pfx) args.push('--cert-type', 'P12', '--cert', p(cert.pfx) + (cert.passphrase ? `:${cert.passphrase}` : ''));
      else if (cert.cert) {
        args.push('--cert', p(cert.cert));
        if (cert.key) args.push('--key', p(cert.key));
        if (cert.passphrase) args.push('--pass', cert.passphrase);
      }
    }
  } catch {
    /* invalid URL - curl will report it */
  }

  return { args, display: formatCurl(args), missing, tempFiles, method, url, headers, body };
}
