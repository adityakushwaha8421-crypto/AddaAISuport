import type { Logger } from 'pino';
import type { MediaRef } from '../domain/messages.js';
import type { ChatFolders, FolderKind, Placement, RemoveReason } from '../monitoring/chatFolders.js';
import type { MatchIssueCategory } from '../nlu/matchIssue.js';
import { withRetry } from '../util/rateLimiter.js';
import { MediaTooLargeError, type ReadStateApi, type SendOptions, type Transport, type TransportHandlers } from './transport.js';

/** A failure the gateway reported (4xx): retrying would repeat it. */
export class GatewayRequestError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

const transient = (err: unknown) => !(err instanceof GatewayRequestError) || err.status >= 500;

/**
 * A worker's Telegram: every operation is an HTTP call to the gateway, which owns the one
 * MTProto session. Network hiccups are retried with backoff; what the gateway refused is not.
 */
export class RemoteTransport implements Transport, ReadStateApi {
  private up = false;

  constructor(private readonly o: { baseUrl: string; token: string; log: Logger; timeoutMs?: number }) {}

  private async call<T>(path: string, body: unknown, opts: { binary?: boolean; attempts?: number } = {}): Promise<T> {
    const url = `${this.o.baseUrl.replace(/\/$/, '')}/internal/${path}`;
    return withRetry(
      async () => {
        const res = await fetch(url, {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: `Bearer ${this.o.token}` },
          body: JSON.stringify(body ?? {}),
          signal: AbortSignal.timeout(this.o.timeoutMs ?? 120_000),
        });
        if (!res.ok) {
          const text = await res.text().catch(() => '');
          if (res.status === 413) throw new MediaTooLargeError(text || 'file too large');
          throw new GatewayRequestError(res.status, `gateway ${path}: ${res.status} ${text.slice(0, 200)}`);
        }
        this.up = true;
        if (opts.binary) return Buffer.from(await res.arrayBuffer()) as unknown as T;
        return (await res.json()) as T;
      },
      { attempts: opts.attempts ?? 4, baseMs: 400, retryOn: transient, onRetry: (err, attempt) => this.o.log.warn({ err, path, attempt }, 'gateway call failed; retrying') },
    );
  }

  async start(_handlers: TransportHandlers): Promise<void> {
    await this.call('ping', {});
  }
  async stop(): Promise<void> {}
  healthy(): boolean {
    return this.up;
  }
  sendText(chatId: string, text: string, opts?: SendOptions) {
    return this.call<{ messageId: number }>('telegram/send-text', { chatId, text, opts });
  }
  forwardMessage(fromChatId: string, messageId: number, toChatId: string) {
    return this.call<{ messageId: number } | null>('telegram/forward', { fromChatId, messageId, toChatId }).then((r) => r ?? undefined);
  }
  downloadMedia(ref: MediaRef) {
    return this.call<Buffer>('telegram/download', { ref }, { binary: true, attempts: 2 });
  }
  messagesExist(chatId: string, messageIds: number[]) {
    return this.call<number[]>('telegram/messages-exist', { chatId, messageIds });
  }
  async sendTyping(chatId: string) {
    await this.call('telegram/typing', { chatId }, { attempts: 1 }).catch(() => undefined);
  }
  async deleteMessage(chatId: string, messageId: number) {
    await this.call('telegram/delete', { chatId, messageId }, { attempts: 2 });
  }
  seenByHuman(chatId: string, messageId: number) {
    return this.call<boolean>('telegram/seen-by-human', { chatId, messageId });
  }
}

/** A worker's view of the chat folders: the gateway keeps the cache and serialises the edits. */
export class RemoteChatFolders implements Pick<ChatFolders, 'place' | 'leave' | 'humanReplied'> {
  constructor(private readonly t: RemoteTransport) {}
  place(chatId: string, target: Placement, category?: MatchIssueCategory) {
    return (this.t as unknown as { call: RemoteTransport['call'] }).call<Awaited<ReturnType<ChatFolders['place']>>>('folders/place', { chatId, target, category });
  }
  leave(chatId: string, kind: FolderKind, reason: RemoveReason) {
    return (this.t as unknown as { call: RemoteTransport['call'] }).call<Awaited<ReturnType<ChatFolders['leave']>>>('folders/leave', { chatId, kind, reason });
  }
  humanReplied(chatId: string) {
    return (this.t as unknown as { call: RemoteTransport['call'] }).call<Awaited<ReturnType<ChatFolders['humanReplied']>>>('folders/human-replied', { chatId });
  }
}
