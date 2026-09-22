import type { CaseRecord, CaseType } from './cases.js';
import type { Language } from '../nlu/types.js';
import { shortMaskAccount } from '../security/masking.js';

/**
 * What we remember about a customer between cases and conversations. Only their own data, only
 * what removes friction later: identifiers they already proved, where their payouts go (masked),
 * how they write, and a short case history for context and for the human team.
 * Never holds passwords, full account numbers, or anything the customer did not send us.
 */
export interface RememberedNumber {
  value: string;
  /** Confirmed by an admin-panel record (order/payout found for it). */
  verified: boolean;
  lastUsedAt: string;
}

export interface RememberedCase {
  id: string;
  type: CaseType;
  status: CaseRecord['status'];
  /** Withdrawal ID or order ID this case was about. */
  ref?: string;
  amount?: number;
  at: string;
}

/** How the customer writes: learned from their own messages, never guessed from their name. */
export interface UserStyle {
  /** How they address us. */
  sirCount: number;
  bhaiCount: number;
  /** Running totals used to spot people who write in very short bursts. */
  messages: number;
  words: number;
}

export interface UserMemory {
  style: UserStyle;
  registrationNumbers: RememberedNumber[];
  /** Destination of the customer's payouts, as shown by the admin panel (masked). */
  bank?: { name?: string; maskedAccount?: string; ifsc?: string; lastSeenAt: string };
  language?: Language;
  recentCases: RememberedCase[];
  stats: { cases: number; resolved: number; escalated: number; lastIssueType?: CaseType; lastIssueAt?: string };
  /** The customer's calendar day (YYYY-MM-DD in their timezone) of their latest message: a greeting goes out once per day. */
  lastSeenOn?: string;
  /** When a match issue was filed for the team and no human has answered since: the chat is theirs, the bot holds off. */
  matchReviewPending?: string;
}

/** Calendar day of `date` in the customers' timezone, as YYYY-MM-DD. */
export function localDay(date: Date, timeZone: string): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(date);
}

/**
 * Record that the customer wrote now. `firstOfDay` is true for their first message of a calendar
 * day (their local day, since Telegram does not tell us their timezone the configured one is used):
 * the only turn on which the bot may greet.
 */
export function noteVisit(m: UserMemory, now: Date, timeZone: string): { memory: UserMemory; firstOfDay: boolean } {
  const today = localDay(now, timeZone);
  const firstOfDay = m.lastSeenOn !== today;
  return { memory: firstOfDay ? { ...m, lastSeenOn: today } : m, firstOfDay };
}

export const emptyMemory = (): UserMemory => ({
  style: { sirCount: 0, bhaiCount: 0, messages: 0, words: 0 },
  registrationNumbers: [],
  recentCases: [],
  stats: { cases: 0, resolved: 0, escalated: 0 },
});

/** Mirror the customer's own form of address, and notice when they keep it very short. */
export function learnStyle(m: UserMemory, text: string): UserMemory {
  const t = text.trim();
  if (!t) return m;
  const words = t.split(/\s+/).filter(Boolean).length;
  const style = { ...m.style, messages: m.style.messages + 1, words: m.style.words + words };
  if (/\bsir\b|सर\b/i.test(t)) style.sirCount++;
  if (/\b(bhai|bro|bhaiya)\b|भाई/i.test(t)) style.bhaiCount++;
  return { ...m, style };
}

/** "bhai" only once they clearly prefer it; "sir" stays the default. */
export const addressTerm = (m: UserMemory | undefined): 'sir' | 'bhai' =>
  m && m.style.bhaiCount >= 2 && m.style.bhaiCount > m.style.sirCount ? 'bhai' : 'sir';

/** Someone who writes in 3-4 word bursts gets the plain, shortest phrasing. */
export const prefersBrief = (m: UserMemory | undefined): boolean =>
  !!m && m.style.messages >= 3 && m.style.words / m.style.messages <= 4;

const MAX_NUMBERS = 3;
const MAX_CASES = 5;

/** The number to use when the customer hasn't given one in this case (verified first, then recent). */
export function preferredRegistrationNumber(m: UserMemory | undefined): RememberedNumber | undefined {
  return [...(m?.registrationNumbers ?? [])].sort(
    (a, b) => Number(b.verified) - Number(a.verified) || Date.parse(b.lastUsedAt) - Date.parse(a.lastUsedAt),
  )[0];
}

export function rememberNumber(m: UserMemory, value: string, verified: boolean, now: Date): UserMemory {
  const rest = m.registrationNumbers.filter((n) => n.value !== value);
  const prev = m.registrationNumbers.find((n) => n.value === value);
  return {
    ...m,
    registrationNumbers: [{ value, verified: verified || (prev?.verified ?? false), lastUsedAt: now.toISOString() }, ...rest].slice(0, MAX_NUMBERS),
  };
}

/** Fold everything worth keeping out of a case into the customer's memory. */
export function rememberCase(m: UserMemory, c: CaseRecord, now: Date): UserMemory {
  let next = { ...m };
  const verified = !!(c.facts.deposit?.matchedOrderId || c.facts.payout);
  if (c.registrationNumber) next = rememberNumber(next, c.registrationNumber, verified, now);

  const payout = c.facts.payout;
  if (payout?.accountNumber || payout?.bankName) {
    next.bank = {
      name: payout.bankName,
      maskedAccount: shortMaskAccount(payout.accountNumber),
      ifsc: payout.ifsc,
      lastSeenAt: now.toISOString(),
    };
  }

  const entry: RememberedCase = {
    id: c.id,
    type: c.type,
    status: c.status,
    ref: c.withdrawalId ?? c.orderId,
    amount: c.amount,
    at: now.toISOString(),
  };
  const others = next.recentCases.filter((x) => x.id !== c.id);
  const seenBefore = next.recentCases.some((x) => x.id === c.id);
  next.recentCases = [entry, ...others].slice(0, MAX_CASES);
  next.stats = {
    cases: next.stats.cases + (seenBefore ? 0 : 1),
    resolved: others.filter((x) => x.status === 'resolved').length + (entry.status === 'resolved' ? 1 : 0),
    escalated: others.filter((x) => x.status === 'escalated').length + (entry.status === 'escalated' ? 1 : 0),
    lastIssueType: c.type,
    lastIssueAt: now.toISOString(),
  };
  return next;
}

/** Compact, secret-free view for the interpreter prompt and the support summary. */
export function describeMemory(m: UserMemory | undefined): string | undefined {
  if (!m || (!m.stats.cases && !m.registrationNumbers.length)) return undefined;
  const parts: string[] = [];
  if (m.stats.cases) parts.push(`${m.stats.cases} earlier case(s): ${m.stats.resolved} resolved, ${m.stats.escalated} escalated`);
  const n = preferredRegistrationNumber(m);
  if (n) parts.push(`known registration number${n.verified ? ' (verified)' : ''}`);
  if (m.bank?.maskedAccount) parts.push(`payouts go to ${[m.bank.name, m.bank.maskedAccount].filter(Boolean).join(' ')}`);
  const last = m.recentCases[0];
  if (last) parts.push(`last issue: ${last.type}${last.ref ? ` ${last.ref}` : ''} (${last.status})`);
  return parts.join('; ');
}
