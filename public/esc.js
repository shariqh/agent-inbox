// HTML-escapes agent-authored (attacker-influenced) text before it lands in innerHTML.
// Every one of & < > " ' matters: today every escaped value lands inside a
// double-quoted attribute or text node, but a single unescaped `'` is a landmine —
// the day someone writes `title='...'`, this silently stops protecting.
export function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))
}
