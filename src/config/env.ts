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
  TELEGRAM_SESSION_FILE: z.string().trim().min(1).default('secrets/telegram.session.enc'),
  /** PID lock so only one copy of the agent runs on this account. */
  INSTANCE_LOCK_FILE: z.string().trim().min(1).default('secrets/agent.lock'),
  /** Mirror of the ON/OFF switch so OFF survives a full restart even with STORE=memory. */
  BOT_STATE_FILE: z.string().trim().min(1).default('data/bot-state.json'),
  /** Optional existing string session (GramJS/Telethon). Imported into the encrypted session file on first start. */
  /** The account's session string (from `npm run telegram:session`). When set, it is used as is and no session file or encryption key is needed. */
  TELEGRAM_SESSION: optionalString,
  SESSION_ENCRYPTION_KEY: optionalString,
  /** Comma-separated user ids / @usernames. When set, ONLY these chats get AI replies (testing / gradual rollout). */
  TELEGRAM_ALLOWED_USERS: optionalString,
  /** Comma-separated Telegram user ids allowed to run /boton, /botoff and /restart by messaging the account. The account owner can always run them in Saved Messages. */
  ADMIN_TELEGRAM_IDS: optionalString,
  /** Personal account: don't auto-reply to people saved in the account's contacts (friends, family, team). */
  TELEGRAM_IGNORE_CONTACTS: bool(true),
  SUPPORT_GROUP_CHAT_ID: optionalString,
  /** Telegram user id of the export bot that receives each case's requested details and files. */
  EXPORT_BOT_ID: optionalString,
  /** After a human replies in a customer chat the bot stays silent there. 0 (default) = until the human types the resume command; N = also hand back automatically after N minutes. */
  HUMAN_TAKEOVER_MINUTES: int(0),
  /** Typed by a human in a customer chat to hand it back to the bot (deleted again, the customer never sees it). "/bot" always works too. */
  AI_RESUME_COMMAND: z.string().trim().min(1).default('/ai'),
  /**
   * What the bot says inside a deposit/withdrawal case. request_only (default): exactly one evidence-request
   * message, then silence — no acknowledgements, reminders, choices, status or confirmations; the team takes
   * it from there. conversational: the full dialogue (acks, follow-ups, export/solved confirmations).
   */
  CASE_REPLIES: z.enum(['request_only', 'conversational']).default('request_only'),
  /** A customer message older than this when the bot gets to it (a restart, a reconnect catch-up) is never answered. */
  STALE_MESSAGE_SECONDS: int(300),
  /** Re-queue messages left unprocessed by a previous run, up to this many minutes old. 0 (default): never — old messages are not answered after a restart. */
  RECOVER_UNPROCESSED_MINUTES: int(0),
  /** Customers' timezone (IANA name): a greeting goes out only on a customer's first message of their calendar day. */
  CUSTOMER_TIMEZONE: z.string().trim().min(1).default('Asia/Kolkata'),
  /** Reply only to messages still unread on Telegram: once a human has read a message, the bot leaves it to them. */
  REPLY_ONLY_TO_UNREAD: bool(true),
  /** Organise chats into Telegram folders by the latest message: match problems vs other support issues. */
  CHAT_FOLDERS_ENABLED: bool(true),
  /** Folder titles on the account. Telegram allows at most 12 characters each. */
  MATCH_ISSUES_FOLDER: z.string().trim().min(1).max(12).default('Match issues'),
  SUPPORT_FOLDER: z.string().trim().min(1).max(12).default('Support'),

  // ── Database ────────────────────────────────────────────────────────────
  STORE: z.enum(['postgres', 'memory']).default('postgres'),
  DATABASE_URL: optionalString,
  DATABASE_POOL_MAX: int(10),

  // ── OpenAI ──────────────────────────────────────────────────────────────
  OPENAI_API_KEY: optionalString,
  OPENAI_BASE_URL: optionalString,
  OPENAI_MODEL: z.string().default('gpt-5.6-terra'),
  OPENAI_VISION_MODEL: z.string().default('gpt-5.6-terra'),
  OPENAI_REASONING_EFFORT: z.enum(['none', 'minimal', 'low', 'medium', 'high']).optional(),
  OPENAI_TIMEOUT_MS: int(45_000),
  /** template = deterministic phrasing only; llm = LLM phrasing with hallucination guard. */
  RESPONSE_MODE: z.enum(['template', 'llm']).default('llm'),

  // ── Admin panel ─────────────────────────────────────────────────────────
  ADMIN_MODE: z.enum(['playwright', 'fixture', 'disabled']).default('disabled'),
  ADMIN_BASE_URL: optionalString,
  ADMIN_USERNAME: optionalString,
  ADMIN_PASSWORD: optionalString,
  ADMIN_CONFIG_FILE: z.string().default('config/admin.json'),
  ADMIN_FIXTURE_FILE: z.string().default('config/admin-fixtures.example.json'),
  ADMIN_STORAGE_STATE_FILE: z.string().default('secrets/admin-storage-state.json'),
  ADMIN_HEADLESS: bool(true),
  /** Use a specific Chromium binary, or an installed browser channel such as "chrome". */
  ADMIN_BROWSER_PATH: optionalString,
  ADMIN_BROWSER_CHANNEL: optionalString,
  ADMIN_TIMEOUT_MS: int(30_000),
  ADMIN_CACHE_TTL_SECONDS: int(120),

  // ── Behaviour ───────────────────────────────────────────────────────────
  TURN_DEBOUNCE_MS: int(1500),
  TURN_MAX_WAIT_MS: int(5000),
  MAX_CONCURRENT_TURNS: int(8),
  MAX_ASKS_PER_SLOT: int(2),
  HISTORY_MESSAGES: int(20),
  CASE_IDLE_CLOSE_HOURS: int(48),
  WITHDRAWAL_PROCESSING_SLA_HOURS: int(24),
  REGISTRATION_NUMBER_PATTERN: z.string().default('(?<![\\d])[6-9]\\d{9}(?![\\d])'),
  /** Matched case-insensitively. Contextual phrases ("withdrawal id 12345") are handled separately. */
  WITHDRAWAL_ID_PATTERN: z.string().default('\\b(?:WD|WDR|WID)[-_]?\\d{3,}(?:[-_]\\d{2,})*\\b'),
  ORDER_ID_PATTERN: z.string().default('\\b(?:ORD|ORDER|DEP|TXN)[-_]?(?=[A-Z0-9]*\\d)[A-Z0-9]{4,}(?:[-_][A-Z0-9]+)*\\b'),
  FFMPEG_PATH: optionalString,
  STYLE_GUIDE_FILE: z.string().default('config/style/fa_chat_style.json'),
  KNOWLEDGE_FILE: z.string().default('config/knowledge.json'),

  // ── Scaling ─────────────────────────────────────────────────────────────
  /**
   * all: one process does everything (default). gateway: owns the Telegram session, persists and
   * queues messages, serves the internal API. worker: runs queued jobs (AI, media, export) and
   * talks to Telegram through the gateway. gateway/worker need STORE=postgres and INTERNAL_TOKEN.
   */
  ROLE: z.enum(['all', 'gateway', 'worker']).default('all'),
  /** Shared secret for the gateway's internal API (workers → gateway). */
  INTERNAL_TOKEN: optionalString,
  /** Where a worker reaches the gateway, e.g. http://gateway:9464 */
  GATEWAY_URL: optionalString,
  /** Jobs one worker process runs at once. */
  WORKER_CONCURRENCY: int(4),
  /** A job not finished within this is assumed crashed and re-queued. */
  JOB_LEASE_SECONDS: int(180),
  JOB_MAX_ATTEMPTS: int(8),
  /** Concurrent OpenAI calls per process. */
  OPENAI_MAX_CONCURRENCY: int(8),
  /** Outbound Telegram messages per second (account-wide) and per chat. */
  TELEGRAM_SEND_RATE: z.coerce.number().positive().default(20),
  TELEGRAM_CHAT_SEND_RATE: z.coerce.number().positive().default(1),

  // ── Ops ─────────────────────────────────────────────────────────────────
  HTTP_PORT: int(9464),
  /** Bind address for /healthz and /metrics. Use 0.0.0.0 inside containers. */
  HTTP_HOST: z.string().default('127.0.0.1'),
  HANDOFF_RETRY_INTERVAL_SECONDS: int(60),
  HANDOFF_MAX_ATTEMPTS: int(10),
});

export type Env = z.infer<typeof envSchema>;

export class ConfigError extends Error {}

/** Which parts of the configuration the calling program actually needs. */
export type EnvRequirement = 'telegram' | 'store' | 'admin';

/** Parse + cross-validate environment. Never echoes secret values in errors. */
export function loadEnv(source: NodeJS.ProcessEnv = process.env, require: EnvRequirement[] = ['telegram', 'store', 'admin']): Env {
  const parsed = envSchema.safeParse(source);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new ConfigError(`Invalid environment: ${issues}`);
  }
  const env = parsed.data;
  const problems: string[] = [];

  if (env.NODE_ENV !== 'test') {
    if (require.includes('telegram') && env.ROLE !== 'worker') {
      if (!env.TELEGRAM_API_ID || !env.TELEGRAM_API_HASH) problems.push('TELEGRAM_API_ID and TELEGRAM_API_HASH are required (https://my.telegram.org)');
      // A path setting that holds a secret would end up as directory names on disk: refuse it outright.
      for (const key of ['TELEGRAM_SESSION_FILE', 'INSTANCE_LOCK_FILE', 'BOT_STATE_FILE'] as const) {
        const v = env[key];
        if (looksLikeSessionString(v) || v.length > 200 || /\s/.test(v)) problems.push(`${key} must be a file path such as secrets/telegram.session.enc (the session string belongs in TELEGRAM_SESSION)`);
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
    try {
      new Intl.DateTimeFormat('en-CA', { timeZone: env.CUSTOMER_TIMEZONE });
    } catch {
      problems.push(`CUSTOMER_TIMEZONE "${env.CUSTOMER_TIMEZONE}" is not a valid IANA timezone (e.g. Asia/Kolkata)`);
    }
    if (env.ROLE !== 'all') {
      if (env.STORE !== 'postgres') problems.push('ROLE=gateway/worker needs STORE=postgres (the queue lives in the database)');
      if (!env.INTERNAL_TOKEN) problems.push('INTERNAL_TOKEN is required when ROLE=gateway/worker');
      if (env.ROLE === 'worker' && !env.GATEWAY_URL) problems.push('GATEWAY_URL is required when ROLE=worker');
    }
    if (require.includes('admin') && env.ADMIN_MODE === 'playwright' && (!env.ADMIN_BASE_URL || !env.ADMIN_USERNAME || !env.ADMIN_PASSWORD)) {
      problems.push('ADMIN_BASE_URL, ADMIN_USERNAME and ADMIN_PASSWORD are required when ADMIN_MODE=playwright');
    }
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
  return [
    env.TELEGRAM_SESSION,
    env.TELEGRAM_API_HASH,
    env.SESSION_ENCRYPTION_KEY,
    env.OPENAI_API_KEY,
    env.ADMIN_PASSWORD,
    env.DATABASE_URL,
    env.INTERNAL_TOKEN,
  ].filter((v): v is string => typeof v === 'string' && v.length >= 6);
}
