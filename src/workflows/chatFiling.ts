import type { Logger } from 'pino';
import type { IssueCategory } from '../nlu/issueType.js';
import type { Transport } from '../telegram/transport.js';

export type FolderKind = 'support' | 'match';
export type FilingOutcome = FolderKind | 'none' | 'failed' | 'disabled';

export interface ChatFilingOptions {
  /** The RAW transport: filing edits the account's own folders, never a chat. */
  transport: Pick<Transport, 'addChatToFolder'>;
  /** Folder titles on the account, as shown in Telegram. */
  titles?: Record<FolderKind, string>;
  log: Logger;
}

/**
 * Which folder a customer's message calls for, so the team sees what is waiting:
 *  - a match matter (points, lineup, result, settlement, a request to add a sport) → Match issues
 *  - a deposit / withdrawal case, any other support matter, an unclear money message → Support
 *  - a greeting, thanks, "ok" → no folder.
 * A human's reply takes the chat out again (workflows/humanReplyFolders.ts). Folder edits run one
 * at a time; a failure is logged and swallowed — filing must never break anything else.
 */
export function folderFor(category: IssueCategory): FolderKind | 'none' {
  if (category === 'match') return 'match';
  if (category === 'chitchat') return 'none';
  return 'support';
}

export class ChatFiling {
  private queue: Promise<unknown> = Promise.resolve();
  /** Chats filed since start (for /status). */
  filed = 0;

  constructor(private readonly o: ChatFilingOptions) {}

  get enabled(): boolean {
    return !!this.o.titles && typeof this.o.transport.addChatToFolder === 'function';
  }

  file(chatId: string, category: IssueCategory): Promise<FilingOutcome> {
    if (!this.enabled) return Promise.resolve('disabled');
    const kind = folderFor(category);
    if (kind === 'none') return Promise.resolve('none');
    const title = this.o.titles![kind];
    const run = this.queue.then(async (): Promise<FilingOutcome> => {
      try {
        await this.o.transport.addChatToFolder!(title, chatId);
        this.filed++;
        this.o.log.info({ chat: chatId, folder: title, category }, 'chat filed for the team');
        return kind;
      } catch (err) {
        this.o.log.warn({ err, chat: chatId, folder: title, category }, 'chat could not be filed');
        return 'failed';
      }
    });
    this.queue = run.catch(() => undefined);
    return run;
  }
}
