import { randomUUID } from 'node:crypto';
import type { Logger } from 'pino';
import { ACTIVE_STATUSES, emptyFacts, type CaseRecord } from '../domain/cases.js';
import { emptyMemory, type UserMemory } from '../domain/memory.js';
import type { EvidenceItem } from '../domain/evidence.js';
import { migrate, type Queryable } from './migrate.js';
import {
  ConflictError,
  type CaseRepo,
  type EvidenceRepo,
  type MessageRepo,
  type NewCase,
  type NewEvidence,
  type NewStoredMessage,
  type OutboxEntry,
  type OutboxRepo,
  type Store,
  type StoredMessage,
  type TicketRecord,
  type TicketRepo,
  type TurnRecord,
  type TurnRepo,
  type UserRecord,
  type UserRepo,
} from './types.js';

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
  focusCaseId: str(r.focus_case_id),
  memory: { ...emptyMemory(), ...parse(r.memory, {}) },
  createdAt: new Date(r.created_at),
  updatedAt: new Date(r.updated_at),
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
  caseId: str(r.case_id),
  turnId: str(r.turn_id),
  meta: parse(r.meta, {}),
  processedAt: date(r.processed_at),
  createdAt: new Date(r.created_at),
});

const toTurn = (r: Row): TurnRecord => ({
  id: r.id,
  chatId: r.chat_id,
  userId: r.user_id,
  messageIds: parse(r.message_ids, []),
  status: r.status,
  caseId: str(r.case_id),
  trace: parse(r.trace, {}),
  error: str(r.error),
  createdAt: new Date(r.created_at),
  completedAt: date(r.completed_at),
});

const toCase = (r: Row): CaseRecord => ({
  id: r.id,
  userId: r.user_id,
  chatId: r.chat_id,
  type: r.type,
  status: r.status,
  step: r.step,
  registrationNumber: str(r.registration_number),
  withdrawalId: str(r.withdrawal_id),
  orderId: str(r.order_id),
  amount: num(r.amount),
  txnTime: str(r.txn_time),
  utr: str(r.utr),
  confidence: Number(r.confidence ?? 0),
  missing: parse(r.missing, []),
  escalation: r.escalation,
  facts: { ...emptyFacts(), ...parse(r.facts, {}) },
  version: Number(r.version),
  createdAt: new Date(r.created_at),
  updatedAt: new Date(r.updated_at),
  lastActivityAt: new Date(r.last_activity_at),
});

const toEvidence = (r: Row): EvidenceItem => {
  const x = parse<Record<string, any>>(r.extracted, {});
  return {
    id: r.id,
    userId: r.user_id,
    chatId: r.chat_id,
    caseId: str(r.case_id),
    messageId: Number(r.message_id),
    mediaKind: r.media_kind,
    fileRef: r.file_ref,
    fileUniqueId: str(r.file_unique_id),
    mimeType: str(r.mime_type),
    fileName: str(r.file_name),
    sha256: str(r.sha256),
    category: r.category,
    categoryConfidence: Number(r.category_confidence ?? 0),
    status: r.status,
    transcript: str(r.transcript),
    payment: x.payment ?? undefined,
    withdrawals: x.withdrawals ?? undefined,
    statement: x.statement ?? undefined,
    technical: x.technical ?? undefined,
    notes: x.notes ?? [],
    createdAt: new Date(r.created_at),
  };
};

const extractedOf = (e: EvidenceItem | NewEvidence) =>
  json({ payment: e.payment, withdrawals: e.withdrawals, statement: e.statement, technical: e.technical, notes: e.notes });

const toTicket = (r: Row): TicketRecord => ({
  id: r.id,
  caseId: r.case_id,
  userId: r.user_id,
  chatId: r.chat_id,
  reason: r.reason,
  summary: parse(r.summary, {}),
  status: r.status,
  attempts: Number(r.attempts),
  supportChatId: str(r.support_chat_id),
  supportMessageId: num(r.support_message_id),
  lastError: str(r.last_error),
  userNotified: Boolean(r.user_notified),
  createdAt: new Date(r.created_at),
  deliveredAt: date(r.delivered_at),
});

const toOutbox = (r: Row): OutboxEntry => ({
  id: r.id,
  key: r.key,
  chatId: r.chat_id,
  userId: str(r.user_id),
  text: r.text,
  replyToMessageId: num(r.reply_to_message_id),
  meta: parse(r.meta, {}),
  status: r.status,
  attempts: Number(r.attempts),
  telegramMessageId: num(r.telegram_message_id),
  lastError: str(r.last_error),
  createdAt: new Date(r.created_at),
  sentAt: date(r.sent_at),
});

/** Build "col = $n" SET clauses from a camelCase patch using a column map. */
function setClause(patch: Record<string, unknown>, cols: Record<string, [string, (v: any) => unknown]>, start = 1) {
  const sets: string[] = [];
  const params: unknown[] = [];
  for (const [k, v] of Object.entries(patch)) {
    const col = cols[k];
    if (!col) continue;
    params.push(v === undefined ? null : col[1](v));
    sets.push(`${col[0]} = $${start + params.length - 1}`);
  }
  return { sets, params };
}

const id = (v: unknown) => v;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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
    return rows[0] ? toUser(rows[0]) : undefined;
  }
  async setHumanTakeover(userId: string, until: Date | undefined) {
    await this.db.query(`UPDATE users SET human_takeover_until = $2, updated_at = now() WHERE id = $1`, [userId, until ?? null]);
  }
  async setPreferredLanguage(userId: string, lang: UserRecord['preferredLanguage']) {
    await this.db.query(`UPDATE users SET preferred_language = $2, updated_at = now() WHERE id = $1`, [userId, lang ?? null]);
  }
  async setFocus(userId: string, caseId: string | undefined) {
    await this.db.query(`UPDATE users SET focus_case_id = $2, updated_at = now() WHERE id = $1`, [userId, caseId ?? null]);
  }
  async saveMemory(userId: string, memory: UserMemory) {
    await this.db.query(`UPDATE users SET memory = $2, updated_at = now() WHERE id = $1`, [userId, json(memory)]);
  }
}

class PgMessages implements MessageRepo {
  constructor(private db: Queryable) {}
  async insert(m: NewStoredMessage) {
    const newId = randomUUID();
    const { rows } = await this.db.query(
      `INSERT INTO messages (id, chat_id, user_id, telegram_message_id, direction, text, caption, media,
                             reply_to_message_id, case_id, turn_id, meta, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
       ON CONFLICT (chat_id, telegram_message_id, direction) DO NOTHING
       RETURNING *`,
      [
        newId, m.chatId, m.userId, m.telegramMessageId, m.direction, m.text ?? null, m.caption ?? null,
        json(m.media), m.replyToMessageId ?? null, m.caseId ?? null, m.turnId ?? null, json(m.meta), m.createdAt ?? new Date(),
      ],
    );
    if (rows[0]?.id === newId) return { inserted: true, message: toMessage(rows[0]) };
    const existing = await this.db.query(
      `SELECT * FROM messages WHERE chat_id = $1 AND telegram_message_id = $2 AND direction = $3`,
      [m.chatId, m.telegramMessageId, m.direction],
    );
    return { inserted: false, message: toMessage(existing.rows[0]) };
  }
  async find(chatId: string, telegramMessageId: number) {
    const { rows } = await this.db.query(
      `SELECT * FROM messages WHERE chat_id = $1 AND telegram_message_id = $2 ORDER BY created_at DESC LIMIT 1`,
      [chatId, telegramMessageId],
    );
    return rows[0] ? toMessage(rows[0]) : undefined;
  }
  async recent(chatId: string, limit: number) {
    const { rows } = await this.db.query(
      `SELECT * FROM messages WHERE chat_id = $1 ORDER BY created_at DESC, telegram_message_id DESC LIMIT $2`,
      [chatId, limit],
    );
    return rows.map(toMessage).reverse();
  }
  async update(msgId: string, patch: Partial<Pick<StoredMessage, 'caseId' | 'turnId' | 'meta' | 'text' | 'caption'>>) {
    const { sets, params } = setClause(patch, {
      caseId: ['case_id', id],
      turnId: ['turn_id', id],
      meta: ['meta', json],
      text: ['text', id],
      caption: ['caption', id],
    }, 2);
    if (!sets.length) return;
    await this.db.query(`UPDATE messages SET ${sets.join(', ')} WHERE id = $1`, [msgId, ...params]);
  }
  async markProcessed(chatId: string, ids: number[], patch: { turnId: string; caseId?: string }) {
    if (!ids.length) return;
    await this.db.query(
      `UPDATE messages SET processed_at = now(), turn_id = $2, case_id = COALESCE($3, case_id)
       WHERE chat_id = $1 AND direction = 'in' AND telegram_message_id IN (${ids.map((_, i) => `$${i + 4}`).join(',')})`,
      [chatId, patch.turnId, patch.caseId ?? null, ...ids],
    );
  }
  async listUnprocessed(since: Date) {
    const { rows } = await this.db.query(
      `SELECT * FROM messages WHERE direction = 'in' AND processed_at IS NULL AND created_at > $1 ORDER BY created_at`,
      [since],
    );
    return rows.map(toMessage);
  }
  async listInbound(chatId: string, ids: number[]) {
    if (!ids.length) return [];
    const { rows } = await this.db.query(
      `SELECT * FROM messages WHERE chat_id = $1 AND direction = 'in' AND telegram_message_id IN (${ids.map((_, i) => `$${i + 2}`).join(',')}) ORDER BY telegram_message_id`,
      [chatId, ...ids],
    );
    return rows.map(toMessage);
  }
}

class PgTurns implements TurnRepo {
  constructor(private db: Queryable) {}
  async create(t: Pick<TurnRecord, 'chatId' | 'userId' | 'messageIds'>) {
    const { rows } = await this.db.query(
      `INSERT INTO turns (id, chat_id, user_id, message_ids, status, trace, created_at)
       VALUES ($1, $2, $3, $4, 'processing', '{}', now()) RETURNING *`,
      [randomUUID(), t.chatId, t.userId, json(t.messageIds)],
    );
    return toTurn(rows[0]);
  }
  async update(turnId: string, patch: Partial<Omit<TurnRecord, 'id' | 'createdAt'>>) {
    const { sets, params } = setClause(patch, {
      status: ['status', id],
      caseId: ['case_id', id],
      trace: ['trace', json],
      error: ['error', id],
      completedAt: ['completed_at', id],
      messageIds: ['message_ids', json],
    }, 2);
    if (!sets.length) return;
    await this.db.query(`UPDATE turns SET ${sets.join(', ')} WHERE id = $1`, [turnId, ...params]);
  }
  async get(turnId: string) {
    const { rows } = await this.db.query(`SELECT * FROM turns WHERE id = $1`, [turnId]);
    return rows[0] ? toTurn(rows[0]) : undefined;
  }
  async listStuck(olderThan: Date, newerThan: Date) {
    const { rows } = await this.db.query(
      `SELECT * FROM turns WHERE status = 'processing' AND created_at < $1 AND created_at > $2 ORDER BY created_at`,
      [olderThan, newerThan],
    );
    return rows.map(toTurn);
  }
}

const CASE_COLS = `user_id, chat_id, type, status, step, registration_number, withdrawal_id, order_id, amount,
  txn_time, utr, confidence, missing, escalation, facts`;

const caseParams = (c: Omit<CaseRecord, 'id' | 'version' | 'createdAt' | 'updatedAt' | 'lastActivityAt'>) => [
  c.userId, c.chatId, c.type, c.status, c.step, c.registrationNumber ?? null, c.withdrawalId ?? null,
  c.orderId ?? null, c.amount ?? null, c.txnTime ?? null, c.utr ?? null, c.confidence, json(c.missing),
  c.escalation, json(c.facts),
];

class PgCases implements CaseRepo {
  constructor(private db: Queryable) {}
  async create(c: NewCase) {
    const full = {
      status: 'open' as const,
      step: 'start',
      confidence: 0,
      missing: [],
      escalation: 'none' as const,
      facts: emptyFacts(),
      ...c,
    };
    const { rows } = await this.db.query(
      `INSERT INTO cases (id, ${CASE_COLS}, version, created_at, updated_at, last_activity_at)
       VALUES ($1, $2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16, 1, now(), now(), now())
       RETURNING *`,
      [randomUUID(), ...caseParams(full)],
    );
    return toCase(rows[0]);
  }
  async get(caseId: string) {
    const { rows } = await this.db.query(`SELECT * FROM cases WHERE id = $1`, [caseId]);
    return rows[0] ? toCase(rows[0]) : undefined;
  }
  async listActive(userId: string) {
    const { rows } = await this.db.query(
      `SELECT * FROM cases WHERE user_id = $1 AND status IN (${ACTIVE_STATUSES.map((_, i) => `$${i + 2}`).join(',')})
       ORDER BY last_activity_at DESC`,
      [userId, ...ACTIVE_STATUSES],
    );
    return rows.map(toCase);
  }
  async listByUser(userId: string) {
    const { rows } = await this.db.query(`SELECT * FROM cases WHERE user_id = $1 ORDER BY created_at DESC`, [userId]);
    return rows.map(toCase);
  }
  async save(c: CaseRecord) {
    const { rows } = await this.db.query(
      `UPDATE cases SET
         type = $3, status = $4, step = $5, registration_number = $6, withdrawal_id = $7, order_id = $8,
         amount = $9, txn_time = $10, utr = $11, confidence = $12, missing = $13, escalation = $14, facts = $15,
         last_activity_at = $16, version = version + 1, updated_at = now()
       WHERE id = $1 AND version = $2
       RETURNING *`,
      [
        c.id, c.version, c.type, c.status, c.step, c.registrationNumber ?? null, c.withdrawalId ?? null,
        c.orderId ?? null, c.amount ?? null, c.txnTime ?? null, c.utr ?? null, c.confidence, json(c.missing),
        c.escalation, json(c.facts), c.lastActivityAt,
      ],
    );
    if (!rows[0]) throw new ConflictError(`Case ${c.id} was modified concurrently`);
    return toCase(rows[0]);
  }
  async listIdle(before: Date) {
    const { rows } = await this.db.query(
      `SELECT * FROM cases WHERE status <> 'closed' AND last_activity_at < $1`,
      [before],
    );
    return rows.map(toCase);
  }
  async listExportFailed() {
    const { rows } = await this.db.query(`SELECT * FROM cases WHERE status <> 'closed' AND facts->'export'->>'status' IN ('failed', 'forwarding')`);
    return rows.map(toCase);
  }
  async listExported() {
    const { rows } = await this.db.query(`SELECT * FROM cases WHERE status <> 'closed' AND facts->'export'->>'status' IN ('verified', 'confirmed')`);
    return rows.map(toCase);
  }
}

class PgEvidence implements EvidenceRepo {
  constructor(private db: Queryable) {}
  async insert(e: NewEvidence) {
    const { rows } = await this.db.query(
      `INSERT INTO evidence (id, user_id, chat_id, case_id, message_id, media_kind, file_ref, file_unique_id,
         mime_type, file_name, sha256, category, category_confidence, status, transcript, extracted, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16, now()) RETURNING *`,
      [
        randomUUID(), e.userId, e.chatId, e.caseId ?? null, e.messageId, e.mediaKind, e.fileRef,
        e.fileUniqueId ?? null, e.mimeType ?? null, e.fileName ?? null, e.sha256 ?? null, e.category,
        e.categoryConfidence, e.status, e.transcript ?? null, extractedOf(e),
      ],
    );
    return toEvidence(rows[0]);
  }
  async update(e: EvidenceItem) {
    await this.db.query(
      `UPDATE evidence SET case_id = $2, sha256 = $3, category = $4, category_confidence = $5, status = $6,
         transcript = $7, extracted = $8 WHERE id = $1`,
      [e.id, e.caseId ?? null, e.sha256 ?? null, e.category, e.categoryConfidence, e.status, e.transcript ?? null, extractedOf(e)],
    );
  }
  async get(evId: string) {
    const { rows } = await this.db.query(`SELECT * FROM evidence WHERE id = $1`, [evId]);
    return rows[0] ? toEvidence(rows[0]) : undefined;
  }
  async findByFile(userId: string, fileUniqueId: string) {
    const { rows } = await this.db.query(
      `SELECT * FROM evidence WHERE user_id = $1 AND file_unique_id = $2 ORDER BY created_at DESC LIMIT 1`,
      [userId, fileUniqueId],
    );
    return rows[0] ? toEvidence(rows[0]) : undefined;
  }
  async findBySha(userId: string, sha: string) {
    const { rows } = await this.db.query(
      `SELECT * FROM evidence WHERE user_id = $1 AND sha256 = $2 ORDER BY created_at DESC LIMIT 1`,
      [userId, sha],
    );
    return rows[0] ? toEvidence(rows[0]) : undefined;
  }
  async listByMessage(chatId: string, messageId: number) {
    const { rows } = await this.db.query(
      `SELECT * FROM evidence WHERE chat_id = $1 AND message_id = $2 ORDER BY created_at`,
      [chatId, messageId],
    );
    return rows.map(toEvidence);
  }
  async listByIds(requested: string[]) {
    const ids = requested.filter((i) => UUID_RE.test(i));
    if (!ids.length) return [];
    const { rows } = await this.db.query(
      `SELECT * FROM evidence WHERE id IN (${ids.map((_, i) => `$${i + 1}`).join(',')})`,
      ids,
    );
    const byId = new Map(rows.map((r) => [r.id as string, toEvidence(r)]));
    return ids.map((i) => byId.get(i)).filter((e): e is EvidenceItem => !!e);
  }
}

const TICKET_COLS: Record<string, [string, (v: any) => unknown]> = {
  reason: ['reason', id],
  summary: ['summary', json],
  status: ['status', id],
  attempts: ['attempts', id],
  supportChatId: ['support_chat_id', id],
  supportMessageId: ['support_message_id', id],
  lastError: ['last_error', id],
  userNotified: ['user_notified', id],
  deliveredAt: ['delivered_at', id],
  userId: ['user_id', id],
  chatId: ['chat_id', id],
};

class PgTickets implements TicketRepo {
  constructor(private db: Queryable) {}
  async createIfAbsent(t: Pick<TicketRecord, 'caseId' | 'userId' | 'chatId' | 'reason' | 'summary'>) {
    const newId = randomUUID();
    const { rows } = await this.db.query(
      `INSERT INTO tickets (id, case_id, open_case_id, user_id, chat_id, reason, summary, status, attempts, user_notified, created_at)
       VALUES ($1, $2, $2, $3, $4, $5, $6, 'created', 0, false, now())
       ON CONFLICT (open_case_id) DO NOTHING
       RETURNING *`,
      [newId, t.caseId, t.userId, t.chatId, t.reason, json(t.summary)],
    );
    if (rows[0]?.id === newId) return { ticket: toTicket(rows[0]), created: true };
    const existing = await this.findOpenByCase(t.caseId);
    if (!existing) throw new Error(`Ticket insert conflicted but no open ticket for case ${t.caseId}`);
    return { ticket: existing, created: false };
  }
  async update(ticketId: string, patch: Partial<Omit<TicketRecord, 'id' | 'caseId' | 'createdAt'>>) {
    const { sets, params } = setClause(patch, TICKET_COLS, 2);
    if (patch.status === 'closed') sets.push('open_case_id = NULL');
    const { rows } = sets.length
      ? await this.db.query(`UPDATE tickets SET ${sets.join(', ')} WHERE id = $1 RETURNING *`, [ticketId, ...params])
      : await this.db.query(`SELECT * FROM tickets WHERE id = $1`, [ticketId]);
    if (!rows[0]) throw new Error(`Ticket ${ticketId} not found`);
    return toTicket(rows[0]);
  }
  async get(ticketId: string) {
    const { rows } = await this.db.query(`SELECT * FROM tickets WHERE id = $1`, [ticketId]);
    return rows[0] ? toTicket(rows[0]) : undefined;
  }
  async findOpenByCase(caseId: string) {
    const { rows } = await this.db.query(`SELECT * FROM tickets WHERE open_case_id = $1`, [caseId]);
    return rows[0] ? toTicket(rows[0]) : undefined;
  }
  async listUndelivered(maxAttempts: number) {
    const { rows } = await this.db.query(
      `SELECT * FROM tickets WHERE status IN ('created', 'failed') AND attempts < $1 ORDER BY created_at`,
      [maxAttempts],
    );
    return rows.map(toTicket);
  }
  async findBySupportMessage(supportChatId: string, supportMessageId: number) {
    const { rows } = await this.db.query(
      `SELECT * FROM tickets WHERE support_chat_id = $1 AND support_message_id = $2`,
      [supportChatId, supportMessageId],
    );
    return rows[0] ? toTicket(rows[0]) : undefined;
  }
}

class PgOutbox implements OutboxRepo {
  constructor(private db: Queryable) {}
  async enqueue(e: Pick<OutboxEntry, 'key' | 'chatId' | 'text' | 'meta'> & Partial<Pick<OutboxEntry, 'userId' | 'replyToMessageId'>>) {
    const newId = randomUUID();
    const { rows } = await this.db.query(
      `INSERT INTO outbox (id, key, chat_id, user_id, text, reply_to_message_id, meta, status, attempts, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,'pending',0, now())
       ON CONFLICT (key) DO NOTHING RETURNING *`,
      [newId, e.key, e.chatId, e.userId ?? null, e.text, e.replyToMessageId ?? null, json(e.meta)],
    );
    if (rows[0]?.id === newId) return { entry: toOutbox(rows[0]), created: true };
    const existing = await this.getByKey(e.key);
    if (!existing) throw new Error(`Outbox conflict without row for ${e.key}`);
    return { entry: existing, created: false };
  }
  async markSent(entryId: string, telegramMessageId: number) {
    await this.db.query(
      `UPDATE outbox SET status = 'sent', telegram_message_id = $2, sent_at = now(), attempts = attempts + 1 WHERE id = $1`,
      [entryId, telegramMessageId],
    );
  }
  async markFailed(entryId: string, error: string) {
    await this.db.query(
      `UPDATE outbox SET status = 'failed', last_error = $2, attempts = attempts + 1 WHERE id = $1`,
      [entryId, error.slice(0, 1000)],
    );
  }
  async listPending(maxAttempts: number) {
    const { rows } = await this.db.query(
      `SELECT * FROM outbox WHERE status <> 'sent' AND attempts < $1 ORDER BY created_at`,
      [maxAttempts],
    );
    return rows.map(toOutbox);
  }
  async getByKey(key: string) {
    const { rows } = await this.db.query(`SELECT * FROM outbox WHERE key = $1`, [key]);
    return rows[0] ? toOutbox(rows[0]) : undefined;
  }
}

export class PostgresStore implements Store {
  readonly kind = 'postgres' as const;
  readonly users: UserRepo;
  readonly messages: MessageRepo;
  readonly turns: TurnRepo;
  readonly cases: CaseRepo;
  readonly evidence: EvidenceRepo;
  readonly tickets: TicketRepo;
  readonly outbox: OutboxRepo;

  constructor(readonly pool: PoolLike) {
    this.users = new PgUsers(pool);
    this.messages = new PgMessages(pool);
    this.turns = new PgTurns(pool);
    this.cases = new PgCases(pool);
    this.evidence = new PgEvidence(pool);
    this.tickets = new PgTickets(pool);
    this.outbox = new PgOutbox(pool);
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
