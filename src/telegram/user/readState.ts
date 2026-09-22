/**
 * Which incoming messages a human on this account has already read, from Telegram's read updates.
 *
 * When anyone reads a private chat on this account (phone app, Telegram Desktop), Telegram pushes
 * `updateReadHistoryInbox` with the highest message id now read. Sending a message can mark the chat
 * read as well, so a read that arrives while our own reply is going out (or just after), and covers
 * nothing newer than what we had received by then, is attributed to that send, not to a human.
 */
export class ReadTracker {
  /** Highest incoming message id a human has read, per chat. */
  private readonly readUpTo = new Map<string, number>();
  /** First incoming message seen live per chat: from there on the updates are complete. */
  private readonly firstLive = new Map<string, number>();
  private readonly lastIncoming = new Map<string, number>();
  private readonly inFlight = new Map<string, number>();
  private readonly lastSend = new Map<string, { at: number; covers: number }>();
  private readonly graceMs: number;
  private readonly now: () => number;

  constructor(opts: { graceMs?: number; now?: () => number } = {}) {
    this.graceMs = opts.graceMs ?? 3000;
    this.now = opts.now ?? Date.now;
  }

  /** A customer message arrived while we were listening. */
  incoming(chatId: string, messageId: number): void {
    if (!this.firstLive.has(chatId)) this.firstLive.set(chatId, messageId);
    this.lastIncoming.set(chatId, Math.max(this.lastIncoming.get(chatId) ?? 0, messageId));
  }

  /** We are sending into this chat; call the returned function once the send finished. */
  sending(chatId: string): () => void {
    this.inFlight.set(chatId, (this.inFlight.get(chatId) ?? 0) + 1);
    return () => {
      const n = (this.inFlight.get(chatId) ?? 1) - 1;
      if (n > 0) this.inFlight.set(chatId, n);
      else this.inFlight.delete(chatId);
      this.lastSend.set(chatId, { at: this.now(), covers: this.lastIncoming.get(chatId) ?? 0 });
    };
  }

  /** Telegram reports the chat read up to `maxId`. Returns who read it. */
  read(chatId: string, maxId: number): 'human' | 'own_send' {
    const last = this.lastSend.get(chatId);
    const covers = this.inFlight.has(chatId)
      ? (this.lastIncoming.get(chatId) ?? 0)
      : last && this.now() - last.at <= this.graceMs ? last.covers : -1;
    if (maxId <= covers) return 'own_send';
    this.readUpTo.set(chatId, Math.max(this.readUpTo.get(chatId) ?? 0, maxId));
    return 'human';
  }

  /** Known read state, or undefined for a message that arrived before we were listening. */
  seen(chatId: string, messageId: number): boolean | undefined {
    if ((this.readUpTo.get(chatId) ?? 0) >= messageId) return true;
    const first = this.firstLive.get(chatId);
    return first !== undefined && messageId >= first ? false : undefined;
  }
}
