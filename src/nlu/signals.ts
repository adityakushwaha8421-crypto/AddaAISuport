import { parseOrdinalReference } from '../context/references.js';
import { scrubber } from '../security/scrubber.js';
import { extractEntities, type EntityPatterns } from './entities.js';
import { detectLanguage } from './normalize.js';
import { extractPassword } from './password.js';
import type { Signals } from './types.js';

export interface SignalOptions {
  awaitingPassword: boolean;
  patterns?: EntityPatterns;
  now?: Date;
  hasMedia?: boolean;
}

/**
 * Deterministic pass over the raw turn text. Passwords are pulled out and redacted FIRST, so the
 * text that is stored, logged or sent to the LLM never contains them.
 */
export function computeSignals(rawTexts: string[], opts: SignalOptions): Signals {
  const candidates: string[] = [];
  let explicit = false;
  let skip = false;
  const safeParts: string[] = [];
  for (const raw of rawTexts) {
    if (!raw.trim()) continue;
    const pw = extractPassword(raw, { awaitingPassword: opts.awaitingPassword });
    candidates.push(...pw.candidates);
    explicit ||= pw.explicit;
    skip ||= pw.skip;
    safeParts.push(scrubber.scrub(pw.redactedText));
  }
  const text = safeParts.join('\n');
  return {
    text,
    entities: extractEntities(text, { patterns: opts.patterns, now: opts.now }),
    reference: parseOrdinalReference(text),
    passwordCandidates: [...new Set(candidates)],
    passwordExplicit: explicit,
    skipPassword: skip,
    hasMedia: !!opts.hasMedia,
    language: detectLanguage(text.replace(/\[[A-Z_]+\]/g, ' ')),
  };
}
