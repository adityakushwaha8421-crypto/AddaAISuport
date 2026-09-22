import dotenv from 'dotenv';
import { access } from 'node:fs/promises';
import { DisabledAdminGateway, FixtureAdminGateway } from './admin/fixture.js';
import { loadAdminPanelConfig } from './admin/playwright/config.js';
import { PlaywrightAdminGateway } from './admin/playwright/gateway.js';
import { assemble, type App } from './app.js';
import { Supervisor, type Booted, type BootContext } from './control/supervisor.js';
import { loadEnv, secretValues, type Env } from './config/env.js';
import type { AdminGateway } from './domain/admin.js';
import { FfmpegFrameExtractor, NoFrameExtractor, type FrameExtractor } from './evidence/video.js';
import { LlmVisionAnalyzer } from './evidence/vision.js';
import { DisabledLlm, type LlmClient } from './llm/client.js';
import { OpenAiLlm } from './llm/openai.js';
import { compilePatterns } from './nlu/entities.js';
import { startHealthServer, type HealthChecks } from './observability/health.js';
import { createLogger, type Logger } from './observability/logger.js';
import { Metrics } from './observability/metrics.js';
import { loadStyleGuide } from './response/composer.js';
import { KnowledgeBase } from './response/knowledge.js';
import { acquireInstanceLock } from './util/instanceLock.js';
import { scrubber } from './security/scrubber.js';
import { createQueue, createStore } from './storage/index.js';
import { sessionStoreFromEnv } from './telegram/user/sessionStore.js';
import { parseAllowedUsers, UserTransport } from './telegram/user/userTransport.js';
import { gatewayRoutes } from './telegram/gatewayApi.js';
import { RemoteChatFolders, RemoteTransport } from './telegram/remote.js';
import { ChatFolders } from './monitoring/chatFolders.js';
import type { Transport } from './telegram/transport.js';

function createTransport(env: Env, log: Logger): UserTransport {
  return new UserTransport({
    apiId: env.TELEGRAM_API_ID!,
    apiHash: env.TELEGRAM_API_HASH!,
    sessions: sessionStoreFromEnv(env, () => log.warn('the Telegram session changed at runtime; if login fails after a restart, run `npm run telegram:session` again')),
    supportChatId: env.SUPPORT_GROUP_CHAT_ID,
    exportChatId: env.EXPORT_BOT_ID,
    filter: { allowed: parseAllowedUsers(env.TELEGRAM_ALLOWED_USERS), ignoreContacts: env.TELEGRAM_IGNORE_CONTACTS },
    sendRate: env.TELEGRAM_SEND_RATE, chatSendRate: env.TELEGRAM_CHAT_SEND_RATE,
    log: log.child({ mod: 'telegram' }),
  });
}

async function createAdmin(env: Env, log: Logger): Promise<AdminGateway> {
  switch (env.ADMIN_MODE) {
    case 'playwright':
      return new PlaywrightAdminGateway({
        baseUrl: env.ADMIN_BASE_URL!, username: env.ADMIN_USERNAME!, password: env.ADMIN_PASSWORD!,
        config: await loadAdminPanelConfig(env.ADMIN_CONFIG_FILE), storageStateFile: env.ADMIN_STORAGE_STATE_FILE,
        encryptionKey: env.SESSION_ENCRYPTION_KEY, headless: env.ADMIN_HEADLESS, timeoutMs: env.ADMIN_TIMEOUT_MS,
        executablePath: env.ADMIN_BROWSER_PATH, channel: env.ADMIN_BROWSER_CHANNEL, log: log.child({ mod: 'admin' }),
      });
    case 'fixture':
      log.warn({ file: env.ADMIN_FIXTURE_FILE }, 'ADMIN_MODE=fixture: using fixture data, not the real admin panel');
      return FixtureAdminGateway.fromFile(env.ADMIN_FIXTURE_FILE);
    default:
      log.warn('ADMIN_MODE=disabled: verifications will be handed to humans');
      return new DisabledAdminGateway();
  }
}

async function createFrames(env: Env): Promise<FrameExtractor> {
  const candidates = [env.FFMPEG_PATH, 'ffmpeg'].filter((p): p is string => !!p);
  for (const p of candidates) {
    if (p.includes('/')) {
      try {
        await access(p);
      } catch {
        continue;
      }
    }
    const f = new FfmpegFrameExtractor(p);
    if (await f.available()) return f;
  }
  return new NoFrameExtractor();
}

dotenv.config();

/** One full start of the agent. The supervisor calls it at process start and again on /restart. */
async function boot(ctx: BootContext, rootLog: Logger): Promise<Booted> {
  const env = loadEnv();
  scrubber.register(...secretValues(env));
  const role = env.ROLE;
  const instance = `${role}-${process.pid}${ctx.attempt > 1 ? `-r${ctx.attempt}` : ''}`;
  const log = rootLog.child({ role, instance });
  const metrics = new Metrics();

  const store = await createStore(env, log.child({ mod: 'store' }));
  const queue = createQueue(store);
  const llm: LlmClient = env.OPENAI_API_KEY
    ? new OpenAiLlm({
        apiKey: env.OPENAI_API_KEY, baseURL: env.OPENAI_BASE_URL, model: env.OPENAI_MODEL, visionModel: env.OPENAI_VISION_MODEL,
        reasoningEffort: env.OPENAI_REASONING_EFFORT, timeoutMs: env.OPENAI_TIMEOUT_MS, log: log.child({ mod: 'llm' }), metrics,
        maxConcurrency: env.OPENAI_MAX_CONCURRENCY,
      })
    : new DisabledLlm();
  if (!llm.available) log.warn('OPENAI_API_KEY not set: running in degraded mode (lexical interpreter, no image analysis)');
  if (!env.SUPPORT_GROUP_CHAT_ID) log.warn('SUPPORT_GROUP_CHAT_ID not set: tickets for customers who decline or ask for a person cannot be delivered');
  if (!env.EXPORT_BOT_ID) log.warn('EXPORT_BOT_ID not set: case details and files will not be exported');

  // Telegram: the real session (gateway, all) or the gateway's internal API (worker).
  const userTransport = role === 'worker' ? undefined : createTransport(env, log);
  const remote = role === 'worker' ? new RemoteTransport({ baseUrl: env.GATEWAY_URL!, token: env.INTERNAL_TOKEN!, log: log.child({ mod: 'gateway-client' }) }) : undefined;
  const transport: Transport = (userTransport ?? remote)!;
  const localFolders = userTransport && env.CHAT_FOLDERS_ENABLED
    ? new ChatFolders({ folders: userTransport, titles: { match: env.MATCH_ISSUES_FOLDER, support: env.SUPPORT_FOLDER }, log, metrics })
    : undefined;
  const chatFolders = localFolders ?? (remote && env.CHAT_FOLDERS_ENABLED ? new RemoteChatFolders(remote) : undefined);

  const frames = await createFrames(env);
  const app: App = assemble(
    {
      store, transport, llm, vision: new LlmVisionAnalyzer(llm), frames, admin: await createAdmin(env, log),
      patterns: compilePatterns({ registration: env.REGISTRATION_NUMBER_PATTERN, withdrawalId: env.WITHDRAWAL_ID_PATTERN, orderId: env.ORDER_ID_PATTERN }),
      style: await loadStyleGuide(env.STYLE_GUIDE_FILE), knowledge: await KnowledgeBase.fromFile(env.KNOWLEDGE_FILE), log, metrics,
      queue, chatFolders,
      readState: env.REPLY_ONLY_TO_UNREAD ? (userTransport ?? remote) : undefined,
    },
    {
      supportChatId: env.SUPPORT_GROUP_CHAT_ID,
      chatFolders: { match: env.MATCH_ISSUES_FOLDER, support: env.SUPPORT_FOLDER },
      exportChatId: env.EXPORT_BOT_ID,
      historyMessages: env.HISTORY_MESSAGES,
      customerTimezone: env.CUSTOMER_TIMEZONE,
      reopenWindowHours: env.CASE_IDLE_CLOSE_HOURS,
      workflow: { maxAsksPerSlot: env.MAX_ASKS_PER_SLOT, withdrawalSlaHours: env.WITHDRAWAL_PROCESSING_SLA_HOURS, depositLookbackDays: 30, refreshMinutes: 10, maxPasswordAttempts: 3 },
      debounceMs: env.TURN_DEBOUNCE_MS,
      maxWaitMs: env.TURN_MAX_WAIT_MS,
      maxConcurrentTurns: role === 'all' ? env.MAX_CONCURRENT_TURNS : env.WORKER_CONCURRENCY,
      responseMode: env.RESPONSE_MODE,
      takeoverMinutes: env.HUMAN_TAKEOVER_MINUTES,
      resumeCommand: env.AI_RESUME_COMMAND,
      handoffMaxAttempts: env.HANDOFF_MAX_ATTEMPTS,
      idleCloseHours: env.CASE_IDLE_CLOSE_HOURS,
      admin: { timeoutMs: env.ADMIN_TIMEOUT_MS + 5000, cacheTtlMs: env.ADMIN_CACHE_TTL_SECONDS * 1000, retries: 1, breakerThreshold: 5, breakerCooldownMs: 60_000 },
      jobLeaseMs: env.JOB_LEASE_SECONDS * 1000,
      jobMaxAttempts: env.JOB_MAX_ATTEMPTS,
      instanceName: instance,
      adminIds: (env.ADMIN_TELEGRAM_IDS ?? '').split(',').map((s) => s.trim()).filter(Boolean),
      onRestart: role === 'worker' ? undefined : ctx.requestRestart,
    },
  );
  // ON/OFF survives an in-process restart even with the in-memory store.
  if (ctx.previous?.botOn !== undefined) await app.botSwitch.seed(ctx.previous.botOn);

  let draining = false;
  const runsJobs = role !== 'gateway';
  // Bind the port first so a clash fails fast, before we connect to Telegram.
  const live: HealthChecks = {
    store: () => store.healthy(),
    telegram: () => transport.healthy(),
    admin: () => !app.admin.circuitOpen,
  };
  const health = await startHealthServer(env.HTTP_PORT, live, metrics, env.HTTP_HOST, {
    ready: { accepting: () => !draining, queue: () => queue.stats().then(() => true) },
    routes: userTransport && env.INTERNAL_TOKEN ? gatewayRoutes({ token: env.INTERNAL_TOKEN, transport: userTransport, folders: localFolders, log: log.child({ mod: 'internal-api' }) }) : undefined,
  });

  await transport.start({
    onMessage: (m) => app.onMessage(m),
    onSupportMessage: (m) => app.onSupportMessage(m),
    onOwnOutgoing: (e) => app.onOwnOutgoing(e),
    onExportMessage: (m) => app.onExportMessage(m),
    onExportForward: (e) => app.onExportForward(e),
    onAdminCommand: (e) => app.onAdminCommand(e),
  });
  if (localFolders) {
    const counts = await localFolders.refresh();
    log.info({ [localFolders.title('match')]: counts.match, [localFolders.title('support')]: counts.support }, 'chat folders on (chats per folder)');
  }
  if (userTransport) {
    // Only the process that receives messages can know which ones were never queued.
    const recovered = await app.recover(15);
    if (recovered) log.info({ recovered }, 're-queued messages left unprocessed by a previous run');
    await app.outbox.flushPending();
    app.worker.start(env.HANDOFF_RETRY_INTERVAL_SECONDS * 1000); // periodic maintenance runs once, here
  }
  if (runsJobs) app.runner.start();
  const depth = setInterval(() => {
    queue.stats().then((s) => {
      for (const [k, v] of Object.entries(s)) metrics.queueDepth.set(v, { status: k });
      if (s.pending > 500) log.warn({ pending: s.pending }, 'queue backlog is high: add workers');
    }, () => undefined);
  }, 15_000);
  depth.unref();
  log.info({ role, admin: env.ADMIN_MODE, llm: llm.available, port: env.HTTP_PORT, jobs: runsJobs, botOn: await app.botSwitch.current(), admins: (env.ADMIN_TELEGRAM_IDS ?? '').split(',').filter(Boolean).length }, 'support agent running');

  let stopped = false;
  return {
    async stop() {
      if (stopped) return;
      stopped = true;
      draining = true; // /readyz turns 503: the load balancer stops sending traffic
      log.info('stopping: finishing in-flight jobs');
      clearInterval(depth);
      app.worker.stop();
      await Promise.race([app.runner.drain(), new Promise((r) => setTimeout(r, 30_000))]);
      await transport.stop().catch((err) => log.warn({ err }, 'transport stop failed'));
      await app.admin.close();
      health.close();
      await store.close();
    },
    sendText: (chatId, text) => transport.sendText(chatId, text),
    carry: async () => ({ botOn: await app.botSwitch.current() }),
  };
}

async function main() {
  const first = loadEnv();
  const rootLog = createLogger({ level: first.LOG_LEVEL, pretty: first.LOG_PRETTY, file: first.LOG_FILE });
  // The gateway owns the account's one Telegram session: never two copies on the same account.
  // Taken once per process; an in-process /restart keeps it.
  if (first.ROLE !== 'worker') acquireInstanceLock(`${first.TELEGRAM_SESSION_FILE}.lock`);

  const supervisor = new Supervisor({
    boot: (ctx) => boot(ctx, rootLog),
    log: rootLog.child({ mod: 'supervisor' }),
    reloadEnv: () => dotenv.config({ override: true }),
  });
  process.on('SIGINT', () => void supervisor.shutdown('SIGINT'));
  process.on('SIGTERM', () => void supervisor.shutdown('SIGTERM'));
  process.on('unhandledRejection', (err) => rootLog.error({ err }, 'unhandled rejection'));
  await supervisor.start();
}

main().catch((err) => {
  console.error(scrubber.scrub(err instanceof Error ? `${err.name}: ${err.message}` : String(err)));
  process.exit(1);
});
