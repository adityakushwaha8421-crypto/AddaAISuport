import type { CaseRecord, CaseType, Slot } from '../domain/cases.js';
import type { EvidenceCategory } from '../domain/evidence.js';

/** Compact, secret-free view of the conversation handed to the interpreter (LLM or lexical). */
export interface CaseSummary {
  id: string;
  type: CaseType;
  status: CaseRecord['status'];
  step: string;
  lastAsked: Slot[];
  /** How many times each item has been requested in this case: already-asked things are never asked again lightly. */
  asked?: Partial<Record<Slot, number>>;
  known: string[]; // e.g. ["registration_number", "payment_screenshot", "withdrawal_id"]
  lastActivityMinutesAgo: number;
}

export interface InterpreterInput {
  signals: import('./types.js').Signals;
  /** One line about the returning customer (earlier cases, known number, payout bank). */
  customer?: string;
  focused?: CaseSummary;
  others: CaseSummary[];
  history: Array<{ role: 'user' | 'bot'; text: string }>;
  lastBot?: { text: string; acts: string[] };
  /** The customer's first message of their calendar day (the only turn a greeting may go out on). */
  firstMessageOfDay?: boolean;
  reply?: {
    fromSelf: boolean;
    text?: string;
    caseId?: string;
    caseType?: CaseType;
    candidateCount: number;
    evidenceCategories: EvidenceCategory[];
  };
  evidence: Array<{ category: EvidenceCategory; confidence: number; summary: string }>;
}

export function summariseCase(c: CaseRecord, now: Date): CaseSummary {
  const known: string[] = [];
  if (c.registrationNumber) known.push('registration_number');
  if (c.withdrawalId) known.push('withdrawal_id');
  if (c.orderId) known.push('order_id');
  if (c.utr) known.push('utr');
  if (c.amount !== undefined) known.push('amount');
  if (c.facts.paymentEvidenceId) known.push('payment_screenshot');
  if (c.facts.withdrawalEvidenceId) known.push('withdrawal_screenshot');
  if (c.facts.statementEvidenceId) known.push('bank_statement');
  if (c.facts.payout) known.push(`payout_status:${c.facts.payout.status}`);
  if (c.facts.pendingPdf) known.push('pdf_waiting_for_password');
  return {
    id: c.id,
    type: c.type,
    status: c.status,
    step: c.step,
    lastAsked: c.facts.lastAsked,
    asked: c.facts.asks,
    known,
    lastActivityMinutesAgo: Math.round((now.getTime() - c.lastActivityAt.getTime()) / 60_000),
  };
}

export const EVIDENCE_CASE_TYPE: Partial<Record<EvidenceCategory, CaseType>> = {
  payment_screenshot: 'deposit',
  payment_recording: 'deposit',
  withdrawal_screenshot: 'withdrawal',
  withdrawal_recording: 'withdrawal',
  technical_screenshot: 'technical',
  technical_recording: 'technical',
  account_screenshot: 'account',
};
