import type { Logger } from 'pino';
import { ResilientAdminGateway } from './admin/resilient.js';
import { CaseService } from './cases/service.js';
import { AdminCommands, type AdminCommandEvent } from './control/adminCommands.js';
import { BotSwitch } from './control/botSwitch.js';
import { CUSTOMER_MESSAGING_ENABLED } from './control/customerMessaging.js';
import { guardTransport } from './control/guardedTransport.js';
import type { AdminGateway } from './domain/admin.js';
import { messageBody, type InboundMessage } from './domain/messages.js';
import { EvidenceService } from './evidence/service.js';
import type { FrameExtractor } from './evidence/video.js';
import type { VisionAnalyzer } from './evidence/vision.js';
import { ExportConfirmations } from './handoff/confirmations.js';
import { EvidenceExporter } from './handoff/exporter.js';
import { ManualExports } from './handoff/manualExports.js';
import { HandoffService } from './handoff/service.js';
import { SupportRelay } from './handoff/relay.js';
import { HandoffWorker } from './handoff/worker.js';
import type { LlmClient } from './llm/client.js';
import type { EntityPatterns } from './nlu/entities.js';
import { LlmInterpreter, type Interpreter } from './nlu/interpreter.js';
import { ChatFolders } from './monitoring/chatFolders.js';
import type { Metrics } from './observability/metrics.js';
import { OutboxSender } from './pipeline/outbox.js';
import { TurnProcessor } from './pipeline/processor.js';
import { MemoryQueue } from './queue/memory.js';
import { JobRunner } from './queue/runner.js';
import type { Job, Queue } from './queue/types.js';
import { ResponseComposer, type StyleGuide } from './response/composer.js';
import type { KnowledgeBase } from './response/knowledge.js';
import type { Store, StoredMessage } from './storage/types.js';
import type { ChatFolderApi, ExportForwardEvent, ReadStateApi, SupportGroupMessage, Transport } from './telegram/transport.js';
import { KeyedMutex } from './util/mutex.js';
import { createWorkflows, type WorkflowConfig } from './workflows/index.js';

export interface AppConfig {
  supportChatId?: string;
  historyMessages: number;
  customerTimezone?: string;
  /** request_only (default): one evidence request per deposit/withdrawal case, then silence. */
  caseReplies?: 'request_only' | 'conversational';
  /** Customer-facing sends at all; defaults to the code-level hold in `control/customerMessaging.ts`. */
  customerMessaging?: boolean;
  /** A customer message older than this when the bot gets to it is never answered. 0: no limit. */
  staleSeconds?: number;
  /** Mirror of the ON/OFF switch on disk, so OFF survives a full restart with the in-memory store. */
  botStateFile?: string;
  reopenWindowHours: number;
  workflow: WorkflowConfig;
  /** A customer's rapid-fire messages are handled as one turn: wait this long after the latest … */
  debounceMs: number;
  /** … but never hold the first one longer than this. */
  maxWaitMs: number;
  /** Jobs this process runs at once (a worker's parallelism). */
  maxConcurrentTurns: number;
  responseMode: 'template' | 'llm';
  takeoverMinutes: number;
  /** Typed by a human in a customer chat to hand it back to the bot (default "/ai"). */
  resumeCommand?: string;
  handoffMaxAttempts: number;
  idleCloseHours: number;
  admin: { timeoutMs: number; cacheTtlMs: number; retries: number; breakerThreshold: number; breakerCooldownMs: number };
  /** Telegram folder titles for match problems and other support issues (needs `folders`). */
  chatFolders?: { match: string; support: string };
  /** Export bot (Telegram user id): receives each case's requested items once they are all in. */
  exportChatId?: string;
  /** Job lease: a job not finished within this is assumed crashed and re-queued. */
  jobLeaseMs?: number;
  jobMaxAttempts?: number;
  /** Runner name in logs and leases. */
  instanceName?: string;
  /** Telegram user ids allowed to run /boton, /botoff, /restart by messaging the account. */
  adminIds?: string[];
  /** Given by the supervisor: perform a safe restart and confirm to that chat afterwards. */
  onRestart?: (reply: { chatId: string }) => void;
}

export interface AppComponents {
  store: Store;
  transport: Transport;
  llm: LlmClient;
  vision: VisionAnalyzer;
  frames: FrameExtractor;
  admin: AdminGateway;
  patterns: EntityPatterns;
  style: StyleGuide;
  knowledge: KnowledgeBase;
  log: Logger;
  metrics?: Metrics;
  clock?: () => Date;
  /** Durable job queue shared by every process; defaults to an in-memory one (single process). */
  queue?: Queue;
  /** Telegram chat folders on the account; enables the "Match issues" and "Support" folders. */
  folders?: ChatFolderApi;
  /** An already-built folder service (a worker's remote one); wins over `folders`. */
  chatFolders?: Pick<ChatFolders, 'place' | 'leave' | 'humanReplied'>;
  /** Telegram read state; when set, messages a human already read get no reply. */
  readState?: ReadStateApi;
  /** Override the interpreter (tests); defaults to LLM with lexical fallback. */
  interpreter?: Interpreter;
  /** The ON/OFF switch (defaults to one over the store's settings). */
  botSwitch?: BotSwitch;
}

export interface App {
  processor: TurnProcessor;
  /** ON/OFF, persisted; OFF = no automatic reply of any kind. */
  botSwitch: BotSwitch;
  adminCommands: AdminCommands;
  handoff: HandoffService;
  worker: HandoffWorker;
  relay: SupportRelay;
  /** Handles the export bot's replies ("PAYMENT CONFIRMED" → customer told, case solved). */
  confirmations: ExportConfirmations;
  /** Tracks evidence a human forwarded to the export bot by hand (undefined when no export bot is set). */
  manualExports?: ManualExports;
  outbox: OutboxSender;
  evidence: EvidenceService;
  admin: ResilientAdminGateway;
  locks: KeyedMutex;
  queue: Queue;
  /** Runs queued jobs in this process (started by the worker / all roles). */
  runner: JobRunner;
  chatFolders?: Pick<ChatFolders, 'place' | 'leave' | 'humanReplied'>;
  /** Transport entry points (the gateway): persist, then queue. Never process inline. */
  onMessage(msg: InboundMessage): Promise<void>;
  onSupportMessage(msg: SupportGroupMessage): Promise<void>;
  onOwnOutgoing(ev: { chatId: string; messageId: number; text?: string }): Promise<void>;
  onExportMessage(msg: { messageId: number; text?: string; replyToMessageId?: number }): Promise<void>;
  /** A human forwarded a customer's evidence to the export bot by hand. */
  onExportForward(ev: ExportForwardEvent): Promise<void>;
  /** The account owner typed in Saved Messages (admin console). */
  onAdminCommand(ev: AdminCommandEvent): Promise<void>;
  /** Queue turns for inbound messages a crash left unprocessed (persisted, never queued). */
  recover(sinceMinutes: number): Promise<number>;
}

/** A stored inbound message, back in the shape the transport delivered it. */
export function toInbound(m: StoredMessage): InboundMessage {
  return {
    chatId: m.chatId,
    userId: m.userId,
    messageId: m.telegramMessageId,
    date: m.createdAt,
    text: m.text,
    caption: m.caption,
    media: m.media,
    replyTo: m.replyToMessageId ? { messageId: m.replyToMessageId, media: [], fromSelf: false } : undefined,
    sender: {},
  };
}

export function assemble(c: AppComponents, cfg: AppConfig): App {
  const locks = new KeyedMutex();
  const now = () => c.clock?.() ?? new Date();
  const queue = c.queue ?? new MemoryQueue(now);
  const admin = new ResilientAdminGateway(c.admin, { ...cfg.admin, log: c.log, metrics: c.metrics });
  // The ON/OFF switch lives in the shared store, so every process reads the same state. Everything
  // automatic sends through `transport`, which re-reads the switch right before each send or forward
  // and refuses while OFF; only the admin replies (/boton, /botoff, /restart) bypass it.
  const botSwitch = c.botSwitch ?? new BotSwitch({ settings: c.store.settings, log: c.log, clock: c.clock, stateFile: cfg.botStateFile });
  const customerMessaging = cfg.customerMessaging ?? CUSTOMER_MESSAGING_ENABLED;
  if (!customerMessaging) c.log.warn('CUSTOMER MESSAGING IS DISABLED (control/customerMessaging.ts): no automatic message reaches any customer');
  const transport = guardTransport(c.transport, botSwitch, c.log.child({ mod: 'bot-switch' }), { customerMessaging, internalChats: [cfg.supportChatId, cfg.exportChatId] });
  const evidence = new EvidenceService({
    store: c.store,
    download: (ref) => c.transport.downloadMedia(ref),
    vision: c.vision,
    frames: c.frames,
    patterns: c.patterns,
    log: c.log,
    metrics: c.metrics,
  });
  const outbox = new OutboxSender({ store: c.store, transport, log: c.log, metrics: c.metrics, maxAttempts: 5 });
  const handoff = new HandoffService({
    store: c.store,
    transport,
    supportChatId: cfg.supportChatId,
    log: c.log,
    metrics: c.metrics,
    summarise: c.llm.available
      ? async (kase, history) =>
          c.llm.text({
            purpose: 'handoff_summary',
            system: 'Summarise this customer-support conversation for a human agent in 1-2 plain English sentences. Mention only what the customer said and did; do not add facts.',
            user: history.slice(-12).map((m) => `${m.direction === 'in' ? 'Customer' : 'Bot'}: ${m.text ?? m.caption ?? '[attachment]'}`).join('\n') + `\nCase type: ${kase.type}`,
            maxTokens: 150,
          })
      : undefined,
  });
  const adminCommands = new AdminCommands({ admins: cfg.adminIds ?? [], botSwitch, outbox, transport: c.transport, log: c.log.child({ mod: 'admin-commands' }), onRestart: cfg.onRestart });
  const exporter = cfg.exportChatId ? new EvidenceExporter({ store: c.store, transport, exportChatId: cfg.exportChatId, log: c.log, metrics: c.metrics, clock: c.clock }) : undefined;
  const composer = new ResponseComposer({ llm: c.llm, mode: cfg.responseMode, style: c.style, log: c.log, metrics: c.metrics });
  const chatFolders = c.chatFolders ?? (c.folders && cfg.chatFolders
    ? new ChatFolders({ folders: c.folders, titles: cfg.chatFolders, log: c.log, metrics: c.metrics, clock: c.clock })
    : undefined);
  const processor = new TurnProcessor({
    store: c.store,
    transport,
    evidence,
    interpreter: c.interpreter ?? new LlmInterpreter(c.llm, c.log),
    cases: new CaseService(c.store),
    workflows: createWorkflows(),
    admin,
    handoff,
    composer,
    outbox,
    folders: chatFolders,
    readState: c.readState,
    exporter,
    botSwitch,
    knowledge: c.knowledge,
    locks,
    patterns: c.patterns,
    cfg: { historyMessages: cfg.historyMessages, customerTimezone: cfg.customerTimezone, caseReplies: cfg.caseReplies ?? 'request_only', customerMessaging, staleSeconds: cfg.staleSeconds, reopenWindowHours: cfg.reopenWindowHours, workflow: cfg.workflow },
    log: c.log,
    metrics: c.metrics,
    clock: c.clock,
  });
  const worker = new HandoffWorker({
    store: c.store, handoff, outbox, locks, log: c.log, maxAttempts: cfg.handoffMaxAttempts, idleCloseHours: cfg.idleCloseHours, clock: c.clock,
    exporter, composer, botSwitch, notifyCustomer: cfg.caseReplies === 'conversational',
  });
  const confirmations = new ExportConfirmations({ store: c.store, outbox, locks, log: c.log, notifyCustomer: true }); // the one customer message that is on in every mode
  const manualExports = cfg.exportChatId
    ? new ManualExports({ store: c.store, outbox, transport, exportChatId: cfg.exportChatId, locks, log: c.log, metrics: c.metrics, clock: c.clock })
    : undefined;
  const relay = new SupportRelay({ store: c.store, outbox, transport, takeoverMinutes: cfg.takeoverMinutes, resumeCommand: cfg.resumeCommand, log: c.log, clock: c.clock, folders: chatFolders, locks });

  // Job handlers: every one of them is safe to run twice (a worker may die mid-job).
  const runner = new JobRunner({
    queue,
    gate: () => botSwitch.isOnNow(), // OFF: nothing is claimed, every job waits; ON: the backlog runs
    log: c.log,
    metrics: c.metrics,
    concurrency: cfg.maxConcurrentTurns,
    leaseMs: cfg.jobLeaseMs,
    maxAttempts: cfg.jobMaxAttempts,
    clock: c.clock,
    name: cfg.instanceName,
    handlers: {
      async turn(job: Job, log: Logger) {
        const chatId = String(job.payload.chatId);
        const ids = (job.payload.messageIds as number[]) ?? [];
        // Only what no finished turn has handled yet: a re-run after a crash skips what is done.
        const messages = (await c.store.messages.listInbound(chatId, ids)).filter((m) => !m.processedAt);
        if (!messages.length) {
          log.debug('turn job had nothing left to do');
          return;
        }
        await processor.process(chatId, messages.map(toInbound), { jobId: job.id, log });
      },
      async support_message(job: Job) {
        await relay.onSupportMessage(job.payload as unknown as SupportGroupMessage);
      },
      async own_outgoing(job: Job) {
        await relay.onOwnOutgoing({ chatId: String(job.payload.chatId), messageId: job.payload.messageId ? Number(job.payload.messageId) : undefined, text: typeof job.payload.text === 'string' ? job.payload.text : undefined });
      },
      async export_message(job: Job) {
        await confirmations.onExportMessage(job.payload as { messageId: number; text?: string; replyToMessageId?: number });
      },
      async export_forward(job: Job) {
        await manualExports?.onForward(job.payload as unknown as ExportForwardEvent);
      },
    },
  });

  const queueTurn = async (chatId: string, messageId: number, receivedAt: Date) => {
    const t = now().getTime();
    await queue.enqueueOrMerge({
      type: 'turn',
      orderingKey: chatId,
      payload: { chatId, messageIds: [messageId] },
      runAt: new Date(t + cfg.debounceMs),
      maxRunAt: new Date(receivedAt.getTime() + Math.max(cfg.debounceMs, cfg.maxWaitMs)),
      merge: (existing) => ({ chatId, messageIds: [...new Set([...((existing.messageIds as number[]) ?? []), messageId])].sort((a, b) => a - b) }),
    });
    runner.poke();
  };

  return {
    processor, handoff, worker, relay, confirmations, manualExports, outbox, evidence, admin, locks, queue, runner, chatFolders, botSwitch, adminCommands,
    async onMessage(msg) {
      // An authorised admin's /boton, /botoff or /restart is acted on at once and never enters the customer pipeline.
      if (await adminCommands.handle({ chatId: msg.chatId, messageId: msg.messageId, fromUserId: msg.userId, text: messageBody(msg) })) return;
      // FIRST LINE for every customer message: bot_enabled, fresh from the shared store. OFF → the message
      // is kept in the transcript (marked handled) and otherwise ignored: no queue, no AI, no folder, no
      // reply — not now, and not after /boton. The same for a message that is already stale on arrival.
      const off = !(await botSwitch.isOnNow());
      const stale = (cfg.staleSeconds ?? 0) > 0 && now().getTime() - msg.date.getTime() > (cfg.staleSeconds ?? 0) * 1000;
      if (off || stale) {
        const { inserted } = await processor.receive(msg).then((i) => ({ inserted: i }));
        if (inserted) await c.store.messages.markProcessed(msg.chatId, [msg.messageId], { turnId: off ? 'ignored:bot_off' : 'ignored:stale' });
        c.log.info({ chat: msg.chatId, message: msg.messageId, reason: off ? 'bot_off' : 'stale_message' }, 'customer message ignored');
        return;
      }
      manualExports?.noteInbound(msg); // so a hand-forwarded file can be traced back to its customer
      if (await processor.receive(msg)) await queueTurn(msg.chatId, msg.messageId, now());
    },
    async onAdminCommand(ev) {
      await adminCommands.handle({ ...ev, owner: true });
    },
    async onSupportMessage(msg) {
      await queue.enqueue({ type: 'support_message', orderingKey: `support:${msg.chatId}`, payload: { ...msg }, idempotencyKey: `support:${msg.chatId}:${msg.messageId}` });
      runner.poke();
    },
    async onOwnOutgoing(ev) {
      // Same ordering key as the customer's turns: a human's message and the AI never race.
      await queue.enqueue({ type: 'own_outgoing', orderingKey: ev.chatId, payload: { ...ev }, idempotencyKey: `own:${ev.chatId}:${ev.messageId}` });
      runner.poke();
    },
    async onExportMessage(msg) {
      await queue.enqueue({ type: 'export_message', orderingKey: 'export-bot', payload: { ...msg }, idempotencyKey: `export:${msg.messageId}` });
      runner.poke();
    },
    async onExportForward(ev) {
      if (!manualExports) return;
      await queue.enqueue({ type: 'export_forward', orderingKey: 'export-bot', payload: { ...ev }, idempotencyKey: `export-fwd:${ev.messageId}` });
      runner.poke();
    },
    async recover(sinceMinutes) {
      const since = new Date(now().getTime() - sinceMinutes * 60_000);
      const pending = await c.store.messages.listUnprocessed(since);
      for (const m of pending) await queueTurn(m.chatId, m.telegramMessageId, m.createdAt);
      return pending.length;
    },
  };
}
