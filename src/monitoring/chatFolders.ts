import type { Logger } from 'pino';
import type { CaseRecord } from '../domain/cases.js';
import type { MatchIssueCategory } from '../nlu/matchIssue.js';
import type { Intent, Interpretation } from '../nlu/types.js';
import type { Metrics } from '../observability/metrics.js';
import type { ChatFolderApi } from '../telegram/transport.js';

export type FolderKind = 'match' | 'support';
export type Placement = FolderKind | 'none';
export type FolderChange = 'added' | 'removed' | 'unchanged' | 'failed';
/** What a placement changed, per folder; folders it left untouched are omitted. */
export type FolderChanges = Partial<Record<FolderKind, FolderChange>>;
export type RemoveReason = 'no_issue' | `moved_to_${FolderKind}` | 'human_reply' | 'turn_failed';

const KINDS: readonly FolderKind[] = ['match', 'support'];

/** Intents that are a non-match support matter on their own. */
const SUPPORT_INTENTS = new Set<Intent>([
  'deposit_issue', 'withdrawal_issue', 'payment_issue_unclear', 'account_issue', 'technical_issue', 'provide_info', 'general_query', 'human_request',
]);

/**
 * Which folder the latest message puts the chat in — nothing earlier counts:
 *  - any match problem → Match issues (even next to a deposit problem: the message is match-related)
 *  - any other support matter → Support, including an answer, document or "ok" inside an ongoing case
 *  - small talk with no case behind it (hello, thanks) → neither
 */
export function placementFor(interp: Pick<Interpretation, 'intent' | 'matchIssue' | 'relation'>, focused?: Pick<CaseRecord, 'id'>): Placement {
  if (interp.matchIssue || interp.intent === 'match_issue') return 'match';
  if (SUPPORT_INTENTS.has(interp.intent)) return 'support';
  if (focused && interp.relation === 'continue') return 'support';
  return 'none';
}

export interface ChatFoldersOptions {
  folders: ChatFolderApi;
  /** Folder titles on the account. Telegram allows at most 12 characters. */
  titles: Record<FolderKind, string>;
  log: Logger;
  metrics?: Metrics;
  /** How long known folder membership is trusted before it is read from Telegram again. */
  cacheTtlMs?: number;
  clock?: () => Date;
}

/**
 * Keeps each customer chat in the one folder its latest message calls for — "Match issues" or
 * "Support" — for the human team. The customer is never told.
 *
 * Telegram is the source of truth (the team can also move chats by hand); membership is cached
 * briefly, so a message that leaves a chat where it already is costs no API call. Edits rewrite a
 * whole folder, so they run one at a time. A chat is added to its new folder before it leaves the
 * old one, so a failure can leave it where it was but never in no folder. Failures are logged and
 * swallowed: organising chats must never break a customer's turn.
 */
export class ChatFolders {
  private readonly cache = new Map<FolderKind, { members: Set<string>; loadedAt: number }>();
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly o: ChatFoldersOptions) {
    const [match, support] = KINDS.map((k) => o.titles[k].trim().toLocaleLowerCase());
    if (match === support) throw new Error('The match-issues and support folders need different titles');
  }

  title(kind: FolderKind): string {
    return this.o.titles[kind];
  }

  /** Put the chat in `target` only (or in no folder). */
  place(chatId: string, target: Placement, category?: MatchIssueCategory): Promise<FolderChanges> {
    return this.serial(async () => {
      const changes: FolderChanges = {};
      if (target !== 'none') {
        const added = await this.add(target, chatId, category);
        if (added !== 'unchanged') changes[target] = added;
        if (added === 'failed') return changes; // keep it where it was rather than in no folder
      }
      const reason: RemoveReason = target === 'none' ? 'no_issue' : `moved_to_${target}`;
      for (const kind of KINDS) {
        if (kind === target) continue;
        const removed = await this.remove(kind, chatId, reason);
        if (removed !== 'unchanged') changes[kind] = removed;
      }
      return changes;
    });
  }

  /** A human answered (from the account, or relayed from the support group): the chat has been dealt with, so it leaves both folders. */
  humanReplied(chatId: string): Promise<FolderChange> {
    return this.serial(async () => {
      const match = await this.remove('match', chatId, 'human_reply');
      const support = await this.remove('support', chatId, 'human_reply');
      return match === 'removed' || support === 'removed' ? 'removed' : match === 'failed' || support === 'failed' ? 'failed' : 'unchanged';
    });
  }

  leave(chatId: string, kind: FolderKind, reason: RemoveReason): Promise<FolderChange> {
    return this.serial(() => this.remove(kind, chatId, reason));
  }

  contains(kind: FolderKind, chatId: string): Promise<boolean> {
    return this.serial(async () => (await this.members(kind)).has(chatId));
  }

  /** Read both folders from Telegram now. A count is undefined when that folder could not be read. */
  refresh(): Promise<Record<FolderKind, number | undefined>> {
    return this.serial(async () => {
      const counts = {} as Record<FolderKind, number | undefined>;
      for (const kind of KINDS) {
        try {
          counts[kind] = (await this.members(kind, true)).size;
        } catch (err) {
          this.cache.delete(kind);
          counts[kind] = undefined;
          this.o.log.warn({ err, folder: this.title(kind) }, 'could not read chat folder');
        }
      }
      return counts;
    });
  }

  private async add(kind: FolderKind, chatId: string, category?: MatchIssueCategory): Promise<FolderChange> {
    try {
      const members = await this.members(kind);
      if (members.has(chatId)) return 'unchanged';
      await this.o.folders.addChatToFolder(this.title(kind), chatId);
      members.add(chatId);
      this.o.metrics?.chatFolders.inc({ folder: kind, action: 'add', category, outcome: 'added' });
      this.o.log.info({ chat: chatId, folder: this.title(kind), category }, 'chat moved into folder');
      return 'added';
    } catch (err) {
      return this.failed(kind, 'add', chatId, err);
    }
  }

  private async remove(kind: FolderKind, chatId: string, reason: RemoveReason): Promise<FolderChange> {
    try {
      const members = await this.members(kind);
      if (!members.has(chatId)) return 'unchanged';
      await this.o.folders.removeChatFromFolder(this.title(kind), chatId);
      members.delete(chatId);
      this.o.metrics?.chatFolders.inc({ folder: kind, action: 'remove', reason, outcome: 'removed' });
      this.o.log.info({ chat: chatId, folder: this.title(kind), reason }, 'chat removed from folder');
      return 'removed';
    } catch (err) {
      return this.failed(kind, 'remove', chatId, err);
    }
  }

  private async members(kind: FolderKind, force = false): Promise<Set<string>> {
    const now = (this.o.clock?.() ?? new Date()).getTime();
    const hit = this.cache.get(kind);
    if (!force && hit && now - hit.loadedAt < (this.o.cacheTtlMs ?? 60_000)) return hit.members;
    const members = new Set(await this.o.folders.folderChats(this.title(kind)));
    this.cache.set(kind, { members, loadedAt: now });
    return members;
  }

  private failed(kind: FolderKind, action: 'add' | 'remove', chatId: string, err: unknown): FolderChange {
    this.cache.delete(kind); // unsure what Telegram holds now: read it again next time
    this.o.metrics?.chatFolders.inc({ folder: kind, action, outcome: 'failed' });
    this.o.log.warn({ err, chat: chatId, action, folder: this.title(kind) }, 'chat folder update failed');
    return 'failed';
  }

  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.queue.then(fn);
    this.queue = run.catch(() => undefined);
    return run;
  }
}
