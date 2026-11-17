# REST Workbench for VS Code

## Preface

This extension has been created using Claude Code because the Rest Client extension i used caused crashes of VS Code 
on my Mac. Other than the Rest Client extension (which i quite like) it supports the full Jetbrains specification, i.e. it
allows to specify tests after the curl call.

Feel free to use, i will not give any warranty or support!

## What it does

Run the requests in `.http` / `.rest` files with **curl**, right in VS Code. The extension supports
the syntax of the **VS Code REST Client** extension and of the **JetBrains HTTP Client**
specification. A response panel next to the editor shows:

- the curl command for the request, which you can edit and run again,
- the status, time and size,
- tabs for Body, Headers, Raw, Tests and Log.

## Quick tour

| Action                                 | How                                                      |
| -------------------------------------- | -------------------------------------------------------- |
| Send the request at the cursor         | ⌘↵ / Ctrl+Enter, the ▶ *Send Request* CodeLens, or the editor toolbar |
| Run all requests in the file           | ⇧⌘↵ / Ctrl+Shift+Enter, or the *Run All* CodeLens on line 1 |
| Switch environment                     | ⌥⌘E / Ctrl+Alt+E, or the environment in the status bar   |
| Request history (send again)           | ⌥⌘H / Ctrl+Alt+H                                        |
| Cancel a request                       | ⌘. / Ctrl+., or click the spinner in the status bar      |
| Copy a request as curl                 | *Copy as curl* CodeLens                                  |
| Show the value of a variable           | hover over `{{…}}`; F12 jumps to its definition          |
| Save the response                      | *Save body* / *Save response* in the panel               |
| Open the file in the desktop app       | editor toolbar                                           |

Unknown variables and missing files are underlined as warnings. Typing `{{` suggests variables,
and headers are suggested in the header section. Test results and `client.log` output appear in
the *Tests* tab and in the *REST Workbench* output channel.

## Syntax reference

```http
@baseUrl = {{host}}/api            # file variable (may use other variables)

### login                          # ### separates requests; the text is the title
# @name login                      # request name -> response can be referenced
# @prompt password Your password   # asked before sending (masked for password/token/secret)
# @note                            # confirm before sending
# @no-redirect                     # don't follow redirects (default: follow)
# @no-cookie-jar                   # don't send/store cookies (default: cookie jar on)
# @no-log                          # not stored in the request history
# @timeout 10                      # seconds (also 500ms, 2m); @connection-timeout 2
< {% request.variables.set("reqId", $random.uuid()) %}       # pre-request script
POST {{baseUrl}}/login HTTP/1.1    # METHOD URL [HTTP/1.0|1.1|2|3]; method optional (GET)
    ?lang=de                       # multi-line query string
    &verbose=true
Content-Type: application/json
X-Request-Id: {{reqId}}

{ "user": "{{user}}", "password": "{{password}}" }

> {%                               # response handler (JavaScript)
  client.test("ok", () => client.assert(response.status === 200, "status " + response.status));
  client.global.set("token", response.body.token);   # -> {{token}} in later requests
  client.log(response.headers.valueOf("Content-Type"));
%}
>> ./responses/login.json          # save the response body (>>! overwrites)

### use values of the login
GET {{baseUrl}}/me
Authorization: Bearer {{token}}
X-Token-Again: {{login.response.body.$.token}}        # JSONPath: $.a.b[0], $..x, [?(@.p > 8)], [-1], [0:2]
X-Location: {{login.response.headers.Location}}
X-Original-Id: {{login.request.headers.X-Request-Id}} # the request is stored as well

### XML responses use XPath
GET {{baseUrl}}/user.xml
X-Name: {{xmlRequest.response.body.//name}}

### origin-form with Host header
GET /api/status
Host: localhost:8080

### bodies
POST {{baseUrl}}/upload
Content-Type: application/json

< ./payload.json                   # file as is;  <@ ./file  = with {{variables}};  <@latin1 ./file = encoding

### form (lines are joined)
POST {{baseUrl}}/form
Content-Type: application/x-www-form-urlencoded

name=foo
&age=20

### multipart (sent with CRLF line endings, files included)
POST {{baseUrl}}/files
Content-Type: multipart/form-data; boundary=XYZ

--XYZ
Content-Disposition: form-data; name="file"; filename="a.png"
Content-Type: image/png

< ./a.png
--XYZ--

### GraphQL: query, blank line, variables
POST {{baseUrl}}/graphql
X-Request-Type: GraphQL

query User($id: ID!) { user(id: $id) { name } }

{ "id": "42" }

### authentication helpers
GET {{baseUrl}}/basic
Authorization: Basic {{user}}:{{password}}           # base64-encoded automatically (also "Basic user pass")
# Authorization: Digest user password                # curl --digest
# Authorization: AWS <id> <secret> [token:<t>] [region:<r>] [service:<s>]   # AWS Signature v4

### plain curl
curl {{baseUrl}}/health -H 'Accept: application/json'
```

**System variables:**

| Variable | Value |
| --- | --- |
| `{{$guid}}`, `{{$uuid}}`, `{{$random.uuid}}` | random UUID |
| `{{$randomInt 1 100}}`, `{{$random.integer(1, 100)}}`, `{{$random.float(0, 1)}}` | random number |
| `{{$random.alphabetic(8)}}`, `{{$random.alphanumeric(8)}}`, `{{$random.hexadecimal(8)}}`, `{{$random.email}}` | random text |
| `{{$timestamp}}`, `{{$timestamp -1 d}}`, `{{$isoTimestamp}}` | current time |
| `{{$datetime iso8601}}`, `{{$datetime rfc1123}}`, `{{$datetime "DD.MM.YYYY" 1 w}}` | UTC date; offset units `y M w d h m s ms` |
| `{{$localDatetime …}}` | same as `$datetime`, in local time |
| `{{$processEnv HOME}}`, `{{$processEnv %envVarName}}` | environment variable of the VS Code process |
| `{{$dotenv API_KEY}}` | from the `.env` file next to the `.http` file |
| `{{$shared.version}}` | `$shared` environment |

**Environments** come from two kinds of source:

- `http-client.env.json` and `http-client.private.env.json` (JetBrains format) next to the `.http`
  file, or in a parent folder up to the workspace root.
- The settings `rest-client.environmentVariables` and `restWorkbench.environmentVariables`.

```json
{ "$shared": { "version": "v1" },
  "local":   { "host": "http://localhost:8080", "user": "alice" },
  "prod":    { "host": "https://api.example.com" } }
```

If a name is defined in several places, the first match in this list wins: prompt values and
pre-request variables, system variables, request variables, script globals, file variables, the
selected environment, then `$shared`.

**Scripts:** response handlers and pre-request scripts follow the JetBrains API:

- `client.test`, `client.assert`, `client.log`, `client.exit`
- `client.global.set/get/clear/clearAll/isEmpty`
- `response.status`, `response.body` (parsed if JSON), `response.headers.valueOf/valuesOf`,
  `response.contentType.mimeType/charset`
- `request.variables.set/get`, `request.environment.get`

They run in a separate `node:vm` context with a 5 s timeout. That context is not a security
sandbox, so only run `.http` files you trust.

### Not supported

- `{{$aadToken}}`, `{{$aadV2Token}}` and `{{$oidcAccessToken}}` (Azure AD / OIDC sign-in flows).
  They are underlined as warnings.
- JetBrains *asynchronous* scripts and WebSocket/gRPC requests.

## Settings

| Setting | Default | |
| --- | --- | --- |
| `restWorkbench.environmentVariables` | `{}` | environments (`rest-client.environmentVariables` is read too) |
| `restWorkbench.timeoutSeconds` | `60` | default `--max-time` |
| `restWorkbench.followRedirects` | `true` | `-L` (falls back to `rest-client.followredirect`) |
| `restWorkbench.rememberCookies` | `true` | cookie jar (falls back to `rest-client.rememberCookiesForSubsequentRequests`) |
| `restWorkbench.defaultHeaders` | `{}` | added unless the request sets the header (merged with `rest-client.defaultHeaders`) |
| `restWorkbench.certificates` | `{}` | client certificates per `host[:port]` (`cert`/`key`/`pfx`/`passphrase`; merged with `rest-client.certificates`) |
| `restWorkbench.allowInsecureTLS` | `false` | `curl -k` |
| `restWorkbench.curlPath` | `curl` | curl executable |
| `restWorkbench.appPath` | (empty) | desktop app for *Open in REST Workbench App* |

The VS Code setting `http.proxy` is passed to curl as `-x`.

## Build, test, install

```bash
npm install
npm test             # type-check, bundle, and run an integration test (18 request types) in a downloaded VS Code
npm run package      # -> rest-workbench-<version>.vsix
code --install-extension rest-workbench-1.1.0.vsix --force
```

Requirements: Node.js 20+ and `curl` on the `PATH`. The `code` command must be installed
(VS Code: *Shell Command: Install 'code' command in PATH*).

## Coexistence with the REST Client extension

Both extensions use the language id `http`. If both are enabled, each shows its own CodeLens above
a request. ⌘↵ sends the request with REST Workbench, and REST Client keeps its own shortcut
Ctrl+Alt+R.
