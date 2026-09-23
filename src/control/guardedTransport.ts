import type { Logger } from 'pino';
import type { Transport } from '../telegram/transport.js';
import type { BotSwitch } from './botSwitch.js';

/** Thrown by the guarded transport: the agent is switched OFF, so the send did not happen. */
export class BotOffError extends Error {
  constructor(what = 'send') {
    super(`bot is OFF: ${what} cancelled`);
  }
}

/**
 * The transport every automatic path uses. Right before anything leaves the account — a reply, a
 * forward, even the "typing…" indicator — the switch is read again, fresh from the shared store.
 * OFF cancels the action with a {@link BotOffError}, so a reply prepared while the agent was ON but
 * finished after /botoff is never sent, whichever process prepared it. Admin replies (`/boton`,
 * `/botoff`, `/restart`) use the raw transport: they must work precisely while OFF.
 */
export function guardTransport(transport: Transport, botSwitch: Pick<BotSwitch, 'isOnNow'>, log: Logger): Transport {
  const cancelled = (what: string, chatId: string) => {
    log.info({ chat: chatId, what }, 'bot is OFF: outgoing action cancelled');
    return new BotOffError(what);
  };
  const guarded: Transport = {
    start: (h) => transport.start(h),
    stop: () => transport.stop(),
    healthy: () => transport.healthy(),
    downloadMedia: (ref) => transport.downloadMedia(ref),
    messagesExist: (chatId, ids) => transport.messagesExist(chatId, ids),
    async sendText(chatId, text, opts) {
      if (!(await botSwitch.isOnNow())) throw cancelled('send', chatId);
      return transport.sendText(chatId, text, opts);
    },
    async forwardMessage(fromChatId, messageId, toChatId) {
      if (!(await botSwitch.isOnNow())) throw cancelled('forward', toChatId);
      return transport.forwardMessage(fromChatId, messageId, toChatId);
    },
    async sendTyping(chatId) {
      if (!(await botSwitch.isOnNow())) return; // silently: typing is not worth an error
      return transport.sendTyping(chatId);
    },
  };
  if (transport.deleteMessage) guarded.deleteMessage = (chatId, id) => transport.deleteMessage!(chatId, id);
  return guarded;
}
