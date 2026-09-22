/**
 * Removes secrets from arbitrary text before it reaches logs, the database, the LLM or a
 * support group. Two layers:
 *  1. exact known secret values (tokens, API keys, DB URL, admin password) registered at startup
 *  2. patterns for secrets users type into chat (PDF passwords, OTPs, PINs, CVVs)
 */

const REDACTED = '[REDACTED]';

const PATTERNS: Array<{ re: RegExp; replace: (m: string, ...g: string[]) => string }> = [
  // "password: abc", "pdf password:- abc", "the password is abc"
  {
    re: /\b((?:pdf\s*)?(?:password|passcode|passwd)\b\s*(?:is\s*|hai\s*)?[:=\-–]*\s*)(\S+)/gi,
    replace: (_m, prefix) => `${prefix}${REDACTED}`,
  },
  // "pass: abc", "pwd = abc" (separator required: "mere pass" means "near me" in Hinglish)
  {
    re: /\b((?:pass|pwd)\s*(?::-|:|=|-)\s*)(\S+)/gi,
    replace: (_m, prefix) => `${prefix}${REDACTED}`,
  },
  // OTP / PIN / CVV followed by digits
  {
    re: /\b((?:otp|pin|mpin|upi\s*pin|cvv|cvc|login\s*code|verification\s*code|code)\b\s*(?:is\s*)?[:=\-–]*\s*)(\d{3,8})\b/gi,
    replace: (_m, prefix) => `${prefix}${REDACTED}`,
  },
  // OpenAI-style keys
  { re: /\bsk-[A-Za-z0-9_-]{16,}\b/g, replace: () => REDACTED },
  // Connection strings with inline credentials
  { re: /\b(postgres(?:ql)?:\/\/[^:\s/]+:)[^@\s]+@/gi, replace: (_m, p) => `${p}${REDACTED}@` },
];

export class SecretScrubber {
  private readonly values = new Set<string>();

  register(...secrets: Array<string | undefined | null>): void {
    for (const s of secrets) if (s && s.length >= 4) this.values.add(s);
  }

  /** Exact-value masking only (used where pattern masking would destroy meaning, e.g. IDs). */
  scrubKnown(text: string): string {
    let out = text;
    for (const v of this.values) if (out.includes(v)) out = out.split(v).join(REDACTED);
    return out;
  }

  scrub(text: string): string {
    let out = this.scrubKnown(text);
    for (const { re, replace } of PATTERNS) out = out.replace(re, replace as (...a: string[]) => string);
    return out;
  }

  /** Deep-scrub a JSON-able value (for log objects / traces). */
  scrubDeep<T>(value: T, depth = 0): T {
    if (depth > 8) return value;
    if (typeof value === 'string') return this.scrub(value) as unknown as T;
    if (value instanceof Error) return value; // the logger's err serializer scrubs message/stack
    if (Array.isArray(value)) return value.map((v) => this.scrubDeep(v, depth + 1)) as unknown as T;
    if (value && typeof value === 'object' && !(value instanceof Date) && !Buffer.isBuffer(value)) {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
        out[k] = SENSITIVE_KEYS.test(k) ? REDACTED : this.scrubDeep(v, depth + 1);
      }
      return out as T;
    }
    return value;
  }
}

/** Object keys whose values are always masked in logs/traces. */
const SENSITIVE_KEYS =
  /^(password|passwd|pwd|pdfPassword|pdf_password|otp|pin|cvv|token|botToken|apiKey|api_key|apiHash|api_hash|session|sessionString|cookie|cookies|authorization|secret|encryptionKey|storageState)$/i;

export const scrubber = new SecretScrubber();
