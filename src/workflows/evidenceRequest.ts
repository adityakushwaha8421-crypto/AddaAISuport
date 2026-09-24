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
  | 'seen_by_human'
  | 'cancelled'
  | 'send_failed';

export interface EvidenceRequestOptions {
  store: Store;
  /** The GUARDED transport: it refuses the send if the bot is OFF or messaging is disabled. */
  transport: Pick<Transport, 'sendText' | 'deleteMessage'>;
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
    const user = await store.users.get(msg.userId);
    if (user?.humanTakeoverUntil && user.humanTakeoverUntil > now) return 'human';

    const body = messageBody(msg);
    if (!body) return 'no_text'; // a bare photo or file says nothing about the issue
    const lang = detectLanguage(body);
    if (lang && lang !== user?.preferredLanguage) await store.users.setPreferredLanguage(msg.userId, lang);
    const language: Language = lang ?? user?.preferredLanguage ?? 'hinglish';

    // A case with its request out is silent, whatever the customer writes: the team has it. Only a
    // clearly named problem of ANOTHER kind (deposit while a withdrawal is open) is a new case; the
    // model is not consulted inside an open case, so small talk and follow-ups cost nothing.
    const open = await store.requests.listOpen(msg.chatId);
    const reopenMs = (this.o.reopenHours ?? 48) * 3_600_000;
    const live = open.filter((r) => r.status === 'sending' || now.getTime() - r.createdAt.getTime() < reopenMs);
    const history = (await store.messages.recent(msg.chatId, 12))
      .filter((m) => m.direction === 'in' && m.telegramMessageId !== msg.messageId && now.getTime() - m.createdAt.getTime() < 48 * 3_600_000)
      .map((m) => [m.text, m.caption].filter(Boolean).join('\n'))
      .filter(Boolean);
    const verdict = await classifyIssue(body, live.length ? undefined : this.o.llm, clog, { history });
    clog.debug({ category: verdict.category, source: verdict.source }, 'issue classified');
    if (!verdict.type) return live.length ? 'already_requested' : 'not_an_issue';
    if (live.some((r) => r.issueType === verdict.type || r.status === 'sending')) return 'already_requested';

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
    const user = await store.users.get(ev.chatId);
    if (!user) return 'ignored'; // never a customer we know: nothing to protect
    await store.users.setHumanTakeover(user.id, FAR_FUTURE);
    log.info({ chat: ev.chatId }, 'a human wrote in this chat: the agent stays out until the resume command');
    return 'takeover';
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
