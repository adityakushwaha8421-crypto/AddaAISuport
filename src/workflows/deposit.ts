import type { DepositOrder, LookupResult } from '../domain/admin.js';
import type { Slot } from '../domain/cases.js';
import type { EvidenceItem } from '../domain/evidence.js';
import { matchDeposit } from '../verification/depositMatch.js';
import { findTransaction } from '../verification/statementCheck.js';
import {
  absorb, asked, askLimitReached, escalatedFollowup, evidenceNotices, frustrationPreamble, handlePendingPdf, noneAsked,
  requestSlots, setField, type Absorbed,
} from './common.js';
import type { Workflow, WorkflowInput, WorkflowOutput } from './types.js';

const informed = (inp: WorkflowInput, key: string) => inp.c.facts.informed.includes(key);
const inform = (inp: WorkflowInput, key: string) => {
  if (!informed(inp, key)) inp.c.facts.informed.push(key);
};

function statementOf(inp: WorkflowInput): EvidenceItem | undefined {
  const id = inp.c.facts.statementEvidenceId;
  return id ? inp.caseEvidence.find((e) => e.id === id) : undefined;
}

/**
 * Deposit: money paid into the app but wallet not credited.
 * Goal: find the order for the customer's payment and report its real status; ask only for what
 * the next lookup genuinely needs; hand off when the admin panel can't settle it.
 */
export class DepositWorkflow implements Workflow {
  async run(inp: WorkflowInput): Promise<WorkflowOutput> {
    const { c, interp } = inp;
    const absorbed = absorb(inp);
    if (c.status === 'escalated') return escalatedFollowup(inp, absorbed);

    const out: WorkflowOutput = { acts: frustrationPreamble(inp), meta: { caseId: c.id, caseType: 'deposit' } };
    const pdf = handlePendingPdf(inp, out, absorbed);
    if (pdf === 'waiting') {
      return out;
    }
    // Receipts are tracked silently; only problems with an attachment are mentioned.
    const pre = evidenceNotices(absorbed);

    if (c.facts.claims.wantsHuman) {
      out.acts.push(...pre);
      out.handoff = { reason: 'user_requested_human' };
      return out;
    }

    // Proof of payment: a receipt, a UTR, or amount + date. (An amount alone is guessable.)
    const hasPayment = !!(c.facts.paymentEvidenceId || c.utr || (c.amount !== undefined && c.txnTime));

    // The case's first request lists every deposit document still missing, in one message:
    // registered number, payment screenshot, bank statement and payment video. Afterwards we only
    // ask for what the next verification step needs, and verify as soon as number + proof exist.
    const firstRequest = noneAsked(c, ['registration_number', 'payment_proof', 'bank_statement', 'payment_video']);
    const firstBatch = (): Slot[] =>
      [
        !c.registrationNumber && 'registration_number',
        !c.facts.paymentEvidenceId && 'payment_proof',
        !c.facts.statementEvidenceId && 'bank_statement',
        !c.facts.paymentVideoEvidenceId && 'payment_video',
      ].filter((s): s is Slot => !!s);

    // The user asked what to send → list exactly what is still outstanding, once, without counting it.
    if (interp.claims.asksWhatIsNeeded && firstBatch().length) {
      out.acts.push(...pre);
      requestSlots(inp, out, absorbed, firstBatch(), { userAsked: true });
      return out;
    }

    // 1. Registration number is the key to every lookup.
    if (!c.registrationNumber) {
      out.acts.push(...pre);
      if (c.facts.claims.refusesDocuments) return this.handoff(out, 'user_declined_more_info', true);
      if (askLimitReached(inp, ['registration_number']) || (interp.claims.frustrated && asked(c, 'registration_number') > 0)) {
        return this.handoff(out, 'max_asks_reached', false, 'Registration number never provided');
      }
      if (firstRequest) requestSlots(inp, out, absorbed, firstBatch(), { initial: true });
      // Documents arriving after the one request: track silently, no "mil gaya / ab ye bhejo".
      // A wrong/unreadable file already got its own notice — don't pile a checklist on top.
      else if (!absorbed.changed && !pre.length) requestSlots(inp, out, absorbed, hasPayment ? ['registration_number'] : ['registration_number', 'payment_proof']);
      c.step = 'collecting';
      return out;
    }

    // 2. Orders for this registration number (authoritative).
    const orders = await this.orders(inp, absorbed);
    // Without proof of payment there is nothing to verify either way, and the team needs that proof
    // too: when the admin panel can't be reached, keep collecting quietly and hand off once it's in.
    if (!orders.ok && hasPayment) {
      out.acts.push(...pre);
      return this.handoff(out, 'verification_unavailable', false, `Deposit lookup failed: ${orders.error}`);
    }
    const list = orders.ok ? orders.data : [];
    const statement = statementOf(inp);

    // 3. No payment details yet. Order details are only disclosed against proof of payment:
    //    anyone can type a phone number, so we never list or confirm orders from the number alone.
    if (!hasPayment) {
      out.acts.push(...pre);
      if (c.facts.claims.refusesDocuments) {
        return this.handoff(out, 'user_declined_more_info', true, orders.ok ? `${list.length} recent orders on this number` : `Deposit lookup failed: ${orders.error}`);
      }
      if (askLimitReached(inp, ['payment_proof'])) return this.handoff(out, 'max_asks_reached', false, 'Payment details never provided');
      if (firstRequest) requestSlots(inp, out, absorbed, firstBatch(), { initial: true });
      else if (!absorbed.changed && !pre.length) requestSlots(inp, out, absorbed, ['payment_proof']);
      c.step = 'collecting';
      return out;
    }

    // 4. Match the customer's payment against the orders.
    const m = matchDeposit({ amount: c.amount, utr: c.utr, when: c.txnTime }, list);
    c.facts.deposit = { ...(c.facts.deposit ?? { orders: list, fetchedAt: inp.now.toISOString() }), quality: m.quality, matchedOrderId: m.order?.orderId };
    c.confidence = { exact_utr: 0.97, amount_and_time: 0.85, amount_only: 0.6, single_recent: 0.5, ambiguous: 0.3, none: 0.2 }[m.quality];

    const usable = m.order && (m.quality !== 'amount_only' || m.order.status === 'SUCCESS' || list.length === 1);
    if (m.order && usable) return this.onMatchedOrder(inp, out, pre, absorbed, m.order, statement);

    if (m.quality === 'ambiguous') {
      out.acts.push(...pre);
      if (!c.utr && asked(c, 'utr') === 0 && !c.facts.claims.refusesDocuments) {
        requestSlots(inp, out, absorbed, ['utr']);
        return out;
      }
      return this.handoff(out, 'ambiguous_transaction', false, `${m.candidates.length} orders match the payment`);
    }

    // 5. Not matched.
    out.acts.push(...pre);
    if (statement) return this.verifyDebitAndHandoff(inp, out, statement, 'No order matched the payment');
    if (!c.facts.claims.confirmedRegistration && !informed(inp, 'not_matched')) {
      out.acts.push({ type: 'deposit_not_matched', askStatement: true });
      inform(inp, 'not_matched');
      c.facts.asks.bank_statement = asked(c, 'bank_statement') + 1;
      c.facts.lastAsked = ['registration_number', 'bank_statement'];
      c.step = 'not_matched';
      return out;
    }
    if (c.facts.claims.refusesDocuments) return this.handoff(out, 'user_declined_more_info', true, 'No order matched the payment');
    if (askLimitReached(inp, ['bank_statement'])) return this.handoff(out, 'insufficient_evidence', false, 'No order matched; statement not provided');
    requestSlots(inp, out, absorbed, ['bank_statement']);
    c.step = 'awaiting_statement';
    return out;
  }

  private onMatchedOrder(
    inp: WorkflowInput, out: WorkflowOutput, pre: WorkflowOutput['acts'], absorbed: Absorbed, order: DepositOrder, statement?: EvidenceItem,
  ): WorkflowOutput {
    const { c } = inp;
    setField(c, 'orderId', order.orderId, { source: 'admin', confidence: 1 });
    if (order.amount !== undefined) setField(c, 'amount', order.amount, { source: 'admin', confidence: 1 });
    if (order.utr) setField(c, 'utr', order.utr, { source: 'admin', confidence: 1 });
    out.meta = { ...out.meta, refs: { orderId: order.orderId, amount: order.amount } };
    out.acts.push(...pre);

    switch (order.status) {
      case 'SUCCESS':
        // Already told them it succeeded and they insist it isn't in the wallet: a human must look.
        if (informed(inp, `success:${order.orderId}`) && (inp.interp.claims.notReceived || inp.interp.claims.frustrated)) {
          c.status = 'open';
          return this.handoff(out, 'deposit_not_reflected', false, `Order ${order.orderId} is SUCCESS but customer says the wallet is not credited`);
        }
        inform(inp, `success:${order.orderId}`);
        out.acts.push({ type: 'deposit_success', orderId: order.orderId, amount: order.amount });
        c.status = 'resolved';
        c.step = 'resolved';
        c.facts.resolution = `Order ${order.orderId} already SUCCESS`;
        c.missing = [];
        c.facts.lastAsked = [];
        return out;
      case 'PENDING':
      case 'FAILED': {
        const pay = c.facts.paymentEvidenceId ? inp.caseEvidence.find((e) => e.id === c.facts.paymentEvidenceId)?.payment : undefined;
        const strongProof = pay?.status?.value === 'success' && !!pay.utr && pay.utr.origin !== 'vision' && pay.utr.confidence >= 0.8;
        if (statement) return this.verifyDebitAndHandoff(inp, out, statement, `Order ${order.orderId} is ${order.status}`);
        if (strongProof) {
          // A verified UTR on a successful receipt is enough for the team; no statement needed.
          // (The failed-order template asks for a statement, so it is not used here.)
          if (order.status === 'PENDING') out.acts.push({ type: 'deposit_pending', orderId: order.orderId, amount: order.amount });
          return this.handoff(out, 'deposit_not_reflected', false, `Order ${order.orderId} is ${order.status}; payment screenshot shows success with UTR ${c.utr}`);
        }
        if (c.facts.claims.refusesDocuments) return this.handoff(out, 'user_declined_more_info', true, `Order ${order.orderId} is ${order.status}`);
        if (askLimitReached(inp, ['bank_statement'])) return this.handoff(out, 'deposit_not_reflected', false, `Order ${order.orderId} is ${order.status}; statement not provided`);
        if (order.status === 'FAILED' && !informed(inp, `failed:${order.orderId}`)) {
          out.acts.push({ type: 'deposit_failed', orderId: order.orderId, amount: order.amount });
          inform(inp, `failed:${order.orderId}`);
          c.facts.asks.bank_statement = asked(c, 'bank_statement') + 1;
          c.facts.lastAsked = ['bank_statement'];
        } else {
          if (order.status === 'PENDING' && !informed(inp, `pending:${order.orderId}`)) {
            out.acts.push({ type: 'deposit_pending', orderId: order.orderId, amount: order.amount });
            inform(inp, `pending:${order.orderId}`);
          }
          requestSlots(inp, out, absorbed, ['bank_statement']);
        }
        c.step = 'awaiting_statement';
        return out;
      }
      default:
        return this.handoff(out, 'insufficient_evidence', false, `Order ${order.orderId} has unrecognised status ${order.statusRaw ?? ''}`);
    }
  }

  /** The customer's statement can prove the debit; crediting it is a human decision. */
  private verifyDebitAndHandoff(inp: WorkflowInput, out: WorkflowOutput, statement: EvidenceItem, context: string): WorkflowOutput {
    const { c } = inp;
    if (statement.status === 'unreadable') {
      if (!informed(inp, `unreadable:${statement.id}`) && !askLimitReached(inp, ['bank_statement'])) {
        out.acts.push({ type: 'statement_unreadable' });
        inform(inp, `unreadable:${statement.id}`);
        c.facts.asks.bank_statement = asked(c, 'bank_statement') + 1;
        c.facts.lastAsked = ['bank_statement'];
        return out;
      }
      return this.handoff(out, 'pdf_unreadable', false, context);
    }
    if (statement.category !== 'bank_statement' || !statement.statement) return this.handoff(out, 'insufficient_evidence', false, `${context}; statement not usable`);
    const r = findTransaction(statement.statement.lines, { amount: c.amount, date: c.txnTime?.slice(0, 10), utr: c.utr });
    const note = r.found ? `${context}. Debit found in customer's statement (${r.quality}): ${r.line}` : `${context}. Debit NOT found in customer's statement.`;
    return this.handoff(out, 'deposit_not_reflected', false, note);
  }

  private handoff(out: WorkflowOutput, reason: NonNullable<WorkflowOutput['handoff']>['reason'], declined = false, note?: string): WorkflowOutput {
    out.handoff = { reason, declined, note };
    return out;
  }

  private async orders(inp: WorkflowInput, absorbed: Absorbed): Promise<LookupResult<DepositOrder[]>> {
    const { c, now, deps } = inp;
    const d = c.facts.deposit;
    const age = d ? now.getTime() - Date.parse(d.fetchedAt) : Infinity;
    const stale = age > deps.cfg.refreshMinutes * 60_000;
    const newPayment = absorbed.received.includes('payment_screenshot') || absorbed.received.includes('utr');
    if (d && !stale && !newPayment) return { ok: true, data: d.orders, fetchedAt: d.fetchedAt, cached: true };
    const res = await deps.admin.findDeposits({
      registrationNumber: c.registrationNumber!,
      from: new Date(now.getTime() - deps.cfg.depositLookbackDays * 86_400_000),
    });
    if (res.ok) c.facts.deposit = { orders: res.data, fetchedAt: res.fetchedAt, quality: 'none' };
    return res;
  }
}
