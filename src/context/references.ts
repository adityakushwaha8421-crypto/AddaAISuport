import { lexicalForm } from '../nlu/normalize.js';

/**
 * Ordinal / deictic references to items shown in a screenshot or listed by the bot.
 * These are a closed class of expressions, so they are parsed deterministically; the LLM can also
 * emit a reference, and both go through the same resolver.
 */
export type OrdinalRef =
  | { kind: 'index'; index: number } // 1-based from the top
  | { kind: 'last'; strict: boolean } // strict=false for "neeche wala" (only unambiguous with 2 items)
  | { kind: 'this' }; // "ye wala", "isi ka" → whatever the reply/current context points at

const WORD_INDEX: Array<[RegExp, number]> = [
  [/\b(sabse\s+)?(upar|upper|uppar|uper|oopar|top|first|1st|pehla|pehle|pahla|pahle|pehli|pahli)\b|ऊपर|पहला|पहले/, 1],
  [/\b(second|2nd|doosra|dusra|dusre|doosre|dusri|doosri)\b|दूसरा|दूसरे/, 2],
  [/\b(third|3rd|teesra|tisra|teesre|tisre|teesri)\b|तीसरा/, 3],
  [/\b(fourth|4th|chautha|chotha)\b|चौथा/, 4],
  [/\b(fifth|5th|panchva|paanchva)\b/, 5],
];

const LAST_STRICT = /\b(last|bottom|aakhri|akhri|aakhiri|sabse\s+(neeche|niche|nichey))\b|आखिरी|सबसे नीचे/;
const LAST_LOOSE = /\b(neeche|niche|nichey|neche|nichla|nichle|lower|below)\b|नीचे/;
const THIS = /\b(ye|yeh|yahi|ya|is|isi|iska|iski|iske|isme|wo|woh|vo|wahi|uska|uski|us|that|this|same)\s*(wala|wali|wale|vala|vali|one|ka|ki|ke|me|mein|transaction|withdrawal|payment)?\b|यह वाला|ये वाला|इसका|वही/;
const NUMBERED = /(?:\b(?:number|no\.?|#)\s*(\d)\b|\b(\d)\s*(?:wala|wali|vala|number\s*wala|st|nd|rd|th)\b)/;

/** Only treat as a reference when the message is short / reference-like (avoids "top up karna hai"). */
export function parseOrdinalReference(text: string): OrdinalRef | undefined {
  const t = lexicalForm(text);
  if (!t) return undefined;
  const words = t.split(' ').length;
  const referential = /\b(wala|wali|wale|vala|vali|one|transaction|withdrawal|entry|row|item)\b|वाला|वाली/.test(t) || words <= 3;
  if (!referential) return undefined;
  if (/\btop\s*up\b/.test(t)) return undefined;

  const numbered = t.match(NUMBERED);
  if (numbered) {
    const n = Number(numbered[1] ?? numbered[2]);
    if (n >= 1 && n <= 9) return { kind: 'index', index: n };
  }
  if (LAST_STRICT.test(t)) return { kind: 'last', strict: true };
  for (const [re, idx] of WORD_INDEX) if (re.test(t)) return { kind: 'index', index: idx };
  if (LAST_LOOSE.test(t)) return { kind: 'last', strict: false };
  if (THIS.test(t) && words <= 6) return { kind: 'this' };
  return undefined;
}

export type ResolveOutcome<T> =
  | { status: 'resolved'; item: T; position: number }
  | { status: 'ambiguous'; reason: string }
  | { status: 'out_of_range' }
  | { status: 'no_candidates' };

/** Resolve an ordinal reference against items in visual order (position 1 = top). */
export function resolveReference<T extends { position: number }>(ref: OrdinalRef, items: T[]): ResolveOutcome<T> {
  if (!items.length) return { status: 'no_candidates' };
  const sorted = [...items].sort((a, b) => a.position - b.position);
  switch (ref.kind) {
    case 'index': {
      const item = sorted[ref.index - 1];
      return item ? { status: 'resolved', item, position: ref.index } : { status: 'out_of_range' };
    }
    case 'last': {
      if (!ref.strict && sorted.length > 2) return { status: 'ambiguous', reason: '"neeche" with more than two rows' };
      const item = sorted[sorted.length - 1]!;
      return { status: 'resolved', item, position: sorted.length };
    }
    case 'this':
      if (sorted.length === 1) return { status: 'resolved', item: sorted[0]!, position: 1 };
      return { status: 'ambiguous', reason: '"ye wala" with several rows and no narrower context' };
  }
}
