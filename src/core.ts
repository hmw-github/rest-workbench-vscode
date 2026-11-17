/**
 * .http parsing, curl command handling and execution, HTML helpers.
 */
export { parseHttpFile, blockAtLine, type HttpBlock, type ParsedFile, type ScriptRef } from './shared/httpParser.js';
export { formatCurl, parseCurlCommand, runCurl, type CurlProcess, type CurlResult } from './shared/curl.js';
export { escapeHtml, highlightJson } from './shared/highlight.js';
