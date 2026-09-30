import { createHash } from 'node:crypto';
import type { Logger } from 'pino';
import { BotOffError } from '../control/guardedTransport.js';
import { escapeHtml } from '../response/html.js';
import { solvedText, type Language } from '../response/requests.js';
import { extractMobileNumbers, maskMobile } from '../nlu/mobile.js';
import { scrubber } from '../security/scrubber.js';
import type { Store, UserRecord } from '../storage/types.js';
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
  /** The customer's mobile number as printed: the fallback address when there is no User ID. */
  mobile?: string;
}

/** A valid confirmation names PAYMENT CONFIRMED; the customer is taken only from an explicit User ID line. */
export function parseConfirmation(text: string): Confirmation | undefined {
  if (!/PAYMENT\s+CONFIRMED/i.test(text)) return undefined;
  const userId = /User\s*ID\s*[:=]?\s*(\d{5,20})\b/i.exec(text)?.[1];
  const orderId = /(?:Order|Txn|Transaction|UTR|Ref(?:erence)?)\s*(?:ID|No\.?|Number)?\s*[:=]?\s*([A-Z0-9][A-Z0-9-]{5,})\b/i.exec(text)?.[1];
  const customerLine = text.split('\n').find((l) => /Customer\s*[:=]/i.test(l));
  const { customerName, customerUsername } = parseCustomer(customerLine);
  const amountRaw = /Amount\s*[:=]?\s*(?:₹|Rs\.?|INR)?\s*(\d[\d,]*(?:\.\d{1,2})?)\b/i.exec(text)?.[1];
  const amount = amountRaw ? `₹${amountRaw}` : undefined;
  const mobileLine = text.split('\n').find((l) => /(?:Mobile|Phone|Contact|Number)\s*[:=]/i.test(l));
  const mobile = mobileLine ? extractMobileNumbers(mobileLine)[0] : undefined;
  return { userId, orderId, customerName, customerUsername, amount, mobile };
}

/**
 * The Customer line, in the shapes the export bot prints:
 *   "P Kumar (User ID: 6135570708, no username)" · "Fantasy Expert News (no username, no user id)" ·
 *   "@Sureshreddy45 (Suresh)" · "Suresh @Sureshreddy45".
 * The @handle is the username wherever it stands; the name is whatever else is a name — in front
 * of the brackets, or inside them when the handle came first. Never the handle itself.
 */
export function parseCustomer(line: string | undefined): Pick<Confirmation, 'customerName' | 'customerUsername'> {
  if (!line) return {};
  const value = /Customer\s*[:=]\s*(.*)$/i.exec(line)?.[1] ?? '';
  const customerUsername = /@([A-Za-z][A-Za-z0-9_]{3,31})\b/.exec(value)?.[1];
  const clean = (t: string) => t.replace(/@[A-Za-z0-9_]+/g, ' ').replace(/\s+/g, ' ').trim();
  const outside = clean(value.replace(/\([^)]*\)?/g, ' '));
  const inside = [...value.matchAll(/\(([^)]*)\)?/g)]
    .flatMap((m) => (m[1] ?? '').split(','))
    .map(clean)
    .filter((part) => part && !/user\s*id|username|^no\b|^n\/?a$/i.test(part) && /\p{L}/u.test(part));
  const customerName = outside || inside[0] || undefined;
  return { customerName, customerUsername };
}

const nameTokens = (s: string | undefined) => (s ?? '').normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').split(' ').filter(Boolean);

/**
 * Does the customer the export bot names look like this Telegram user? A stated @username must be
 * theirs; a stated name must share a word (or an initial) with their Telegram name. With a User ID
 * the id is the address and this only stops a mistyped id from reaching the wrong person; `strict`
 * (the mobile-number fallback) demands a positive match — nothing to compare is not a match.
 */
export function identityMatches(claimed: Pick<Confirmation, 'customerName' | 'customerUsername'>, actual: Pick<TelegramUserProfile, 'firstName' | 'lastName' | 'username'>, strict = false): { ok: boolean; reason?: string } {
  if (claimed.customerUsername && actual.username && claimed.customerUsername.toLowerCase() !== actual.username.toLowerCase()) {
    return { ok: false, reason: `the confirmation names @${claimed.customerUsername}, Telegram has @${actual.username} for this customer` };
  }
  // The same @username is the same Telegram account: nothing else needs to agree.
  if (claimed.customerUsername && actual.username && claimed.customerUsername.toLowerCase() === actual.username.toLowerCase()) return { ok: true };
  const a = nameTokens(claimed.customerName);
  const b = nameTokens([actual.firstName, actual.lastName].filter(Boolean).join(' '));
  if (a.length && b.length) {
    const hit = a.some((x) => b.some((y) => x === y || (x.length === 1 && y.startsWith(x)) || (y.length === 1 && x.startsWith(y))));
    if (!hit) return { ok: false, reason: `the confirmation names "${claimed.customerName}", Telegram shows a different name for this customer` };
    return { ok: true };
  }
  if (strict) return { ok: false, reason: 'the confirmation gives no customer name or @username that Telegram could confirm' };
  return { ok: true };
}

/** The confirmation's content, ignoring spacing and case: the same confirmation re-sent has the same print. */
const fingerprint = (text: string) => createHash('sha1').update(text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '')).digest('hex').slice(0, 16);

export type ConfirmationOutcome = 'solved' | 'duplicate' | 'ignored' | 'bot_off' | 'user_unverified' | 'user_mismatch' | 'send_failed';

/**
 * The export bot says "✅ PAYMENT CONFIRMED … User ID: <id>": exactly that customer is told, once
 * per payment, in their language, that the issue is solved — by their Telegram name, with the
 * confirmed amount. Before sending, the customer named in the confirmation is checked against the
 * Telegram user behind the User ID. Without a User ID, the @username is resolved on Telegram (taken
 * when that account is a known customer or the confirmation's name matches it); failing that, the
 * Mobile line: the one customer who typed that exact number in their chat, and only if the
 * confirmation's name or @username positively matches them. Unclear → nobody. Nothing else.
 */
export class PaymentConfirmedWorkflow {
  constructor(
    private readonly o: {
      store: Store;
      /** The GUARDED transport. */
      transport: Pick<Transport, 'sendText'>;
      /** Who a Telegram user id / @username is (the raw transport). Without it, the stored customer record is used. */
      directory?: Pick<Transport, 'userProfile' | 'userByUsername'>;
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
    if (!parsed.userId && !parsed.customerUsername && !parsed.mobile) {
      log.warn({ messageId: msg.messageId, text: scrubber.scrub(text).slice(0, 300) }, 'PAYMENT CONFIRMED without a User ID, an @username or a Mobile line: nobody is messaged');
      return 'ignored';
    }
    if (!(await this.o.botSwitch.isOnNow())) return 'bot_off';

    let target: { userId: string; user?: UserRecord; profile: TelegramUserProfile; via: 'user_id' | 'username' | 'mobile' };
    if (parsed.userId) {
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
      target = { userId: parsed.userId, user, profile, via: 'user_id' };
    } else {
      // No User ID: the @username is the next exact address; the mobile number the last resort.
      const byName = await this.byUsername(parsed, log);
      const found = byName ?? (parsed.mobile ? await this.byMobile(parsed, log) : undefined);
      if (!found) return 'user_unverified';
      target = { ...found, via: byName ? 'username' : 'mobile' };
    }
    const { userId, user, profile } = target;

    const key = `payment_confirmed:${userId}:${parsed.orderId ? `order:${parsed.orderId.toUpperCase()}` : `text:${fingerprint(text)}`}`;
    if (await store.settings.get(key)) {
      log.info({ userId }, 'payment confirmed again for the same payment: customer already told');
      return 'duplicate';
    }
    const lang: Language = user?.preferredLanguage ?? 'hinglish';
    const chatId = user?.chatId ?? userId; // a private chat's id is the user's id
    const now = this.o.clock?.() ?? new Date();
    const issue = (await store.requests.listOpen(chatId))[0]?.issueType ?? 'deposit';
    const name = [profile.firstName, profile.lastName].filter(Boolean).join(' ').trim() || parsed.customerName;
    // Claim the key before sending so two deliveries of the same confirmation cannot both send.
    await store.settings.set(key, { at: now.toISOString(), messageId: msg.messageId });
    const note = solvedText(lang, { name, amount: parsed.amount, issue });
    try {
      const sent = await this.o.transport.sendText(chatId, escapeHtml(note), { html: true, kind: 'payment_confirmed' });
      await store.messages.insert({ chatId, userId, telegramMessageId: sent.messageId, direction: 'out', text: note, media: [], meta: { kind: 'payment_confirmed' }, createdAt: now });
      const closed = await store.requests.markSolved(userId, now);
      log.info({ userId, via: target.via, language: lang, issue, amount: parsed.amount, requestsClosed: closed }, 'payment confirmed: customer told once');
      return 'solved';
    } catch (err) {
      await store.settings.set(key, null).catch(() => undefined); // released: a later delivery may try again
      if (err instanceof BotOffError) return 'bot_off';
      log.warn({ err, userId }, 'solved note could not be sent');
      return 'send_failed';
    }
  }

  /**
   * No User ID, but an @username: Telegram resolves the handle to one account. It is taken when
   * that account is a customer who has written to us, or when the confirmation's name matches the
   * account's Telegram name — so a mistyped or recycled handle never reaches a stranger.
   */
  private async byUsername(parsed: Confirmation, log: Logger): Promise<{ userId: string; user?: UserRecord; profile: TelegramUserProfile } | undefined> {
    const username = parsed.customerUsername;
    if (!username || !this.o.directory?.userByUsername) return undefined;
    let profile: TelegramUserProfile | undefined;
    try {
      profile = await this.o.directory.userByUsername(username);
    } catch (err) {
      log.warn({ err, username }, 'could not resolve the @username from the confirmation');
    }
    if (!profile) {
      log.info({ username }, 'PAYMENT CONFIRMED without a User ID: Telegram has no user with this @username');
      return undefined;
    }
    const user = await this.o.store.users.get(profile.id);
    const nameAgrees = !!parsed.customerName && identityMatches({ customerName: parsed.customerName }, profile, true).ok;
    if (!user && !nameAgrees) {
      log.warn({ username, userId: profile.id, customer: parsed.customerName }, 'PAYMENT CONFIRMED without a User ID: the @username is not a customer who wrote to this account and the name does not confirm it; trying the mobile number');
      return undefined;
    }
    log.info({ username, userId: profile.id, knownCustomer: !!user }, 'PAYMENT CONFIRMED without a User ID: customer found by @username');
    return { userId: profile.id, user, profile };
  }

  /**
   * No User ID: the customer who typed the confirmation's mobile number in their chat. Exactly one
   * customer may have typed it, and the confirmation's name / @username must positively match them
   * on Telegram; otherwise nobody is messaged. A number several customers typed is resolved only
   * when the identity check leaves exactly one of them.
   */
  private async byMobile(parsed: Confirmation, log: Logger): Promise<{ userId: string; user: UserRecord; profile: TelegramUserProfile } | undefined> {
    const mobile = parsed.mobile!;
    const masked = maskMobile(mobile);
    const candidates = await this.o.store.users.findByMobileNumber(mobile);
    if (!candidates.length) {
      log.warn({ mobile: masked, customer: parsed.customerName }, 'PAYMENT CONFIRMED without a User ID: no customer chat holds this mobile number; nobody is messaged');
      return undefined;
    }
    const matched: Array<{ userId: string; user: UserRecord; profile: TelegramUserProfile }> = [];
    for (const user of candidates) {
      const profile = (await this.profile(user.id)) ?? { id: user.id, firstName: user.firstName, username: user.username };
      const identity = identityMatches(parsed, profile, true);
      if (identity.ok) matched.push({ userId: user.id, user, profile });
      else log.info({ mobile: masked, userId: user.id, reason: identity.reason }, 'mobile-number candidate does not match the confirmation');
    }
    if (matched.length !== 1) {
      log.warn({ mobile: masked, customer: parsed.customerName, candidates: candidates.length, matched: matched.length }, matched.length ? 'PAYMENT CONFIRMED without a User ID: several customers match this mobile number; nobody is messaged' : 'PAYMENT CONFIRMED without a User ID: the customer who typed this mobile number does not match the confirmation; nobody is messaged');
      return undefined;
    }
    log.info({ mobile: masked, userId: matched[0]!.userId }, 'PAYMENT CONFIRMED without a User ID: customer found by mobile number and verified');
    return matched[0];
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
