import { createHash } from 'node:crypto';
import type { Logger } from 'pino';
import { BotOffError } from '../control/guardedTransport.js';
import { escapeHtml } from '../response/html.js';
import { solvedText, type Language } from '../response/requests.js';
import { scrubber } from '../security/scrubber.js';
import type { Store } from '../storage/types.js';
import type { Transport } from '../telegram/transport.js';

export interface Confirmation {
  userId?: string;
  /** The payment's order/transaction reference, when the bot prints one: the same payment confirmed twice is told once. */
  orderId?: string;
}

/** A valid confirmation names PAYMENT CONFIRMED; the customer is taken only from an explicit User ID line. */
export function parseConfirmation(text: string): Confirmation | undefined {
  if (!/PAYMENT\s+CONFIRMED/i.test(text)) return undefined;
  const userId = /User\s*ID\s*[:=]?\s*(\d{5,20})\b/i.exec(text)?.[1];
  const orderId = /(?:Order|Txn|Transaction|UTR|Ref(?:erence)?)\s*(?:ID|No\.?|Number)?\s*[:=]?\s*([A-Z0-9][A-Z0-9-]{5,})\b/i.exec(text)?.[1];
  return { userId, orderId };
}

/** The confirmation's content, ignoring spacing and case: the same confirmation re-sent has the same print. */
const fingerprint = (text: string) => createHash('sha1').update(text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '')).digest('hex').slice(0, 16);

/**
 * The export bot says "✅ PAYMENT CONFIRMED … User ID: <id>": exactly that customer is told, once
 * per payment, in their language, that the issue is solved. Nobody else, nothing else.
 */
export class PaymentConfirmedWorkflow {
  constructor(
    private readonly o: {
      store: Store;
      /** The GUARDED transport. */
      transport: Pick<Transport, 'sendText'>;
      botSwitch: { isOnNow(): Promise<boolean> };
      log: Logger;
      clock?: () => Date;
    },
  ) {}

  async onExportMessage(msg: { messageId: number; text?: string }): Promise<'solved' | 'duplicate' | 'ignored' | 'bot_off' | 'send_failed'> {
    const { store, log } = this.o;
    const text = msg.text ?? '';
    const parsed = parseConfirmation(text);
    if (!parsed) {
      log.info({ messageId: msg.messageId, text: scrubber.scrub(text).slice(0, 200) }, 'export bot message ignored (not a PAYMENT CONFIRMED)');
      return 'ignored';
    }
    if (!parsed.userId) {
      log.warn({ messageId: msg.messageId, text: scrubber.scrub(text).slice(0, 300) }, 'PAYMENT CONFIRMED without a User ID: nobody is messaged');
      return 'ignored';
    }
    if (!(await this.o.botSwitch.isOnNow())) return 'bot_off';
    const key = `payment_confirmed:${parsed.userId}:${parsed.orderId ? `order:${parsed.orderId.toUpperCase()}` : `text:${fingerprint(text)}`}`;
    if (await store.settings.get(key)) {
      log.info({ userId: parsed.userId }, 'payment confirmed again for the same payment: customer already told');
      return 'duplicate';
    }
    const user = await store.users.get(parsed.userId);
    const lang: Language = user?.preferredLanguage ?? 'hinglish';
    const chatId = user?.chatId ?? parsed.userId; // a private chat's id is the user's id
    const now = this.o.clock?.() ?? new Date();
    // Claim the key before sending so two deliveries of the same confirmation cannot both send.
    await store.settings.set(key, { at: now.toISOString(), messageId: msg.messageId });
    const note = solvedText(lang);
    try {
      const sent = await this.o.transport.sendText(chatId, escapeHtml(note), { html: true, kind: 'payment_confirmed' });
      await store.messages.insert({ chatId, userId: parsed.userId, telegramMessageId: sent.messageId, direction: 'out', text: note, media: [], meta: { kind: 'payment_confirmed' } });
      const closed = await store.requests.markSolved(parsed.userId, now);
      log.info({ userId: parsed.userId, language: lang, requestsClosed: closed }, 'payment confirmed: customer told once');
      return 'solved';
    } catch (err) {
      await store.settings.set(key, null).catch(() => undefined); // released: a later delivery may try again
      if (err instanceof BotOffError) return 'bot_off';
      log.warn({ err, userId: parsed.userId }, 'solved note could not be sent');
      return 'send_failed';
    }
  }
}
