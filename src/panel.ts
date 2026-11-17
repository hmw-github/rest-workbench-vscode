import * as vscode from 'vscode';

/** Messages from the webview to the extension. */
export type PanelMessage =
  | { type: 'ready' }
  | { type: 'run'; text: string }
  | { type: 'cancel' }
  | { type: 'copy'; text: string }
  | { type: 'copyBody' }
  | { type: 'saveBody' }
  | { type: 'saveResponse' };

/** Messages from the extension to the webview. */
export type PanelUpdate =
  | { type: 'request'; title: string; curl: string; missing: string[] }
  | { type: 'running' }
  | { type: 'error'; message: string }
  | {
      type: 'result';
      summary: {
        status?: number;
        statusText?: string;
        timeMs: number;
        sizeBytes: number;
        contentType?: string;
        error?: string;
        cancelled: boolean;
      };
      headers: [string, string][];
      bodyHtml: string;
      /** data: URI for image responses */
      image?: string;
      raw: string;
      log: string;
      storedAs?: string;
      savedTo?: string;
      tests: { name: string; passed: boolean; error?: string }[];
      logs: string[];
      scriptErrors: string[];
    };

/** The single "Response" webview shown beside the editor. */
export class ResponsePanel {
  private static current: ResponsePanel | undefined;
  private ready = false;
  private queue: PanelUpdate[] = [];

  static show(extensionUri: vscode.Uri, onMessage: (m: PanelMessage) => void): ResponsePanel {
    if (ResponsePanel.current) {
      if (!ResponsePanel.current.panel.visible) ResponsePanel.current.panel.reveal(vscode.ViewColumn.Beside, true);
      return ResponsePanel.current;
    }
    const panel = vscode.window.createWebviewPanel(
      'restWorkbench.response',
      'Response',
      { viewColumn: vscode.ViewColumn.Beside, preserveFocus: true },
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [vscode.Uri.joinPath(extensionUri, 'media')],
      },
    );
    ResponsePanel.current = new ResponsePanel(panel, extensionUri, onMessage);
    return ResponsePanel.current;
  }

  private constructor(
    private readonly panel: vscode.WebviewPanel,
    extensionUri: vscode.Uri,
    onMessage: (m: PanelMessage) => void,
  ) {
    panel.webview.html = this.html(extensionUri);
    panel.webview.onDidReceiveMessage((m: PanelMessage) => {
      if (m.type === 'ready') {
        this.ready = true;
        for (const u of this.queue.splice(0)) void panel.webview.postMessage(u);
      } else onMessage(m);
    });
    panel.onDidDispose(() => {
      if (ResponsePanel.current === this) ResponsePanel.current = undefined;
    });
  }

  setTitle(title: string) {
    this.panel.title = `Response: ${title}`;
  }

  post(update: PanelUpdate) {
    if (this.ready) void this.panel.webview.postMessage(update);
    else this.queue.push(update);
  }

  private html(extensionUri: vscode.Uri): string {
    const webview = this.panel.webview;
    const media = (f: string) => webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'media', f));
    const nonce = [...crypto.getRandomValues(new Uint8Array(16))].map((b) => b.toString(16).padStart(2, '0')).join('');
    return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta http-equiv="Content-Security-Policy"
        content="default-src 'none'; style-src ${webview.cspSource}; img-src data:; script-src 'nonce-${nonce}';">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <link rel="stylesheet" href="${media('panel.css')}">
  <title>Response</title>
</head>
<body>
  <section class="curl">
    <div class="bar">
      <span class="label">curl</span>
      <span id="hint" class="hint">send a request from an .http file (⌘↵ / Ctrl+Enter)</span>
      <span class="spacer"></span>
      <button id="copyCurl" class="secondary">Copy</button>
      <button id="run" title="Run the curl command as shown (⌘↵ in this box)">Run curl</button>
    </div>
    <textarea id="curlBox" spellcheck="false" wrap="off" placeholder="curl https://…"></textarea>
    <div id="warn" class="warn" hidden></div>
  </section>
  <section class="response">
    <div class="bar">
      <div id="status" class="status muted">No response yet</div>
      <span class="spacer"></span>
      <button id="cancel" class="danger" hidden>Cancel</button>
      <button id="copyBody" class="secondary">Copy body</button>
      <button id="saveBody" class="secondary" title="Save the response body to a file">Save body</button>
      <button id="saveResponse" class="secondary" title="Save headers and body to a file">Save response</button>
    </div>
    <div class="tabs" id="tabs">
      <button data-tab="body" class="active">Body</button>
      <button data-tab="headers">Headers</button>
      <button data-tab="raw">Raw</button>
      <button data-tab="tests" id="testsTab">Tests</button>
      <button data-tab="log">Log</button>
    </div>
    <div class="panes">
      <pre id="tab-body" class="pane active"></pre>
      <div id="tab-headers" class="pane"></div>
      <pre id="tab-raw" class="pane"></pre>
      <div id="tab-tests" class="pane"></div>
      <pre id="tab-log" class="pane"></pre>
    </div>
  </section>
  <script nonce="${nonce}" src="${media('panel.js')}"></script>
</body>
</html>`;
  }
}
