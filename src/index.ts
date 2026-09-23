import dotenv from 'dotenv';
import { assemble, type App } from './app.js';
import { Supervisor, type Booted, type BootContext } from './control/supervisor.js';
import { loadEnv, secretValues, type Env } from './config/env.js';
import { DisabledLlm, type LlmClient } from './llm/client.js';
import { OpenAiLlm } from './llm/openai.js';
import { startHealthServer, type HealthChecks } from './observability/health.js';
import { createLogger, type Logger } from './observability/logger.js';
import { Metrics } from './observability/metrics.js';
import { acquireInstanceLock } from './util/instanceLock.js';
import { scrubber } from './security/scrubber.js';
import { createStore } from './storage/index.js';
import { sessionStoreFromEnv } from './telegram/user/sessionStore.js';
import { parseAllowedUsers, UserTransport } from './telegram/user/userTransport.js';

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

dotenv.config();

/** One full start of the agent. The supervisor calls it at process start and again on /restart. */
async function boot(ctx: BootContext, rootLog: Logger): Promise<Booted> {
  const env = loadEnv();
  scrubber.register(...secretValues(env));
  const instance = `agent-${process.pid}${ctx.attempt > 1 ? `-r${ctx.attempt}` : ''}`;
  const log = rootLog.child({ instance });
  const metrics = new Metrics();

  const store = await createStore(env, log.child({ mod: 'store' }));
  // The OpenAI client is kept as infrastructure for the workflows to come; nothing calls it today.
  const llm: LlmClient = env.OPENAI_API_KEY
    ? new OpenAiLlm({
        apiKey: env.OPENAI_API_KEY, baseURL: env.OPENAI_BASE_URL, model: env.OPENAI_MODEL, visionModel: env.OPENAI_VISION_MODEL,
        reasoningEffort: env.OPENAI_REASONING_EFFORT, timeoutMs: env.OPENAI_TIMEOUT_MS, log: log.child({ mod: 'llm' }), metrics,
        maxConcurrency: env.OPENAI_MAX_CONCURRENCY,
      })
    : new DisabledLlm();

  const transport = createTransport(env, log);
  const app: App = assemble(
    { store, transport, log, metrics },
    {
      adminIds: (env.ADMIN_TELEGRAM_IDS ?? '').split(',').map((s) => s.trim()).filter(Boolean),
      onRestart: ctx.requestRestart,
      botStateFile: env.BOT_STATE_FILE,
      supportChatId: env.SUPPORT_GROUP_CHAT_ID,
      exportChatId: env.EXPORT_BOT_ID,
    },
  );
  // ON/OFF survives every kind of restart: the store (Postgres) or, for the in-memory store, the
  // in-process carry-over of a /restart and the state file for a full process restart.
  await app.botSwitch.restore(ctx.previous?.botOn);

  let draining = false;
  // Bind the port first so a clash fails fast, before we connect to Telegram.
  const live: HealthChecks = { store: () => store.healthy(), telegram: () => transport.healthy() };
  const health = await startHealthServer(env.HTTP_PORT, live, metrics, env.HTTP_HOST, { ready: { accepting: () => !draining } });

  await transport.start({
    onMessage: (m) => app.onMessage(m),
    onSupportMessage: (m) => app.onSupportMessage(m),
    onOwnOutgoing: (e) => app.onOwnOutgoing(e),
    onExportMessage: (m) => app.onExportMessage(m),
    onExportForward: (e) => app.onExportForward(e),
    onAdminCommand: (e) => app.onAdminCommand(e),
  });
  log.info(
    { llm: llm.available, port: env.HTTP_PORT, botOn: await app.botSwitch.current(), admins: (env.ADMIN_TELEGRAM_IDS ?? '').split(',').filter(Boolean).length, replySystem: 'none' },
    'agent running: receiving and storing messages; no automatic replies',
  );

  let stopped = false;
  return {
    async stop() {
      if (stopped) return;
      stopped = true;
      draining = true;
      log.info('stopping');
      await transport.stop().catch((err) => log.warn({ err }, 'transport stop failed'));
      health.close();
      await store.close();
    },
    // The supervisor's restart confirmation goes to the admin who asked, through the raw transport.
    sendText: (chatId, text) => transport.sendText(chatId, text),
    carry: async () => ({ botOn: await app.botSwitch.current() }),
  };
}

async function main() {
  const first = loadEnv();
  const rootLog = createLogger({ level: first.LOG_LEVEL, pretty: first.LOG_PRETTY, file: first.LOG_FILE });
  // One copy of the agent per account: the lock is taken once per process; an in-process /restart keeps it.
  acquireInstanceLock(first.INSTANCE_LOCK_FILE);

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
