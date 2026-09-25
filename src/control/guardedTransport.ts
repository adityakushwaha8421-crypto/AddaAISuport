import type { Logger } from 'pino';
import type { Transport } from '../telegram/transport.js';
import type { BotSwitch } from './botSwitch.js';
import { ENABLED_CUSTOMER_MESSAGES } from './customerMessaging.js';

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
  /** Message kinds let through the hold (defaults to `ENABLED_CUSTOMER_MESSAGES`). */
  allowedKinds?: ReadonlySet<string>;
}

/**
 * The transport every automatic path uses. Right before anything leaves the account the switch is
 * read again, fresh from the shared store, and the message kind is checked against the allowlist.
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
  // Customer messaging disabled (control/customerMessaging.ts): a customer chat is any chat that is not one of the team's.
  const allowed = opts.allowedKinds ?? ENABLED_CUSTOMER_MESSAGES;
  const held = (what: string, chatId: string, kind?: string): Error | undefined => {
    if (opts.customerMessaging || internal.has(chatId) || (kind && allowed.has(kind))) return undefined;
    log.info({ chat: chatId, what }, 'customer messaging is disabled: outgoing message cancelled');
    return new MessagingHeldError(what);
  };
  const guarded: Transport = {
    start: (h) => transport.start(h),
    stop: () => transport.stop(),
    healthy: () => transport.healthy(),
    async sendText(chatId, text, sendOpts) {
      const hold = held('send', chatId, sendOpts?.kind);
      if (hold) throw hold;
      if (!(await botSwitch.isOnNow())) throw cancelled('send', chatId);
      return transport.sendText(chatId, text, sendOpts);
    },
  };
  if (transport.recentOutgoing) guarded.recentOutgoing = (chatId, limit) => transport.recentOutgoing!(chatId, limit);
  return guarded;
}
