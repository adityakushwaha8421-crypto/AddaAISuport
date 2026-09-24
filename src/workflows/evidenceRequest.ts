import type { Logger } from 'pino';
import { BotOffError } from '../control/guardedTransport.js';
import { messageBody, type InboundMessage } from '../domain/messages.js';
import type { LlmClient } from '../llm/client.js';
import { classifyIssue, type IssueType } from '../nlu/issueType.js';
import { detectLanguage } from '../nlu/normalize.js';
import { requestText, type Language } from '../response/requests.js';
import { escapeHtml } from '../response/html.js';
import type { Store } from '../storage/types.js';
import type { ReadStateApi, Transport } from '../telegram/transport.js';

/** A human's chat stays theirs until they hand it back with the resume command. */
const FAR_FUTURE = new Date('9999-12-31T00:00:00Z');

export type RequestOutcome =
  | 'requested'
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
  transport: Pick<Transport, 'sendText' | 'deleteMessage' | 'recentOutgoing'>;
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
  /** Typed by a human in a customer chat to hand it back ("/ai"; "/bot" always works). */
  resumeCommand?: string;
}

/**
 * The one workflow: read which way the money went (deposit or withdrawal), send the evidence request
 * ONCE, then stay silent in that case — no acknowledgements, reminders, status, follow-ups. The
 * human team takes it from there. Nothing else is ever said to the customer by this class.
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
    if (user?.humanTakeoverUntil && user.humanTakeoverUntil > now) return 'human';
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

    const history = (await store.messages.recent(msg.chatId, 12))
      .filter((m) => m.direction === 'in' && m.telegramMessageId !== msg.messageId && now.getTime() - m.createdAt.getTime() < 48 * 3_600_000)
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
      await store.messages.insert({ chatId: msg.chatId, userId: msg.userId, telegramMessageId: sent.messageId, direction: 'out', text, media: [], replyToMessageId: msg.messageId, meta: { kind: 'evidence_request' } });
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

  /** The account itself wrote in a customer chat: a human is handling it — unless it is the resume command. */
  async onOwnOutgoing(ev: { chatId: string; messageId: number; text?: string }): Promise<'takeover' | 'resumed' | 'ignored'> {
    const { store, log } = this.o;
    const text = (ev.text ?? '').trim().toLowerCase();
    const resume = (this.o.resumeCommand ?? '/ai').toLowerCase();
    if (text === resume || text === '/bot') {
      await store.users.setHumanTakeover(ev.chatId, undefined);
      await this.o.transport.deleteMessage?.(ev.chatId, ev.messageId).catch((err) => log.warn({ err, chat: ev.chatId }, 'could not delete the resume command message'));
      log.info({ chat: ev.chatId }, 'chat handed back to the agent');
      return 'resumed';
    }
    // A private chat's id is the customer's id. The record may not exist yet (first contact was theirs, or a
    // restart lost it): create it, so the takeover is recorded either way.
    await store.users.upsert({ id: ev.chatId, chatId: ev.chatId });
    await store.users.setHumanTakeover(ev.chatId, FAR_FUTURE);
    log.info({ chat: ev.chatId }, 'a human wrote in this chat: the agent stays out until the resume command');
    return 'takeover';
  }

  /**
   * Once per customer: does the chat already hold messages from this account that the agent did not
   * send (a human's)? Then the conversation is theirs, until the resume command. 'unknown' when
   * Telegram could not be asked: silence for this turn, checked again next time.
   */
  private async freshConversation(userId: string, chatId: string, now: Date, log: Logger): Promise<'fresh' | 'human' | 'unknown'> {
    const { store } = this.o;
    if (!this.o.transport.recentOutgoing) {
      await store.users.setConversationChecked(userId, now);
      return 'fresh';
    }
    let outgoing: number[];
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
    if (!outgoing.some((id) => !ours.has(id))) return 'fresh';
    await store.users.setHumanTakeover(userId, FAR_FUTURE);
    log.info({ chat: chatId, humanMessages: outgoing.filter((id) => !ours.has(id)).length }, 'existing conversation: a human already wrote in this chat; the agent stays out until the resume command');
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
