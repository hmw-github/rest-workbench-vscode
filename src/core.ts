/**
 * Logic shared with the REST Workbench desktop app (../rest-workbench). esbuild bundles these
 * files into the extension, so the .http parsing, {{variable}} resolution and curl execution
 * behave exactly like in the app.
 */
export { parseHttpFile, blockAtLine, type HttpBlock, type ParsedFile } from '../../rest-workbench/src/renderer/httpParser.js';
export { VariableResolver, type StoredResponse, type VarState } from '../../rest-workbench/src/renderer/variables.js';
export { buildCurlArgs, formatCurl, parseCurlCommand } from '../../rest-workbench/src/renderer/curl.js';
export { escapeHtml, highlightJson } from '../../rest-workbench/src/renderer/highlight.js';
export { runCurl, type CurlProcess } from '../../rest-workbench/src/main/curl.js';
export type { CurlResult } from '../../rest-workbench/src/shared/types.js';
