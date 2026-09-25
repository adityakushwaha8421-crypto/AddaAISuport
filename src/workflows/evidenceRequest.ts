import type { Logger } from 'pino';
import { BotOffError } from '../control/guardedTransport.js';
import { messageBody, type InboundMessage } from '../domain/messages.js';
import type { LlmClient } from '../llm/client.js';
import { isGreeting } from '../nlu/greeting.js';
import { classifyIssue, type IssueType } from '../nlu/issueType.js';
import { detectLanguage } from '../nlu/normalize.js';
import { greetingText, requestText, type Language } from '../response/requests.js';
import { escapeHtml } from '../response/html.js';
import type { Store, UserRecord } from '../storage/types.js';
import type { OutgoingRef, ReadStateApi, Transport } from '../telegram/transport.js';

/** "Never expires": HUMAN_TAKEOVER_HOURS=0. */
const FAR_FUTURE = new Date('9999-12-31T00:00:00Z');

export type RequestOutcome =
  | 'requested'
  | 'greeted'
  | 'greeting_skipped'
  | 'bot_off'
  | 'stale'
  | 'human'
  | 'no_text'
  | 'not_an_issue'
  | 'already_requested'
  | 'existing_conversation'
  | 'conversation_unverified'
  | 'seen_by_human'
  | 'cancelled'
  | 'send_failed';

export interface EvidenceRequestOptions {
  store: Store;
  /** The GUARDED transport: it refuses the send if the bot is OFF or messaging is disabled. */
  transport: Pick<Transport, 'sendText' | 'recentOutgoing'>;
  botSwitch: { isOnNow(): Promise<boolean> };
  llm?: LlmClient;
  /** Telegram read state: a message a human already read is theirs to answer. */
  readState?: ReadStateApi;
  log: Logger;
  clock?: () => Date;
  /** A message older than this when handled is never answered (restart, reconnect catch-up). 0: no limit. */
  staleSeconds?: number;
  /** An open request of the same type younger than this keeps the case silent; older, a new message may ask again. */
  reopenHours?: number;
  /** After a human writes in a customer chat the agent stays out of it for this long, counted from the human's latest message. 0: for good. */
  takeoverHours?: number;
}

/**
 * The one workflow: read which way the money went (deposit or withdrawal), send the evidence request
 * ONCE, then stay silent in that case — no acknowledgements, reminders, status, follow-ups. The
 * human team takes it from there. The only other thing this class says: a greeting back to a bare
 * "Hi"/"Hello" that OPENS a conversation — no case in the chat, nothing said either way recently.
 */
export class EvidenceRequestWorkflow {
  constructor(private readonly o: EvidenceRequestOptions) {}

  private now() {
    return this.o.clock?.() ?? new Date();
  }

  async onMessage(msg: InboundMessage): Promise<RequestOutcome> {
    const { store, log } = this.o;
    const now = this.now();
    const clog = log.child({ chat: msg.chatId, message: msg.messageId });
    // First line: the switch, fresh from the shared store. OFF → nothing at all.
    if (!(await this.o.botSwitch.isOnNow())) return 'bot_off';
    const stale = this.o.staleSeconds ?? 0;
    if (stale > 0 && now.getTime() - msg.date.getTime() > stale * 1000) return 'stale';
    let user = await store.users.get(msg.userId);
    if (user?.humanTakeoverUntil && user.humanTakeoverUntil > now) {
      // A takeover never reaches further than `takeoverHours` from a human's message. One that does
      // is left over from an older rule ("until the resume command") and would silence this customer
      // for ever: it is dropped here, once, and the message is handled on its merits.
      if (this.takeoverIsStale(user.humanTakeoverUntil, now)) {
        await store.users.setHumanTakeover(msg.userId, undefined);
        clog.warn({ until: user.humanTakeoverUntil.toISOString() }, 'dropped a human takeover that could never expire (older rule); this customer can be answered again');
      } else {
        return 'human';
      }
    }
    // First contact: is a human on this account already talking to this customer? Then the chat is theirs.
    if (user && !user.conversationChecked) {
      const fresh = await this.freshConversation(user.id, msg.chatId, now, clog);
      if (fresh === 'unknown') return 'conversation_unverified';
      if (fresh === 'human') return 'existing_conversation';
      user = await store.users.get(msg.userId);
    }

    const body = messageBody(msg);
    if (!body) return 'no_text'; // a bare photo or file says nothing about the issue
    const lang = detectLanguage(body);
    if (lang && lang !== user?.preferredLanguage) await store.users.setPreferredLanguage(msg.userId, lang);
    const language: Language = lang ?? user?.preferredLanguage ?? 'hinglish';

    // The request is out: the chat is completely silent from here, whatever the customer writes —
    // another complaint, another kind of problem, a question, a file. The team has it. Nothing is
    // classified (no model call) until the case is solved or has aged past the window.
    const open = await store.requests.listOpen(msg.chatId);
    const reopenMs = (this.o.reopenHours ?? 48) * 3_600_000;
    if (open.some((r) => r.status === 'sending' || now.getTime() - r.createdAt.getTime() < reopenMs)) return 'already_requested';

    const earlier = (await store.messages.recent(msg.chatId, 12))
      .filter((m) => m.telegramMessageId !== msg.messageId && now.getTime() - m.createdAt.getTime() < reopenMs);
    // A bare greeting: answered only when it opens the conversation (see `greet`); never classified.
    // Under way = something was said in the chat within the window other than bare greetings.
    if (isGreeting(body)) {
      const underWay = earlier.some((m) => m.direction === 'out' || !isGreeting([m.text, m.caption].filter(Boolean).join('\n')));
      return this.greet(msg, user, language, underWay, now, clog);
    }

    const history = earlier
      .filter((m) => m.direction === 'in')
      .map((m) => [m.text, m.caption].filter(Boolean).join('\n'))
      .filter(Boolean);
    const verdict = await classifyIssue(body, this.o.llm, clog, { history });
    clog.debug({ category: verdict.category, source: verdict.source }, 'issue classified');
    if (!verdict.type) return 'not_an_issue';

    // Last looks: a human who read the message answers it; the switch once more; then the guarded send.
    if (await this.seenByHuman(msg.chatId, msg.messageId, clog)) return 'seen_by_human';
    if (!(await this.o.botSwitch.isOnNow())) return 'bot_off';
    const request = await store.requests.create({ chatId: msg.chatId, userId: msg.userId, issueType: verdict.type, language, createdAt: now });
    const text = requestText(verdict.type, language);
    try {
      const sent = await this.o.transport.sendText(msg.chatId, escapeHtml(text), { html: true, kind: 'evidence_request', replyToMessageId: msg.messageId });
      await store.requests.markSent(request.id, sent.messageId);
      await store.messages.insert({ chatId: msg.chatId, userId: msg.userId, telegramMessageId: sent.messageId, direction: 'out', text, media: [], replyToMessageId: msg.messageId, meta: { kind: 'evidence_request' }, createdAt: now });
      clog.info({ issue: verdict.type, source: verdict.source, language }, 'evidence request sent (the one message of this case)');
      return 'requested';
    } catch (err) {
      await store.requests.remove(request.id); // never went out: the next message may ask
      if (err instanceof BotOffError) {
        clog.info({ issue: verdict.type }, 'evidence request cancelled: sending is off');
        return 'cancelled';
      }
      clog.warn({ err, issue: verdict.type }, 'evidence request could not be sent');
      return 'send_failed';
    }
  }

  /**
   * "Hi" / "Hello" / "Hlo" and nothing else. Answered ONCE, and only when it opens a conversation:
   * no open case in the chat (checked by the caller), nothing but bare greetings written in it
   * either way within the case window, and no greeting answered within that window (kept on the customer's record, so a
   * restart does not greet twice). Otherwise silence — a "hi" inside a case, after a question or
   * after a solved case is the team's to answer.
   */
  private async greet(msg: InboundMessage, user: UserRecord | undefined, language: Language, conversationUnderWay: boolean, now: Date, log: Logger): Promise<RequestOutcome> {
    const { store } = this.o;
    const windowMs = (this.o.reopenHours ?? 48) * 3_600_000;
    if (user?.greetedAt && now.getTime() - user.greetedAt.getTime() < windowMs) {
      log.debug('greeting not answered: greeted already in this conversation');
      return 'greeting_skipped';
    }
    if (conversationUnderWay) {
      log.debug('greeting not answered: the conversation is already under way');
      return 'greeting_skipped';
    }
    if (await this.seenByHuman(msg.chatId, msg.messageId, log)) return 'seen_by_human';
    if (!(await this.o.botSwitch.isOnNow())) return 'bot_off';
    const text = greetingText(language);
    try {
      const sent = await this.o.transport.sendText(msg.chatId, escapeHtml(text), { html: true, kind: 'greeting', replyToMessageId: msg.messageId });
      await store.users.setGreetedAt(msg.userId, now);
      await store.messages.insert({ chatId: msg.chatId, userId: msg.userId, telegramMessageId: sent.messageId, direction: 'out', text, media: [], replyToMessageId: msg.messageId, meta: { kind: 'greeting' }, createdAt: now });
      log.info({ language }, 'greeting sent (a fresh conversation, no case)');
      return 'greeted';
    } catch (err) {
      if (err instanceof BotOffError) {
        log.info('greeting cancelled: sending is off');
        return 'cancelled';
      }
      log.warn({ err }, 'greeting could not be sent');
      return 'send_failed';
    }
  }

  /** A human's chat stays theirs until this time, counted from the human's message. */
  private takeoverUntil(humanMessageAt: Date): Date {
    const hours = this.o.takeoverHours ?? 24;
    return hours > 0 ? new Date(humanMessageAt.getTime() + hours * 3_600_000) : FAR_FUTURE;
  }

  /** Beyond what any human message could have set under the current rule. */
  private takeoverIsStale(until: Date, now: Date): boolean {
    const hours = this.o.takeoverHours ?? 24;
    return hours > 0 && until.getTime() > now.getTime() + hours * 3_600_000;
  }

  /** The account itself wrote in a customer chat: a human is handling it. The agent stays out for `takeoverHours` from this message. */
  async onOwnOutgoing(ev: { chatId: string; messageId: number; text?: string }): Promise<'takeover'> {
    const { store, log } = this.o;
    const now = this.now();
    // A private chat's id is the customer's id. The record may not exist yet (first contact was theirs, or a
    // restart lost it): create it, so the takeover is recorded either way.
    await store.users.upsert({ id: ev.chatId, chatId: ev.chatId });
    await store.users.setHumanTakeover(ev.chatId, this.takeoverUntil(now));
    log.info({ chat: ev.chatId, hours: this.o.takeoverHours ?? 24 }, 'a human wrote in this chat: the agent stays out');
    return 'takeover';
  }

  /**
   * Once per customer: is a human on this account talking to them right now? The chat's recent
   * Telegram history is read; a message from the account that the agent did not send, younger than
   * `takeoverHours`, is a human's, and the chat is theirs for `takeoverHours` from that message.
   * Older human messages are history — a reply from last month does not make the conversation
   * theirs today. 'unknown' when Telegram could not be asked: silence for this turn, checked again
   * next time.
   */
  private async freshConversation(userId: string, chatId: string, now: Date, log: Logger): Promise<'fresh' | 'human' | 'unknown'> {
    const { store } = this.o;
    if (!this.o.transport.recentOutgoing) {
      await store.users.setConversationChecked(userId, now);
      return 'fresh';
    }
    let outgoing: OutgoingRef[];
    try {
      outgoing = await this.o.transport.recentOutgoing(chatId, 30);
    } catch (err) {
      log.warn({ err }, 'could not read the chat history to tell a new conversation from an existing one; staying silent');
      return 'unknown';
    }
    await store.users.setConversationChecked(userId, now);
    if (!outgoing.length) return 'fresh';
    const ours = new Set<number>([
      ...(await store.messages.recent(chatId, 200)).filter((m) => m.direction === 'out').map((m) => m.telegramMessageId),
      ...(await store.requests.listOpen(chatId)).map((r) => r.telegramMessageId).filter((id): id is number => id !== undefined),
    ]);
    const hours = this.o.takeoverHours ?? 24;
    const human = outgoing.filter((m) => !ours.has(m.id) && (hours === 0 || now.getTime() - m.date.getTime() < hours * 3_600_000));
    if (!human.length) return 'fresh';
    const latest = human.reduce((a, b) => (b.date > a.date ? b : a));
    await store.users.setHumanTakeover(userId, this.takeoverUntil(latest.date));
    log.info({ chat: chatId, humanMessages: human.length, latestHumanMessage: latest.date.toISOString() }, 'existing conversation: a human wrote in this chat recently; the agent stays out');
    return 'human';
  }

  private async seenByHuman(chatId: string, messageId: number, log: Logger): Promise<boolean> {
    if (!this.o.readState) return false;
    try {
      return await this.o.readState.seenByHuman(chatId, messageId);
    } catch (err) {
      log.warn({ err }, 'could not read the Telegram read state; treating the message as unread');
      return false;
    }
  }
}

export type { IssueType };
