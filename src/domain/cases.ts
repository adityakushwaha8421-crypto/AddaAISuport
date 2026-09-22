import type { DepositOrder, PayoutDetails } from './admin.js';
import type { WithdrawalCandidate } from './evidence.js';

export type CaseType = 'deposit' | 'withdrawal' | 'technical' | 'account' | 'other';

export type CaseStatus =
  | 'open' // the user's focused case
  | 'paused' // user switched topic; resumable
  | 'resolved' // automation solved it (can reopen if the user returns soon)
  | 'escalated' // handed to humans (ticket delivered)
  | 'closed'; // idle-closed / done

export const ACTIVE_STATUSES: CaseStatus[] = ['open', 'paused', 'resolved', 'escalated'];

/** Not finished: a request is out to the customer, or humans have the case. */
export const PENDING_STATUSES: CaseStatus[] = ['open', 'paused', 'escalated'];

/** Information units a workflow can need. Used for batching asks and the "never ask twice" policy. */
export type Slot =
  | 'registration_number'
  | 'payment_proof' // payment screenshot
  | 'payment_video' // screen recording of the payment
  | 'utr'
  | 'withdrawal_ref' // withdrawal ID or withdrawal-history screenshot
  | 'withdrawal_choice' // which row of a multi-row screenshot
  | 'bank_statement'
  | 'pdf_password'
  | 'issue_description'
  | 'screenshot';

export type FactSource = 'text' | 'reply' | 'screenshot' | 'statement' | 'admin' | 'llm' | 'memory';

export type CaseField = 'registrationNumber' | 'withdrawalId' | 'orderId' | 'amount' | 'txnTime' | 'utr';

export interface FactProvenance {
  source: FactSource;
  confidence: number;
  messageId?: number;
  evidenceId?: string;
}

export type DepositMatchQuality = 'exact_utr' | 'amount_and_time' | 'amount_only' | 'single_recent' | 'ambiguous' | 'none';

export type AccountMatch = 'match' | 'partial' | 'mismatch' | 'unknown';

export interface StatementCheck {
  evidenceId: string;
  account: AccountMatch;
  bank: 'match' | 'mismatch' | 'unknown';
  ifsc: 'match' | 'mismatch' | 'unknown';
  name: 'match' | 'mismatch' | 'unknown';
  /** Whether the statement period covers the payout date. */
  coversPayoutDate: boolean | null;
  transaction: { found: boolean; quality: 'utr' | 'amount_and_date' | 'amount_only' | 'none'; line?: string; date?: string };
  checkedAt: string;
}

export type HandoffReason =
  | 'insufficient_evidence'
  | 'conflicting_evidence'
  | 'ambiguous_transaction'
  | 'verification_unavailable'
  | 'user_declined_more_info'
  | 'user_requested_human'
  | 'max_asks_reached'
  | 'deposit_not_reflected'
  | 'withdrawal_credit_missing'
  | 'withdrawal_failed_dispute'
  | 'withdrawal_sla_breached'
  | 'not_found_in_admin'
  | 'pdf_unreadable'
  | 'unsupported_issue'
  | 'business_rule';

export interface CaseFacts {
  sources: Partial<Record<CaseField, FactProvenance>>;
  claims: {
    notReceived?: boolean;
    refusesDocuments?: boolean;
    wantsHuman?: boolean;
    confirmedRegistration?: boolean;
  };
  /** How many times each slot has been requested from the user. */
  asks: Partial<Record<Slot, number>>;
  /** Slots requested in the most recent bot message of this case. */
  lastAsked: Slot[];
  evidenceIds: string[];
  paymentEvidenceId?: string;
  paymentVideoEvidenceId?: string;
  withdrawalEvidenceId?: string;
  statementEvidenceId?: string;
  /** Rows from the most relevant withdrawal-history screenshot, visual order preserved. */
  candidates?: { evidenceId?: string; messageId?: number; items: WithdrawalCandidate[] };
  pendingPdf?: { evidenceId: string; attempts: number };
  payout?: PayoutDetails & { fetchedAt: string };
  deposit?: { orders: DepositOrder[]; fetchedAt: string; matchedOrderId?: string; quality: DepositMatchQuality };
  statementCheck?: StatementCheck;
  notFoundCount?: number;
  statementMismatchCount?: number;
  /** User's own description of the problem (scrubbed), for generic cases and summaries. */
  description: string[];
  resolution?: string;
  handoffReason?: HandoffReason;
  /** Export to the export bot: what reached it, so a retry never sends a duplicate. */
  export?: ExportState;
  /** Things already told to the user (prevents repeating the same status every turn). */
  informed: string[];
}

/**
 * RECEIVED (all requested items in: the export is decided) → FORWARDING (forwards in flight) →
 * VERIFIED (Telegram confirmed every forward exists in the bot's chat) → CONFIRMED (customer told).
 * FAILED: the last attempt did not verify; retried later, resending only what is missing.
 */
export type ExportStatus = 'forwarding' | 'verified' | 'confirmed' | 'failed';
export const EXPORT_DONE: ExportStatus[] = ['verified', 'confirmed'];

export interface ExportState {
  status: ExportStatus;
  at: string;
  attempts: number;
  /** The handoff the export was decided for; a delayed retry finishes that handoff. */
  reason?: HandoffReason;
  /** Customer message id → id of its forward in the bot chat. */
  forwarded: Record<string, number>;
  lastError?: string;
}

export interface CaseRecord {
  id: string;
  userId: string;
  chatId: string;
  type: CaseType;
  status: CaseStatus;
  step: string;
  registrationNumber?: string;
  withdrawalId?: string;
  orderId?: string;
  amount?: number;
  txnTime?: string;
  utr?: string;
  confidence: number;
  missing: Slot[];
  escalation: 'none' | 'pending' | 'delivered' | 'failed';
  facts: CaseFacts;
  version: number;
  createdAt: Date;
  updatedAt: Date;
  lastActivityAt: Date;
}

export function emptyFacts(): CaseFacts {
  return { sources: {}, claims: {}, asks: {}, lastAsked: [], evidenceIds: [], description: [], informed: [] };
}
