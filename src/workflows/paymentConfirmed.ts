import { createHash } from 'node:crypto';
import type { Logger } from 'pino';
import { BotOffError } from '../control/guardedTransport.js';
import { escapeHtml } from '../response/html.js';
import { solvedText, type Language } from '../response/requests.js';
import { scrubber } from '../security/scrubber.js';
import type { Store } from '../storage/types.js';
import type { TelegramUserProfile, Transport } from '../telegram/transport.js';

export interface Confirmation {
  userId?: string;
  /** The payment's order/transaction reference, when the bot prints one: the same payment confirmed twice is told once. */
  orderId?: string;
  /** The customer as the export bot names them: checked against Telegram before anything is sent. */
  customerName?: string;
  customerUsername?: string;
  /** The confirmed amount as printed, normalised to "₹2,999.01". */
  amount?: string;
}

/** A valid confirmation names PAYMENT CONFIRMED; the customer is taken only from an explicit User ID line. */
export function parseConfirmation(text: string): Confirmation | undefined {
  if (!/PAYMENT\s+CONFIRMED/i.test(text)) return undefined;
  const userId = /User\s*ID\s*[:=]?\s*(\d{5,20})\b/i.exec(text)?.[1];
  const orderId = /(?:Order|Txn|Transaction|UTR|Ref(?:erence)?)\s*(?:ID|No\.?|Number)?\s*[:=]?\s*([A-Z0-9][A-Z0-9-]{5,})\b/i.exec(text)?.[1];
  const customerLine = text.split('\n').find((l) => /Customer\s*[:=]/i.test(l));
  const customerName = customerLine ? /Customer\s*[:=]\s*([^(\n]+?)\s*(?:\(|$)/i.exec(customerLine)?.[1]?.trim() || undefined : undefined;
  const customerUsername = customerLine ? /@([A-Za-z][A-Za-z0-9_]{3,31})\b/.exec(customerLine)?.[1] : undefined;
  const amountRaw = /Amount\s*[:=]?\s*(?:₹|Rs\.?|INR)?\s*(\d[\d,]*(?:\.\d{1,2})?)\b/i.exec(text)?.[1];
  const amount = amountRaw ? `₹${amountRaw}` : undefined;
  return { userId, orderId, customerName, customerUsername, amount };
}

const nameTokens = (s: string | undefined) => (s ?? '').normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').split(' ').filter(Boolean);

/**
 * Does the customer the export bot names look like the Telegram user behind that User ID? A stated
 * @username must be theirs; a stated name must share a word (or an initial) with their Telegram name.
 * The User ID stays the address — this only stops a mistyped id from reaching the wrong person.
 */
export function identityMatches(claimed: Pick<Confirmation, 'customerName' | 'customerUsername'>, actual: Pick<TelegramUserProfile, 'firstName' | 'lastName' | 'username'>): { ok: boolean; reason?: string } {
  if (claimed.customerUsername && actual.username && claimed.customerUsername.toLowerCase() !== actual.username.toLowerCase()) {
    return { ok: false, reason: `the confirmation names @${claimed.customerUsername}, Telegram has @${actual.username} for this User ID` };
  }
  const a = nameTokens(claimed.customerName);
  const b = nameTokens([actual.firstName, actual.lastName].filter(Boolean).join(' '));
  if (a.length && b.length) {
    const hit = a.some((x) => b.some((y) => x === y || (x.length === 1 && y.startsWith(x)) || (y.length === 1 && x.startsWith(y))));
    if (!hit) return { ok: false, reason: `the confirmation names "${claimed.customerName}", Telegram shows a different name for this User ID` };
  }
  return { ok: true };
}

/** The confirmation's content, ignoring spacing and case: the same confirmation re-sent has the same print. */
const fingerprint = (text: string) => createHash('sha1').update(text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '')).digest('hex').slice(0, 16);

export type ConfirmationOutcome = 'solved' | 'duplicate' | 'ignored' | 'bot_off' | 'user_unverified' | 'user_mismatch' | 'send_failed';

/**
 * The export bot says "✅ PAYMENT CONFIRMED … User ID: <id>": exactly that customer is told, once
 * per payment, in their language, that the issue is solved — by their Telegram name, with the
 * confirmed amount. Before sending, the customer named in the confirmation is checked against the
 * Telegram user behind the User ID. Nobody else, nothing else.
 */
export class PaymentConfirmedWorkflow {
  constructor(
    private readonly o: {
      store: Store;
      /** The GUARDED transport. */
      transport: Pick<Transport, 'sendText'>;
      /** Who a Telegram user id is (the raw transport). Without it, the stored customer record is used. */
      directory?: Pick<Transport, 'userProfile'>;
      botSwitch: { isOnNow(): Promise<boolean> };
      log: Logger;
      clock?: () => Date;
    },
  ) {}

  async onExportMessage(msg: { messageId: number; text?: string }): Promise<ConfirmationOutcome> {
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
    // Who is behind the User ID: Telegram's word first, else what the customer's own messages told us.
    const profile = (await this.profile(parsed.userId)) ?? (user ? { id: user.id, firstName: user.firstName, username: user.username } : undefined);
    if (!profile) {
      log.warn({ userId: parsed.userId }, 'PAYMENT CONFIRMED for a User ID Telegram does not know to this account: nobody is messaged');
      return 'user_unverified';
    }
    const identity = identityMatches(parsed, profile);
    if (!identity.ok) {
      log.warn({ userId: parsed.userId, customer: parsed.customerName, username: parsed.customerUsername, reason: identity.reason }, 'PAYMENT CONFIRMED names a customer that does not match this User ID: nobody is messaged');
      return 'user_mismatch';
    }
    const lang: Language = user?.preferredLanguage ?? 'hinglish';
    const chatId = user?.chatId ?? parsed.userId; // a private chat's id is the user's id
    const now = this.o.clock?.() ?? new Date();
    const issue = (await store.requests.listOpen(chatId))[0]?.issueType ?? 'deposit';
    const name = [profile.firstName, profile.lastName].filter(Boolean).join(' ').trim() || parsed.customerName;
    // Claim the key before sending so two deliveries of the same confirmation cannot both send.
    await store.settings.set(key, { at: now.toISOString(), messageId: msg.messageId });
    const note = solvedText(lang, { name, amount: parsed.amount, issue });
    try {
      const sent = await this.o.transport.sendText(chatId, escapeHtml(note), { html: true, kind: 'payment_confirmed' });
      await store.messages.insert({ chatId, userId: parsed.userId, telegramMessageId: sent.messageId, direction: 'out', text: note, media: [], meta: { kind: 'payment_confirmed' }, createdAt: now });
      const closed = await store.requests.markSolved(parsed.userId, now);
      log.info({ userId: parsed.userId, language: lang, issue, amount: parsed.amount, requestsClosed: closed }, 'payment confirmed: customer told once');
      return 'solved';
    } catch (err) {
      await store.settings.set(key, null).catch(() => undefined); // released: a later delivery may try again
      if (err instanceof BotOffError) return 'bot_off';
      log.warn({ err, userId: parsed.userId }, 'solved note could not be sent');
      return 'send_failed';
    }
  }

  private async profile(userId: string): Promise<TelegramUserProfile | undefined> {
    if (!this.o.directory?.userProfile) return undefined;
    try {
      return await this.o.directory.userProfile(userId);
    } catch (err) {
      this.o.log.warn({ err, userId }, 'could not read the Telegram profile for this User ID');
      return undefined;
    }
  }
}
