import type { Logger } from 'pino';
import type { Metrics } from '../observability/metrics.js';
import type { MessageMeta, OutboxEntry, Store } from '../storage/types.js';
import { stripHtml } from '../response/format.js';
import type { Transport } from '../telegram/transport.js';
import { BotOffError } from '../control/guardedTransport.js';

/**
 * Every customer-facing message goes through the outbox: it is written with an idempotency key
 * (e.g. `turn:<id>`) BEFORE sending, so a crash or retry can never produce a second reply for the
 * same turn, and failed sends are retried by the flush loop. A send the transport refuses because
 * the agent is switched OFF is cancelled for good: a reply prepared before /botoff is never sent
 * later, not even by the flush loop, and not by a re-run of the same turn.
 */
export class OutboxSender {
  constructor(
    private readonly deps: { store: Store; transport: Pick<Transport, 'sendText'>; log: Logger; metrics?: Metrics; maxAttempts: number },
  ) {}

  async send(input: { key: string; chatId: string; userId?: string; text: string; replyToMessageId?: number; meta: MessageMeta }): Promise<{ sent: boolean; messageId?: number; duplicate: boolean; cancelled?: boolean }> {
    const { entry, created } = await this.deps.store.outbox.enqueue(input);
    if (!created && entry.status === 'sent') return { sent: true, messageId: entry.telegramMessageId, duplicate: true };
    if (!created && entry.status === 'cancelled') return { sent: false, duplicate: true, cancelled: true };
    const r = await this.deliver(entry);
    return { ...r, duplicate: !created };
  }

  async deliver(entry: OutboxEntry): Promise<{ sent: boolean; messageId?: number; cancelled?: boolean }> {
    const { store, transport, log, metrics } = this.deps;
    try {
      const res = await transport.sendText(entry.chatId, entry.text, { replyToMessageId: entry.replyToMessageId, html: entry.meta.html });
      await store.outbox.markSent(entry.id, res.messageId);
      await store.messages.insert({
        chatId: entry.chatId,
        userId: entry.userId ?? entry.chatId,
        telegramMessageId: res.messageId,
        direction: 'out',
        text: entry.meta.html ? stripHtml(entry.text) : entry.text,
        media: [],
        replyToMessageId: entry.replyToMessageId,
        caseId: entry.meta.caseId,
        meta: entry.meta,
      });
      metrics?.replies.inc({ kind: entry.meta.kind ?? 'reply' });
      return { sent: true, messageId: res.messageId };
    } catch (err) {
      if (err instanceof BotOffError) {
        await store.outbox.markCancelled(entry.id, 'bot_off');
        metrics?.replies.inc({ kind: entry.meta.kind ?? 'reply', outcome: 'cancelled' });
        log.info({ key: entry.key, chat: entry.chatId }, 'reply cancelled: the bot was switched OFF before it could be sent');
        return { sent: false, cancelled: true };
      }
      await store.outbox.markFailed(entry.id, (err as Error).message);
      metrics?.replies.inc({ kind: entry.meta.kind ?? 'reply', outcome: 'failed' });
      log.warn({ err, key: entry.key }, 'outbound send failed; will retry');
      return { sent: false };
    }
  }

  /** /botoff: whatever is still waiting to go out is withdrawn for good, so /boton never sends it. */
  async cancelPending(reason = 'bot_off'): Promise<number> {
    const n = await this.deps.store.outbox.cancelPending(reason);
    if (n) this.deps.log.info({ cancelled: n }, 'unsent replies withdrawn: the bot was switched OFF');
    return n;
  }

  /** Retry unsent messages (startup recovery + periodic). */
  async flushPending(): Promise<number> {
    const pending = await this.deps.store.outbox.listPending(this.deps.maxAttempts);
    let sent = 0;
    for (const e of pending) if ((await this.deliver(e)).sent) sent++;
    return sent;
  }
}
