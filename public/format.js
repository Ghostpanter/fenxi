(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.FenxiFormat = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  function escapeHtml(value) {
    return String(value).replace(/[&<>"']/g, (ch) => {
      switch (ch) {
        case '&': return '\u0026amp;';
        case '<': return '\u0026lt;';
        case '>': return '\u0026gt;';
        case '"': return '\u0026quot;';
        default: return '\u0026#39;';
      }
    });
  }

  function safeImageUrl(url) {
    try {
      const u = new URL(url);
      if (u.protocol !== 'https:') return null;
      return u.href;
    } catch {
      return null;
    }
  }

  function renderMessage(text) {
    const src = String(text || '').replace(/\u0000/g, '');
    const fences = [];
    const withoutFences = src.replace(/```([\w-]*)\n?([\s\S]*?)```/g, (_, _lang, code) => {
      const index = fences.length;
      fences.push(code.replace(/\n$/, ''));
      return `\u0000F${index}\u0000`;
    });
    const codes = [];
    let html = escapeHtml(withoutFences).replace(/`([^`\n]+)`/g, (_, code) => {
      const index = codes.length;
      codes.push(code);
      return `\u0001C${index}\u0001`;
    });
    html = html.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
    html = html.replace(/(https?:\/\/[^\s<]+)/g, (url) => {
      const clean = url.replace(/[),.;!?，。；！]+$/g, '');
      const trail = url.slice(clean.length);
      return `<a href="${clean}" target="_blank" rel="noreferrer noopener">${clean}</a>${trail}`;
    });
    html = html.replace(/\n/g, '<br>');
    html = html.replace(/\u0001C(\d+)\u0001/g, (_, index) => `<code>${codes[Number(index)]}</code>`);
    html = html.replace(/\u0000F(\d+)\u0000/g, (_, index) => `<pre><code>${escapeHtml(fences[Number(index)])}</code></pre>`);
    return html;
  }

  return { escapeHtml, safeImageUrl, renderMessage };
});
