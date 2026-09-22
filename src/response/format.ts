/**
 * Telegram presentation. Replies are plain text everywhere else; this is the only place that adds
 * markup, so nothing can smuggle HTML into a message. The text is escaped first, then:
 *  - `**title**` written by a template becomes bold
 *  - verified facts are highlighted: amounts bold; IDs, UTRs and masked accounts in monospace
 */
const escapeHtml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

const looksLikeId = (v: string) => /^[A-Z0-9][A-Z0-9/-]{5,}$/i.test(v) && /\d/.test(v) && /[A-Za-z-]/.test(v);
const looksLikeMaskedAccount = (v: string) => /^X{2,}\d{3,}$/i.test(v);
/** UTR / bank reference numbers. Amounts are never this long, and only facts are ever matched. */
const looksLikeReference = (v: string) => /^\d{10,22}$/.test(v);

/** Escape, then mark up titles, amounts, identifiers and masked accounts. */
export function toTelegramHtml(text: string, facts: string[] = []): string {
  let out = escapeHtml(text);
  const marked: string[] = [];
  const tokens = [...new Set(facts.filter((f) => looksLikeId(f) || looksLikeMaskedAccount(f) || looksLikeReference(f)))].sort((a, b) => b.length - a.length);
  for (const token of tokens) {
    // Skip anything already inside a <code> block (a shorter id contained in a longer one).
    if (marked.some((m) => m.includes(token))) continue;
    const safe = escapeHtml(token);
    if (!out.includes(safe)) continue;
    out = out.split(safe).join(`<code>${safe}</code>`);
    marked.push(token);
  }
  out = out.replace(/\*\*(.+?)\*\*/g, '<b>$1</b>');
  // Amounts in bold, except where they already sit inside bold text.
  return out
    .split(/(<b>.*?<\/b>)/)
    .map((part) => (part.startsWith('<b>') ? part : part.replace(/₹[\d,]+(?:\.\d{1,2})?/g, (m) => `<b>${m}</b>`)))
    .join('');
}

/** Plain text of a formatted message (logs, tests, stored history). */
export const stripHtml = (s: string) => s.replace(/<\/?(b|i|u|code|pre)>/g, '');

/** A template's text without its `**bold**` markers: what the customer reads. */
export const plainText = (s: string) => s.replace(/\*\*(.+?)\*\*/g, '$1');
