// Integration test, runs inside a real VS Code instance (see test/run.mjs).
const vscode = require('vscode');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

// 1x1 PNG
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');

function startServer(seen) {
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (d) => chunks.push(d));
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8');
      const url = new URL(req.url, 'http://x');
      seen.push({ method: req.method, path: url.pathname, url: req.url, headers: req.headers, body, httpVersion: req.httpVersion });
      const json = (status, obj, extra = {}) => {
        res.writeHead(status, { 'Content-Type': 'application/json', ...extra });
        res.end(JSON.stringify(obj));
      };
      switch (url.pathname) {
        case '/login':
          return json(200, { token: 'tok-1', user: JSON.parse(body).user }, { 'Set-Cookie': 'session=abc; Path=/' });
        case '/redirect':
          res.writeHead(302, { Location: '/target' });
          return res.end();
        case '/target':
          return json(200, { reached: 'target' });
        case '/xml':
          res.writeHead(200, { 'Content-Type': 'application/xml' });
          return res.end('<user id="7"><name>Ann</name></user>');
        case '/image':
          res.writeHead(200, { 'Content-Type': 'image/png' });
          return res.end(PNG);
        case '/digest':
          if (!String(req.headers.authorization || '').startsWith('Digest ')) {
            res.writeHead(401, { 'WWW-Authenticate': 'Digest realm="test", nonce="abc123", qop="auth"' });
            return res.end();
          }
          return json(200, { digest: true });
        default:
          return json(200, { method: req.method, url: req.url });
      }
    });
  });
  return new Promise((r) => server.listen(0, () => r(server)));
}

exports.run = async function () {
  const seen = [];
  const server = await startServer(seen);
  const port = server.address().port;
  const dir = process.env.TEST_WORKSPACE;
  const find = (p, i = 0) => seen.filter((s) => s.path === p)[i];

  // ----- fixtures -----
  fs.writeFileSync(path.join(dir, 'http-client.env.json'), JSON.stringify({
    $shared: { version: 'v9' },
    local: { baseUrl: `http://localhost:${port}`, user: 'alice' },
    prod: { baseUrl: 'https://example.invalid' },
  }));
  fs.writeFileSync(path.join(dir, 'http-client.private.env.json'), JSON.stringify({ local: { password: 's3cret' } }));
  fs.writeFileSync(path.join(dir, '.env'), 'API_KEY=key-from-dotenv\n');
  fs.writeFileSync(path.join(dir, 'upload.txt'), 'file-content-123');
  fs.writeFileSync(path.join(dir, 'payload.json'), '{"who": "{{user}}"}');

  const file = path.join(dir, 'full.http');
  fs.writeFileSync(file, `@host = {{baseUrl}}

### login
# @name login
< {% request.variables.set("reqId", "r-42") %}
POST {{host}}/login
Content-Type: application/json
X-Req: {{reqId}}

{"user": "{{user}}", "password": "{{password}}"}

> {%
  client.test("status 200", () => client.assert(response.status === 200, "bad status"));
  client.test("has token", () => client.assert(response.body.token === "tok-1", "no token"));
  client.global.set("token", response.body.token);
  client.log("logged in as", response.body.user);
%}

### me (cookie, global, request variables)
GET {{host}}/me
Authorization: Bearer {{token}}
X-From-Login: {{login.response.body.$.token}}
X-Req-Header: {{login.request.headers.X-Req}}
X-Cookie-Value: {{login.response.headers.Set-Cookie}}

### basic auth
GET {{host}}/basic
Authorization: Basic {{user}}:{{password}}

### follow redirect
GET {{host}}/redirect

### no redirect
# @no-redirect
GET {{host}}/redirect

### form
POST {{host}}/form
Content-Type: application/x-www-form-urlencoded

name=foo
&age=20

### multipart
POST {{host}}/upload
Content-Type: multipart/form-data; boundary=XYZ

--XYZ
Content-Disposition: form-data; name="text"

hello {{user}}
--XYZ
Content-Disposition: form-data; name="file"; filename="upload.txt"
Content-Type: text/plain

< ./upload.txt
--XYZ--

### graphql
POST {{host}}/graphql
Content-Type: application/json
X-Request-Type: GraphQL

query GetUser($id: ID!) {
  user(id: $id) { name }
}

{ "id": "{{user}}" }

### file body with variables
POST {{host}}/filevars
Content-Type: application/json

<@ ./payload.json

### file body raw
POST {{host}}/fileraw
Content-Type: application/json

< ./payload.json

### system variables
GET {{host}}/system
X-Ts: {{$timestamp}}
X-Dt: {{$datetime "YYYY-MM-DD" 1 d}}
X-Env: {{$dotenv API_KEY}}
X-Rand: {{$random.integer(5, 6)}}
X-Shared: {{$shared.version}}
X-Guid: {{$guid}}

### xml
# @name xml
GET {{host}}/xml

### xpath
GET {{host}}/xpath
X-Name: {{xml.response.body.//name}}
X-Id: {{xml.response.body./user/@id}}

### image to file
GET {{host}}/image

>> ./out/image.png

### origin form + Host header, multi-line query, HTTP version
GET /origin
    ?a=1
    &b=two words
Host: localhost:${port}

### http version
GET {{host}}/v11 HTTP/1.1

### digest
GET {{host}}/digest
Authorization: Digest {{user}} {{password}}

### failing test
GET {{host}}/fail

> {% client.test("expects 201", () => client.assert(response.status === 201, "status was " + response.status)); %}
`);

  const uri = vscode.Uri.file(file);
  const doc = await vscode.workspace.openTextDocument(uri);
  await vscode.window.showTextDocument(doc);
  const api = await vscode.extensions.getExtension('awt-lecture.rest-workbench').activate();
  await api.selectEnvironment('local');

  // hover: environment variable
  const hoverText = async (line, needle) => {
    const col = doc.lineAt(line).text.indexOf(needle) + 2;
    const hs = await vscode.commands.executeCommand('vscode.executeHoverProvider', uri, new vscode.Position(line, col));
    return hs.flatMap((h) => h.contents.map((c) => c.value ?? String(c))).join('\n');
  };
  const loginLine = doc.getText().split('\n').findIndex((l) => l.startsWith('POST {{host}}/login'));
  const h1 = await hoverText(loginLine, '{{host}}');
  console.log('hover host:', h1.replace(/\n/g, ' '));
  assert.match(h1, new RegExp(`localhost:${port}`));

  // completion offers env + system variables
  const cl = await vscode.commands.executeCommand('vscode.executeCompletionItemProvider', uri, new vscode.Position(loginLine, 'POST {{'.length));
  const labels = cl.items.map((i) => (typeof i.label === 'string' ? i.label : i.label.label));
  assert.ok(labels.includes('baseUrl') && labels.includes('$guid') && labels.includes('login.response.body.$'), 'completions');

  // definition of {{host}}
  const defs = await vscode.commands.executeCommand('vscode.executeDefinitionProvider', uri, new vscode.Position(loginLine, 'POST {{h'.length));
  assert.equal(defs[0].range.start.line, 0, 'definition of host');

  // ----- run everything -----
  const summary = await api.sendAll(uri);
  for (const s of summary) console.log(`  ${s.status ?? s.error}  ${s.title}  ${s.tests.map((t) => (t.passed ? '✓' : '✗') + t.name).join(' ')}`);

  // login: pre-request script, env + private env vars, tests, global
  const login = find('/login');
  assert.equal(login.headers['x-req'], 'r-42');
  assert.deepEqual(JSON.parse(login.body), { user: 'alice', password: 's3cret' });
  assert.deepEqual(summary[0].tests.map((t) => t.passed), [true, true]);
  assert.equal(api.globals.get('token'), 'tok-1');

  // me: cookie jar, global, request variables (response + request)
  const me = find('/me');
  assert.match(String(me.headers.cookie), /session=abc/);
  assert.equal(me.headers.authorization, 'Bearer tok-1');
  assert.equal(me.headers['x-from-login'], 'tok-1');
  assert.equal(me.headers['x-req-header'], 'r-42');
  assert.match(me.headers['x-cookie-value'], /session=abc/);

  assert.equal(find('/basic').headers.authorization, 'Basic ' + Buffer.from('alice:s3cret').toString('base64'));
  assert.equal(summary[3].status, 200, 'redirect followed');
  assert.ok(find('/target'));
  assert.equal(summary[4].status, 302, '@no-redirect');
  assert.equal(find('/form').body, 'name=foo&age=20');

  const up = find('/upload').body;
  assert.ok(up.includes('hello alice\r\n'), 'multipart variables + CRLF');
  assert.ok(up.includes('file-content-123'), 'multipart file include');

  const gql = JSON.parse(find('/graphql').body);
  assert.match(gql.query, /^query GetUser/);
  assert.deepEqual(gql.variables, { id: 'alice' });
  assert.equal(gql.operationName, 'GetUser');
  assert.equal(find('/graphql').headers['x-request-type'], undefined);

  assert.deepEqual(JSON.parse(find('/filevars').body), { who: 'alice' });
  assert.equal(find('/fileraw').body, '{"who": "{{user}}"}');

  const sys = find('/system').headers;
  assert.ok(Math.abs(Number(sys['x-ts']) - Date.now() / 1000) < 60, '$timestamp');
  const tomorrow = new Date(Date.now() + 86400000).toISOString().slice(0, 10);
  assert.equal(sys['x-dt'], tomorrow, '$datetime format + offset');
  assert.equal(sys['x-env'], 'key-from-dotenv');
  assert.equal(sys['x-rand'], '5');
  assert.equal(sys['x-shared'], 'v9');
  assert.match(sys['x-guid'], /^[0-9a-f-]{36}$/);

  assert.equal(find('/xpath').headers['x-name'], 'Ann');
  assert.equal(find('/xpath').headers['x-id'], '7');

  const img = path.join(dir, 'out', 'image.png');
  assert.ok(fs.readFileSync(img).equals(PNG), 'binary output redirect');

  const origin = find('/origin');
  assert.equal(origin.url, '/origin?a=1&b=two%20words');

  assert.equal(find('/v11').httpVersion, '1.1');
  assert.equal(summary.find((s) => s.title === 'digest').status, 200, 'digest auth');
  assert.equal(find('/digest', 1).headers.authorization.startsWith('Digest username="alice"'), true);

  const failing = summary.find((s) => s.title === 'failing test');
  assert.equal(failing.tests[0].passed, false);
  assert.equal(failing.tests[0].error, 'status was 200');

  // environment switch changes resolution
  await api.selectEnvironment('prod');
  const h2 = await hoverText(loginLine, '{{host}}');
  assert.match(h2, /example\.invalid/);
  await api.selectEnvironment(undefined);
  await new Promise((r) => setTimeout(r, 700));
  const diags = vscode.languages.getDiagnostics(uri).map((d) => d.message);
  assert.ok(diags.includes('Unresolved variable {{baseUrl}}'), 'no environment -> warning');

  server.close();
  console.log(`ALL ${summary.length} REQUESTS CHECKED - TESTS PASSED`);
};
