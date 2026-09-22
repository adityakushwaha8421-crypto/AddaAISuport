import type { Logger } from 'pino';
import { emptyMemory } from '../domain/memory.js';
import { PENDING_STATUSES } from '../domain/cases.js';
import type { ChatFolders } from '../monitoring/chatFolders.js';
import type { OutboxSender } from '../pipeline/outbox.js';
import type { Store } from '../storage/types.js';
import type { SupportGroupMessage, Transport } from '../telegram/transport.js';
import type { KeyedMutex } from '../util/mutex.js';

/**
 * Human ↔ bot handover.
 *
 * Support group → customer: a support agent replies to the ticket message:
 *   plain text → relayed to the customer; the human owns the chat now (see `humanTookOver`)
 *   /note …   → internal, not relayed
 *   /bot      → hand the chat back to the bot
 *   /close    → close the ticket and the case
 *   /forget   → erase what we remember about this customer
 *
 * Typed on the account in a customer chat: any message means a human is handling that customer,
 * and the bot falls silent there — no replies, no requests, no greetings, no new workflow — until
 * the human hands the chat back by typing the resume command (`/ai` by default, `/bot` too),
 * which is deleted again so the customer never sees it. `takeoverMinutes` > 0 adds an automatic
 * hand-back after that long; 0 (the default) means the human's handling lasts until they say so.
 */
const FAR_FUTURE = new Date('9999-12-31T00:00:00Z');

export class SupportRelay {
  private readonly resume: RegExp;

  constructor(
    private readonly o: {
      store: Store; outbox: OutboxSender; transport: Pick<Transport, 'sendText' | 'deleteMessage'>; takeoverMinutes: number; resumeCommand?: string;
      log: Logger; clock?: () => Date; folders?: Pick<ChatFolders, 'humanReplied'>; locks?: KeyedMutex;
    },
  ) {
    const cmd = (o.resumeCommand ?? '/ai').trim();
    const escaped = cmd.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    this.resume = new RegExp(`^(?:${escaped}|/bot)\\s*$`, 'i');
  }

  /** Is this text the human's "hand the chat back to the bot" command? */
  isResumeCommand(text: string | undefined): boolean {
    return !!text && this.resume.test(text.trim());
  }

  async onSupportMessage(msg: SupportGroupMessage): Promise<void> {
    const { store, outbox, log } = this.o;
    if (!msg.replyToMessageId || !msg.text?.trim()) return;
    const ticket = await store.tickets.findBySupportMessage(msg.chatId, msg.replyToMessageId);
    if (!ticket) return;
    const text = msg.text.trim();
    const now = this.o.clock?.() ?? new Date();

    if (/^\/note\b/i.test(text)) return;
    if (/^\/forget\b/i.test(text)) {
      // Privacy: drop everything we remember about this customer (cases stay for audit).
      await store.users.saveMemory(ticket.userId, emptyMemory());
      await this.o.transport.sendText(msg.chatId, '🧹 Customer memory cleared.', { replyToMessageId: msg.messageId }).catch(() => undefined);
      return;
    }
    if (/^\/bot\b/i.test(text)) {
      await store.users.setHumanTakeover(ticket.userId, undefined);
      await this.o.transport.sendText(msg.chatId, '🤖 Bot re-enabled for this customer.', { replyToMessageId: msg.messageId }).catch(() => undefined);
      return;
    }
    if (/^\/close\b/i.test(text)) {
      await store.tickets.update(ticket.id, { status: 'closed' });
      const c = await store.cases.get(ticket.caseId);
      if (c && c.status !== 'closed') await store.cases.save({ ...c, status: 'closed' });
      await store.users.setHumanTakeover(ticket.userId, undefined);
      await this.o.transport.sendText(msg.chatId, '✅ Case closed.', { replyToMessageId: msg.messageId }).catch(() => undefined);
      return;
    }

    const res = await outbox.send({
      key: `relay:${msg.chatId}:${msg.messageId}`,
      chatId: ticket.chatId,
      userId: ticket.userId,
      text,
      meta: { kind: 'human', caseId: ticket.caseId },
    });
    if (res.sent) {
      await this.humanTookOver(ticket.userId, ticket.chatId, now);
      log.info({ ticket: ticket.id }, 'support reply relayed to customer');
    }
  }

  /** Someone typed from our own account in a customer chat. */
  async onOwnOutgoing(ev: { chatId: string; messageId?: number; text?: string }): Promise<void> {
    const now = this.o.clock?.() ?? new Date();
    // In private chats the chat id is the customer's user id. The human may write first.
    await this.o.store.users.upsert({ id: ev.chatId, chatId: ev.chatId });
    if (this.isResumeCommand(ev.text)) {
      // The human is done: the chat is the bot's again from the customer's next message.
      await this.o.store.users.setHumanTakeover(ev.chatId, undefined);
      if (ev.messageId && this.o.transport.deleteMessage) {
        await this.o.transport.deleteMessage(ev.chatId, ev.messageId).catch((err) => this.o.log.warn({ err, chat: ev.chatId }, 'could not delete the resume command message'));
      }
      this.o.log.info({ chat: ev.chatId }, 'human handed the chat back: bot resumed for this customer');
      return;
    }
    await this.humanTookOver(ev.chatId, ev.chatId, now);
    this.o.log.info({ chat: ev.chatId, until: this.o.takeoverMinutes > 0 ? `${this.o.takeoverMinutes} min` : 'resume command' }, 'human reply from the account: pending cases closed, bot silent in this chat');
  }

  /**
   * A human replied to the customer. The bot pauses in that chat, and the unfinished cases are the
   * human's now: closed, so the bot does not go on collecting for them or wait on them afterwards.
   */
  private async humanTookOver(userId: string, chatId: string, now: Date): Promise<void> {
    const { store } = this.o;
    const reset = async () => {
      await store.users.setHumanTakeover(userId, this.o.takeoverMinutes > 0 ? new Date(now.getTime() + this.o.takeoverMinutes * 60_000) : FAR_FUTURE);
      for (const c of await store.cases.listActive(userId)) {
        if (PENDING_STATUSES.includes(c.status)) await store.cases.save({ ...c, status: 'closed', facts: { ...c.facts, lastAsked: [] } });
      }
      await store.users.setFocus(userId, undefined);
      // A match issue held for the team has now been seen by a human.
      const u = await store.users.get(userId);
      if (u?.memory.matchReviewPending) {
        const { matchReviewPending: _seen, ...rest } = u.memory;
        await store.users.saveMemory(userId, rest);
      }
    };
    // Same lock as the turn processor: never close a case under a turn that is saving it.
    await (this.o.locks ? this.o.locks.run(chatId, reset) : reset());
    // A human answered, so the chat has been reviewed: out of the "Match issues" folder.
    await this.o.folders?.humanReplied(chatId);
  }
}
