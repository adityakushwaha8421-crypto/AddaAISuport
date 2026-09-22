import { cleanText, lexicalForm } from './normalize.js';

/**
 * PDF password handling. Passwords are extracted deterministically, redacted from the stored/LLM
 * text immediately, tried against the PDF, and then discarded. They are never logged or persisted.
 */

export const PASSWORD_PLACEHOLDER = '[PDF_PASSWORD]';

export interface PasswordExtraction {
  /** Candidates in the order they should be tried. */
  candidates: string[];
  /** True when the user explicitly labelled it ("password: X"). */
  explicit: boolean;
  /** Text safe to store and to send to the LLM. */
  redactedText: string;
  /** "skip", "password nahi hai", "no password" … */
  skip: boolean;
}

// Strong labels accept whitespace separators: "Password:- ABC", "PDF Password: ABC", "password = ABC",
// "password ABC", "The password is ABC", "password hai ABC", "पासवर्ड ABC".
const STRONG_LABEL = /(?:\bpdf\s*)?(?:\bpass\s*word\b|\bpassword\b|\bpasscode\b|पासवर्ड)\s*(?:of\s+(?:the\s+)?pdf\s*)?(?:is|hai|h|he|:-|:|=|-|–|—|\s)*\s*["'`“]?([^\s"'`”]{3,64})["'`”]?/giu;
// Weak labels need an explicit separator: in Hinglish "pass" usually means "near" ("mere pass").
const WEAK_LABEL = /\b(?:pass|pwd)\s*(?::-|:|=|-)\s*["'`“]?([^\s"'`”]{3,64})["'`”]?/giu;

const NOT_A_PASSWORD = new Set([
  'ok', 'okay', 'haan', 'han', 'ha', 'yes', 'no', 'nahi', 'nhi', 'nahin', 'skip', 'thanks', 'thank', 'thankyou',
  'sir', 'bhai', 'ji', 'hai', 'hain', 'kya', 'nahi hai', 'done', 'hello', 'hi', 'send', 'bheja', 'bhej', 'diya',
  'protected', 'required', 'chahiye', 'kaunsa', 'bataya', 'pata', 'hmm', 'wait', 'ruko', 'sent', 'mujhe', 'mera',
  'meri', 'mere', 'ye', 'yeh', 'wo', 'woh', 'tha', 'kaise', 'kyu', 'main', 'mai', 'hu', 'hoon', 'raha', 'rha', 'de',
  'do', 'dunga', 'bhejta', 'bhejunga', 'abhi', 'baad', 'later', 'kal', 'please', 'plz', 'pls', 'the', 'is', 'for',
  'kar', 'karo', 'dijiye', 'hota', 'nahi', 'wala', 'wali', 'statement', 'pdf', 'file', 'bank', 'mein', 'me',
]);

const SKIP = /\b(skip|no password|password nahi|password nhi|password nahin|nahi pata|pata nahi|nhi pata|don'?t know( the)? password|password yaad nahi|password bhool)\b/i;

function plausible(token: string): boolean {
  if (token.length < 3 || token.length > 64) return false;
  if (NOT_A_PASSWORD.has(token.toLowerCase())) return false;
  if (/^[\p{P}\p{S}]+$/u.test(token)) return false;
  return true;
}

export function extractPassword(input: string, opts: { awaitingPassword: boolean }): PasswordExtraction {
  const text = cleanText(input);
  const candidates: string[] = [];
  let redacted = text;
  let explicit = false;

  for (const m of [...text.matchAll(STRONG_LABEL), ...text.matchAll(WEAK_LABEL)]) {
    const token = m[1]!.replace(/[.,;!?]+$/, '');
    if (!plausible(token)) continue;
    // "password protected hai" / "password chahiye" are not passwords.
    if (/^(protected|protect|required|chahiye|nahi|nhi|kya|kaunsa|kaise)$/i.test(token)) continue;
    candidates.push(token);
    explicit = true;
    redacted = redacted.split(token).join(PASSWORD_PLACEHOLDER);
  }

  const skip = SKIP.test(lexicalForm(text));

  if (!explicit && opts.awaitingPassword && !skip) {
    const tokens = text.split(/\s+/).filter(Boolean);
    if (tokens.length === 1 && plausible(tokens[0]!)) {
      candidates.push(tokens[0]!);
      redacted = PASSWORD_PLACEHOLDER;
    } else if (tokens.length <= 4) {
      // "ye lo ABCD1234", "ABCD1234 hai sir": pick password-looking tokens (mixed/digits).
      const looks = tokens.filter((t) => plausible(t) && /\d/.test(t) && (/[A-Za-z@#$_]/.test(t) || /^\d{4,12}$/.test(t)));
      for (const t of looks) {
        candidates.push(t);
        redacted = redacted.split(t).join(PASSWORD_PLACEHOLDER);
      }
    }
  }

  // "password mujhe nahi pata" → skip wins over word-like captures.
  const finalCandidates = skip ? candidates.filter((c) => /\d/.test(c)) : candidates;
  return { candidates: [...new Set(finalCandidates)], explicit: explicit && finalCandidates.length > 0, redactedText: redacted, skip };
}
