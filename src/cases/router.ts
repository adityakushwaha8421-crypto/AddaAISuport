import type { ResolvedReply } from '../context/reply.js';
import { PENDING_STATUSES, type CaseRecord, type CaseType } from '../domain/cases.js';
import type { EvidenceItem } from '../domain/evidence.js';
import { EVIDENCE_CASE_TYPE } from '../nlu/context.js';
import { bestEntities } from '../nlu/entities.js';
import type { Interpretation, Signals } from '../nlu/types.js';

export interface RouteInput {
  cases: CaseRecord[];
  focused?: CaseRecord;
  interp: Interpretation;
  signals: Signals;
  turnEvidence: EvidenceItem[];
  reply?: ResolvedReply;
  now: Date;
  reopenWindowHours: number;
}

export type RouteDecision =
  | { kind: 'case'; target: CaseRecord; retypeTo?: CaseType; why: string }
  | { kind: 'create'; type: CaseType; step: string; why: string }
  | { kind: 'none'; unfocus: boolean; why: string };

const SUPPORT_TYPES: CaseType[] = ['deposit', 'withdrawal', 'technical', 'account'];

/** Case type implied by what the user uploaded this turn (strongest, processed evidence only). */
function evidenceCaseType(evidence: EvidenceItem[]): CaseType | undefined {
  const scored = evidence
    .filter((e) => e.status === 'processed' && EVIDENCE_CASE_TYPE[e.category])
    .sort((a, b) => b.categoryConfidence - a.categoryConfidence);
  return scored[0] ? EVIDENCE_CASE_TYPE[scored[0].category] : undefined;
}

/**
 * True when the turn clearly refers to a different transaction than the case already holds.
 * Only identifiers the admin panel confirmed count: re-typing an ID that was never found is a
 * correction of the same complaint, not a second transaction.
 */
function differentTransaction(c: CaseRecord, signals: Signals, evidence: EvidenceItem[]): boolean {
  const e = bestEntities(signals.entities);
  const payoutConfirmed = !!c.facts.payout;
  const orderConfirmed = !!c.facts.deposit?.matchedOrderId;
  if (payoutConfirmed && c.withdrawalId && e.withdrawalId && e.withdrawalId.value !== c.withdrawalId) return true;
  if (orderConfirmed && c.orderId && e.orderId && e.orderId.value !== c.orderId) return true;
  if (orderConfirmed && c.type === 'deposit' && c.utr) {
    const newUtr = e.utr?.value ?? evidence.find((x) => x.payment?.utr)?.payment?.utr?.value;
    if (newUtr && newUtr !== c.utr) return true;
  }
  if (payoutConfirmed && c.type === 'withdrawal' && c.withdrawalId) {
    const rows = evidence.flatMap((x) => x.withdrawals ?? []).filter((r) => r.withdrawalId);
    if (rows.length && !rows.some((r) => r.withdrawalId === c.withdrawalId)) return true;
  }
  return false;
}

const retypable = (c: CaseRecord, t: CaseType) => c.type === 'other' && c.step === 'clarify_type' && SUPPORT_TYPES.includes(t);

/**
 * Decide which case (if any) this turn belongs to. Structural signals (a pending PDF password,
 * a swipe-reply to a case message, a statement upload) beat the interpretation; the
 * interpretation decides topic switches; uploaded case evidence is never ignored.
 */
export function routeTurn(r: RouteInput): RouteDecision {
  const { cases, focused, interp, signals, turnEvidence, reply } = r;
  const byId = (id?: string) => (id ? cases.find((c) => c.id === id) : undefined);
  const evType = evidenceCaseType(turnEvidence);

  const toCase = (target: CaseRecord, why: string, type?: CaseType): RouteDecision =>
    type && retypable(target, type) ? { kind: 'case', target, retypeTo: type, why: `${why} (retype)` } : { kind: 'case', target, why };

  // 1. A password (or "skip") while a PDF waits for one.
  if (signals.passwordCandidates.length || signals.skipPassword) {
    const pending = (focused?.facts.pendingPdf ? focused : undefined) ?? cases.find((c) => c.facts.pendingPdf);
    if (pending) return toCase(pending, 'pdf password for pending statement');
  }

  // 2. Swipe-reply to a message that belongs to a case.
  if (reply?.caseId && interp.relation !== 'side_topic' && interp.relation !== 'new_issue') {
    const rc = byId(reply.caseId);
    if (rc) return toCase(rc, 'reply to case message', interp.caseType ?? evType);
  }

  // 3. A bank statement goes to the case that is waiting for one.
  if (turnEvidence.some((e) => e.category === 'bank_statement')) {
    const waiting = [focused, ...cases].find(
      (c) => c && (c.facts.pendingPdf || c.facts.lastAsked.includes('bank_statement') || c.step === 'awaiting_statement'),
    );
    if (waiting) return toCase(waiting, 'statement for waiting case');
  }

  // 4. A wordless screenshot of the app during a pending withdrawal case is that case's history
  //    screenshot, however the classifier labelled it (payment and withdrawal screens look alike).
  if (focused?.type === 'withdrawal' && PENDING_STATUSES.includes(focused.status) && !signals.text.trim()
    && turnEvidence.some((e) => e.status === 'processed' && e.category === 'payment_screenshot')) {
    return toCase(focused, 'screenshot for the withdrawal case');
  }

  switch (interp.relation) {
    case 'continue':
      // "continue" still means a NEW case when the turn names a different transaction
      // ("ek aur deposit nahi aaya, ORD-2 wala" while ORD-1 is the focused case).
      if (focused && !differentTransaction(focused, signals, turnEvidence)) return toCase(focused, 'continue focused', interp.caseType ?? evType);
      break;
    case 'resume': {
      const target = byId(interp.targetCaseId) ?? cases.find((c) => c !== focused && c.type === interp.caseType);
      if (target) return toCase(target, 'resume');
      break;
    }
    case 'side_topic':
    case 'none': {
      // Case evidence or identifiers are never dropped just because the words were small talk.
      const hasCaseData = !!evType || !!bestEntities(signals.entities).withdrawalId || !!bestEntities(signals.entities).registrationNumber;
      if (!hasCaseData) return { kind: 'none', unfocus: interp.relation === 'side_topic', why: interp.relation };
      if (focused && (!evType || focused.type === evType || retypable(focused, evType))) return toCase(focused, 'case data during small talk', evType);
      break;
    }
    case 'new_issue':
      break;
  }

  // New issue (or nothing else fitted).
  const type: CaseType | undefined =
    interp.caseType && interp.caseType !== 'other' ? interp.caseType : evType ?? interp.caseType ?? (interp.intent === 'payment_issue_unclear' ? 'other' : undefined);
  if (!type) return focused ? toCase(focused, 'fallback to focused') : { kind: 'none', unfocus: false, why: 'no case type' };

  // A second problem of the same kind while the first is already with the team is a new case;
  // the team has the first one in full, and the customer needs a fresh request for this one.
  const anotherForTeam = interp.relation === 'new_issue' && focused?.status === 'escalated';
  if (focused && (focused.type === type || retypable(focused, type)) && !differentTransaction(focused, signals, turnEvidence) && !anotherForTeam) {
    return toCase(focused, 'same issue restated', type);
  }
  const windowMs = r.reopenWindowHours * 3_600_000;
  const recent = cases.find(
    (c) => c !== focused && c.type === type && !(anotherForTeam && c.status === 'escalated') && r.now.getTime() - c.lastActivityAt.getTime() < windowMs && !differentTransaction(c, signals, turnEvidence),
  );
  if (recent && interp.intent !== 'payment_issue_unclear') return toCase(recent, 'recent case of same type');

  const clarify = type === 'other' && interp.intent === 'payment_issue_unclear';
  return { kind: 'create', type, step: clarify ? 'clarify_type' : 'start', why: 'new issue' };
}
