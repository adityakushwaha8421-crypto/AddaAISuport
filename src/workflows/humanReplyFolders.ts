import type { Logger } from 'pino';
import type { Transport } from '../telegram/transport.js';

export type FolderOutcome = 'removed' | 'unchanged' | 'failed' | 'disabled';

export interface HumanReplyFoldersOptions {
  /** The RAW transport: this is account housekeeping, not a message to anyone. */
  transport: Pick<Transport, 'removeChatFromFolders'>;
  /** Folder titles a chat leaves once a human has replied in it. Empty: feature off. */
  titles: string[];
  log: Logger;
}

/**
 * The team files customer chats into Telegram folders ("Support", "Match issues") to see what is
 * waiting. Once a human has replied in a chat from the account, that chat is dealt with: it is taken
 * out of those folders automatically. Nothing is said to the customer; folder edits are one at a
 * time (Telegram rewrites the whole folder), and a failure is logged and swallowed — housekeeping
 * must never break anything else.
 */
export class HumanReplyFolders {
  private queue: Promise<unknown> = Promise.resolve();
  /** Chats taken out of a folder since start (for /status). */
  removed = 0;

  constructor(private readonly o: HumanReplyFoldersOptions) {}

  get enabled(): boolean {
    return this.o.titles.length > 0 && typeof this.o.transport.removeChatFromFolders === 'function';
  }

  /** A human wrote in this customer chat from the account: the chat leaves the folders. */
  onHumanReply(chatId: string): Promise<FolderOutcome> {
    if (!this.enabled) return Promise.resolve('disabled');
    const run = this.queue.then(async (): Promise<FolderOutcome> => {
      try {
        const left = await this.o.transport.removeChatFromFolders!(chatId, this.o.titles);
        if (!left.length) return 'unchanged';
        this.removed++;
        this.o.log.info({ chat: chatId, folders: left }, 'human replied: chat taken out of the folder');
        return 'removed';
      } catch (err) {
        this.o.log.warn({ err, chat: chatId, folders: this.o.titles }, 'human replied, but the chat could not be taken out of the folder');
        return 'failed';
      }
    });
    this.queue = run.catch(() => undefined);
    return run;
  }
}
