import { createHash } from 'node:crypto';
import type { Logger } from 'pino';
import { EXPORT_DONE, PENDING_STATUSES, type CaseRecord } from '../domain/cases.js';
import type { OutboxSender } from '../pipeline/outbox.js';
import { toTelegramHtml } from '../response/format.js';
import { renderActs } from '../response/templates.js';
import { scrubber } from '../security/scrubber.js';
import type { Store } from '../storage/types.js';
import type { KeyedMutex } from '../util/mutex.js';

/**
 * The export bot answers an exported deposit with a "PAYMENT CONFIRMED" message. The customer it
 * is about is found, in this order, from: a `User ID: <telegram id>` in the text; the forwarded
 * message the bot replied to; the `Mobile: <number>` in the text, when exactly one pending
 * exported deposit case carries that registration number. No match → nothing is sent to anyone.
 */
export interface Confirmation {
  userId?: string;
  mobile?: string;
  /** The payment's order/transaction reference, when the bot prints one: the same payment confirmed twice is told once. */
  orderId?: string;
}

export function parseConfirmation(text: string): Confirmation | undefined {
  if (!/PAYMENT\s+CONFIRMED/i.test(text)) return undefined;
  const userId = /User\s*ID\s*[:=]?\s*(\d{5,20})\b/i.exec(text)?.[1];
  const mobile = /(?:Mobile|Phone|Number|Registered\s*(?:no|number))\s*[:=]?\s*(?:\+?91[\s-]?)?(\d{10})\b/i.exec(text)?.[1];
  const orderId = /(?:Order|Txn|Transaction|UTR|Ref(?:erence)?)\s*(?:ID|No\.?|Number)?\s*[:=]?\s*([A-Z0-9][A-Z0-9-]{5,})\b/i.exec(text)?.[1];
  return { userId, mobile, orderId };
}

/** The confirmation's content, ignoring spacing and case: the same confirmation re-sent has the same print. */
function fingerprint(text: string): string {
  return createHash('sha1').update(text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '')).digest('hex').slice(0, 16);
}

/** The agreed wording, in the customer's language; never paraphrased by a model. */
export function solvedMessage(lang: 'hinglish' | 'english' | 'hindi'): string {
  return renderActs([{ type: 'deposit_solved' }], lang);
}

export class ExportConfirmations {
  constructor(
    private readonly o: { store: Store; outbox: OutboxSender; locks: KeyedMutex; log: Logger; notifyCustomer?: boolean },
  ) {}

  async onExportMessage(msg: { messageId: number; text?: string; replyToMessageId?: number }): Promise<'solved' | 'duplicate' | 'ignored'> {
    const { store, log } = this.o;
    const text = msg.text ?? '';
    const parsed = parseConfirmation(text);
    if (!parsed) {
      log.info({ messageId: msg.messageId, replyTo: msg.replyToMessageId, text: scrubber.scrub(text).slice(0, 300) }, 'export bot message ignored (not a PAYMENT CONFIRMED)');
      return 'ignored';
    }
    const target = await this.findCase(parsed, msg.replyToMessageId);
    // The customer is told only when the confirmation names their Telegram User ID, and only that
    // customer — never one guessed from a mobile number or a reply. A private chat's id is the user's id.
    const tellUserId = parsed.userId;
    if (!target && !tellUserId) {
      log.warn({ messageId: msg.messageId, replyTo: msg.replyToMessageId, text: scrubber.scrub(text).slice(0, 400) }, 'PAYMENT CONFIRMED carries no User ID and matches no pending deposit case; nothing sent');
      return 'ignored';
    }
    const chatId = target ? (await store.users.get(target.userId))?.chatId ?? target.chatId : tellUserId!;
    return this.o.locks.run(chatId, async () => {
      const c = target ? await store.cases.get(target.id) : undefined;
      const user = await store.users.get(target?.userId ?? tellUserId!);
      if (c && !PENDING_STATUSES.includes(c.status)) {
        log.info({ case: c.id }, 'payment confirmed again for a case already solved: nothing sent');
        return 'duplicate';
      }
      const lang = user?.preferredLanguage ?? 'hinglish';
      let told = false;
      if (this.o.notifyCustomer && tellUserId) {
        // Once per payment: the same order confirmed twice is one message; without an order line, the
        // same confirmation text re-sent is one message (a different amount or date is a different payment).
        const key = `payment_confirmed:${tellUserId}:${parsed.orderId ? `order:${parsed.orderId.toUpperCase()}` : `text:${fingerprint(text)}`}`;
        const sent = await this.o.outbox.send({
          key, chatId: user?.chatId ?? tellUserId, userId: tellUserId, text: toTelegramHtml(solvedMessage(lang)),
          meta: { kind: 'payment_confirmed', html: true, caseId: c?.id, caseType: c?.type ?? 'deposit', acts: ['deposit_solved'] },
        });
        if (sent.duplicate) {
          log.info({ userId: tellUserId, key }, 'payment confirmed again for the same payment: customer already told, nothing sent');
          if (!c) return 'duplicate';
        } else if (!sent.sent && !sent.cancelled) {
          log.warn({ userId: tellUserId, case: c?.id }, 'resolution message could not be sent; case left pending for retry');
          return 'ignored';
        }
        told = sent.sent;
      }
      if (c) {
        c.status = 'resolved';
        c.step = 'solved';
        c.facts.resolution = 'Payment confirmed by the team (export bot)';
        c.facts.lastAsked = [];
        c.missing = [];
        await store.cases.save(c);
        const ticket = await store.tickets.findOpenByCase(c.id);
        if (ticket) await store.tickets.update(ticket.id, { status: 'closed' });
      }
      log.info({ case: c?.id, userId: tellUserId ?? target?.userId, language: lang, matchedBy: parsed.userId ? 'user_id' : msg.replyToMessageId ? 'reply' : 'mobile', customerTold: told }, c ? 'deposit solved' : 'payment confirmed for a customer with no open case: customer told');
      return 'solved';
    });
  }

  /** The one deposit case the confirmation is about (pending, or already solved → duplicate), or nothing. */
  private async findCase(parsed: Confirmation, replyTo: number | undefined): Promise<CaseRecord | undefined> {
    const { store } = this.o;
    const pending = (c: CaseRecord) => PENDING_STATUSES.includes(c.status);
    const deposit = (c: CaseRecord) => c.type === 'deposit' && (pending(c) || c.step === 'solved');
    const prefer = (list: CaseRecord[]) => list.find(pending) ?? list[0];
    if (parsed.userId) {
      const cases = (await store.cases.listByUser(parsed.userId)).filter(deposit);
      return cases.find((c) => pending(c) && c.facts.export && EXPORT_DONE.includes(c.facts.export.status)) ?? prefer(cases);
    }
    const exported = (await store.cases.listExported()).filter(deposit);
    if (replyTo) {
      const byReply = exported.filter((c) => Object.values(c.facts.export?.forwarded ?? {}).includes(replyTo));
      if (byReply.length) return prefer(byReply);
    }
    if (parsed.mobile) {
      const byMobile = exported.filter((c) => c.registrationNumber === parsed.mobile);
      const open = byMobile.filter(pending);
      if (open.length === 1) return open[0];
      if (open.length > 1) {
        this.o.log.warn({ mobile: parsed.mobile, cases: open.length }, 'PAYMENT CONFIRMED mobile matches several pending customers');
        return undefined;
      }
      return byMobile[0]; // solved already → reported as a duplicate, nothing sent
    }
    return undefined;
  }
}
