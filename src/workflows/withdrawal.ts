import { resolveReference } from '../context/references.js';
import { isFinalPayoutStatus, type LookupResult, type PayoutDetails } from '../domain/admin.js';
import type { Slot } from '../domain/cases.js';
import type { EvidenceItem, WithdrawalCandidate } from '../domain/evidence.js';
import { canonicalBank } from '../evidence/banks.js';
import type { Act } from '../response/acts.js';
import { shortMaskAccount } from '../security/masking.js';
import { checkStatementAgainstPayout, isSameAccount } from '../verification/statementCheck.js';
import {
  absorb, asked, askLimitReached, escalatedFollowup, evidenceNotices, frustrationPreamble, handlePendingPdf, noneAsked,
  requestSlots, setField, type Absorbed,
} from './common.js';
import type { HandoffRequest, Workflow, WorkflowInput, WorkflowOutput } from './types.js';

const informed = (inp: WorkflowInput, key: string) => inp.c.facts.informed.includes(key);
const inform = (inp: WorkflowInput, key: string) => {
  if (!informed(inp, key)) inp.c.facts.informed.push(key);
};

interface Selection {
  selected?: WithdrawalCandidate;
  ambiguous?: boolean;
  rowWithoutId?: WithdrawalCandidate;
}

/**
 * Withdrawal: money withdrawn from the app to a bank account.
 * Withdrawal ID (typed, or read from a history screenshot + "upar wala") → admin payout record
 * (authoritative) → status-specific answer → bank-statement verification only when the user says
 * the money did not arrive.
 */
export class WithdrawalWorkflow implements Workflow {
  async run(inp: WorkflowInput): Promise<WorkflowOutput> {
    const { c } = inp;
    const absorbed = absorb(inp);
    const sel = this.resolveSelection(inp);
    if (c.status === 'escalated') return escalatedFollowup(inp, absorbed);

    const out: WorkflowOutput = { acts: frustrationPreamble(inp), meta: { caseId: c.id, caseType: 'withdrawal' } };
    const pdf = handlePendingPdf(inp, out, absorbed);
    if (pdf === 'waiting') {
      return out;
    }

    // A reference that picked a row replaces the generic "screenshot mil gaya" acknowledgement.
    const pre: Act[] = sel.selected
      ? [{ type: 'candidate_selected', candidate: sel.selected }]
      : evidenceNotices(absorbed);

    if (c.facts.claims.wantsHuman) {
      out.acts.push(...pre);
      return this.handoff(out, { reason: 'user_requested_human' });
    }

    // "kya bhejna hai?" → say what is outstanding right now, without counting it as a new ask.
    if (inp.interp.claims.asksWhatIsNeeded) {
      // Everything from the one-time request that hasn't arrived yet, including the statement.
      const missing: Slot[] = [];
      if (!this.hasReference(c)) missing.push('withdrawal_ref');
      if (!this.hasStatement(c) && (!c.withdrawalId || c.step === 'awaiting_statement')) missing.push('bank_statement');
      if (missing.length) {
        out.acts.push(...pre);
        requestSlots(inp, out, absorbed, missing, { userAsked: true });
        return out;
      }
    }

    if (!c.withdrawalId) return this.collectReference(inp, out, pre, absorbed, sel);

    const res = await this.payout(inp, absorbed);
    if (!res.ok) {
      out.acts.push(...pre);
      // The team will need the statement of the destination account; ask once if we never did
      // (the ID came in the first message, so the one-time request was never sent).
      if (!c.facts.statementEvidenceId && noneAsked(c, ['bank_statement']) && !c.facts.claims.refusesDocuments) {
        requestSlots(inp, out, absorbed, ['bank_statement'], { initial: true });
        c.step = 'awaiting_statement';
        return out;
      }
      return this.handoff(out, { reason: 'verification_unavailable', note: `Payout lookup failed: ${res.error}` });
    }
    if (res.data === null) return this.notFound(inp, out, pre);

    const p = res.data;
    c.facts.payout = { ...p, fetchedAt: res.fetchedAt };
    if (p.amount !== undefined) setField(c, 'amount', p.amount, { source: 'admin', confidence: 1 });
    if (p.utr) setField(c, 'utr', p.utr, { source: 'admin', confidence: 1 });
    const when = p.processedAt ?? p.requestedAt;
    if (when) setField(c, 'txnTime', when, { source: 'admin', confidence: 1 });
    c.confidence = 0.95;
    out.meta = { ...out.meta, refs: { withdrawalId: p.withdrawalId, amount: p.amount } };
    out.acts.push(...pre);

    switch (p.status) {
      case 'SUCCESS':
        return this.onSuccess(inp, out, absorbed, p);
      case 'PROCESSING':
      case 'PENDING': {
        const since = p.requestedAt ? (inp.now.getTime() - Date.parse(p.requestedAt)) / 3_600_000 : 0;
        out.acts.push({ type: 'withdrawal_processing', amount: p.amount });
        c.step = 'processing';
        c.facts.lastAsked = [];
        if (since > inp.deps.cfg.withdrawalSlaHours) {
          return this.handoff(out, { reason: 'withdrawal_sla_breached', note: `Payout ${p.status} for ${Math.round(since)}h` });
        }
        return out;
      }
      case 'FAILED':
      case 'REJECTED':
      case 'REVERSED': {
        const key = `failed:${p.withdrawalId}`;
        if (informed(inp, key) && (c.facts.claims.notReceived || inp.interp.claims.frustrated)) {
          return this.handoff(out, { reason: 'withdrawal_failed_dispute', note: `Payout ${p.status}${p.failureReason ? ` (${p.failureReason})` : ''}; customer disputes` });
        }
        out.acts.push({ type: 'withdrawal_failed', amount: p.amount, reason: p.failureReason });
        inform(inp, key);
        c.step = 'informed_failed';
        c.facts.lastAsked = [];
        return out;
      }
      default:
        return this.handoff(out, { reason: 'insufficient_evidence', note: `Unrecognised payout status "${p.statusRaw ?? ''}"` });
    }
  }

  /** "upar wala", "second wala", "ye wala" → a concrete row / withdrawal ID. */
  private resolveSelection(inp: WorkflowInput): Selection {
    const { c, reply } = inp;
    const ref = inp.interp.reference ?? inp.signals.reference;

    // Swipe-reply to a bot message that was about one specific withdrawal.
    if (reply?.refs?.withdrawalId && (!ref || ref.kind === 'this') && !reply.candidates.length) {
      if (setField(c, 'withdrawalId', reply.refs.withdrawalId, { source: 'reply', confidence: 0.9, messageId: reply.messageId })) c.facts.payout = undefined;
      return {};
    }
    const fromReply = reply?.candidates.length ? reply.candidates : undefined;
    const items = fromReply ?? c.facts.candidates?.items ?? [];
    if (fromReply) c.facts.candidates = { messageId: reply!.messageId, items: fromReply };
    if (!ref || !items.length) return {};

    const r = resolveReference(ref, items);
    if (r.status !== 'resolved') return { ambiguous: true };
    if (!r.item.withdrawalId) return { rowWithoutId: r.item };
    const prov = { source: fromReply ? ('reply' as const) : ('screenshot' as const), confidence: r.item.confidence, messageId: reply?.messageId };
    if (setField(c, 'withdrawalId', r.item.withdrawalId, prov)) {
      c.facts.payout = undefined;
      c.facts.notFoundCount = 0;
    }
    return { selected: r.item };
  }

  /** The two things a withdrawal case needs: a reference (typed ID or history screenshot) and the statement PDF. */
  private hasReference(c: WorkflowInput['c']): boolean {
    return !!c.withdrawalId || !!c.facts.withdrawalEvidenceId;
  }

  private hasStatement(c: WorkflowInput['c']): boolean {
    return !!c.facts.statementEvidenceId && !c.facts.pendingPdf;
  }

  private collectReference(inp: WorkflowInput, out: WorkflowOutput, pre: Act[], absorbed: Absorbed, sel: Selection): WorkflowOutput {
    const { c } = inp;
    const items = c.facts.candidates?.items ?? [];
    out.acts.push(...pre);

    // The history screenshot and the statement are everything the case requires. Without an ID we
    // cannot look the payout up, so the team takes it from here — no picking a row, no more asks.
    if (c.facts.withdrawalEvidenceId && this.hasStatement(c)) {
      return this.handoff(out, { reason: 'verification_unavailable', note: 'Withdrawal ID not confirmed from the history screenshot; team to check the rows' });
    }

    if (sel.ambiguous || items.length > 1) {
      if (askLimitReached(inp, ['withdrawal_choice'])) return this.handoff(out, { reason: 'ambiguous_transaction', note: `${items.length} withdrawals in screenshot; user did not pick one` });
      c.facts.asks.withdrawal_choice = asked(c, 'withdrawal_choice') + 1;
      c.facts.lastAsked = ['withdrawal_choice'];
      c.step = 'awaiting_selection';
      out.acts.push({ type: 'choose_candidate', candidates: items });
      out.meta = { ...out.meta, candidates: items };
      return out;
    }
    if (c.facts.claims.refusesDocuments) return this.handoff(out, { reason: 'user_declined_more_info', declined: true });
    if (askLimitReached(inp, ['withdrawal_ref']) || (inp.interp.claims.frustrated && asked(c, 'withdrawal_ref') > 0)) {
      const row = sel.rowWithoutId ?? items[0];
      return this.handoff(out, { reason: 'max_asks_reached', note: row ? `Screenshot row without a visible ID: ${JSON.stringify(row)}` : 'Withdrawal ID never provided' });
    }
    // One request covers the ID/screenshot and the statement of the destination account.
    const first = noneAsked(c, ['withdrawal_ref', 'bank_statement']) && items.length === 0;
    if (first) {
      const slots: Slot[] = c.facts.statementEvidenceId ? ['withdrawal_ref'] : ['withdrawal_ref', 'bank_statement'];
      requestSlots(inp, out, absorbed, slots, { initial: true });
    } else if (!absorbed.changed && !pre.length) {
      requestSlots(inp, out, absorbed, ['withdrawal_ref']);
    }
    c.step = 'collecting';
    return out;
  }

  private notFound(inp: WorkflowInput, out: WorkflowOutput, pre: Act[]): WorkflowOutput {
    const { c } = inp;
    out.acts.push(...pre);
    c.facts.notFoundCount = (c.facts.notFoundCount ?? 0) + 1;
    const fromScreenshot = c.facts.sources.withdrawalId?.source === 'screenshot' || c.facts.sources.withdrawalId?.source === 'reply';
    // Each new (wrong) ID resets notFoundCount, so the ask limit is what prevents an endless loop.
    if (c.facts.notFoundCount >= 2 || fromScreenshot || askLimitReached(inp, ['withdrawal_ref'])) {
      return this.handoff(out, { reason: 'not_found_in_admin', note: `Withdrawal ID ${c.withdrawalId} not found in admin panel` });
    }
    out.acts.push({ type: 'withdrawal_not_found', withdrawalId: c.withdrawalId! });
    c.facts.asks.withdrawal_ref = asked(c, 'withdrawal_ref') + 1;
    c.facts.lastAsked = ['withdrawal_ref'];
    c.step = 'not_found';
    return out;
  }

  private onSuccess(inp: WorkflowInput, out: WorkflowOutput, absorbed: Absorbed, p: PayoutDetails): WorkflowOutput {
    const { c } = inp;
    const bank = canonicalBank(p.bankName) ?? p.bankName;
    const maskedAccount = shortMaskAccount(p.accountNumber);
    const statement = this.statement(inp);
    const key = `withdrawal_success:${p.withdrawalId}`;

    if (statement) return this.verifyStatement(inp, out, p, statement, bank, maskedAccount);

    if (!c.facts.claims.notReceived) {
      if (!informed(inp, key) || absorbed.changed) out.acts.push({ type: 'withdrawal_success', amount: p.amount, bank, maskedAccount, askStatement: false });
      inform(inp, key);
      c.status = 'resolved';
      c.step = 'informed_success';
      c.facts.resolution = `Payout ${p.withdrawalId} SUCCESS`;
      c.facts.lastAsked = [];
      c.missing = [];
      return out;
    }

    // The user says the money did not arrive: verify against the payout destination account.
    c.status = 'open';
    if (c.facts.claims.refusesDocuments) {
      return this.handoff(out, { reason: 'user_declined_more_info', declined: true, note: 'Payout SUCCESS; customer says not received and cannot share a statement' });
    }
    if (askLimitReached(inp, ['bank_statement'])) {
      return this.handoff(out, { reason: 'withdrawal_credit_missing', note: 'Payout SUCCESS; customer says not received; statement not provided' });
    }
    const noticed = out.acts.some((a) => a.type === 'evidence_unrelated' || a.type === 'evidence_unsupported' || a.type === 'not_a_statement' || a.type === 'statement_unreadable');
    if (!informed(inp, key)) {
      out.acts.push({ type: 'withdrawal_success', amount: p.amount, bank, maskedAccount, askStatement: true });
      inform(inp, key);
      // The one-time request already asked for the statement: this line repeats that standing
      // request with the account named, so it must not count as a second ask.
      if (asked(c, 'bank_statement') === 0) c.facts.asks.bank_statement = 1;
      c.facts.lastAsked = ['bank_statement'];
      c.missing = ['bank_statement'];
    } else if (noticed || absorbed.received.length) {
      // Something arrived (or a file had a problem and was answered): collect it quietly.
      c.step = 'awaiting_statement';
      return out;
    } else if (!c.facts.lastAsked.includes('bank_statement')) {
      out.acts.push({ type: 'ask_statement_for_account', bank, maskedAccount });
      c.facts.asks.bank_statement = asked(c, 'bank_statement') + 1;
      c.facts.lastAsked = ['bank_statement'];
      c.missing = ['bank_statement'];
    } else {
      requestSlots(inp, out, absorbed, ['bank_statement']);
    }
    c.step = 'awaiting_statement';
    return out;
  }

  private verifyStatement(
    inp: WorkflowInput, out: WorkflowOutput, p: PayoutDetails, st: EvidenceItem, bank?: string, maskedAccount?: string,
  ): WorkflowOutput {
    const { c } = inp;
    if (st.status === 'unreadable' || !st.statement) {
      if (!informed(inp, `unreadable:${st.id}`) && !askLimitReached(inp, ['bank_statement'])) {
        out.acts.push({ type: 'statement_unreadable' });
        inform(inp, `unreadable:${st.id}`);
        c.facts.asks.bank_statement = asked(c, 'bank_statement') + 1;
        c.facts.lastAsked = ['bank_statement'];
        // The scanned PDF stays on the case: any PDF counts as the statement for the team.
        return out;
      }
      return this.handoff(out, { reason: 'pdf_unreadable', note: 'Statement PDF could not be read' });
    }

    const check = checkStatementAgainstPayout(st.id, p, st.statement, inp.now);
    c.facts.statementCheck = check;
    const same = isSameAccount(check);

    if (check.transaction.found && same !== false) {
      out.acts.push({ type: 'statement_credit_found', amount: p.amount, date: check.transaction.date, utr: p.utr });
      c.status = 'resolved';
      c.step = 'credit_found';
      c.facts.resolution = `Credit found in customer's statement (${check.transaction.quality})`;
      c.facts.lastAsked = [];
      return out;
    }
    if (same === false) {
      c.facts.statementMismatchCount = (c.facts.statementMismatchCount ?? 0) + 1;
      out.acts.push({ type: 'statement_account_mismatch', bank, maskedAccount });
      c.facts.statementEvidenceId = undefined; // wait for the right account's statement
      if (c.facts.statementMismatchCount >= 2 || c.facts.claims.refusesDocuments) {
        return this.handoff(out, { reason: 'conflicting_evidence', note: 'Statements provided are not for the payout account' });
      }
      c.facts.asks.bank_statement = asked(c, 'bank_statement') + 1;
      c.facts.lastAsked = ['bank_statement'];
      c.step = 'awaiting_statement';
      return out;
    }
    const payoutDate = (p.processedAt ?? p.requestedAt)?.slice(0, 10);
    if (same === true && check.coversPayoutDate === false && payoutDate && !informed(inp, 'statement_outdated')) {
      out.acts.push({ type: 'statement_outdated', payoutDate });
      inform(inp, 'statement_outdated');
      c.facts.statementEvidenceId = undefined;
      c.facts.asks.bank_statement = asked(c, 'bank_statement') + 1;
      c.facts.lastAsked = ['bank_statement'];
      return out;
    }
    const note = same === true
      ? 'Statement verified for the payout account; the payout credit is NOT in the statement'
      : 'Could not confirm the statement account (no comparable account number); payout credit not found';
    return this.handoff(out, { reason: 'withdrawal_credit_missing', note });
  }

  private statement(inp: WorkflowInput): EvidenceItem | undefined {
    const id = inp.c.facts.statementEvidenceId;
    return id ? inp.caseEvidence.find((e) => e.id === id && e.status !== 'needs_password') : undefined;
  }

  private handoff(out: WorkflowOutput, req: HandoffRequest): WorkflowOutput {
    out.handoff = req;
    return out;
  }

  private async payout(inp: WorkflowInput, absorbed: Absorbed): Promise<LookupResult<PayoutDetails | null>> {
    const { c, now, deps } = inp;
    const cached = c.facts.payout;
    if (cached && cached.withdrawalId.toUpperCase() === c.withdrawalId!.toUpperCase()) {
      const age = now.getTime() - Date.parse(cached.fetchedAt);
      const final = isFinalPayoutStatus(cached.status);
      if (final || (age < deps.cfg.refreshMinutes * 60_000 && !absorbed.changed)) {
        const { fetchedAt, ...payout } = cached;
        return { ok: true, data: payout, fetchedAt, cached: true };
      }
    }
    return deps.admin.findPayout(c.withdrawalId!);
  }
}
