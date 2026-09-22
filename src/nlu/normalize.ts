/** Text normalisation shared by the deterministic extractors and the lexical fallback. */

const DEVANAGARI_DIGITS = '०१२३४५६७८९';

function asciiDigits(s: string): string {
  return s.replace(/[\u0966-\u096F]/g, (d) => String(DEVANAGARI_DIGITS.indexOf(d)));
}

/** NFKC, strip zero-width chars, Devanagari digits → ASCII, collapse whitespace. Case preserved. */
export function cleanText(s: string): string {
  return asciiDigits(s.normalize('NFKC'))
    .replace(/[\u200B-\u200D\uFEFF]/g, '')
    .replace(/[ \t]+/g, ' ')
    .trim();
}

/** Lower-cased, punctuation-light form for lexical matching. Collapses "nahiii" → "nahi". */
export function lexicalForm(s: string): string {
  return cleanText(s)
    .toLowerCase()
    .replace(/([a-z])\1{2,}/g, '$1')
    .replace(/[“”"'`’]/g, '')
    .replace(/[!?.,;:]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const HINGLISH_MARKERS = /^(hai|hain|h|nahi|nhi|nahin|nai|kya|kyu|kyon|kab|kaise|kitna|kitne|mera|meri|mere|mujhe|hum|humara|aap|aapka|bhai|ji|karo|kar|kardo|kiya|kia|dijiye|bhej|bhejo|bheja|bhejta|aaya|aya|aaye|mila|mili|paisa|paise|abhi|tak|wala|wali|wale|upar|neeche|niche|haan|han|thik|theek|ho|hoga|gaya|gya|gayi|raha|rha|rahi|kal|aaj|koi|kuch|dekho|dekh|batao|bata|ka|ki|ke|ko|se|me|mein|hoon|hu|hun|baad|pehle|jaldi|sahi|galat|kab|yeh|ye|wo|woh|isme|iska|uska|lekin|par|aur|bhi|toh|to)$/;
const ENGLISH_MARKERS = /^(the|is|are|am|was|were|my|your|i|you|it|this|that|not|didn't|did|has|have|had|please|why|when|what|where|how|received|yet|can|could|will|would|of|to|and|for|with|from|still|money|account)$/;

/** Undefined when the text carries no clear language signal (IDs, numbers, "ok", "withdrawal status"). */
export function detectLanguage(s: string): 'hindi' | 'english' | 'hinglish' | undefined {
  const t = s.trim();
  if (!t) return undefined;
  const deva = (t.match(/[\u0900-\u097F]/g) ?? []).length;
  const latin = (t.match(/[A-Za-z]/g) ?? []).length;
  if (deva > latin) return 'hindi';
  const words = lexicalForm(t).split(' ');
  const hi = words.filter((w) => HINGLISH_MARKERS.test(w)).length;
  const en = words.filter((w) => ENGLISH_MARKERS.test(w)).length;
  if (hi >= 1 && hi >= en) return 'hinglish';
  if (en >= 2) return 'english';
  return undefined;
}
