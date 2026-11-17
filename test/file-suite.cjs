// Runs any .http file (HTTP_FILE) with "Run All" and reports every request and test.
// TEST_PORT (optional) replaces "localhost:FROM_PORT" (default 8080) in a copy of the file, so it can run against another server.
const vscode = require('vscode');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

exports.run = async function () {
  const src = process.env.HTTP_FILE;
  assert.ok(src && fs.existsSync(src), `HTTP_FILE not found: ${src}`);
  let text = fs.readFileSync(src, 'utf8');
  if (process.env.TEST_PORT) text = text.replaceAll(`localhost:${process.env.FROM_PORT || 8080}`, `localhost:${process.env.TEST_PORT}`);
  const file = path.join(process.env.TEST_WORKSPACE, path.basename(src));
  fs.writeFileSync(file, text);

  const uri = vscode.Uri.file(file);
  await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(uri));
  const api = await vscode.extensions.getExtension('awt-lecture.rest-workbench').activate();

  await new Promise((r) => setTimeout(r, 500));
  const diags = vscode.languages.getDiagnostics(uri).map((d) => `${d.range.start.line + 1}: ${d.message}`);
  console.log('diagnostics:', diags);

  const summary = await api.sendAll(uri);
  let failures = 0;
  for (const s of summary) {
    const bad = !s.status || s.tests.some((t) => !t.passed);
    if (bad) failures++;
    console.log(`${bad ? '✗' : '✓'} ${String(s.status ?? s.error).padEnd(4)} ${s.title}`);
    for (const t of s.tests) if (!t.passed) console.log(`        ✗ ${t.name}: ${t.error}`);
  }
  const tests = summary.flatMap((s) => s.tests);
  console.log(`${summary.length} requests, ${tests.filter((t) => t.passed).length}/${tests.length} tests passed`);
  assert.equal(diags.length, 0, 'no diagnostics');
  assert.equal(failures, 0, 'all requests ok');
};
