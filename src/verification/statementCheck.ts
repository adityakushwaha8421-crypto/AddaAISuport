import type { PayoutDetails } from '../domain/admin.js';
import type { StatementCheck } from '../domain/cases.js';
import type { StatementFacts } from '../domain/evidence.js';
import { extractEntities } from '../nlu/entities.js';
import { moneyValues } from '../evidence/statement.js';
import { bestAccountMatch, compareBank, compareIfsc, compareName } from './accountMatch.js';

export interface TxnQuery {
  amount?: number;
  date?: string; // ISO
  utr?: string;
  windowDays?: number;
}

export interface TxnSearchResult {
  found: boolean;
  quality: 'utr' | 'amount_and_date' | 'amount_only' | 'none';
  line?: string;
  date?: string;
}

const dayDiff = (a: string, b: string) => Math.abs(Date.parse(a) - Date.parse(b)) / 86_400_000;
const alnum = (s: string) => s.toUpperCase().replace(/[^A-Z0-9]/g, '');

/** Targeted search for one transaction in statement lines. */
export function findTransaction(lines: string[], q: TxnQuery): TxnSearchResult {
  const window = q.windowDays ?? 3;
  if (q.utr && q.utr.length >= 6) {
    const utr = alnum(q.utr);
    const hit = lines.find((l) => alnum(l).includes(utr));
    if (hit) return { found: true, quality: 'utr', line: hit, date: extractEntities(hit).dates[0]?.value };
  }
  if (q.amount === undefined) return { found: false, quality: 'none' };
  const amountHits = lines.filter((l) => moneyValues(l).some((v) => Math.abs(v - q.amount!) < 0.01));
  if (q.date) {
    const dated = amountHits.find((l) => {
      const d = extractEntities(l).dates[0]?.value;
      return d !== undefined && dayDiff(d, q.date!) <= window;
    });
    if (dated) return { found: true, quality: 'amount_and_date', line: dated, date: extractEntities(dated).dates[0]?.value };
  }
  if (amountHits[0]) return { found: false, quality: 'amount_only', line: amountHits[0], date: extractEntities(amountHits[0]).dates[0]?.value };
  return { found: false, quality: 'none' };
}

/** Is this statement for the account the payout went to? (account + corroborating signals) */
export function isSameAccount(check: Pick<StatementCheck, 'account' | 'bank' | 'ifsc' | 'name'>): boolean | undefined {
  if (check.account === 'match') return check.bank !== 'mismatch' && check.ifsc !== 'mismatch';
  if (check.account === 'mismatch') return false;
  if (check.account === 'partial') {
    if (check.ifsc === 'mismatch' || check.bank === 'mismatch') return false;
    if (check.ifsc === 'match' || check.bank === 'match' || check.name === 'match') return true;
    return undefined;
  }
  // No comparable account number on the statement.
  if (check.ifsc === 'mismatch' || check.bank === 'mismatch') return false;
  return undefined;
}

/** Full statement verification against an authoritative payout record. */
export function checkStatementAgainstPayout(
  evidenceId: string,
  payout: PayoutDetails,
  st: StatementFacts,
  now: Date = new Date(),
): StatementCheck {
  const payoutDate = (payout.processedAt ?? payout.requestedAt)?.slice(0, 10);
  const coversPayoutDate =
    payoutDate && st.periodTo ? Date.parse(st.periodTo) + 86_400_000 * 1 >= Date.parse(payoutDate) : null;
  return {
    evidenceId,
    account: bestAccountMatch(payout.accountNumber, st.accountNumbers),
    bank: compareBank(payout.bankName, st.bankName),
    ifsc: compareIfsc(payout.ifsc, st.ifsc),
    name: compareName(payout.beneficiaryName, st.holderName),
    coversPayoutDate,
    transaction: findTransaction(st.lines, { amount: payout.amount, date: payoutDate, utr: payout.utr }),
    checkedAt: now.toISOString(),
  };
}
