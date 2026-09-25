import type { InboundMessage, MediaRef } from '../../src/domain/messages.js';
import type { ReadStateApi, SendOptions, Transport, TransportHandlers } from '../../src/telegram/transport.js';

export const ADMIN = '500000001';
export const SUPPORT = '-100999';
export const EXPORT_BOT = '8869616760';
export const NOW = new Date('2026-09-23T12:00:00+05:30');

/** In-memory Telegram: records every send/forward; per-chat sequential ids; read state a test can set. */
export class FakeTransport implements Transport, ReadStateApi {
  readonly sent: Array<{ chatId: string; text: string; kind?: string; replyTo?: number }> = [];
  readonly readUpTo = new Map<string, number>();
  /** Messages a human sent from the account in a chat before the agent ever saw it. */
  readonly humanHistory = new Map<string, number[]>();
  failSends = 0;
  failHistoryChecks = 0;
  handlers?: TransportHandlers;
  private counters = new Map<string, number>();
  nextId(chatId: string) {
    const n = (this.counters.get(chatId) ?? 0) + 1;
    this.counters.set(chatId, n);
    return n;
  }
  async start(h: TransportHandlers) {
    this.handlers = h;
  }
  async stop() {}
  healthy() {
    return true;
  }
  async sendText(chatId: string, text: string, opts?: SendOptions) {
    if (this.failSends > 0) {
      this.failSends--;
      throw new Error('FLOOD_WAIT_3');
    }
    const messageId = this.nextId(chatId);
    this.sentIds.set(`${chatId}:${this.sent.length}`, messageId);
    this.sent.push({ chatId, text, kind: opts?.kind, replyTo: opts?.replyToMessageId });
    return { messageId };
  }
  async recentOutgoing(chatId: string, limit: number) {
    if (this.failHistoryChecks > 0) {
      this.failHistoryChecks--;
      throw new Error('FLOOD_WAIT_5');
    }
    const ownIds = this.sent.reduce<number[]>((acc, s, i) => (s.chatId === chatId ? [...acc, this.idOf(chatId, i)] : acc), []);
    return [...ownIds, ...(this.humanHistory.get(chatId) ?? [])].sort((a, b) => b - a).slice(0, limit);
  }
  /** The id a send got: sends are recorded in order, ids per chat are sequential across in+out. */
  private idOf(chatId: string, sentIndex: number) {
    return this.sentIds.get(`${chatId}:${sentIndex}`) ?? 0;
  }
  private readonly sentIds = new Map<string, number>();
  /** A human already wrote in this chat from the account (before the agent ran). */
  humanWroteEarlier(chatId: string): number {
    const id = this.nextId(chatId);
    this.humanHistory.set(chatId, [...(this.humanHistory.get(chatId) ?? []), id]);
    return id;
  }
  async seenByHuman(chatId: string, messageId: number) {
    return (this.readUpTo.get(chatId) ?? 0) >= messageId;
  }
  /** A human opened the chat on the account: everything so far is read. */
  humanReads(chatId: string) {
    this.readUpTo.set(chatId, this.counters.get(chatId) ?? 0);
  }
  /** Build an inbound customer message with the next id in that chat. */
  inbound(userId: string, text?: string, media: MediaRef[] = [], date = NOW): InboundMessage {
    return { chatId: userId, userId, messageId: this.nextId(userId), date, text, media, sender: { firstName: 'C' } };
  }
}

export const customerSends = (t: FakeTransport, except: string[] = [ADMIN, SUPPORT, EXPORT_BOT]) => t.sent.filter((s) => !except.includes(s.chatId));
export const photo = (): MediaRef[] => [{ kind: 'photo', fileRef: 'f', fileUniqueId: 'f', mimeType: 'image/jpeg' }];
export const pdf = (): MediaRef[] => [{ kind: 'document', fileRef: 'p', fileUniqueId: 'p', mimeType: 'application/pdf', fileName: 's.pdf' }];
