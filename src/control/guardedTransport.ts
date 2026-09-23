import type { Logger } from 'pino';
import type { Transport } from '../telegram/transport.js';
import type { BotSwitch } from './botSwitch.js';

/** Thrown by the guarded transport: the agent is switched OFF, so the send did not happen. */
export class BotOffError extends Error {
  /** Recorded on the cancelled outbox entry. */
  readonly reason: string = 'bot_off';
  constructor(what = 'send') {
    super(`bot is OFF: ${what} cancelled`);
  }
}

/** Thrown by the guarded transport: customer messaging is on hold (`control/customerMessaging.ts`). */
export class MessagingHeldError extends BotOffError {
  override readonly reason = 'messaging_disabled';
  constructor(what = 'send') {
    super(what);
    this.message = `customer messaging is disabled: ${what} cancelled`;
  }
}

export interface GuardOptions {
  /** `false` (the temporary hold): every send to a chat outside `internalChats` is refused. */
  customerMessaging: boolean;
  /** Team-facing chats (support group, export bot) that the hold does not cover. */
  internalChats?: Iterable<string | undefined>;
}

/**
 * The transport every automatic path uses. Right before anything leaves the account — a reply, a
 * forward, even the "typing…" indicator — the switch is read again, fresh from the shared store.
 * OFF cancels the action with a {@link BotOffError}, so a reply prepared while the agent was ON but
 * finished after /botoff is never sent, whichever process prepared it. Admin replies (`/boton`,
 * `/botoff`, `/restart`) use the raw transport: they must work precisely while OFF.
 */
export function guardTransport(transport: Transport, botSwitch: Pick<BotSwitch, 'isOnNow'>, log: Logger, opts: GuardOptions = { customerMessaging: true }): Transport {
  const internal = new Set([...(opts.internalChats ?? [])].filter((c): c is string => !!c));
  const cancelled = (what: string, chatId: string) => {
    log.info({ chat: chatId, what }, 'bot is OFF: outgoing action cancelled');
    return new BotOffError(what);
  };
  // The temporary hold: a customer chat is any chat that is not one of the team's.
  const held = (what: string, chatId: string): Error | undefined => {
    if (opts.customerMessaging || internal.has(chatId)) return undefined;
    log.info({ chat: chatId, what }, 'customer messaging is disabled: outgoing message cancelled');
    return new MessagingHeldError(what);
  };
  const guarded: Transport = {
    start: (h) => transport.start(h),
    stop: () => transport.stop(),
    healthy: () => transport.healthy(),
    downloadMedia: (ref) => transport.downloadMedia(ref),
    messagesExist: (chatId, ids) => transport.messagesExist(chatId, ids),
    async sendText(chatId, text, sendOpts) {
      const hold = held('send', chatId);
      if (hold) throw hold;
      if (!(await botSwitch.isOnNow())) throw cancelled('send', chatId);
      return transport.sendText(chatId, text, sendOpts);
    },
    async forwardMessage(fromChatId, messageId, toChatId) {
      if (!(await botSwitch.isOnNow())) throw cancelled('forward', toChatId);
      return transport.forwardMessage(fromChatId, messageId, toChatId);
    },
    async sendTyping(chatId) {
      if (held('typing', chatId)) return;
      if (!(await botSwitch.isOnNow())) return; // silently: typing is not worth an error
      return transport.sendTyping(chatId);
    },
  };
  if (transport.deleteMessage) guarded.deleteMessage = (chatId, id) => transport.deleteMessage!(chatId, id);
  return guarded;
}
