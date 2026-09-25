import type { Logger } from 'pino';
import { AdminCommands, REPLIES, type AdminCommandEvent } from './control/adminCommands.js';
import { BotSwitch } from './control/botSwitch.js';
import { CUSTOMER_MESSAGING_ENABLED, ENABLED_CUSTOMER_MESSAGES } from './control/customerMessaging.js';
import { guardTransport } from './control/guardedTransport.js';
import { OtherCopyDetector } from './control/otherCopy.js';
import { messageBody, type InboundMessage } from './domain/messages.js';
import type { LlmClient } from './llm/client.js';
import type { Metrics } from './observability/metrics.js';
import { scrubber } from './security/scrubber.js';
import type { Store } from './storage/types.js';
import type { ReadStateApi, SupportGroupMessage, Transport } from './telegram/transport.js';
import { EvidenceRequestWorkflow, type RequestOutcome } from './workflows/evidenceRequest.js';
import { PaymentConfirmedWorkflow } from './workflows/paymentConfirmed.js';

export interface AppConfig {
  /** Telegram user ids allowed to run /boton, /botoff, /restart by messaging the account. */
  adminIds?: string[];
  /** Given by the supervisor: perform a safe restart and confirm to that chat afterwards. */
  onRestart?: (reply: { chatId: string }) => void;
  /** Mirror of the ON/OFF switch on disk, so OFF survives a full restart with the in-memory store. */
  botStateFile?: string;
  /** Team chats the transport tells apart from customer chats. */
  supportChatId?: string;
  exportChatId?: string;
  /** See the matching env settings. */
  staleSeconds?: number;
  reopenHours?: number;
  takeoverHours?: number;
  /** Shown by /status. */
  version?: string;
  transportStats?: () => { reconnects: number; lastUpdateAt: Date };
}

export interface AppComponents {
  store: Store;
  transport: Transport;
  log: Logger;
  metrics?: Metrics;
  clock?: () => Date;
  /** Used only to tell deposit from withdrawal when the lexical scorer cannot. */
  llm?: LlmClient;
  /** Telegram read state; when set, a message a human already read gets no request. */
  readState?: ReadStateApi;
  /** The ON/OFF switch (defaults to one over the store's settings). */
  botSwitch?: BotSwitch;
}

export interface App {
  /** ON/OFF, persisted; OFF = nothing automatic at all. */
  botSwitch: BotSwitch;
  adminCommands: AdminCommands;
  /** The guarded transport: refuses any customer send that is not an enabled kind, or while OFF. */
  transport: Transport;
  requests: EvidenceRequestWorkflow;
  confirmations: PaymentConfirmedWorkflow;
  /** Replies from another (old) copy of the bot seen in customer chats. */
  otherCopy: OtherCopyDetector;
  status(): Promise<string>;
  /** A customer wrote to the account: stored; a deposit/withdrawal issue gets its one request; a bare greeting opening a fresh chat gets one greeting. */
  onMessage(msg: InboundMessage): Promise<RequestOutcome | 'admin' | 'duplicate'>;
  /** The account owner typed in Saved Messages (admin console). */
  onAdminCommand(ev: AdminCommandEvent): Promise<void>;
  onSupportMessage(msg: SupportGroupMessage): Promise<void>;
  /** A human wrote from the account in a customer chat: the chat is theirs for HUMAN_TAKEOVER_HOURS. */
  onOwnOutgoing(ev: { chatId: string; messageId: number; text?: string }): Promise<void>;
  /** The export bot wrote: a valid PAYMENT CONFIRMED with a User ID tells that customer once. */
  onExportMessage(msg: { messageId: number; text?: string; replyToMessageId?: number }): Promise<void>;
}

/**
 * The agent: it holds the Telegram session, stores what customers send, and runs exactly two
 * customer-facing workflows — the one evidence request per deposit/withdrawal case (plus one
 * greeting back to a bare "Hi" that opens a fresh chat), and the one solved note after the export
 * bot's payment confirmation. Both send through the guarded transport, which refuses everything
 * else and everything while OFF.
 */
export function assemble(c: AppComponents, cfg: AppConfig = {}): App {
  const now = () => c.clock?.() ?? new Date();
  const botSwitch = c.botSwitch ?? new BotSwitch({ settings: c.store.settings, log: c.log, clock: c.clock, stateFile: cfg.botStateFile });
  c.log.info({ customerMessaging: CUSTOMER_MESSAGING_ENABLED, allowed: [...ENABLED_CUSTOMER_MESSAGES] }, 'customer messages allowed: only these kinds');
  const transport = guardTransport(c.transport, botSwitch, c.log.child({ mod: 'send-guard' }), {
    customerMessaging: CUSTOMER_MESSAGING_ENABLED,
    internalChats: [cfg.supportChatId, cfg.exportChatId],
  });
  const requests = new EvidenceRequestWorkflow({
    store: c.store, transport, botSwitch, llm: c.llm, readState: c.readState, log: c.log.child({ mod: 'evidence-request' }), clock: c.clock,
    staleSeconds: cfg.staleSeconds, reopenHours: cfg.reopenHours, takeoverHours: cfg.takeoverHours,
  });
  const confirmations = new PaymentConfirmedWorkflow({ store: c.store, transport, botSwitch, log: c.log.child({ mod: 'payment-confirmed' }), clock: c.clock });
  // Admin replies ("✅ Bot is ON") go through the raw transport: they must work while OFF, and admins are not customers.
  const adminCommands = new AdminCommands({ admins: cfg.adminIds ?? [], botSwitch, transport: c.transport, log: c.log.child({ mod: 'admin-commands' }), onRestart: cfg.onRestart, status: () => status() });
  const otherCopy = new OtherCopyDetector();
  const startedAt = now();
  let requestsSent = 0;
  let notesSent = 0;
  let greetingsSent = 0;
  const status = async (): Promise<string> => {
    const on = await botSwitch.isOnNow();
    const up = Math.round((now().getTime() - startedAt.getTime()) / 60_000);
    const stats = cfg.transportStats?.();
    const seen = otherCopy.recent(now(), 24);
    const lines = [
      on ? REPLIES.on : REPLIES.off,
      `Code: ${cfg.version ?? 'unknown'} · up ${up >= 60 ? `${Math.floor(up / 60)}h ${up % 60}m` : `${up}m`}`,
      `Sent since start: ${requestsSent} evidence request${requestsSent === 1 ? '' : 's'}, ${notesSent} solved note${notesSent === 1 ? '' : 's'}, ${greetingsSent} greeting${greetingsSent === 1 ? '' : 's'}`,
    ];
    if (stats) lines.push(`Telegram: last update ${Math.round((now().getTime() - stats.lastUpdateAt.getTime()) / 1000)}s ago · stream taken over ${stats.reconnects}× since start${stats.reconnects >= 3 ? ' ⚠️ another connection is using this session' : ''}`);
    lines.push(seen.length
      ? `⚠️ OLD bot wording seen ${seen.length}× in the last 24h (last ${seen[seen.length - 1]!.at.toISOString().slice(11, 16)} UTC, chat ${seen[seen.length - 1]!.chatId}): another copy of the old bot is replying`
      : 'No old-bot replies seen in the last 24h');
    return lines.join('\n');
  };

  return {
    botSwitch,
    adminCommands,
    transport,
    requests,
    confirmations,
    otherCopy,
    status,
    async onMessage(msg) {
      // An authorised admin's /boton, /botoff or /restart is acted on at once.
      if (await adminCommands.handle({ chatId: msg.chatId, messageId: msg.messageId, fromUserId: msg.userId, text: messageBody(msg) })) return 'admin';
      // Every customer message is kept in the transcript first, whatever happens next.
      const body = messageBody(msg);
      const scrubbed = scrubber.scrub(body);
      await c.store.users.upsert({ id: msg.userId, chatId: msg.chatId, username: msg.sender.username, firstName: msg.sender.firstName, languageCode: msg.sender.languageCode });
      const { inserted } = await c.store.messages.insert({
        chatId: msg.chatId, userId: msg.userId, telegramMessageId: msg.messageId, direction: 'in',
        text: msg.text === undefined ? undefined : scrubbed, caption: msg.caption === undefined ? undefined : scrubber.scrub(msg.caption),
        media: msg.media, replyToMessageId: msg.replyTo?.messageId, createdAt: msg.date, meta: { scrubbed: scrubbed !== body },
      });
      if (!inserted) {
        c.metrics?.duplicateMessages.inc();
        return 'duplicate';
      }
      c.metrics?.inboundMessages.inc({ kind: msg.media.length ? 'media' : 'text' });
      // The one workflow. Its first line checks the switch; every other outcome is silence.
      const outcome = await requests.onMessage(msg);
      if (outcome === 'requested') requestsSent++;
      if (outcome === 'greeted') greetingsSent++;
      await c.store.messages.markProcessed(msg.chatId, [msg.messageId]);
      c.metrics?.outbound.inc({ kind: outcome.startsWith('greet') ? 'greeting' : 'evidence_request', outcome });
      c.log.info(
        { chat: msg.chatId, message: msg.messageId, media: msg.media.length, outcome, at: now().toISOString() },
        outcome === 'requested' ? 'customer message: evidence request sent' : outcome === 'greeted' ? 'customer message: greeting sent (fresh conversation)' : 'customer message stored, no reply',
      );
      return outcome;
    },
    async onAdminCommand(ev) {
      await adminCommands.handle({ ...ev, owner: true });
    },
    async onSupportMessage(msg) {
      c.log.info({ chat: msg.chatId, message: msg.messageId }, 'support group message received (no handler)');
    },
    async onOwnOutgoing(ev) {
      if (otherCopy.note(ev.chatId, ev.text, now())) {
        c.log.warn({ chat: ev.chatId, message: ev.messageId, sightings24h: otherCopy.recent(now(), 24).length }, 'ANOTHER COPY OF THE OLD BOT replied in this chat (old wording, not sent by this process)');
      }
      await requests.onOwnOutgoing(ev);
    },
    async onExportMessage(msg) {
      const outcome = await confirmations.onExportMessage(msg);
      if (outcome === 'solved') notesSent++;
      c.metrics?.outbound.inc({ kind: 'payment_confirmed', outcome });
    },
  };
}
