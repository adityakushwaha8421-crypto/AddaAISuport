/** Telegram HTML: everything we send is escaped, so no text can smuggle markup in. */
export const escapeHtml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
