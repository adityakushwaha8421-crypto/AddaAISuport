import type { Logger } from 'pino';
import type { Transport } from '../telegram/transport.js';
import type { BotSwitch } from './botSwitch.js';

export interface AdminCommandEvent {
  chatId: string;
  messageId: number;
  /** Telegram user id of whoever typed it. */
  fromUserId: string;
  text?: string;
  /** Typed from the agent's own account (Saved Messages): the owner is always an admin. */
  owner?: boolean;
}

export type AdminCommand = 'boton' | 'botoff' | 'restart';

const COMMAND = /^\/(boton|botoff|restart)(?:@\w+)?\s*$/i;

export const REPLIES = {
  on: '✅ Bot is ON',
  off: '⛔ Bot is OFF',
  restarted: '✅ Bot restarted successfully.',
  restartUnavailable: '⚠️ Restart is not available in this process (it runs jobs only).',
} as const;

/** The command in a message, if it is one — whoever sent it. */
export function parseAdminCommand(text: string | undefined): AdminCommand | undefined {
  const m = text ? COMMAND.exec(text.trim()) : null;
  return m ? (m[1]!.toLowerCase() as AdminCommand) : undefined;
}

/**
 * /boton, /botoff, /restart — for the authorised admin Telegram ids (ADMIN_TELEGRAM_IDS) and the
 * account owner typing in Saved Messages. Anyone else typing the same words is a customer whose
 * message goes through the normal pipeline and changes nothing.
 */
export class AdminCommands {
  constructor(
    private readonly o: {
      admins: Iterable<string>;
      botSwitch: BotSwitch;
      transport: Pick<Transport, 'sendText'>;
      log: Logger;
      /** Provided by the supervisor: perform a safe restart, then send the success reply to `chatId`. */
      onRestart?: (reply: { chatId: string }) => void;
    },
  ) {
    this.admins = new Set([...o.admins].map((a) => a.trim()).filter(Boolean));
  }

  private readonly admins: Set<string>;

  isAdmin(userId: string): boolean {
    return this.admins.has(userId);
  }

  /** True when the message was an admin command and has been handled (the caller stops there). */
  async handle(ev: AdminCommandEvent): Promise<boolean> {
    const cmd = parseAdminCommand(ev.text);
    if (!cmd) return false;
    if (!ev.owner && !this.isAdmin(ev.fromUserId)) {
      this.o.log.warn({ chat: ev.chatId, user: ev.fromUserId, command: cmd }, 'admin command from a non-admin ignored');
      return false;
    }
    const log = this.o.log.child({ chat: ev.chatId, admin: ev.fromUserId, command: cmd });
    switch (cmd) {
      case 'boton':
        await this.o.botSwitch.set(true);
        await this.reply(ev.chatId, REPLIES.on);
        break;
      case 'botoff':
        await this.o.botSwitch.set(false);
        await this.reply(ev.chatId, REPLIES.off);
        break;
      case 'restart':
        if (!this.o.onRestart) {
          await this.reply(ev.chatId, REPLIES.restartUnavailable);
          break;
        }
        log.info('restart requested by an admin');
        this.o.onRestart({ chatId: ev.chatId });
        break;
    }
    log.info('admin command handled');
    return true;
  }

  private async reply(chatId: string, text: string) {
    await this.o.transport.sendText(chatId, text).catch((err) => this.o.log.warn({ err, chat: chatId }, 'could not send the admin reply'));
  }
}
