import type { Logger } from 'pino';
import type { CaseRecord } from '../domain/cases.js';
import type { EvidenceItem } from '../domain/evidence.js';
import type { Metrics } from '../observability/metrics.js';
import type { StoredMessage, Store, TicketRecord, UserRecord } from '../storage/types.js';
import type { Transport } from '../telegram/transport.js';
import type { HandoffRequest } from '../workflows/types.js';
import { buildHandoffSummary, renderSupportMessage, type HandoffSummary } from './summary.js';

export interface HandoffDeps {
  store: Store;
  transport: Pick<Transport, 'sendText' | 'forwardMessage'>;
  supportChatId?: string;
  log: Logger;
  metrics?: Metrics;
  /** Optional one-paragraph conversation summary (LLM); failures are ignored. */
  summarise?: (c: CaseRecord, history: StoredMessage[]) => Promise<string | undefined>;
}

export interface EscalationResult {
  ticket: TicketRecord;
  delivered: boolean;
  alreadyDelivered: boolean;
}

/**
 * Human handoff as a first-class workflow. Ticket creation and support-group delivery are
 * separate states; callers may only tell the customer "forwarded" when `delivered` is true.
 */
export class HandoffService {
  constructor(private readonly deps: HandoffDeps) {}

  /** Without a support group, tickets are recorded but can never be delivered. */
  get configured(): boolean {
    return !!this.deps.supportChatId;
  }

  async escalate(c: CaseRecord, req: HandoffRequest, ctx: { user: UserRecord; evidence: EvidenceItem[]; history: StoredMessage[] }): Promise<EscalationResult> {
    const aiSummary = await this.deps.summarise?.(c, ctx.history).catch(() => undefined);
    const summary = buildHandoffSummary({ c, reason: req.reason, note: req.note, user: ctx.user, evidence: ctx.evidence, history: ctx.history, aiSummary });
    const { ticket, created } = await this.deps.store.tickets.createIfAbsent({
      caseId: c.id, userId: c.userId, chatId: c.chatId, reason: req.reason, summary: summary as unknown as Record<string, unknown>,
    });
    if (!created && ticket.status === 'delivered') return { ticket, delivered: true, alreadyDelivered: true };
    const current = created ? ticket : await this.deps.store.tickets.update(ticket.id, { reason: req.reason, summary: summary as unknown as Record<string, unknown> });
    const res = await this.deliver(current);
    this.deps.metrics?.handoffs.inc({ reason: req.reason, delivered: res.delivered });
    return { ticket: res.ticket, delivered: res.delivered, alreadyDelivered: false };
  }

  /** Post the ticket to the support group (and forward the customer's evidence messages). */
  async deliver(ticket: TicketRecord): Promise<{ ticket: TicketRecord; delivered: boolean }> {
    const { store, transport, supportChatId, log } = this.deps;
    if (!supportChatId) {
      const t = await store.tickets.update(ticket.id, { status: 'failed', attempts: ticket.attempts + 1, lastError: 'SUPPORT_GROUP_CHAT_ID not configured' });
      log.warn({ ticket: ticket.id, case: ticket.caseId, reason: ticket.reason }, 'ticket recorded but not delivered: no support group configured');
      return { ticket: t, delivered: false };
    }
    const summary = ticket.summary as unknown as HandoffSummary;
    try {
      const sent = await transport.sendText(supportChatId, renderSupportMessage(summary));
      for (const mid of summary.evidenceMessageIds ?? []) {
        await transport.forwardMessage(ticket.chatId, mid, supportChatId).catch((err) => log.warn({ err, mid }, 'evidence forward failed'));
      }
      const t = await store.tickets.update(ticket.id, {
        status: 'delivered', attempts: ticket.attempts + 1, supportChatId, supportMessageId: sent.messageId, deliveredAt: new Date(), lastError: undefined,
      });
      log.info({ ticket: ticket.id, case: ticket.caseId, reason: ticket.reason }, 'handoff delivered');
      return { ticket: t, delivered: true };
    } catch (err) {
      const t = await store.tickets.update(ticket.id, { status: 'failed', attempts: ticket.attempts + 1, lastError: (err as Error).message.slice(0, 500) });
      log.warn({ err, ticket: ticket.id }, 'handoff delivery failed; will retry');
      return { ticket: t, delivered: false };
    }
  }

  /** New customer information on an already-delivered ticket → threaded reply in the support group. */
  async appendUpdate(caseId: string, note: string, evidenceMessageIds: number[]): Promise<boolean> {
    const { store, transport, supportChatId, log } = this.deps;
    const ticket = await store.tickets.findOpenByCase(caseId);
    if (!ticket || ticket.status !== 'delivered' || !supportChatId) return false;
    try {
      await transport.sendText(supportChatId, `🔄 Update\n${note}`.slice(0, 3900), {
        replyToMessageId: ticket.supportMessageId,
      });
      for (const mid of evidenceMessageIds.slice(0, 5)) {
        await transport.forwardMessage(ticket.chatId, mid, supportChatId).catch(() => undefined);
      }
      return true;
    } catch (err) {
      log.warn({ err, caseId }, 'ticket update delivery failed');
      return false;
    }
  }
}
