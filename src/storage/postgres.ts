import { randomUUID } from 'node:crypto';
import type { Logger } from 'pino';
import { migrate, type Queryable } from './migrate.js';
import type { EvidenceRequest, EvidenceRequestRepo, MessageRepo, NewStoredMessage, SettingsRepo, Store, StoredMessage, UserRecord, UserRepo } from './types.js';

/** A pool-like object: pg.Pool in production, pg-mem's adapter in tests. */
export interface PoolLike extends Queryable {
  connect(): Promise<Queryable & { release(): void }>;
  end(): Promise<void>;
}

type Row = Record<string, any>;

const num = (v: unknown): number | undefined => (v === null || v === undefined ? undefined : Number(v));
const str = (v: unknown): string | undefined => (v === null || v === undefined ? undefined : String(v));
const date = (v: unknown): Date | undefined => (v === null || v === undefined ? undefined : new Date(v as string));
const json = (v: unknown) => JSON.stringify(v ?? null);
const parse = <T>(v: unknown, fallback: T): T => {
  if (v === null || v === undefined) return fallback;
  if (typeof v === 'string') {
    try {
      return JSON.parse(v) as T;
    } catch {
      return fallback;
    }
  }
  return v as T;
};

// ── mappers ────────────────────────────────────────────────────────────────

const toUser = (r: Row): UserRecord => ({
  id: r.id,
  chatId: r.chat_id,
  username: str(r.username),
  firstName: str(r.first_name),
  languageCode: str(r.language_code),
  preferredLanguage: str(r.preferred_language) as UserRecord['preferredLanguage'],
  humanTakeoverUntil: date(r.human_takeover_until),
  conversationChecked: date(r.conversation_checked),
  greetedAt: date(r.greeted_at),
  createdAt: new Date(r.created_at),
  updatedAt: new Date(r.updated_at),
});

const toRequest = (r: Row): EvidenceRequest => ({
  id: r.id,
  chatId: r.chat_id,
  userId: r.user_id,
  issueType: r.issue_type,
  language: r.language,
  status: r.status,
  telegramMessageId: num(r.telegram_message_id),
  createdAt: new Date(r.created_at),
  solvedAt: date(r.solved_at),
});

const toMessage = (r: Row): StoredMessage => ({
  id: r.id,
  chatId: r.chat_id,
  userId: r.user_id,
  telegramMessageId: Number(r.telegram_message_id),
  direction: r.direction,
  text: str(r.text),
  caption: str(r.caption),
  media: parse(r.media, []),
  replyToMessageId: num(r.reply_to_message_id),
  meta: parse(r.meta, {}),
  processedAt: date(r.processed_at),
  createdAt: new Date(r.created_at),
});

// ── repos ──────────────────────────────────────────────────────────────────

class PgUsers implements UserRepo {
  constructor(private db: Queryable) {}
  async upsert(u: Pick<UserRecord, 'id' | 'chatId'> & Partial<UserRecord>) {
    const { rows } = await this.db.query(
      `INSERT INTO users (id, chat_id, username, first_name, language_code, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, now(), now())
       ON CONFLICT (id) DO UPDATE SET
         chat_id = EXCLUDED.chat_id,
         username = COALESCE(EXCLUDED.username, users.username),
         first_name = COALESCE(EXCLUDED.first_name, users.first_name),
         language_code = COALESCE(EXCLUDED.language_code, users.language_code),
         updated_at = now()
       RETURNING *`,
      [u.id, u.chatId, u.username ?? null, u.firstName ?? null, u.languageCode ?? null],
    );
    return toUser(rows[0]);
  }
  async get(userId: string) {
    const { rows } = await this.db.query(`SELECT * FROM users WHERE id = $1`, [userId]);
    if (!rows[0]) return undefined;
    const user = toUser(rows[0]);
    const mobiles = await this.db.query(`SELECT number FROM customer_mobiles WHERE user_id = $1 ORDER BY seen_at`, [userId]);
    if (mobiles.rows.length) user.mobileNumbers = mobiles.rows.map((r: Row) => String(r.number));
    return user;
  }
  async setPreferredLanguage(userId: string, lang: UserRecord['preferredLanguage']) {
    await this.db.query(`UPDATE users SET preferred_language = $2, updated_at = now() WHERE id = $1`, [userId, lang ?? null]);
  }
  async setHumanTakeover(userId: string, until: Date | undefined) {
    await this.db.query(`UPDATE users SET human_takeover_until = $2, updated_at = now() WHERE id = $1`, [userId, until ?? null]);
  }
  async setConversationChecked(userId: string, at: Date) {
    await this.db.query(`UPDATE users SET conversation_checked = $2, updated_at = now() WHERE id = $1`, [userId, at]);
  }
  async setGreetedAt(userId: string, at: Date) {
    await this.db.query(`UPDATE users SET greeted_at = $2, updated_at = now() WHERE id = $1`, [userId, at]);
  }
  async addMobileNumber(userId: string, number: string, at: Date) {
    await this.db.query(`INSERT INTO customer_mobiles (number, user_id, seen_at) VALUES ($1, $2, $3) ON CONFLICT (number, user_id) DO NOTHING`, [number, userId, at]);
  }
  async findByMobileNumber(number: string) {
    const { rows } = await this.db.query(`SELECT user_id FROM customer_mobiles WHERE number = $1 ORDER BY seen_at`, [number]);
    const users: UserRecord[] = [];
    for (const r of rows) {
      const u = await this.get(String(r.user_id));
      if (u) users.push(u);
    }
    return users;
  }
}

class PgRequests implements EvidenceRequestRepo {
  constructor(private db: Queryable) {}
  async create(r: Pick<EvidenceRequest, 'chatId' | 'userId' | 'issueType' | 'language'> & { createdAt?: Date }) {
    const { rows } = await this.db.query(
      `INSERT INTO evidence_requests (id, chat_id, user_id, issue_type, language, status, created_at) VALUES ($1,$2,$3,$4,$5,'sending',$6) RETURNING *`,
      [randomUUID(), r.chatId, r.userId, r.issueType, r.language, r.createdAt ?? new Date()],
    );
    return toRequest(rows[0]);
  }
  async markSent(id: string, telegramMessageId: number) {
    await this.db.query(`UPDATE evidence_requests SET status = 'sent', telegram_message_id = $2 WHERE id = $1`, [id, telegramMessageId]);
  }
  async remove(id: string) {
    await this.db.query(`DELETE FROM evidence_requests WHERE id = $1`, [id]);
  }
  async listOpen(chatId: string) {
    const { rows } = await this.db.query(`SELECT * FROM evidence_requests WHERE chat_id = $1 AND status <> 'solved' ORDER BY created_at DESC`, [chatId]);
    return rows.map(toRequest);
  }
  async markSolved(userId: string, at: Date) {
    const r = await this.db.query(`UPDATE evidence_requests SET status = 'solved', solved_at = $2 WHERE user_id = $1 AND status <> 'solved'`, [userId, at]);
    return r.rowCount ?? 0;
  }
}

class PgSettings implements SettingsRepo {
  constructor(private db: Queryable) {}
  async get(key: string) {
    const { rows } = await this.db.query(`SELECT value FROM settings WHERE key = $1`, [key]);
    if (!rows[0]) return undefined;
    const v = rows[0].value;
    return typeof v === 'string' ? JSON.parse(v) : v;
  }
  async set(key: string, value: unknown) {
    await this.db.query(
      `INSERT INTO settings (key, value, updated_at) VALUES ($1, $2, now())
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
      [key, JSON.stringify(value)],
    );
  }
}

class PgMessages implements MessageRepo {
  constructor(private db: Queryable) {}
  async insert(m: NewStoredMessage) {
    const newId = randomUUID();
    const { rows } = await this.db.query(
      `INSERT INTO messages (id, chat_id, user_id, telegram_message_id, direction, text, caption, media, reply_to_message_id, meta, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
       ON CONFLICT (chat_id, telegram_message_id, direction) DO NOTHING
       RETURNING *`,
      [newId, m.chatId, m.userId, m.telegramMessageId, m.direction, m.text ?? null, m.caption ?? null, json(m.media), m.replyToMessageId ?? null, json(m.meta), m.createdAt ?? new Date()],
    );
    if (rows[0]?.id === newId) return { inserted: true, message: toMessage(rows[0]) };
    const existing = await this.db.query(`SELECT * FROM messages WHERE chat_id = $1 AND telegram_message_id = $2 AND direction = $3`, [m.chatId, m.telegramMessageId, m.direction]);
    return { inserted: false, message: toMessage(existing.rows[0]) };
  }
  async find(chatId: string, telegramMessageId: number) {
    const { rows } = await this.db.query(`SELECT * FROM messages WHERE chat_id = $1 AND telegram_message_id = $2 ORDER BY created_at DESC LIMIT 1`, [chatId, telegramMessageId]);
    return rows[0] ? toMessage(rows[0]) : undefined;
  }
  async recent(chatId: string, limit: number) {
    const { rows } = await this.db.query(`SELECT * FROM messages WHERE chat_id = $1 ORDER BY created_at DESC, telegram_message_id DESC LIMIT $2`, [chatId, limit]);
    return rows.map(toMessage).reverse();
  }
  async markProcessed(chatId: string, ids: number[]) {
    if (!ids.length) return;
    await this.db.query(
      `UPDATE messages SET processed_at = now() WHERE chat_id = $1 AND direction = 'in' AND telegram_message_id IN (${ids.map((_, i) => `$${i + 2}`).join(',')})`,
      [chatId, ...ids],
    );
  }
}

/**
 * Postgres store. The schema (storage/migrations.ts) still carries the tables of the removed reply
 * system (turns, cases, evidence, tickets, outbox, jobs); they are unused and harmless, and the
 * migrations are append-only, so they stay.
 */
export class PostgresStore implements Store {
  readonly kind = 'postgres' as const;
  readonly settings: SettingsRepo;
  readonly users: UserRepo;
  readonly messages: MessageRepo;
  readonly requests: EvidenceRequestRepo;

  constructor(readonly pool: PoolLike) {
    this.settings = new PgSettings(pool);
    this.users = new PgUsers(pool);
    this.messages = new PgMessages(pool);
    this.requests = new PgRequests(pool);
  }

  async migrate(log?: Logger): Promise<string[]> {
    const client = await this.pool.connect();
    try {
      return await migrate(client, log);
    } finally {
      client.release();
    }
  }

  async healthy(): Promise<boolean> {
    try {
      await this.pool.query('SELECT 1');
      return true;
    } catch {
      return false;
    }
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}
