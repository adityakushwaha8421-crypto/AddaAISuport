import type { Logger } from 'pino';
import type { IssueCategory } from '../nlu/issueType.js';
import type { Transport } from '../telegram/transport.js';

export type FolderKind = 'support' | 'match' | 'deposit' | 'withdrawal';
export type FilingOutcome = FolderKind | 'none' | 'unchanged' | 'failed' | 'disabled';

/** Folder titles on the account, as shown in Telegram. Deposit and withdrawal may share the support folder. */
export type FolderTitles = Record<FolderKind, string>;

export interface ChatFilingOptions {
  /** The RAW transport: filing edits the account's own folders, never a chat. */
  transport: Pick<Transport, 'addChatToFolder'>;
  titles?: FolderTitles;
  log: Logger;
}

/**
 * Which folder a customer's message calls for, so the team sees what is waiting:
 *  - a match matter (points, lineup, result, settlement, a request to add a sport) → Match issues
 *  - a deposit case → the deposit folder; a withdrawal case → the withdrawal folder (both: Support, unless configured)
 *  - any other support matter, an unclear money message → Support
 *  - a greeting, thanks, "ok" → no folder.
 */
export function folderFor(category: IssueCategory): FolderKind | 'none' {
  if (category === 'match') return 'match';
  if (category === 'deposit' || category === 'withdrawal') return category;
  if (category === 'chitchat') return 'none';
  return 'support';
}

/**
 * The folders hold exactly the chats waiting for the team. A live customer message that is an issue
 * (or any message inside an open case) files the chat; a human's reply takes it out again
 * (workflows/humanReplyFolders.ts) and the next issue files it anew. Chats a human is already
 * talking in, stale catch-up messages and small talk are never filed. Folder edits run one at a
 * time; a failure is logged and swallowed — filing must never break anything else.
 */
export class ChatFiling {
  private queue: Promise<unknown> = Promise.resolve();
  /** Where each chat was last put by this process, so a case's every message costs one folder read, not one each. */
  private readonly placed = new Map<string, string>();
  /** Chats filed since start (for /status). */
  filed = 0;

  constructor(private readonly o: ChatFilingOptions) {}

  get enabled(): boolean {
    return !!this.o.titles && typeof this.o.transport.addChatToFolder === 'function';
  }

  /** The distinct folder titles in use (the human-reply removal covers all of them). */
  get folders(): string[] {
    return [...new Set(Object.values(this.o.titles ?? {}))];
  }

  file(chatId: string, category: IssueCategory): Promise<FilingOutcome> {
    if (!this.enabled) return Promise.resolve('disabled');
    const kind = folderFor(category);
    if (kind === 'none') return Promise.resolve('none');
    const title = this.o.titles![kind];
    if (this.placed.get(chatId) === title) return Promise.resolve('unchanged');
    const run = this.queue.then(async (): Promise<FilingOutcome> => {
      try {
        await this.o.transport.addChatToFolder!(title, chatId);
        this.placed.set(chatId, title);
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

  /** A human replied (the chat left the folders): the next issue files it again. */
  forget(chatId: string): void {
    this.placed.delete(chatId);
  }
}
