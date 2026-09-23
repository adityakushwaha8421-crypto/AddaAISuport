import { DeferJobError } from '../../src/queue/runner.js';
import { assemble, type App } from '../../src/app.js';
import { FixtureAdminGateway, type AdminFixtures } from '../../src/admin/fixture.js';
import type { AdminGateway } from '../../src/domain/admin.js';
import { messageBody, type InboundMessage, type MediaRef } from '../../src/domain/messages.js';
import { NoFrameExtractor } from '../../src/evidence/video.js';
import { DisabledLlm, type LlmClient } from '../../src/llm/client.js';
import { DEFAULT_PATTERNS } from '../../src/nlu/entities.js';
import type { Interpreter } from '../../src/nlu/interpreter.js';
import type { Logger } from 'pino';
import { silentLogger } from '../../src/observability/logger.js';
import { Metrics } from '../../src/observability/metrics.js';
import { KnowledgeBase, type KnowledgeEntry } from '../../src/response/knowledge.js';
import { MemoryQueue } from '../../src/queue/memory.js';
import { MemoryStore } from '../../src/storage/memory.js';
import type { Store } from '../../src/storage/types.js';
import { stripHtml } from '../../src/response/format.js';
import type { ExportForwardEvent, ChatFolderApi, ReadStateApi, SendOptions, Transport, TransportHandlers } from '../../src/telegram/transport.js';
import { DEFAULT_WORKFLOW_CONFIG } from '../../src/workflows/types.js';
import { FakeVision } from './fakeVision.js';

export const SUPPORT_CHAT = '-100999';
export const NOW = new Date('2026-09-11T12:00:00+05:30');
export const MATCH_FOLDER = 'Match issues';
export const SUPPORT_FOLDER = 'Support';
export const EXPORT_BOT = '8869616760';

export interface Sent {
  chatId: string;
  messageId: number;
  text: string;
  replyTo?: number;
}

/** In-memory Telegram: per-chat sequential message ids (both directions), files by fileRef. */
export class FakeTransport implements Transport, ReadStateApi {
  readonly sent: Sent[] = [];
  readonly forwards: Array<{ from: string; messageId: number; to: string }> = [];
  readonly files = new Map<string, Buffer>();
  private readonly counters = new Map<string, number>();
  private readonly forwardedIds = new Map<string, number[]>();
  failSupportSends = 0;
  failCustomerSends = 0;
  /** Make the next sends / forwards to the export bot fail. */
  failExportSends = 0;
  failExportForwards = 0;
  /** Make the next delivery check to the export bot report its first forward as missing. */
  failExportVerify = 0;
  /** Highest incoming message id a human has read, per chat (Telegram's read_inbox_max_id). */
  readonly readUpTo = new Map<string, number>();
  failReadChecks = 0;

  nextId(chatId: string): number {
    const n = (this.counters.get(chatId) ?? 0) + 1;
    this.counters.set(chatId, n);
    return n;
  }
  async start(_h: TransportHandlers) {}
  async stop() {}
  healthy() {
    return true;
  }
  async sendText(chatId: string, text: string, opts: SendOptions = {}) {
    if (chatId === SUPPORT_CHAT && this.failSupportSends > 0) {
      this.failSupportSends--;
      throw new Error('support group unreachable');
    }
    if (chatId === EXPORT_BOT && this.failExportSends > 0) {
      this.failExportSends--;
      throw new Error('export bot unreachable');
    }
    if (chatId !== SUPPORT_CHAT && chatId !== EXPORT_BOT && this.failCustomerSends > 0) {
      this.failCustomerSends--;
      throw new Error('429: Too Many Requests');
    }
    const messageId = this.nextId(chatId);
    this.sent.push({ chatId, messageId, text, replyTo: opts.replyToMessageId });
    return { messageId };
  }
  async forwardMessage(fromChatId: string, messageId: number, toChatId: string) {
    if (toChatId === EXPORT_BOT && this.failExportForwards > 0) {
      this.failExportForwards--;
      return undefined;
    }
    this.forwards.push({ from: fromChatId, messageId, to: toChatId });
    const id = this.nextId(toChatId);
    this.forwardedIds.set(toChatId, [...(this.forwardedIds.get(toChatId) ?? []), id]);
    return { messageId: id };
  }
  /** A human forwards something into a chat from the account (not through the bot). `arrives: false` = Telegram never shows it. */
  humanForward(toChatId: string, arrives = true): number {
    const id = this.nextId(toChatId);
    if (arrives) this.forwardedIds.set(toChatId, [...(this.forwardedIds.get(toChatId) ?? []), id]);
    return id;
  }
  async messagesExist(chatId: string, messageIds: number[]) {
    const known = new Set([...this.sent.filter((s) => s.chatId === chatId).map((s) => s.messageId), ...this.forwardedIds.get(chatId) ?? []]);
    let found = messageIds.filter((id) => known.has(id));
    if (chatId === EXPORT_BOT && this.failExportVerify > 0) {
      this.failExportVerify--;
      const first = Math.min(...found);
      found = found.filter((id) => id !== first); // the first forward "never arrived"
    }
    return found;
  }
  async downloadMedia(ref: MediaRef) {
    const f = this.files.get(ref.fileRef);
    if (!f) throw new Error(`no file ${ref.fileRef}`);
    return f;
  }
  async sendTyping() {}
  async seenByHuman(chatId: string, messageId: number) {
    if (this.failReadChecks > 0) {
      this.failReadChecks--;
      throw new Error('FLOOD_WAIT_3');
    }
    return (this.readUpTo.get(chatId) ?? 0) >= messageId;
  }
  /** A human opens the chat on the account: everything in it so far is read. */
  humanReads(chatId: string) {
    this.readUpTo.set(chatId, this.counters.get(chatId) ?? 0);
  }
}

/** In-memory Telegram chat folders, with Telegram's rule that a folder cannot be empty. */
export class FakeFolders implements ChatFolderApi {
  readonly folders = new Map<string, string[]>();
  readonly calls: Array<{ op: 'list' | 'add' | 'remove'; title: string; chatId?: string }> = [];
  failNext = 0;

  private maybeFail() {
    if (this.failNext > 0) {
      this.failNext--;
      throw new Error('FLOOD_WAIT_5');
    }
  }
  async folderChats(title: string) {
    this.calls.push({ op: 'list', title });
    this.maybeFail();
    return [...(this.folders.get(title) ?? [])];
  }
  async addChatToFolder(title: string, chatId: string) {
    this.calls.push({ op: 'add', title, chatId });
    this.maybeFail();
    const chats = this.folders.get(title) ?? [];
    if (!chats.includes(chatId)) chats.push(chatId);
    this.folders.set(title, chats);
  }
  async removeChatFromFolder(title: string, chatId: string) {
    this.calls.push({ op: 'remove', title, chatId });
    this.maybeFail();
    const chats = (this.folders.get(title) ?? []).filter((c) => c !== chatId);
    if (chats.length) this.folders.set(title, chats);
    else this.folders.delete(title);
  }
  has(title: string, chatId: string) {
    return this.folders.get(title)?.includes(chatId) ?? false;
  }
}

export interface HarnessOptions {
  fixtures?: AdminFixtures;
  /** Replace the fixture admin panel, e.g. with DisabledAdminGateway (ADMIN_MODE=disabled). */
  /** `llm` phrases multi-part replies with the model, as production does (RESPONSE_MODE=llm). */
  responseMode?: 'template' | 'llm';
  log?: Logger;
  adminGateway?: AdminGateway;
  /** Persistent store (e.g. pg-mem) so `restart()` can prove data survives a process restart. */
  store?: Store;
  llm?: LlmClient;
  interpreter?: Interpreter;
  knowledge?: KnowledgeEntry[];
  supportChatId?: string | null;
  /** Export bot chat id; `null` disables the export (EXPORT_BOT_ID unset). */
  exportBot?: string | null;
  /** Job runner settings for queue-driven tests. */
  concurrency?: number;
  jobLeaseMs?: number;
  instanceName?: string;
  debounceMs?: number;
  maxWaitMs?: number;
  /** Telegram ids allowed to run /boton, /botoff, /restart. */
  adminIds?: string[];
  /** request_only (production default): one evidence request per money case, then silence. */
  caseReplies?: 'request_only' | 'conversational';
  onRestart?: (reply: { chatId: string }) => void;
}

export class UserSim {
  private pendingReplyTo?: number;
  private pendingRead = false;
  constructor(
    readonly h: Harness,
    readonly id: string,
    readonly profile: { firstName?: string; username?: string } = {},
  ) {}

  get chatId() {
    return this.id;
  }

  /** Replies the bot sent to this user, in order. */
  get replies(): Sent[] {
    return this.h.transport.sent.filter((s) => s.chatId === this.id);
  }

  /** Last reply as the customer reads it (markup stripped). */
  get last(): string {
    return stripHtml(this.replies[this.replies.length - 1]?.text ?? '');
  }

  /** Last reply exactly as sent to Telegram, including HTML markup. */
  get lastRaw(): string {
    return this.replies[this.replies.length - 1]?.text ?? '';
  }

  get lastSent(): Sent | undefined {
    return this.replies[this.replies.length - 1];
  }

  /** A human reads the next message on Telegram before the bot gets to it. */
  readByHuman(): this {
    this.pendingRead = true;
    return this;
  }

  /** Make the next message a swipe-reply to `messageId`. */
  replyTo(messageId: number | undefined): this {
    this.pendingReplyTo = messageId;
    return this;
  }

  build(parts: { text?: string; caption?: string; media?: MediaRef[] }): InboundMessage {
    const messageId = this.h.transport.nextId(this.id);
    let replyTo: InboundMessage['replyTo'];
    if (this.pendingReplyTo !== undefined) {
      const target = this.h.transport.sent.find((s) => s.chatId === this.id && s.messageId === this.pendingReplyTo);
      replyTo = { messageId: this.pendingReplyTo, text: target?.text, media: [], fromSelf: !!target };
      this.pendingReplyTo = undefined;
    }
    return {
      chatId: this.id, userId: this.id, messageId, date: this.h.clock(),
      text: parts.text, caption: parts.caption, media: parts.media ?? [], replyTo, sender: { ...this.profile },
    };
  }

  /** Deliver through the real entry point (persist → queue), as the gateway does. Nothing runs until `h.drain()`. */
  async deliver(msg: InboundMessage): Promise<void> {
    if (this.pendingRead) this.h.transport.humanReads(this.id);
    this.pendingRead = false;
    await this.h.app.onMessage(msg);
  }

  /** Deliver one message as its own turn and return the bot's reply text ('' if none). */
  async send(msg: InboundMessage): Promise<string> {
    const before = this.replies.length;
    // As app.onMessage does: an authorised admin's command is acted on before the customer pipeline.
    if (await this.h.app.adminCommands.handle({ chatId: msg.chatId, messageId: msg.messageId, fromUserId: msg.userId, text: messageBody(msg) })) {
      return this.replies.length > before ? this.last : '';
    }
    const inserted = await this.h.app.processor.receive(msg);
    if (this.pendingRead) this.h.transport.humanReads(this.id);
    this.pendingRead = false;
    if (inserted) {
      try {
        await this.h.app.processor.process(this.id, [msg]);
      } catch (err) {
        if (!(err instanceof DeferJobError)) throw err; // the agent is switched off: the turn waits
      }
    }
    return this.replies.length > before ? this.last : '';
  }

  say(text: string) {
    return this.send(this.build({ text }));
  }

  /** Photo whose "bytes" are a FakeVision key. */
  photo(visionKey: string, caption?: string, uniq = `${visionKey}-${Math.random().toString(36).slice(2, 8)}`) {
    this.h.transport.files.set(uniq, Buffer.from(visionKey));
    return this.send(this.build({ caption, media: [{ kind: 'photo', fileRef: uniq, fileUniqueId: uniq, mimeType: 'image/jpeg' }] }));
  }

  /** A screen recording (never analysed in tests: no ffmpeg), kept for the team. */
  video(caption?: string, key = `video-${Math.random().toString(36).slice(2, 8)}`) {
    this.h.transport.files.set(key, Buffer.from('mp4'));
    return this.send(this.build({ caption, media: [{ kind: 'video', fileRef: key, fileUniqueId: key, mimeType: 'video/mp4', durationSec: 11 }] }));
  }

  pdf(bytes: Buffer, fileName = 'statement.pdf', caption?: string) {
    const uniq = `pdf-${Math.random().toString(36).slice(2, 10)}`;
    this.h.transport.files.set(uniq, bytes);
    return this.send(this.build({ caption, media: [{ kind: 'document', fileRef: uniq, fileUniqueId: uniq, mimeType: 'application/pdf', fileName }] }));
  }
}

export class Harness {
  readonly store: Store & Partial<MemoryStore>;
  readonly transport = new FakeTransport();
  readonly folders = new FakeFolders();
  readonly queue = new MemoryQueue(() => this.clock());
  readonly vision = new FakeVision();
  readonly admin: FixtureAdminGateway;
  readonly metrics = new Metrics();
  app: App;
  private now = NOW.getTime();

  constructor(private readonly opts: HarnessOptions = {}) {
    this.store = (opts.store ?? new MemoryStore()) as Store & Partial<MemoryStore>;
    this.admin = new FixtureAdminGateway(structuredClone(opts.fixtures ?? { payouts: [], deposits: [] }));
    this.app = this.build();
  }

  /** Rebuild the application over the same store: what a process restart does. */
  restart(): void {
    this.app = this.build();
  }

  private build(): App {
    const opts = this.opts;
    return assemble(
      {
        store: this.store,
        transport: this.transport,
        llm: opts.llm ?? new DisabledLlm(),
        vision: this.vision,
        frames: new NoFrameExtractor(),
        admin: opts.adminGateway ?? this.admin,
        patterns: DEFAULT_PATTERNS,
        style: {},
        knowledge: new KnowledgeBase(opts.knowledge ?? []),
        log: opts.log ?? silentLogger,
        metrics: this.metrics,
        clock: () => this.clock(),
        interpreter: opts.interpreter,
        folders: this.folders,
        readState: this.transport,
        queue: this.queue,
      },
      {
        supportChatId: opts.supportChatId === null ? undefined : (opts.supportChatId ?? SUPPORT_CHAT),
        exportChatId: opts.exportBot === null ? undefined : (opts.exportBot ?? EXPORT_BOT),
        chatFolders: { match: MATCH_FOLDER, support: SUPPORT_FOLDER },
        historyMessages: 20,
        reopenWindowHours: 48,
        workflow: DEFAULT_WORKFLOW_CONFIG,
        debounceMs: opts.debounceMs ?? 0,
        maxWaitMs: opts.maxWaitMs ?? 0,
        maxConcurrentTurns: opts.concurrency ?? 8,
        jobLeaseMs: opts.jobLeaseMs,
        instanceName: opts.instanceName,
        adminIds: opts.adminIds,
        caseReplies: opts.caseReplies ?? 'request_only',
        onRestart: opts.onRestart,
        responseMode: opts.responseMode ?? 'template',
        takeoverMinutes: 0, // like production: a human's chat stays theirs until they hand it back
        handoffMaxAttempts: 10,
        idleCloseHours: 48,
        admin: { timeoutMs: 2000, cacheTtlMs: 0, retries: 0, breakerThreshold: 50, breakerCooldownMs: 1000 },
      },
    );
  }

  clock(): Date {
    return new Date(this.now);
  }

  advance(minutes: number): void {
    this.now += minutes * 60_000;
  }

  user(id: string, profile?: { firstName?: string; username?: string }) {
    return new UserSim(this, id, profile);
  }

  get supportMessages(): Sent[] {
    return this.transport.sent.filter((s) => s.chatId === SUPPORT_CHAT);
  }

  /** Headers sent to the export bot. */
  get exports(): Sent[] {
    return this.transport.sent.filter((s) => s.chatId === EXPORT_BOT);
  }

  /** Customer messages forwarded to the export bot, as (chat, message id). */
  get exportedFiles(): Array<{ from: string; messageId: number }> {
    return this.transport.forwards.filter((f) => f.to === EXPORT_BOT).map(({ from, messageId }) => ({ from, messageId }));
  }

  /** Run every queued job to completion (what a worker does continuously). */
  async drain(): Promise<number> {
    return this.app.runner.runUntilIdle();
  }

  /** A human on the account forwards a customer's message to the export bot by hand. Runs the queue. */
  async humanForwards(ev: Omit<ExportForwardEvent, 'messageId'>, opts: { arrives?: boolean } = {}): Promise<number> {
    const messageId = this.transport.humanForward(EXPORT_BOT, opts.arrives ?? true);
    await this.app.onExportForward({ ...ev, messageId });
    await this.drain();
    return messageId;
  }

  /** The export bot writes back (e.g. "PAYMENT CONFIRMED"). */
  botSays(text: string, replyToMessageId?: number) {
    return this.app.confirmations.onExportMessage({ messageId: this.transport.nextId(EXPORT_BOT), text, replyToMessageId });
  }

  async caseOf(userId: string) {
    const u = await this.store.users.get(userId);
    return u?.focusCaseId ? this.store.cases.get(u.focusCaseId) : undefined;
  }

  casesOf(userId: string) {
    return this.store.cases.listByUser(userId);
  }

  /** Is this chat in the "Match issues" folder on the (fake) Telegram account? */
  inMatchFolder(chatId: string): boolean {
    return this.folders.has(MATCH_FOLDER, chatId);
  }

  inSupportFolder(chatId: string): boolean {
    return this.folders.has(SUPPORT_FOLDER, chatId);
  }

  /** Where the chat is filed: one folder, neither, or — which must never happen — both. */
  folderOf(chatId: string): 'match' | 'support' | 'none' | 'both' {
    const m = this.inMatchFolder(chatId);
    const s = this.inSupportFolder(chatId);
    return m && s ? 'both' : m ? 'match' : s ? 'support' : 'none';
  }
}
