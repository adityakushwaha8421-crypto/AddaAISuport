import type { CaseType, Slot } from '../domain/cases.js';
import type { WithdrawalCandidate } from '../domain/evidence.js';

/** Things we can truthfully acknowledge as received (only when actually received this turn). */
export type ReceivedItem =
  | 'registration_number'
  | 'payment_screenshot'
  | 'withdrawal_id'
  | 'withdrawal_screenshot'
  | 'bank_statement'
  | 'utr'
  | 'screenshot'
  | 'details'
  | 'pdf'
  | 'payment_video'
  | 'video';

/**
 * A response plan is a list of acts. Workflows decide WHAT to say (facts are verified values
 * only); the composer decides HOW to say it. Every fact in an act is either user-provided or
 * admin-verified — the composer's guard rejects any phrasing that adds facts.
 */
export type Act =
  | { type: 'greeting'; /** Already greeted in this chat: answer rather than repeat the same line. */ again?: 'hello' | 'how_are_you' }
  | { type: 'thanks' }
  | { type: 'ack' }
  | { type: 'frustration_ack'; /** The customer has already sent something in this case. */ hasDetails?: boolean }
  | { type: 'received'; items: ReceivedItem[] }
  | { type: 'ask'; slots: Slot[]; mode: 'initial' | 'followup' | 'reminder' | 'not_found_yet'; caseType: CaseType }
  | { type: 'promise_noted' }
  /** The requested items reached the team's export bot. */
  | { type: 'export_confirmed' }
  /** The team confirmed the payment through the export bot. */
  | { type: 'deposit_solved' }
  | { type: 'clarify_issue_type' }
  // deposit
  | { type: 'deposit_success'; orderId: string; amount?: number }
  | { type: 'deposit_not_matched'; askStatement: boolean }
  | { type: 'deposit_failed'; orderId: string; amount?: number }
  | { type: 'deposit_pending'; orderId: string; amount?: number }
  // withdrawal
  | { type: 'withdrawal_success'; amount?: number; bank?: string; maskedAccount?: string; askStatement: boolean }
  | { type: 'ask_statement_for_account'; bank?: string; maskedAccount?: string }
  | { type: 'withdrawal_processing'; amount?: number }
  | { type: 'withdrawal_failed'; amount?: number; reason?: string }
  | { type: 'withdrawal_not_found'; withdrawalId: string }
  | { type: 'choose_candidate'; candidates: WithdrawalCandidate[] }
  | { type: 'candidate_selected'; candidate: WithdrawalCandidate }
  // documents
  | { type: 'pdf_password_needed' }
  | { type: 'pdf_password_wrong' }
  | { type: 'statement_account_mismatch'; bank?: string; maskedAccount?: string }
  | { type: 'statement_credit_found'; amount?: number; date?: string; utr?: string }
  | { type: 'statement_outdated'; payoutDate: string }
  | { type: 'statement_unreadable' }
  | { type: 'not_a_statement' }
  | { type: 'evidence_unrelated' }
  | { type: 'evidence_unsupported'; what: 'voice' | 'video' | 'file' | 'image' }
  // general
  | { type: 'general_answer'; question: string; knowledge: string[] };

/** Values an act makes public — the only facts the composer may mention. */
export function actFacts(acts: Act[]): string[] {
  const out: string[] = [];
  const push = (v: unknown) => {
    if (v !== undefined && v !== null && v !== '') out.push(String(v));
  };
  for (const a of acts) {
    switch (a.type) {
      case 'deposit_success':
      case 'deposit_failed':
      case 'deposit_pending':
        push(a.orderId);
        push(a.amount);
        break;
      case 'withdrawal_success':
        push(a.amount);
        push(a.maskedAccount);
        push(a.bank);
        break;
      case 'ask_statement_for_account':
      case 'statement_account_mismatch':
        push(a.maskedAccount);
        push(a.bank);
        break;
      case 'withdrawal_processing':
      case 'withdrawal_failed':
        push(a.amount);
        break;
      case 'withdrawal_not_found':
        push(a.withdrawalId);
        break;
      case 'choose_candidate':
        for (const c of a.candidates) {
          push(c.withdrawalId);
          push(c.amount);
          push(c.position);
        }
        break;
      case 'candidate_selected':
        push(a.candidate.withdrawalId);
        push(a.candidate.amount);
        break;
      case 'statement_credit_found':
        push(a.amount);
        push(a.date);
        push(a.utr);
        break;
      case 'statement_outdated':
        push(a.payoutDate);
        break;
      case 'general_answer':
        for (const k of a.knowledge) push(k);
        break;
      default:
        break;
    }
  }
  return out;
}
