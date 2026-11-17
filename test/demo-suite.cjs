// Runs ../demo/demo.http against a running ACME server (port DEMO_PORT).
// @prompt / @note need user interaction, so they are replaced in a copy of the file.
const vscode = require('vscode');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

exports.run = async function () {
  const src = path.resolve(__dirname, '../demo');
  const dir = process.env.TEST_WORKSPACE;
  for (const f of ['http-client.env.json', 'http-client.private.env.json', 'demo-data', 'demo-scripts']) {
    fs.cpSync(path.join(src, f), path.join(dir, f), { recursive: true });
  }
  fs.writeFileSync(path.join(dir, '.env'), `PORT=${process.env.DEMO_PORT}\n`);
  const text = fs
    .readFileSync(path.join(src, 'demo.http'), 'utf8')
    .replace('# @prompt email E-mail address of the user to look up', '@email = user@mail.com')
    .replace(/^# @note$/m, '# (note removed for test)');
  const file = path.join(dir, 'demo.http');
  fs.writeFileSync(file, text);

  const uri = vscode.Uri.file(file);
  await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(uri));
  const api = await vscode.extensions.getExtension('hmw-github.rest-workbench').activate();
  await api.selectEnvironment('local');

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
  assert.ok(fs.statSync(path.join(dir, 'demo-output', 'image.png')).size > 1000);
  assert.ok(JSON.parse(fs.readFileSync(path.join(dir, 'demo-output', 'latest-invoices.json'), 'utf8')).length === 5);
};
