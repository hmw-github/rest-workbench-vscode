/**
 * Parser for .http / .rest files (VS Code REST Client + JetBrains HTTP Client syntax).
 *
 * A file is split into blocks at lines starting with "###". Each block contains, in this order:
 *   comments, # @meta lines, @file = variables, < pre-request scripts,
 *   the request line (METHOD URL [HTTP/x]) or a plain "curl ..." command,
 *   indented ?query / &query continuation lines, headers,
 *   a blank line and the body (or "< ./file" / "<@ ./file" as body),
 *   > response handlers and >> / >>! output redirects.
 * The part before the first "###" is a block as well (usually only variables and comments).
 */

export type LineKind =
  | 'blank'
  | 'separator'
  | 'comment'
  | 'meta'
  | 'variable'
  | 'script'
  | 'request'
  | 'curl'
  | 'header'
  | 'body'
  | 'output';

export interface ScriptRef {
  /** inline code of < {% … %} / > {% … %} */
  inline?: string;
  /** script file of < ./file.js / > ./file.js */
  file?: string;
  /** line where the script starts */
  line: number;
}

export interface Prompt {
  name: string;
  description?: string;
}

export interface RequestSettings {
  note: boolean;
  noRedirect: boolean;
  noCookieJar: boolean;
  noLog: boolean;
  /** seconds */
  timeout?: number;
  /** seconds */
  connectionTimeout?: number;
  prompts: Prompt[];
}

export interface HttpBlock {
  /** position in ParsedFile.blocks */
  index: number;
  /** 'none' = no request in this block (only comments / variables) */
  kind: 'http' | 'curl' | 'none';
  title: string;
  /** # @name */
  name?: string;
  /** first line (the ### separator, or 0) */
  startLine: number;
  /** last line */
  endLine: number;
  /** line of the request line / curl command (startLine for 'none') */
  requestLine: number;
  method: string;
  /** URL including multi-line query continuations, variables not resolved */
  url: string;
  httpVersion?: string;
  headers: [string, string][];
  body: string;
  /** body is a file: < ./file (sent as is) or <@ ./file (variables replaced) */
  bodyFile?: string;
  bodyFileProcessVariables?: boolean;
  /** <@latin1 ./file */
  bodyFileEncoding?: string;
  /** line of the body (file reference), -1 if there is none */
  bodyLine: number;
  /** command text of a curl block (without trailing handlers) */
  curl?: string;
  settings: RequestSettings;
  preRequestScripts: ScriptRef[];
  responseHandlers: ScriptRef[];
  /** >> path (overwrite = >>!) */
  outputFile?: { path: string; overwrite: boolean };
}

export interface ParsedFile {
  lines: string[];
  lineKinds: LineKind[];
  blocks: HttpBlock[];
  /** file variables (@name = value), unresolved */
  variables: Map<string, string>;
  /** line of the definition of each file variable */
  variableLines: Map<string, number>;
}

const METHODS = 'GET|POST|PUT|DELETE|PATCH|HEAD|OPTIONS|TRACE|CONNECT|PROPFIND|PROPPATCH|MKCOL|COPY|MOVE|LOCK|UNLOCK|REPORT|SEARCH|PURGE';
const REQUEST_LINE = new RegExp(`^(${METHODS})\\s+(.+?)(?:\\s+(HTTP\\/[\\d.]+))?\\s*$`);
const URL_ONLY_LINE = /^(\S+?)(?:\s+(HTTP\/[\d.]+))?\s*$/;
const SEPARATOR = /^###/;
const COMMENT = /^\s*(#|\/\/)/;
const META = /^\s*(?:#|\/\/)\s*@([\w-]+)(?:\s*=\s*|\s+|$)(.*)$/;
const VARIABLE = /^\s*@([\w.-]+)\s*=\s*(.*?)\s*$/;
const HEADER = /^([^:\s][^:]*?)\s*:\s?(.*)$/;
const FILE_REF = /^<(@(\w*))?\s+(.+?)\s*$/;
const OUTPUT = /^>>(!)?\s*(.+?)\s*$/;

/** "10" → 10, "500ms" → 0.5, "2m" → 120 (seconds) */
function parseDuration(text: string): number | undefined {
  const m = /^(\d+(?:\.\d+)?)\s*(ms|s|m)?$/i.exec(text.trim());
  if (!m) return undefined;
  const n = Number(m[1]);
  const unit = (m[2] ?? 's').toLowerCase();
  return unit === 'ms' ? n / 1000 : unit === 'm' ? n * 60 : n;
}

/**
 * Reads a script that starts at `lines[i]` after the "<" / ">" marker.
 * Returns the script and the index of its last line.
 */
function readScript(lines: string[], i: number, rest: string): { ref: Omit<ScriptRef, 'line'>; end: number } {
  const t = rest.trim();
  if (!t.startsWith('{%')) return { ref: { file: t }, end: i };
  const after = t.slice(2);
  const close = after.indexOf('%}');
  if (close >= 0) return { ref: { inline: after.slice(0, close).trim() }, end: i };
  const code = [after];
  for (let j = i + 1; j < lines.length; j++) {
    const c = lines[j].indexOf('%}');
    if (c >= 0) {
      code.push(lines[j].slice(0, c));
      return { ref: { inline: code.join('\n').trim() }, end: j };
    }
    code.push(lines[j]);
  }
  return { ref: { inline: code.join('\n').trim() }, end: lines.length - 1 };
}

const isScriptStart = (line: string) => /^<\s*\{%/.test(line) || /^<\s+\S/.test(line);
const isHandlerStart = (line: string) => /^>(?!>)\s*(\{%|\S)/.test(line);

function parseBlock(lines: string[], kinds: LineKind[], start: number, end: number, index: number, file: ParsedFile): HttpBlock {
  const block: HttpBlock = {
    index,
    kind: 'none',
    title: '',
    startLine: start,
    endLine: end,
    requestLine: start,
    method: 'GET',
    url: '',
    headers: [],
    body: '',
    bodyLine: -1,
    settings: { note: false, noRedirect: false, noCookieJar: false, noLog: false, prompts: [] },
    preRequestScripts: [],
    responseHandlers: [],
  };
  let i = start;
  if (SEPARATOR.test(lines[i] ?? '')) {
    kinds[i] = 'separator';
    block.title = lines[i].replace(/^#+/, '').trim();
    i++;
  }

  const variable = (line: string, n: number) => {
    const v = VARIABLE.exec(line);
    if (!v) return false;
    file.variables.set(v[1], v[2]);
    file.variableLines.set(v[1], n);
    kinds[n] = 'variable';
    return true;
  };

  // ----- preamble: comments, meta, variables, pre-request scripts -----
  for (; i <= end; i++) {
    const line = lines[i];
    if (!line.trim()) {
      kinds[i] = 'blank';
      continue;
    }
    const meta = META.exec(line);
    if (meta) {
      kinds[i] = 'meta';
      const key = meta[1].toLowerCase();
      const value = meta[2].trim();
      const s = block.settings;
      if (key === 'name' && value) block.name = value.split(/\s+/)[0];
      else if (key === 'note') s.note = true;
      else if (key === 'no-redirect') s.noRedirect = true;
      else if (key === 'no-cookie-jar') s.noCookieJar = true;
      else if (key === 'no-log') s.noLog = true;
      else if (key === 'timeout') s.timeout = parseDuration(value);
      else if (key === 'connection-timeout') s.connectionTimeout = parseDuration(value);
      else if (key === 'prompt' && value) {
        const [, name, desc] = /^(\S+)\s*(.*)$/.exec(value)!;
        s.prompts.push({ name, description: desc.trim() || undefined });
      } else kinds[i] = 'comment';
      continue;
    }
    if (COMMENT.test(line)) {
      kinds[i] = 'comment';
      continue;
    }
    if (variable(line, i)) continue;
    if (isScriptStart(line)) {
      const { ref, end: last } = readScript(lines, i, line.replace(/^</, ''));
      block.preRequestScripts.push({ ...ref, line: i });
      for (let j = i; j <= last; j++) kinds[j] = 'script';
      i = last;
      continue;
    }
    break;
  }
  if (i > end) return block;

  // ----- request line -----
  block.requestLine = i;
  const first = lines[i].trim();
  if (/^curl(\s|$)/.test(first)) {
    block.kind = 'curl';
    const cmd = [lines[i]];
    kinds[i] = 'curl';
    while (/\\\s*$/.test(lines[i]) && i < end) {
      i++;
      cmd.push(lines[i]);
      kinds[i] = 'curl';
    }
    block.curl = cmd.join('\n');
    block.method = /(?:^|\s)(?:-X|--request)\s+(\w+)/.exec(block.curl)?.[1] ?? 'GET';
    block.url = /(https?:\/\/\S+|\{\{[^}]+\}\}\S*)/.exec(block.curl)?.[1]?.replace(/['"]$/, '') ?? '';
    i++;
  } else {
    block.kind = 'http';
    const m = REQUEST_LINE.exec(first) ?? URL_ONLY_LINE.exec(first);
    if (m && m.length === 4) {
      block.method = m[1];
      block.url = m[2];
      block.httpVersion = m[3];
    } else if (m) {
      block.url = m[1];
      block.httpVersion = m[2];
    } else block.url = first;
    kinds[i] = 'request';
    i++;
    // multi-line query string
    while (i <= end && /^\s+[?&]/.test(lines[i])) {
      block.url += lines[i].trim();
      kinds[i] = 'request';
      i++;
    }
    // headers
    for (; i <= end; i++) {
      const line = lines[i];
      if (!line.trim()) break;
      if (COMMENT.test(line)) {
        kinds[i] = 'comment';
        continue;
      }
      if (isHandlerStart(line) || OUTPUT.test(line)) break;
      const h = HEADER.exec(line);
      kinds[i] = 'header';
      if (h) block.headers.push([h[1].trim(), h[2].trim()]);
    }
    // body
    const bodyLines: number[] = [];
    for (; i <= end; i++) {
      const line = lines[i];
      if (isHandlerStart(line) || OUTPUT.test(line)) break;
      if (!line.trim()) kinds[i] = 'blank';
      else {
        kinds[i] = 'body';
        bodyLines.push(i);
      }
    }
    if (bodyLines.length) {
      const from = bodyLines[0];
      const to = bodyLines[bodyLines.length - 1];
      block.body = lines.slice(from, to + 1).join('\n');
      block.bodyLine = from;
      for (let j = from; j <= to; j++) kinds[j] = 'body';
      const ref = bodyLines.length === 1 ? FILE_REF.exec(lines[from].trim()) : null;
      if (ref) {
        block.bodyFile = ref[3];
        block.bodyFileProcessVariables = !!ref[1];
        block.bodyFileEncoding = ref[2] || undefined;
        block.body = '';
      }
    }
  }

  // ----- response handlers, output redirects, trailing comments -----
  for (; i <= end; i++) {
    const line = lines[i];
    if (!line.trim()) {
      kinds[i] = 'blank';
      continue;
    }
    const out = OUTPUT.exec(line);
    if (out) {
      block.outputFile = { path: out[2], overwrite: !!out[1] };
      kinds[i] = 'output';
      continue;
    }
    if (isHandlerStart(line)) {
      const { ref, end: last } = readScript(lines, i, line.replace(/^>/, ''));
      block.responseHandlers.push({ ...ref, line: i });
      for (let j = i; j <= last; j++) kinds[j] = 'script';
      i = last;
      continue;
    }
    if (variable(line, i)) continue;
    kinds[i] = 'comment';
  }

  if (!block.title) block.title = block.name ?? `${block.method} ${block.url}`.trim();
  return block;
}

export function parseHttpFile(text: string): ParsedFile {
  const lines = text.split(/\r?\n/);
  const file: ParsedFile = {
    lines,
    lineKinds: lines.map(() => 'blank' as LineKind),
    blocks: [],
    variables: new Map(),
    variableLines: new Map(),
  };
  const starts = [0];
  lines.forEach((l, i) => {
    if (i > 0 && SEPARATOR.test(l)) starts.push(i);
  });
  starts.forEach((start, n) => {
    const end = (starts[n + 1] ?? lines.length) - 1;
    file.blocks.push(parseBlock(lines, file.lineKinds, start, end, n, file));
  });
  return file;
}

/** The block that contains the given (0-based) line. */
export function blockAtLine(file: ParsedFile, line: number): HttpBlock | undefined {
  return file.blocks.find((b) => line >= b.startLine && line <= b.endLine);
}
