import type { AccountMatch } from '../domain/cases.js';
import { canonicalBank } from '../evidence/banks.js';

/**
 * Compare the payout destination account (from admin) with account numbers found on a statement.
 * Either side may be masked ("XXXXXX1234"). Returns:
 *   match    – same number (or the visible parts agree over ≥6 digits)
 *   partial  – only a short visible suffix (≥4 digits) agrees → needs a second signal (IFSC/bank/name)
 *   mismatch – visible digits disagree
 *   unknown  – nothing comparable
 */

const norm = (s: string) => s.replace(/[\s-]/g, '').replace(/\*/g, 'X').toUpperCase();

/** Trailing run of visible digits ("XXXX1234" → "1234"). */
function visibleSuffix(s: string): string {
  return s.match(/\d+$/)?.[0] ?? '';
}

const isFull = (s: string) => /^\d+$/.test(s);

export function compareAccount(expectedRaw: string, candidateRaw: string): AccountMatch {
  const e = norm(expectedRaw);
  const c = norm(candidateRaw);
  if (!/\d/.test(e) || !/\d/.test(c)) return 'unknown';
  if (isFull(e) && isFull(c)) {
    if (e === c || e.replace(/^0+/, '') === c.replace(/^0+/, '')) return 'match';
    return 'mismatch';
  }
  const es = visibleSuffix(e);
  const cs = visibleSuffix(c);
  const k = Math.min(es.length, cs.length);
  if (k < 4) return 'unknown';
  if (es.slice(-k) !== cs.slice(-k)) return 'mismatch';
  // If lengths are both known and differ, the numbers can't be the same account.
  if (!isFull(e) && !isFull(c) && e.length !== c.length && Math.abs(e.length - c.length) > 2) return 'partial';
  return k >= 6 ? 'match' : 'partial';
}

const RANK: Record<AccountMatch, number> = { match: 3, partial: 2, mismatch: 1, unknown: 0 };

export function bestAccountMatch(expected: string | undefined, candidates: string[]): AccountMatch {
  if (!expected || candidates.length === 0) return 'unknown';
  let best: AccountMatch = 'unknown';
  for (const c of candidates) {
    const r = compareAccount(expected, c);
    if (RANK[r] > RANK[best]) best = r;
  }
  return best;
}

export function compareIfsc(a?: string, b?: string): 'match' | 'mismatch' | 'unknown' {
  if (!a || !b) return 'unknown';
  return a.toUpperCase() === b.toUpperCase() ? 'match' : 'mismatch';
}

export function compareBank(a?: string, b?: string): 'match' | 'mismatch' | 'unknown' {
  if (!a || !b) return 'unknown';
  // "SBI" and "State Bank of India" are the same bank: compare canonical names when known.
  const ca = canonicalBank(a);
  const cb = canonicalBank(b);
  if (ca && cb) return ca === cb ? 'match' : 'mismatch';
  const n = (s: string) => s.toLowerCase().replace(/\b(bank|ltd|limited|of|the)\b/g, '').replace(/[^a-z]/g, '');
  return n(a) === n(b) ? 'match' : 'mismatch';
}

export function compareName(a?: string, b?: string): 'match' | 'mismatch' | 'unknown' {
  if (!a || !b) return 'unknown';
  const tokens = (s: string) => new Set(s.toLowerCase().replace(/[^a-z\s]/g, ' ').split(/\s+/).filter((t) => t.length > 1 && !['mr', 'mrs', 'ms', 'shri', 'smt'].includes(t)));
  const ta = tokens(a);
  const tb = tokens(b);
  const common = [...ta].filter((t) => tb.has(t)).length;
  return common >= 1 && common >= Math.min(ta.size, tb.size) / 2 ? 'match' : 'mismatch';
}
