import { lexicalForm } from './normalize.js';

/**
 * A greeting and nothing else: "Hi", "Hello sir", "Hlo", "Namaste ji", "Good morning team",
 * "नमस्ते", with any punctuation or emoji. One content word ("hi deposit nahi hua", "hello?
 * 9810822372") and it is not a greeting but a message about something — classified as usual.
 */
const GREETING_WORDS =
  /^(?:h+i+y*|h+e+y+|hy|hie|hai+l+o+|hel+o+w?|hlo+|hlw|hallo|hola|namaste+y?|namaskar|namaskaar|pranam|salam|salaam|assalamualaikum|assalam|walaikum|gm|gud|good|morning|mrng|mng|afternoon|evening|evng|night|radhe|ram|jai|shree|shri|krishna|नमस्ते|नमस्कार|हेलो|हैलो|हेल्लो|हाय|हाई|प्रणाम|राम|राधे|जय|श्री|कृष्ण|गुड|मॉर्निंग|सुप्रभात|शुभ|प्रभात|संध्या|रात्रि)$/u;
/** Words that may stand next to a greeting without making it something else. */
const FILLER_WORDS = /^(?:sir|sirji|ji|bhai|bhaiya|bro|mam|madam|team|support|dear|there|boss|admin|sahab|saab|fantasy|adda|fa|sab|sabko|सर|जी|भाई|भैया|टीम|सपोर्ट|मैडम|सब|सबको)$/u;
const MAX_WORDS = 6;

export function isGreeting(text: string): boolean {
  const words = lexicalForm(text)
    .replace(/[^\p{L}\p{N}\p{M}]+/gu, ' ')
    .split(' ')
    .filter(Boolean);
  if (!words.length || words.length > MAX_WORDS) return false;
  let greetings = 0;
  for (const w of words) {
    if (GREETING_WORDS.test(w)) greetings++;
    else if (!FILLER_WORDS.test(w)) return false;
  }
  return greetings > 0;
}
