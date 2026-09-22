/** Records returned by the admin panel. These are authoritative. */

export type PayoutStatus = 'SUCCESS' | 'PROCESSING' | 'PENDING' | 'FAILED' | 'REJECTED' | 'REVERSED' | 'UNKNOWN';

export interface PayoutDetails {
  withdrawalId: string;
  amount?: number;
  status: PayoutStatus;
  statusRaw?: string;
  beneficiaryName?: string;
  bankName?: string;
  branch?: string;
  accountNumber?: string;
  ifsc?: string;
  utr?: string;
  gateway?: string;
  vendorOrderId?: string;
  requestedAt?: string;
  processedAt?: string;
  registrationNumber?: string;
  failureReason?: string;
}

export type DepositStatus = 'SUCCESS' | 'PENDING' | 'FAILED' | 'UNKNOWN';

export interface DepositOrder {
  orderId: string;
  registrationNumber?: string;
  amount?: number;
  status: DepositStatus;
  statusRaw?: string;
  utr?: string;
  createdAt?: string;
  gateway?: string;
}

export type AdminErrorCode = 'unavailable' | 'timeout' | 'auth' | 'parse' | 'disabled' | 'circuit_open';

export type LookupResult<T> =
  | { ok: true; data: T; fetchedAt: string; cached?: boolean }
  | { ok: false; error: AdminErrorCode; message: string };

export interface DepositQuery {
  registrationNumber: string;
  from?: Date;
  to?: Date;
}

export interface AdminGateway {
  readonly name: string;
  /** null data = searched successfully, nothing found. */
  findPayout(withdrawalId: string): Promise<LookupResult<PayoutDetails | null>>;
  findDeposits(query: DepositQuery): Promise<LookupResult<DepositOrder[]>>;
  close?(): Promise<void>;
}

const PAYOUT_STATUS_SYNONYMS: Array<[PayoutStatus, RegExp]> = [
  ['SUCCESS', /^(success|successful|succeeded|completed?|paid|processed|settled|credited|approved & paid|done)$/i],
  ['PROCESSING', /^(processing|in[\s_-]?progress|initiated|submitted|sent to bank|queued|in[\s_-]?process)$/i],
  ['PENDING', /^(pending|awaiting|on[\s_-]?hold|hold|requested|created|new|approval pending)$/i],
  ['FAILED', /^(failed|failure|error|declined|bounced)$/i],
  ['REJECTED', /^(rejected|cancelled|canceled|denied)$/i],
  ['REVERSED', /^(reversed|refunded|returned|reversal)$/i],
];

export function normalisePayoutStatus(raw: string | undefined | null): PayoutStatus {
  const s = (raw ?? '').trim();
  for (const [status, re] of PAYOUT_STATUS_SYNONYMS) if (re.test(s)) return status;
  return 'UNKNOWN';
}

const DEPOSIT_STATUS_SYNONYMS: Array<[DepositStatus, RegExp]> = [
  ['SUCCESS', /^(success|successful|succeeded|completed?|paid|credited|captured|settled|approved)$/i],
  ['PENDING', /^(pending|processing|initiated|created|in[\s_-]?progress|awaiting|new)$/i],
  ['FAILED', /^(failed|failure|declined|expired|cancelled|canceled|rejected|timeout|timed out)$/i],
];

export function normaliseDepositStatus(raw: string | undefined | null): DepositStatus {
  const s = (raw ?? '').trim();
  for (const [status, re] of DEPOSIT_STATUS_SYNONYMS) if (re.test(s)) return status;
  return 'UNKNOWN';
}

export const isFinalPayoutStatus = (s: PayoutStatus): boolean =>
  s === 'SUCCESS' || s === 'FAILED' || s === 'REJECTED' || s === 'REVERSED';
