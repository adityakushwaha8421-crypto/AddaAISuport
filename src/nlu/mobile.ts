const DEVANAGARI_DIGITS = '०१२३४५६७८९';

/**
 * Indian mobile numbers a customer typed: 10 digits starting 6–9, with or without +91 / 91 / 0 in
 * front, spaces or dashes inside ("98108 22372", "+91-9810822372"), Devanagari digits too.
 * Order of appearance, no duplicates. Nothing else (order ids, amounts, dates) qualifies.
 */
export function extractMobileNumbers(text: string | undefined): string[] {
  if (!text) return [];
  const ascii = text.normalize('NFKC').replace(/[०-९]/g, (d) => String(DEVANAGARI_DIGITS.indexOf(d)));
  const found: string[] = [];
  const re = /(?<![\d])(?:\+?91[\s-]?|0)?([6-9](?:[\s-]?\d){9})(?![\d])/g;
  for (const m of ascii.matchAll(re)) {
    const digits = m[1]!.replace(/[\s-]/g, '');
    if (digits.length === 10 && !found.includes(digits)) found.push(digits);
  }
  return found;
}

/** For logs: "98xxxxxx72". */
export const maskMobile = (n: string) => (n.length >= 6 ? `${n.slice(0, 2)}${'x'.repeat(n.length - 4)}${n.slice(-2)}` : 'x'.repeat(n.length));
