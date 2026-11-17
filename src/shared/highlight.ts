export function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

const JSON_TOKEN = /("(?:\\.|[^"\\])*")(\s*:)?|\b(true|false|null)\b|(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)/g;

/** HTML with syntax highlighting (classes j-key, j-str, j-num, j-kw) for formatted JSON text. */
export function highlightJson(json: string): string {
  let out = '';
  let last = 0;
  for (const m of json.matchAll(JSON_TOKEN)) {
    out += escapeHtml(json.slice(last, m.index));
    const [all, str, colon, kw, num] = m;
    if (str !== undefined) out += `<span class="${colon ? 'j-key' : 'j-str'}">${escapeHtml(str)}</span>${colon ? escapeHtml(colon) : ''}`;
    else if (kw !== undefined) out += `<span class="j-kw">${kw}</span>`;
    else if (num !== undefined) out += `<span class="j-num">${num}</span>`;
    last = m.index! + all.length;
  }
  return out + escapeHtml(json.slice(last));
}
