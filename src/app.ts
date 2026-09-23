import type { Logger } from 'pino';
import { AdminCommands, type AdminCommandEvent } from './control/adminCommands.js';
import { BotSwitch } from './control/botSwitch.js';
import { CUSTOMER_MESSAGING_ENABLED } from './control/customerMessaging.js';
import { guardTransport } from './control/guardedTransport.js';
import { messageBody, type InboundMessage } from './domain/messages.js';
import type { Metrics } from './observability/metrics.js';
import { scrubber } from './security/scrubber.js';
import type { Store } from './storage/types.js';
import type { ExportForwardEvent, SupportGroupMessage, Transport } from './telegram/transport.js';

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
}

export interface AppComponents {
  store: Store;
  transport: Transport;
  log: Logger;
  metrics?: Metrics;
  clock?: () => Date;
  /** The ON/OFF switch (defaults to one over the store's settings). */
  botSwitch?: BotSwitch;
}

export interface App {
  /** ON/OFF, persisted; OFF = nothing automatic at all. */
  botSwitch: BotSwitch;
  adminCommands: AdminCommands;
  /** The transport every future automatic path must use: it refuses customer sends until enabled. */
  transport: Transport;
  /** A customer wrote to the account: stored, never answered. */
  onMessage(msg: InboundMessage): Promise<void>;
  /** The account owner typed in Saved Messages (admin console). */
  onAdminCommand(ev: AdminCommandEvent): Promise<void>;
  /** Team-side events: received and logged, nothing more (no workflow exists yet). */
  onSupportMessage(msg: SupportGroupMessage): Promise<void>;
  onOwnOutgoing(ev: { chatId: string; messageId: number; text?: string }): Promise<void>;
  onExportMessage(msg: { messageId: number; text?: string; replyToMessageId?: number }): Promise<void>;
  onExportForward(ev: ExportForwardEvent): Promise<void>;
}

/**
 * The agent without its reply system: it holds the Telegram session, receives and stores what
 * customers send, and answers only its admin's commands. No code path here can message a customer,
 * and the guarded transport refuses any that is added later until it is deliberately enabled.
 */
export function assemble(c: AppComponents, cfg: AppConfig = {}): App {
  const now = () => c.clock?.() ?? new Date();
  const botSwitch = c.botSwitch ?? new BotSwitch({ settings: c.store.settings, log: c.log, clock: c.clock, stateFile: cfg.botStateFile });
  if (!CUSTOMER_MESSAGING_ENABLED) c.log.warn('customer messaging is disabled: no automatic message reaches any customer (control/customerMessaging.ts)');
  const transport = guardTransport(c.transport, botSwitch, c.log.child({ mod: 'send-guard' }), {
    customerMessaging: CUSTOMER_MESSAGING_ENABLED,
    internalChats: [cfg.supportChatId, cfg.exportChatId],
  });
  // Admin replies ("✅ Bot is ON") go through the raw transport: they must work while OFF, and admins are not customers.
  const adminCommands = new AdminCommands({ admins: cfg.adminIds ?? [], botSwitch, transport: c.transport, log: c.log.child({ mod: 'admin-commands' }), onRestart: cfg.onRestart });

  return {
    botSwitch,
    adminCommands,
    transport,
    async onMessage(msg) {
      // An authorised admin's /boton, /botoff or /restart is acted on at once.
      if (await adminCommands.handle({ chatId: msg.chatId, messageId: msg.messageId, fromUserId: msg.userId, text: messageBody(msg) })) return;
      // Everything else is a customer message: kept in the transcript, never answered. Whether the
      // bot is ON or OFF is recorded with it, for the workflows to come; today nothing acts either way.
      const on = await botSwitch.isOnNow();
      const body = messageBody(msg);
      const scrubbed = scrubber.scrub(body);
      await c.store.users.upsert({ id: msg.userId, chatId: msg.chatId, username: msg.sender.username, firstName: msg.sender.firstName, languageCode: msg.sender.languageCode });
      const { inserted } = await c.store.messages.insert({
        chatId: msg.chatId, userId: msg.userId, telegramMessageId: msg.messageId, direction: 'in',
        text: msg.text === undefined ? undefined : scrubbed, caption: msg.caption === undefined ? undefined : scrubber.scrub(msg.caption),
        media: msg.media, replyToMessageId: msg.replyTo?.messageId, createdAt: msg.date,
        meta: { scrubbed: scrubbed !== body, ignored: on ? 'no_reply_system' : 'bot_off' },
      });
      if (!inserted) {
        c.metrics?.duplicateMessages.inc();
        return;
      }
      await c.store.messages.markProcessed(msg.chatId, [msg.messageId]);
      c.metrics?.inboundMessages.inc({ kind: msg.media.length ? 'media' : 'text' });
      c.log.info({ chat: msg.chatId, message: msg.messageId, media: msg.media.length, botOn: on, at: now().toISOString() }, 'customer message received and stored (no automatic reply)');
    },
    async onAdminCommand(ev) {
      await adminCommands.handle({ ...ev, owner: true });
    },
    async onSupportMessage(msg) {
      c.log.info({ chat: msg.chatId, message: msg.messageId }, 'support group message received (no handler)');
    },
    async onOwnOutgoing(ev) {
      c.log.info({ chat: ev.chatId, message: ev.messageId }, 'a human wrote from the account (no handler)');
    },
    async onExportMessage(msg) {
      c.log.info({ message: msg.messageId }, 'export bot message received (no handler)');
    },
    async onExportForward(ev) {
      c.log.info({ message: ev.messageId }, 'a human forwarded to the export bot (no handler)');
    },
  };
}
