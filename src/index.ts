import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import dotenv from 'dotenv';
import { assemble, type App } from './app.js';
import { REPLIES } from './control/adminCommands.js';
import { Supervisor, type Booted, type BootContext } from './control/supervisor.js';
import { updateFromGit } from './control/updater.js';
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
const run = promisify(execFile);

/** The restart confirmation travels from the old process to the new one through a small file next to the bot state. */
const confirmationFile = (stateFile: string) => join(dirname(stateFile), 'restart-confirm.json');
function writeConfirmation(stateFile: string, c: { chatId: string; text: string }) {
  mkdirSync(dirname(stateFile), { recursive: true });
  writeFileSync(confirmationFile(stateFile), JSON.stringify(c));
}
function readConfirmation(stateFile: string): { chatId: string; text: string } | undefined {
  try {
    const c = JSON.parse(readFileSync(confirmationFile(stateFile), 'utf8')) as { chatId: string; text: string };
    rmSync(confirmationFile(stateFile), { force: true });
    return c.chatId ? c : undefined;
  } catch {
    return undefined;
  }
}

/** One full start of the agent. The supervisor calls it at process start and again on /restart. */
async function boot(ctx: BootContext, rootLog: Logger): Promise<Booted> {
  const env = loadEnv();
  scrubber.register(...secretValues(env));
  const instance = `agent-${process.pid}${ctx.attempt > 1 ? `-r${ctx.attempt}` : ''}`;
  const log = rootLog.child({ instance });
  const metrics = new Metrics();

  const store = await createStore(env, log.child({ mod: 'store' }));
  // The model is used for one thing: telling deposit from withdrawal when the lexical scorer cannot.
  const llm: LlmClient = env.OPENAI_API_KEY
    ? new OpenAiLlm({
        apiKey: env.OPENAI_API_KEY, baseURL: env.OPENAI_BASE_URL, model: env.OPENAI_MODEL,
        reasoningEffort: env.OPENAI_REASONING_EFFORT, timeoutMs: env.OPENAI_TIMEOUT_MS, log: log.child({ mod: 'llm' }), metrics,
        maxConcurrency: env.OPENAI_MAX_CONCURRENCY,
      })
    : new DisabledLlm();

  if (!llm.available) log.warn('OPENAI_API_KEY not set: deposit/withdrawal is read by the lexical scorer only');
  if (!env.EXPORT_BOT_ID) log.warn('EXPORT_BOT_ID not set: PAYMENT CONFIRMED messages cannot be recognised');

  const transport = createTransport(env, log);
  const version = await run('git', ['rev-parse', '--short', 'HEAD'], { cwd: process.cwd() }).then((r) => r.stdout.trim()).catch(() => 'unknown');
  const app: App = assemble(
    { store, transport, log, metrics, llm, readState: env.REPLY_ONLY_TO_UNREAD ? transport : undefined },
    {
      adminIds: (env.ADMIN_TELEGRAM_IDS ?? '').split(',').map((s) => s.trim()).filter(Boolean),
      onRestart: ctx.requestRestart,
      botStateFile: env.BOT_STATE_FILE,
      supportChatId: env.SUPPORT_GROUP_CHAT_ID,
      exportChatId: env.EXPORT_BOT_ID,
      staleSeconds: env.STALE_MESSAGE_SECONDS,
      reopenHours: env.CASE_REOPEN_HOURS,
      resumeCommand: env.AI_RESUME_COMMAND,
      version,
      transportStats: () => ({ reconnects: transport.reconnectCount, lastUpdateAt: transport.lastUpdateAt }),
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
    onMessage: async (m) => void (await app.onMessage(m)),
    onSupportMessage: (m) => app.onSupportMessage(m),
    onOwnOutgoing: (e) => app.onOwnOutgoing(e),
    onExportMessage: (m) => app.onExportMessage(m),
    onAdminCommand: (e) => app.onAdminCommand(e),
  });
  log.info(
    { llm: llm.available, port: env.HTTP_PORT, botOn: await app.botSwitch.current(), admins: (env.ADMIN_TELEGRAM_IDS ?? '').split(',').filter(Boolean).length, workflows: ['evidence_request', 'payment_confirmed'] },
    'agent running: one evidence request per deposit/withdrawal case, one solved note per confirmed payment, nothing else',
  );
  // Started by /restart: the previous process pulled and built the code and handed over to us. Tell the admin.
  const pending = readConfirmation(env.BOT_STATE_FILE);
  if (pending) {
    await transport.sendText(pending.chatId, pending.text || REPLIES.restarted).catch((err) => log.warn({ err }, 'restarted, but the confirmation could not be sent'));
    log.info({ chat: pending.chatId }, 'restart confirmed to the admin');
  }

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
    ownChatId: transport.ownChatId,
  };
}

async function main() {
  const first = loadEnv();
  const rootLog = createLogger({ level: first.LOG_LEVEL, pretty: first.LOG_PRETTY, file: first.LOG_FILE });
  // One copy of the agent per account. /restart releases the lock right before handing over to the new process.
  const releaseLock = acquireInstanceLock(first.INSTANCE_LOCK_FILE);

  const supervisor = new Supervisor({
    boot: (ctx) => boot(ctx, rootLog),
    log: rootLog.child({ mod: 'supervisor' }),
    reloadEnv: () => dotenv.config({ override: true }),
    update: () => updateFromGit({ cwd: process.cwd(), log: rootLog.child({ mod: 'updater' }) }),
    releaseLock,
    respawn: (confirm) => {
      writeConfirmation(first.BOT_STATE_FILE, confirm);
      if (first.RESTART_MODE === 'exit') {
        rootLog.info('restart: exiting for the process manager to start the updated code');
        process.exit(0);
      }
      // Same node binary, same entry file, same working directory and log destination; detached so it outlives us.
      const child = spawn(process.execPath, process.argv.slice(1), { cwd: process.cwd(), env: process.env, detached: true, stdio: 'inherit' });
      child.unref();
      rootLog.info({ pid: child.pid }, 'restart: new process started with the updated code; exiting');
      process.exit(0);
    },
  });
  process.on('SIGINT', () => void supervisor.shutdown('SIGINT'));
  // `kill -USR2 <pid>`: the same pull + build + restart as /restart, confirmed in Saved Messages.
  process.on('SIGUSR2', () => void supervisor.restartFromSignal().catch((err) => rootLog.error({ err }, 'restart failed')));
  process.on('SIGTERM', () => void supervisor.shutdown('SIGTERM'));
  process.on('unhandledRejection', (err) => rootLog.error({ err }, 'unhandled rejection'));
  await supervisor.start();
}

main().catch((err) => {
  console.error(scrubber.scrub(err instanceof Error ? `${err.name}: ${err.message}` : String(err)));
  process.exit(1);
});
