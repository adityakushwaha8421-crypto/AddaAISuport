import type { CaseField, CaseRecord, FactProvenance, FactSource, Slot } from '../domain/cases.js';
import { isPaymentEvidence, isUnanalysedVideo, isWithdrawalEvidence, type EvidenceItem } from '../domain/evidence.js';
import { preferredRegistrationNumber } from '../domain/memory.js';
import { bestEntities } from '../nlu/entities.js';
import { PASSWORD_PLACEHOLDER } from '../nlu/password.js';
import type { Act, ReceivedItem } from '../response/acts.js';
import type { WorkflowInput, WorkflowOutput } from './types.js';

// ── Facts with provenance ──────────────────────────────────────────────────

const RANK: Record<FactSource, number> = { admin: 5, statement: 4, screenshot: 3, reply: 3, text: 2, llm: 1, memory: 0 };
/** Identifiers the user may correct explicitly ("number dusra hai …"). */
const USER_CORRECTABLE: CaseField[] = ['registrationNumber', 'withdrawalId', 'orderId'];

/** Set a case field respecting source precedence. Admin data is never overwritten by claims. */
export function setField<K extends CaseField>(c: CaseRecord, field: K, value: CaseRecord[K], prov: FactProvenance): boolean {
  if (value === undefined || value === null || value === '') return false;
  const existing = c.facts.sources[field];
  if (c[field] === value) {
    if (!existing || RANK[prov.source] > RANK[existing.source]) c.facts.sources[field] = prov;
    return false;
  }
  if (existing) {
    if (existing.source === 'admin' && prov.source !== 'admin') return false;
    const correctable = USER_CORRECTABLE.includes(field) && (prov.source === 'text' || prov.source === 'reply');
    if (!correctable && RANK[prov.source] < RANK[existing.source]) return false;
  }
  (c as unknown as Record<string, unknown>)[field] = value;
  c.facts.sources[field] = prov;
  return true;
}

export interface Absorbed {
  received: ReceivedItem[];
  /** Something new and useful arrived this turn. */
  changed: boolean;
  unrelatedEvidence: EvidenceItem[];
  unsupportedEvidence: EvidenceItem[];
}

const toIsoDateTime = (date?: string, time?: string) => (date ? `${date}T${time ?? '12:00'}:00+05:30` : undefined);

/**
 * Pull everything useful out of this turn — text entities, reply context, evidence — into the case.
 * This is what makes "never ask twice" possible: every source is consulted before any request.
 */
/** A processed screenshot of the app (payment / account / technical screen), as opposed to a statement, a match screen or an unrelated photo. */
const isAppScreen = (e: EvidenceItem): boolean =>
  e.status === 'processed' && (e.category === 'payment_screenshot' || e.category === 'account_screenshot' || e.category === 'technical_screenshot');

export function absorb(inp: WorkflowInput): Absorbed {
  const { c, signals, interp, turnEvidence, lastMessageId } = inp;
  const received: ReceivedItem[] = [];
  let changed = false;
  const prov = (source: FactSource, confidence: number, evidenceId?: string): FactProvenance => ({
    source, confidence, messageId: lastMessageId, ...(evidenceId ? { evidenceId } : {}),
  });
  const e = bestEntities(signals.entities);

  // Registration number (text, or an LLM reading that is literally in the text).
  const reg = e.registrationNumber?.value ?? interp.proposed?.registrationNumber?.replace(/\D/g, '');
  if (reg && /^\d{6,15}$|^[A-Z0-9]{4,}$/i.test(reg)) {
    // The message that carried the number (a burst may hold the number and a video): that is
    // the message forwarded to the team as the number's evidence.
    const carrier = inp.turnMessages.find((m) => m.text.replace(/[\s-]/g, '').includes(reg))?.messageId ?? lastMessageId;
    if (setField(c, 'registrationNumber', reg, { ...prov('text', e.registrationNumber?.confidence ?? 0.7), messageId: carrier })) {
      received.push('registration_number');
      c.facts.deposit = undefined; // a different number means different orders
      c.facts.claims.confirmedRegistration = false;
      changed = true;
    }
  }
  if (interp.claims.confirmsDetails && c.registrationNumber) c.facts.claims.confirmedRegistration = true;

  if (c.type === 'withdrawal') {
    const wid = e.withdrawalId?.value ?? interp.proposed?.withdrawalId?.toUpperCase();
    const carrier = wid ? inp.turnMessages.find((m) => m.text.toUpperCase().includes(wid))?.messageId ?? lastMessageId : lastMessageId;
    if (wid && setField(c, 'withdrawalId', wid, { ...prov('text', e.withdrawalId?.confidence ?? 0.7), messageId: carrier })) {
      received.push('withdrawal_id');
      c.facts.payout = undefined;
      c.facts.notFoundCount = 0;
      changed = true;
    }
  }
  if (c.type === 'deposit') {
    const oid = e.orderId?.value ?? interp.proposed?.orderId;
    if (oid && setField(c, 'orderId', oid, prov('text', e.orderId?.confidence ?? 0.7))) changed = true;
    const utr = e.utr?.value ?? interp.proposed?.utr;
    if (utr && setField(c, 'utr', utr, prov('text', e.utr?.confidence ?? 0.7))) {
      received.push('utr');
      changed = true;
    }
    const amount = e.amount?.value ?? interp.proposed?.amount;
    if (amount !== undefined && c.amount === undefined && setField(c, 'amount', amount, prov('text', e.amount?.confidence ?? 0.6))) changed = true;
    if (e.date && !c.txnTime && setField(c, 'txnTime', toIsoDateTime(e.date.value), prov('text', e.date.confidence))) changed = true;
  }

  // Returning customer: reuse the number they already proved, instead of asking for it again.
  if (!c.registrationNumber) {
    const known = preferredRegistrationNumber(inp.memory);
    if (known) setField(c, 'registrationNumber', known.value, { source: 'memory', confidence: known.verified ? 0.8 : 0.5 });
  }

  const unrelated: EvidenceItem[] = [];
  const unsupported: EvidenceItem[] = [];
  for (const { evidence: ev, duplicate } of turnEvidence) {
    if (!c.facts.evidenceIds.includes(ev.id)) c.facts.evidenceIds.push(ev.id);
    // A video we asked for but can't analyse here (no ffmpeg) is still evidence: keep it for the team.
    if (isUnanalysedVideo(ev)) {
      if (c.type === 'deposit') c.facts.paymentVideoEvidenceId = ev.id;
      if (!duplicate) received.push(c.type === 'deposit' ? 'payment_video' : 'video');
      changed = true;
      continue;
    }
    if (ev.status === 'unsupported' || ev.status === 'failed') {
      unsupported.push(ev);
      continue;
    }
    if (c.type === 'withdrawal' && isAppScreen(ev)) {
      // A withdrawal case needs one screenshot: the withdrawal history. A screen of the app that the
      // classifier read as a payment or account screen is that screenshot (any PDF is the statement
      // the same way); the team reads the rows, no ID is extracted from it here.
      c.facts.withdrawalEvidenceId = ev.id;
      if (!duplicate) received.push('withdrawal_screenshot');
      changed = true;
    } else if (isPaymentEvidence(ev)) {
      c.facts.paymentEvidenceId = ev.id;
      const recording = ev.category === 'payment_recording';
      if (recording) c.facts.paymentVideoEvidenceId = ev.id;
      if (!duplicate) received.push(recording ? 'payment_video' : 'payment_screenshot');
      const p = ev.payment;
      if (p?.amount && p.amount.confidence >= 0.6) setField(c, 'amount', p.amount.value, prov('screenshot', p.amount.confidence, ev.id));
      if (p?.utr && p.utr.confidence >= 0.6) setField(c, 'utr', p.utr.value, prov('screenshot', p.utr.confidence, ev.id));
      if (p?.date) setField(c, 'txnTime', toIsoDateTime(p.date.value, p.time?.value), prov('screenshot', p.date.confidence, ev.id));
      changed = true;
    } else if (isWithdrawalEvidence(ev)) {
      c.facts.withdrawalEvidenceId = ev.id;
      if (!duplicate) received.push('withdrawal_screenshot');
      const items = ev.withdrawals ?? [];
      c.facts.candidates = { evidenceId: ev.id, messageId: ev.messageId, items };
      const only = items.length === 1 ? items[0] : undefined;
      if (only?.withdrawalId && setField(c, 'withdrawalId', only.withdrawalId, prov('screenshot', only.confidence, ev.id))) {
        c.facts.payout = undefined;
      }
      changed = true;
    } else if (ev.category === 'bank_statement') {
      c.facts.statementEvidenceId = ev.id;
      if (ev.status === 'needs_password') c.facts.pendingPdf = { evidenceId: ev.id, attempts: 0 };
      else {
        if (c.facts.pendingPdf && c.facts.pendingPdf.evidenceId !== ev.id) c.facts.pendingPdf = undefined; // superseded
        if (!duplicate) received.push('bank_statement');
        c.facts.statementCheck = undefined;
      }
      changed = true;
    } else if (ev.category === 'match_screenshot') {
      // Match problems are filed in the "Match issues" folder for humans; they are not case evidence.
      continue;
    } else if (ev.category === 'other_document') {
      unrelated.push(ev);
    } else if (ev.category === 'unrelated' || ev.category === 'unknown') {
      // Stickers and GIFs are reactions, not evidence: ignore them without comment.
      if (ev.mediaKind === 'sticker' || ev.mediaKind === 'animation') continue;
      (ev.status === 'unreadable' ? unsupported : unrelated).push(ev);
    } else {
      if (!duplicate) received.push('screenshot');
      changed = true;
    }
  }

  // Sticky claims.
  if (interp.claims.notReceived && !c.facts.claims.notReceived) {
    c.facts.claims.notReceived = true;
    changed = true;
  }
  if (interp.claims.refusesDocuments) c.facts.claims.refusesDocuments = true;
  if (interp.claims.wantsHuman) c.facts.claims.wantsHuman = true;

  const said = signals.text.trim();
  if (said && said !== PASSWORD_PLACEHOLDER) {
    c.facts.description = [...c.facts.description, said.slice(0, 300)].slice(-12);
  }
  c.lastActivityAt = inp.now;
  return { received: [...new Set(received)], changed, unrelatedEvidence: unrelated, unsupportedEvidence: unsupported };
}

// ── Asking ────────────────────────────────────────────────────────────────

export const asked = (c: CaseRecord, slot: Slot) => c.facts.asks[slot] ?? 0;
/** True while none of a workflow's own documents have been requested yet (its one-time request). */
export const noneAsked = (c: CaseRecord, slots: Slot[]) => slots.every((s) => asked(c, s) === 0);
export const askLimitReached = (inp: WorkflowInput, slots: Slot[]) =>
  slots.some((s) => asked(inp.c, s) >= inp.deps.cfg.maxAsksPerSlot);

const sameSlots = (a: Slot[], b: Slot[]) => a.length === b.length && a.every((s) => b.includes(s));

/**
 * Request slots with minimum friction:
 *  - first time in a case → one batched "initial" request
 *  - same outstanding request and nothing new → gentle reminder (not counted as a new ask)
 *  - user says they already sent it → "not received yet" (never pretend we got it)
 */
/** True when the turn carries nothing that answers, chases or explains the outstanding request. */
function unrelatedToRequest(inp: WorkflowInput): boolean {
  if (inp.interp.intent !== 'general_query' && inp.interp.intent !== 'unclear') return false;
  return !Object.values(inp.interp.claims).some(Boolean) && !inp.signals.reference;
}

export function requestSlots(inp: WorkflowInput, out: WorkflowOutput, absorbed: Absorbed, slots: Slot[], opts: { initial?: boolean; userAsked?: boolean } = {}): void {
  const { c } = inp;
  let mode: Extract<Act, { type: 'ask' }>['mode'];
  // "ok" / "baad mein bhejta hoon" are answers to the request, not ignoring it: acknowledge, don't count.
  if ((inp.interp.claims.willSendLater || inp.interp.intent === 'acknowledgement') && !absorbed.changed) {
    out.acts.push(inp.interp.claims.willSendLater ? { type: 'promise_noted' } : { type: 'ack' });
    c.facts.lastAsked = slots;
    c.missing = slots;
    return;
  }
  const prev = c.facts.lastAsked;
  // The user asked what to send: answer with the full outstanding list, and don't count it as an ask.
  if (opts.userAsked) {
    c.facts.lastAsked = slots;
    c.missing = slots;
    out.acts.push({ type: 'ask', slots, mode: 'initial', caseType: c.type });
    return;
  }
  if (opts.initial && slots.every((s) => asked(c, s) === 0)) mode = 'initial';
  else if (inp.interp.claims.alreadySent && !absorbed.changed) mode = 'not_found_yet';
  else if (!absorbed.changed && sameSlots(prev, slots)) mode = 'reminder';
  else mode = 'followup';
  // Never repeat a request the customer already has: note what is still outstanding, quietly.
  if (mode === 'reminder') {
    c.missing = slots;
    return;
  }
  // Nothing in this turn invites a repeat of the request: a wordless message (sticker, stray photo)
  // is not a question, and a message we could not tie to the case is not an answer to it. Record
  // what is still outstanding and stay quiet rather than nudge or guess.
  if (!opts.initial && !absorbed.changed && (!inp.signals.text.trim() || unrelatedToRequest(inp))) {
    c.missing = slots;
    return;
  }
  // A request counts against the limit when it is new, or when the user made no progress since we
  // last asked. Asking for the remaining item right after partial progress is batch-then-confirm,
  // not a repeat.
  for (const s of slots) {
    if (asked(c, s) === 0 || !prev.includes(s) || !absorbed.changed) c.facts.asks[s] = asked(c, s) + 1;
  }
  c.facts.lastAsked = slots;
  c.missing = slots;
  out.acts.push({ type: 'ask', slots, mode, caseType: c.type });
}

export function evidenceNotices(absorbed: Absorbed): Act[] {
  const acts: Act[] = [];
  const unsupported = absorbed.unsupportedEvidence[0];
  if (unsupported) {
    const what = unsupported.mediaKind === 'voice' || unsupported.mediaKind === 'audio'
      ? 'voice'
      : unsupported.mediaKind === 'video' || unsupported.mediaKind === 'video_note'
        ? 'video'
        : unsupported.mediaKind === 'document' && unsupported.category !== 'unknown'
          ? 'file'
          : 'image';
    acts.push({ type: 'evidence_unsupported', what });
  } else if (absorbed.unrelatedEvidence.some((e) => e.category === 'other_document')) {
    // A PDF that is not a bank statement: say so even when other files in the burst were fine,
    // otherwise the customer thinks the statement went through and waits for nothing.
    acts.push({ type: 'not_a_statement' });
  } else if (absorbed.unrelatedEvidence.length && !absorbed.received.length) {
    acts.push({ type: 'evidence_unrelated' });
  }
  return acts;
}

// ── PDF password ───────────────────────────────────────────────────────────

/**
 * Drives the encrypted-PDF sub-flow. Returns 'waiting' when the turn's response is about the
 * password; 'ready' when the statement is now readable (or was superseded); 'none' otherwise.
 */
export function handlePendingPdf(inp: WorkflowInput, out: WorkflowOutput, absorbed: Absorbed): 'waiting' | 'ready' | 'none' {
  const { c, unlock, signals, interp, deps } = inp;
  const pend = c.facts.pendingPdf;
  if (!pend) return 'none';

  if (unlock && unlock.evidenceId === pend.evidenceId) {
    if (unlock.ok) {
      c.facts.pendingPdf = undefined;
      c.facts.statementCheck = undefined;
      if (!unlock.unreadable) absorbed.received.push('bank_statement');
      c.facts.lastAsked = c.facts.lastAsked.filter((s) => s !== 'pdf_password');
      return 'ready';
    }
    pend.attempts += unlock.tried;
    if (pend.attempts >= deps.cfg.maxPasswordAttempts) {
      c.facts.pendingPdf = undefined;
      out.handoff = { reason: 'pdf_unreadable', note: `PDF password failed ${pend.attempts} times` };
      return 'waiting';
    }
    out.acts.push({ type: 'pdf_password_wrong' });
    c.facts.lastAsked = ['pdf_password'];
    return 'waiting';
  }

  if (signals.skipPassword || interp.claims.refusesDocuments) {
    c.facts.pendingPdf = undefined;
    out.handoff = { reason: 'user_declined_more_info', declined: true, note: 'User could not provide the PDF password' };
    return 'waiting';
  }

  const justUploaded = inp.turnEvidence.some((r) => r.evidence.id === pend.evidenceId && !r.duplicate);
  if (justUploaded || asked(c, 'pdf_password') === 0) {
    c.facts.asks.pdf_password = asked(c, 'pdf_password') + 1;
    c.facts.lastAsked = ['pdf_password'];
    out.acts.push({ type: 'pdf_password_needed' });
    return 'waiting';
  }
  if (asked(c, 'pdf_password') > deps.cfg.maxAsksPerSlot) {
    c.facts.pendingPdf = undefined;
    out.handoff = { reason: 'max_asks_reached', note: 'PDF password never provided' };
    return 'waiting';
  }
  requestSlots(inp, out, absorbed, ['pdf_password']);
  return 'waiting';
}

// ── Escalated cases ────────────────────────────────────────────────────────

/** The case is with humans: never restart automation; forward genuinely new info. */
export function escalatedFollowup(inp: WorkflowInput, absorbed: Absorbed): WorkflowOutput {
  // Humans own this case now: new information reaches them through the ticket, silently.
  // Problems with an attachment are still worth saying — that is feedback, not an escalation claim.
  const out: WorkflowOutput = { acts: evidenceNotices(absorbed) };
  // A locked PDF blocks the humans too, so it is still worth one password request.
  if (inp.turnEvidence.some((r) => !r.duplicate && r.evidence.status === 'needs_password')) out.acts.push({ type: 'pdf_password_needed' });
  const newEvidence = inp.turnEvidence.filter((r) => !r.duplicate).map((r) => r.evidence.messageId);
  const { claims } = inp.interp;
  // What the customer says matters to the team once per kind ("statement nahi hai", "abhi bhi nahi
  // aaya"); pings like "kya hua?" and the same complaint repeated would only flood the ticket.
  const REMARKS = ['refusesDocuments', 'notReceived', 'wantsHuman', 'frustrated'] as const;
  const newRemarks = REMARKS.filter((k) => claims[k] && !inp.c.facts.informed.includes(`team_told:${k}`));
  if (absorbed.received.length || newEvidence.length) {
    out.ticketUpdate = {
      note: `Customer sent more information: ${absorbed.received.join(', ') || 'attachment'}. ${inp.signals.text.slice(0, 300)}`.trim(),
      evidenceMessageIds: [...new Set(newEvidence)],
    };
  } else if (newRemarks.length && inp.signals.text.trim()) {
    for (const k of newRemarks) inp.c.facts.informed.push(`team_told:${k}`);
    out.ticketUpdate = { note: `Customer says: "${inp.signals.text.slice(0, 400)}"`, evidenceMessageIds: [] };
  } else if (inp.interp.intent === 'thanks') {
    out.acts.push({ type: 'thanks' });
  }
  return out;
}

/** Common preamble for frustrated users: acknowledge, and never make them repeat themselves. */
export function frustrationPreamble(inp: WorkflowInput): Act[] {
  if (!inp.interp.claims.frustrated) return [];
  const { c } = inp;
  const hasDetails = !!(c.registrationNumber || c.withdrawalId || c.orderId || c.utr || c.facts.evidenceIds.length);
  return [{ type: 'frustration_ack', hasDetails }];
}
