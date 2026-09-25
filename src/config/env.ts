import { z } from 'zod';

const bool = (def: boolean) =>
  z
    .enum(['true', 'false', '1', '0', 'yes', 'no'])
    .optional()
    .transform((v) => (v === undefined ? def : ['true', '1', 'yes'].includes(v)));

const int = (def: number) => z.coerce.number().int().nonnegative().default(def);

const optionalString = z
  .string()
  .optional()
  .transform((v) => (v && v.trim().length > 0 ? v.trim() : undefined));

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  LOG_PRETTY: bool(false),
  /** Also write JSON logs to this file (empty to disable). */
  LOG_FILE: z.string().default('logs/agent.log').transform((v) => v.trim() || undefined),

  // ── Telegram (personal account over MTProto) ────────────────────────────
  TELEGRAM_API_ID: z.coerce.number().int().optional(),
  TELEGRAM_API_HASH: optionalString,
  TELEGRAM_PHONE: optionalString,
  /** The account's session string (from `npm run telegram:session`). When set, it is used as is and no session file or encryption key is needed. */
  TELEGRAM_SESSION: optionalString,
  /** Alternative: an AES-256-GCM encrypted session file written by `npm run telegram:login`, unlocked with SESSION_ENCRYPTION_KEY. */
  TELEGRAM_SESSION_FILE: z.string().trim().min(1).default('secrets/telegram.session.enc'),
  SESSION_ENCRYPTION_KEY: optionalString,
  /** PID lock so only one copy of the agent runs on this account. */
  INSTANCE_LOCK_FILE: z.string().trim().min(1).default('secrets/agent.lock'),
  /** Mirror of the ON/OFF switch so OFF survives a full restart even with STORE=memory. */
  BOT_STATE_FILE: z.string().trim().min(1).default('data/bot-state.json'),
  /** With STORE=memory: the evidence-request ledger on disk, so a case is never asked twice across a restart. */
  REQUESTS_STATE_FILE: z.string().trim().min(1).default('data/requests.json'),
  /** With STORE=memory: customers' language, human takeover and conversation check on disk. */
  USERS_STATE_FILE: z.string().trim().min(1).default('data/users.json'),
  /**
   * How /restart brings the updated code up after `git pull` + build. respawn (default): this process
   * starts a fresh one and exits (plain `npm start`, nohup). exit: this process just exits with code 0
   * and a process manager (systemd, docker restart policy, pm2) starts it again.
   */
  RESTART_MODE: z.enum(['respawn', 'exit']).default('respawn'),
  /** Comma-separated user ids / @usernames. When set, ONLY these chats are treated as customers. */
  TELEGRAM_ALLOWED_USERS: optionalString,
  /** Personal account: people saved in the account's contacts (friends, family, team) are not customers. */
  TELEGRAM_IGNORE_CONTACTS: bool(true),
  /** Comma-separated Telegram user ids allowed to run /boton, /botoff and /restart by messaging the account. The account owner can always run them in Saved Messages. */
  ADMIN_TELEGRAM_IDS: optionalString,
  /** Chats the transport tells apart from customer chats (their messages are received, never treated as a customer's). */
  SUPPORT_GROUP_CHAT_ID: optionalString,
  EXPORT_BOT_ID: optionalString,
  /** Outbound Telegram messages per second (account-wide) and per chat. */
  TELEGRAM_SEND_RATE: z.coerce.number().positive().default(20),
  TELEGRAM_CHAT_SEND_RATE: z.coerce.number().positive().default(1),

  // ── Workflow: one evidence request per case ─────────────────────────────
  /** A customer message older than this (seconds) when handled is never answered (restart, reconnect catch-up). 0: no limit. */
  STALE_MESSAGE_SECONDS: int(300),
  /** An open request of the same type younger than this keeps the case silent; after it a new message may be asked again. */
  CASE_REOPEN_HOURS: int(48),
  /** A message a human already read on Telegram is theirs to answer: no request for it. */
  REPLY_ONLY_TO_UNREAD: bool(true),
  /** After a human writes in a customer chat the agent stays out of it for this many hours, from the human's latest message. 0: for good. */
  HUMAN_TAKEOVER_HOURS: int(24),

  // ── Database ────────────────────────────────────────────────────────────
  STORE: z.enum(['postgres', 'memory']).default('postgres'),
  DATABASE_URL: optionalString,
  DATABASE_POOL_MAX: int(10),

  // ── OpenAI (client only; no reply logic uses it yet) ────────────────────
  OPENAI_API_KEY: optionalString,
  OPENAI_BASE_URL: optionalString,
  OPENAI_MODEL: z.string().default('gpt-5.6-terra'),
  OPENAI_REASONING_EFFORT: z.enum(['none', 'minimal', 'low', 'medium', 'high']).optional(),
  OPENAI_TIMEOUT_MS: int(45_000),
  OPENAI_MAX_CONCURRENCY: int(8),

  // ── Ops ─────────────────────────────────────────────────────────────────
  HTTP_PORT: int(9464),
  /** Bind address for /healthz and /metrics. Use 0.0.0.0 inside containers. */
  HTTP_HOST: z.string().default('127.0.0.1'),
});

export type Env = z.infer<typeof envSchema> & {
  /** Things that were wrong but harmless, fixed up at load time; logged at boot. */
  warnings: string[];
};

export class ConfigError extends Error {}

/** Which parts of the configuration the calling program actually needs. */
export type EnvRequirement = 'telegram' | 'store';

/** Parse + cross-validate environment. Never echoes secret values in errors. */
export function loadEnv(source: NodeJS.ProcessEnv = process.env, require: EnvRequirement[] = ['telegram', 'store']): Env {
  const parsed = envSchema.safeParse(source);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new ConfigError(`Invalid environment: ${issues}`);
  }
  const env: Env = { ...parsed.data, warnings: [] };
  const problems: string[] = [];

  if (env.NODE_ENV !== 'test') {
    if (require.includes('telegram')) {
      if (!env.TELEGRAM_API_ID || !env.TELEGRAM_API_HASH) problems.push('TELEGRAM_API_ID and TELEGRAM_API_HASH are required (https://my.telegram.org)');
      // A path setting that holds a secret would end up as directory names on disk: refuse it outright —
      // except the session FILE path while a session STRING is in use: the file is not touched then, so a
      // blob pasted into that line (it keeps happening) must not take the agent down. It is ignored, with a warning.
      for (const key of ['TELEGRAM_SESSION_FILE', 'INSTANCE_LOCK_FILE', 'BOT_STATE_FILE', 'REQUESTS_STATE_FILE', 'USERS_STATE_FILE'] as const) {
        const v = env[key];
        if (!(looksLikeSessionString(v) || v.length > 200 || /\s/.test(v))) continue;
        if (key === 'TELEGRAM_SESSION_FILE' && env.TELEGRAM_SESSION) {
          env.TELEGRAM_SESSION_FILE = 'secrets/telegram.session.enc';
          env.warnings.push('TELEGRAM_SESSION_FILE holds a long value, not a file path; ignored because TELEGRAM_SESSION is in use. Set it to secrets/telegram.session.enc (or delete the line).');
          continue;
        }
        problems.push(`${key} must be a file path such as secrets/telegram.session.enc (the session string belongs in TELEGRAM_SESSION)`);
      }
      if (env.TELEGRAM_SESSION && !looksLikeSessionString(env.TELEGRAM_SESSION)) {
        problems.push('TELEGRAM_SESSION does not look like a Telegram session string (run `npm run telegram:session` to create one)');
      }
      if (!env.TELEGRAM_SESSION && !env.SESSION_ENCRYPTION_KEY) problems.push('Set TELEGRAM_SESSION (run `npm run telegram:session`) or SESSION_ENCRYPTION_KEY (then `npm run telegram:login`)');
      else if (env.SESSION_ENCRYPTION_KEY && looksLikeSessionString(env.SESSION_ENCRYPTION_KEY)) {
        problems.push('SESSION_ENCRYPTION_KEY contains a Telegram session string: move it to TELEGRAM_SESSION and set SESSION_ENCRYPTION_KEY to a random key (openssl rand -hex 32)');
      }
    }
    if (require.includes('store') && env.STORE === 'postgres' && !env.DATABASE_URL) problems.push('DATABASE_URL is required when STORE=postgres');
  }
  if (problems.length) throw new ConfigError(problems.join('; '));
  return env;
}

/** GramJS/Telethon string sessions: version "1" + a long base64 blob. */
export function looksLikeSessionString(v: string): boolean {
  return /^1[A-Za-z0-9+/_=-]{300,}$/.test(v.trim());
}

/** Every env value that must never appear in logs or outbound text. */
export function secretValues(env: Env): string[] {
  return [env.TELEGRAM_SESSION, env.TELEGRAM_API_HASH, env.SESSION_ENCRYPTION_KEY, env.OPENAI_API_KEY, env.DATABASE_URL].filter(
    (v): v is string => typeof v === 'string' && v.length >= 6,
  );
}
