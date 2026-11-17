// Webview script of the "Response" panel. Talks to the extension via postMessage.
// @ts-check
(function () {
  // @ts-ignore - provided by VS Code
  const vscode = acquireVsCodeApi();
  const $ = (id) => /** @type {HTMLElement} */ (document.getElementById(id));

  const curlBox = /** @type {HTMLTextAreaElement} */ ($('curlBox'));
  const runBtn = /** @type {HTMLButtonElement} */ ($('run'));
  const cancelBtn = $('cancel');
  const status = $('status');
  const warn = $('warn');

  const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const formatBytes = (n) => (n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1048576).toFixed(2)} MB`);

  function showWarning(text) {
    warn.hidden = !text;
    warn.textContent = text || '';
  }

  function selectTab(tab) {
    document.querySelectorAll('#tabs button').forEach((b) => b.classList.toggle('active', /** @type {HTMLElement} */ (b).dataset.tab === tab));
    document.querySelectorAll('.pane').forEach((p) => p.classList.toggle('active', p.id === `tab-${tab}`));
    vscode.setState({ ...(vscode.getState() || {}), tab });
  }

  function setRunning(running) {
    runBtn.disabled = running;
    cancelBtn.hidden = !running;
    if (running) status.innerHTML = '<span class="spinner"></span><span>Sending…</span>';
  }

  function renderResult(m) {
    setRunning(false);
    const s = m.summary;
    const badge = s.status
      ? `<span class="badge s${String(s.status)[0]}">${s.status} ${esc(s.statusText || '')}</span>`
      : `<span class="badge err">${s.cancelled ? 'Cancelled' : 'Error'}</span>`;
    const info = [`${s.timeMs} ms`, formatBytes(s.sizeBytes)];
    if (s.contentType) info.push(esc(s.contentType));
    status.innerHTML =
      `${badge}<span>${info.join(' · ')}</span>` +
      (m.storedAs ? `<span class="stored" title="usable as {{${esc(m.storedAs)}.response.body.…}}">stored as @${esc(m.storedAs)}</span>` : '') +
      (m.tests.length
        ? `<span class="${m.tests.every((t) => t.passed) ? 'pass' : 'fail'}">tests ${m.tests.filter((t) => t.passed).length}/${m.tests.length}</span>`
        : '') +
      (m.scriptErrors.length ? '<span class="fail">script error</span>' : '') +
      (m.savedTo ? `<span class="muted" title="${esc(m.savedTo)}">saved to ${esc(m.savedTo.split(/[\\/]/).pop())}</span>` : '');

    const body = $('tab-body');
    body.innerHTML = !s.status && s.error ? `<span class="error">${esc(s.error)}</span>` : m.bodyHtml;
    if (m.image) {
      const img = document.createElement('img');
      img.src = m.image;
      img.className = 'preview';
      body.appendChild(img);
    }
    $('tab-headers').innerHTML = m.headers.length
      ? `<table class="kv"><tbody>${m.headers.map(([k, v]) => `<tr><th>${esc(k)}</th><td>${esc(v)}</td></tr>`).join('')}</tbody></table>`
      : '<span class="muted">(no headers)</span>';
    $('tab-raw').textContent = m.raw;
    $('tab-log').textContent = m.log;

    // tests, script logs and errors
    const parts = [];
    if (m.tests.length) {
      parts.push(
        '<ul class="tests">' +
          m.tests
            .map((t) => `<li class="${t.passed ? 'pass' : 'fail'}">${t.passed ? '✓' : '✗'} ${esc(t.name)}${t.error ? `<div class="detail">${esc(t.error)}</div>` : ''}</li>`)
            .join('') +
          '</ul>',
      );
    }
    for (const e of m.scriptErrors) parts.push(`<div class="fail">✗ ${esc(e)}</div>`);
    if (m.logs.length) parts.push(`<div class="label">client.log</div><pre>${m.logs.map(esc).join('\n')}</pre>`);
    $('tab-tests').innerHTML = parts.join('') || '<span class="muted">No response handler for this request. Add one after the request, e.g.<pre>&gt; {%\n  client.test("status 200", () =&gt; client.assert(response.status === 200));\n%}</pre></span>';
    $('testsTab').textContent = m.tests.length ? `Tests (${m.tests.filter((t) => t.passed).length}/${m.tests.length})` : 'Tests';
    if (m.scriptErrors.length || m.tests.some((t) => !t.passed)) selectTab('tests');
  }

  window.addEventListener('message', (e) => {
    const m = e.data;
    switch (m.type) {
      case 'request':
        curlBox.value = m.curl;
        $('hint').textContent = `from “${m.title}” – editable, runs exactly what you see`;
        showWarning(m.missing.length ? `Unresolved: ${m.missing.map((x) => `{{${x}}}`).join(', ')}` : '');
        break;
      case 'running':
        setRunning(true);
        break;
      case 'error':
        setRunning(false);
        showWarning(m.message);
        break;
      case 'result':
        renderResult(m);
        break;
    }
  });

  runBtn.addEventListener('click', () => {
    showWarning('');
    vscode.postMessage({ type: 'run', text: curlBox.value });
  });
  cancelBtn.addEventListener('click', () => vscode.postMessage({ type: 'cancel' }));
  $('copyCurl').addEventListener('click', () => vscode.postMessage({ type: 'copy', text: curlBox.value }));
  $('copyBody').addEventListener('click', () => vscode.postMessage({ type: 'copyBody' }));
  $('saveBody').addEventListener('click', () => vscode.postMessage({ type: 'saveBody' }));
  $('saveResponse').addEventListener('click', () => vscode.postMessage({ type: 'saveResponse' }));
  curlBox.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      runBtn.click();
    }
  });
  document.querySelectorAll('#tabs button').forEach((b) =>
    b.addEventListener('click', () => selectTab(/** @type {HTMLElement} */ (b).dataset.tab)),
  );

  const saved = vscode.getState();
  if (saved && saved.tab) selectTab(saved.tab);
  vscode.postMessage({ type: 'ready' });
})();
