import type { DepositOrder } from '../domain/admin.js';
import type { DepositMatchQuality } from '../domain/cases.js';

/** What we know about the customer's payment (from screenshot/text), all optional. */
export interface PaymentClaim {
  amount?: number;
  utr?: string;
  /** ISO date or datetime */
  when?: string;
}

export interface DepositMatch {
  quality: DepositMatchQuality;
  order?: DepositOrder;
  candidates: DepositOrder[];
}

const alnum = (s: string) => s.toUpperCase().replace(/[^A-Z0-9]/g, '');
const hours = (a: string, b: string) => Math.abs(Date.parse(a) - Date.parse(b)) / 3_600_000;

/**
 * Match a customer's payment against the orders the admin panel returned for their registration
 * number. Only UTR equality is treated as exact; amount+time is strong; amount alone is weak and
 * only accepted when it is unique.
 */
export function matchDeposit(claim: PaymentClaim, orders: DepositOrder[], opts: { timeWindowHours?: number } = {}): DepositMatch {
  const windowH = opts.timeWindowHours ?? 36;
  if (orders.length === 0) return { quality: 'none', candidates: [] };

  if (claim.utr) {
    const byUtr = orders.filter((o) => o.utr && alnum(o.utr) === alnum(claim.utr!));
    if (byUtr.length === 1) return { quality: 'exact_utr', order: byUtr[0], candidates: byUtr };
  }

  if (claim.amount !== undefined) {
    const byAmount = orders.filter((o) => o.amount !== undefined && Math.abs(o.amount - claim.amount!) < 0.01);
    if (claim.when) {
      const timed = byAmount
        .filter((o) => o.createdAt && hours(o.createdAt, claim.when!) <= windowH)
        .sort((a, b) => hours(a.createdAt!, claim.when!) - hours(b.createdAt!, claim.when!));
      if (timed.length === 1) return { quality: 'amount_and_time', order: timed[0], candidates: timed };
      // Several same-amount orders in the window: never guess which one the customer means.
      if (timed.length > 1) return { quality: 'ambiguous', candidates: timed };
    }
    if (byAmount.length === 1) return { quality: 'amount_only', order: byAmount[0], candidates: byAmount };
    if (byAmount.length > 1) return { quality: 'ambiguous', candidates: byAmount };
    return { quality: 'none', candidates: [] };
  }

  // No payment details at all: only a single recent order is meaningful.
  if (orders.length === 1) return { quality: 'single_recent', order: orders[0], candidates: orders };
  return { quality: 'ambiguous', candidates: orders };
}
