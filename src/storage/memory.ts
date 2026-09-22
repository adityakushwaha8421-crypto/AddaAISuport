import { randomUUID } from 'node:crypto';
import { ACTIVE_STATUSES, emptyFacts, type CaseRecord } from '../domain/cases.js';
import { emptyMemory, type UserMemory } from '../domain/memory.js';
import type { EvidenceItem } from '../domain/evidence.js';
import {
  ConflictError,
  type CaseRepo,
  type EvidenceRepo,
  type MessageRepo,
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

/** Deep copy so callers can't mutate stored state without saving (mirrors DB semantics). */
const clone = <T>(v: T): T => structuredClone(v);

class MemoryUsers implements UserRepo {
  readonly rows = new Map<string, UserRecord>();
  async upsert(u: Pick<UserRecord, 'id' | 'chatId'> & Partial<UserRecord>): Promise<UserRecord> {
    const now = new Date();
    const prev = this.rows.get(u.id);
    const defined = Object.fromEntries(Object.entries(u).filter(([, v]) => v !== undefined));
    const next: UserRecord = { createdAt: now, memory: emptyMemory(), ...prev, ...defined, updatedAt: now } as UserRecord;
    this.rows.set(u.id, clone(next));
    return clone(next);
  }
  async get(id: string) {
    const r = this.rows.get(id);
    return r ? clone(r) : undefined;
  }
  async setHumanTakeover(userId: string, until: Date | undefined) {
    const r = this.rows.get(userId);
    if (r) r.humanTakeoverUntil = until;
  }
  async setPreferredLanguage(userId: string, lang: UserRecord['preferredLanguage']) {
    const r = this.rows.get(userId);
    if (r) r.preferredLanguage = lang;
  }
  async setFocus(userId: string, caseId: string | undefined) {
    const r = this.rows.get(userId);
    if (r) r.focusCaseId = caseId;
  }
  async saveMemory(userId: string, memory: UserMemory) {
    const r = this.rows.get(userId);
    if (r) r.memory = clone(memory);
  }
}

class MemoryMessages implements MessageRepo {
  readonly rows: StoredMessage[] = [];
  async insert(m: Omit<StoredMessage, 'id' | 'createdAt'> & { createdAt?: Date }) {
    const existing = this.rows.find(
      (r) => r.chatId === m.chatId && r.telegramMessageId === m.telegramMessageId && r.direction === m.direction,
    );
    if (existing) return { inserted: false, message: clone(existing) };
    const row: StoredMessage = { ...clone(m), id: randomUUID(), createdAt: m.createdAt ?? new Date() };
    this.rows.push(row);
    return { inserted: true, message: clone(row) };
  }
  async find(chatId: string, telegramMessageId: number) {
    const r = this.rows.find((x) => x.chatId === chatId && x.telegramMessageId === telegramMessageId);
    return r ? clone(r) : undefined;
  }
  async recent(chatId: string, limit: number) {
    return clone(
      this.rows
        .filter((r) => r.chatId === chatId)
        .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime() || a.telegramMessageId - b.telegramMessageId)
        .slice(-limit),
    );
  }
  async update(id: string, patch: Partial<Pick<StoredMessage, 'caseId' | 'turnId' | 'meta' | 'text' | 'caption'>>) {
    const r = this.rows.find((x) => x.id === id);
    if (r) Object.assign(r, clone(patch));
  }
  async markProcessed(chatId: string, ids: number[], patch: { turnId: string; caseId?: string }) {
    const now = new Date();
    for (const r of this.rows) {
      if (r.chatId === chatId && r.direction === 'in' && ids.includes(r.telegramMessageId)) {
        Object.assign(r, { processedAt: now, turnId: patch.turnId, ...(patch.caseId ? { caseId: patch.caseId } : {}) });
      }
    }
  }
  async listUnprocessed(since: Date) {
    return clone(
      this.rows
        .filter((r) => r.direction === 'in' && !r.processedAt && r.createdAt > since)
        .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime()),
    );
  }
  async listInbound(chatId: string, ids: number[]) {
    return clone(this.rows.filter((r) => r.chatId === chatId && r.direction === 'in' && ids.includes(r.telegramMessageId)).sort((a, b) => a.telegramMessageId - b.telegramMessageId));
  }
}

class MemoryTurns implements TurnRepo {
  readonly rows = new Map<string, TurnRecord>();
  async create(t: Pick<TurnRecord, 'chatId' | 'userId' | 'messageIds'>) {
    const row: TurnRecord = { ...clone(t), id: randomUUID(), status: 'processing', trace: {}, createdAt: new Date() };
    this.rows.set(row.id, row);
    return clone(row);
  }
  async update(id: string, patch: Partial<Omit<TurnRecord, 'id' | 'createdAt'>>) {
    const r = this.rows.get(id);
    if (r) Object.assign(r, clone(patch));
  }
  async get(id: string) {
    const r = this.rows.get(id);
    return r ? clone(r) : undefined;
  }
  async listStuck(olderThan: Date, newerThan: Date) {
    return clone(
      [...this.rows.values()].filter(
        (t) => t.status === 'processing' && t.createdAt < olderThan && t.createdAt > newerThan,
      ),
    );
  }
}

class MemoryCases implements CaseRepo {
  readonly rows = new Map<string, CaseRecord>();
  async create(c: Pick<CaseRecord, 'userId' | 'chatId' | 'type'> & Partial<CaseRecord>) {
    const now = new Date();
    const row: CaseRecord = {
      status: 'open',
      step: 'start',
      confidence: 0,
      missing: [],
      escalation: 'none',
      facts: emptyFacts(),
      ...clone(c),
      id: randomUUID(),
      version: 1,
      createdAt: now,
      updatedAt: now,
      lastActivityAt: now,
    };
    this.rows.set(row.id, row);
    return clone(row);
  }
  async get(id: string) {
    const r = this.rows.get(id);
    return r ? clone(r) : undefined;
  }
  async listActive(userId: string) {
    return clone(
      [...this.rows.values()]
        .filter((c) => c.userId === userId && ACTIVE_STATUSES.includes(c.status))
        .sort((a, b) => b.lastActivityAt.getTime() - a.lastActivityAt.getTime()),
    );
  }
  async listByUser(userId: string) {
    return clone([...this.rows.values()].filter((c) => c.userId === userId).sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime()));
  }
  async save(c: CaseRecord) {
    const cur = this.rows.get(c.id);
    if (!cur) throw new Error(`Case ${c.id} not found`);
    if (cur.version !== c.version) throw new ConflictError(`Case ${c.id} version ${c.version} != ${cur.version}`);
    const next: CaseRecord = { ...clone(c), version: c.version + 1, updatedAt: new Date() };
    this.rows.set(c.id, next);
    return clone(next);
  }
  async listIdle(before: Date) {
    return clone(
      [...this.rows.values()].filter((c) => c.status !== 'closed' && c.lastActivityAt < before),
    );
  }
  async listExportFailed() {
    return clone([...this.rows.values()].filter((c) => c.status !== 'closed' && (c.facts.export?.status === 'failed' || c.facts.export?.status === 'forwarding')));
  }
  async listExported() {
    return clone([...this.rows.values()].filter((c) => c.status !== 'closed' && (c.facts.export?.status === 'verified' || c.facts.export?.status === 'confirmed')));
  }
}

class MemoryEvidence implements EvidenceRepo {
  readonly rows = new Map<string, EvidenceItem>();
  async insert(e: Omit<EvidenceItem, 'id' | 'createdAt'>) {
    const row: EvidenceItem = { ...clone(e), id: randomUUID(), createdAt: new Date() };
    this.rows.set(row.id, row);
    return clone(row);
  }
  async update(e: EvidenceItem) {
    this.rows.set(e.id, clone(e));
  }
  async get(id: string) {
    const r = this.rows.get(id);
    return r ? clone(r) : undefined;
  }
  async findByFile(userId: string, fileUniqueId: string) {
    const r = [...this.rows.values()].find((e) => e.userId === userId && e.fileUniqueId === fileUniqueId);
    return r ? clone(r) : undefined;
  }
  async findBySha(userId: string, sha256: string) {
    const r = [...this.rows.values()].find((e) => e.userId === userId && e.sha256 === sha256);
    return r ? clone(r) : undefined;
  }
  async listByMessage(chatId: string, messageId: number) {
    return clone([...this.rows.values()].filter((e) => e.chatId === chatId && e.messageId === messageId));
  }
  async listByIds(ids: string[]) {
    return clone(ids.map((id) => this.rows.get(id)).filter((e): e is EvidenceItem => !!e));
  }
}

class MemoryTickets implements TicketRepo {
  readonly rows = new Map<string, TicketRecord>();
  async createIfAbsent(t: Pick<TicketRecord, 'caseId' | 'userId' | 'chatId' | 'reason' | 'summary'>) {
    const existing = [...this.rows.values()].find((r) => r.caseId === t.caseId && r.status !== 'closed');
    if (existing) return { ticket: clone(existing), created: false };
    const row: TicketRecord = {
      ...clone(t),
      id: randomUUID(),
      status: 'created',
      attempts: 0,
      userNotified: false,
      createdAt: new Date(),
    };
    this.rows.set(row.id, row);
    return { ticket: clone(row), created: true };
  }
  async update(id: string, patch: Partial<Omit<TicketRecord, 'id' | 'caseId' | 'createdAt'>>) {
    const r = this.rows.get(id);
    if (!r) throw new Error(`Ticket ${id} not found`);
    Object.assign(r, clone(patch));
    return clone(r);
  }
  async get(id: string) {
    const r = this.rows.get(id);
    return r ? clone(r) : undefined;
  }
  async findOpenByCase(caseId: string) {
    const r = [...this.rows.values()].find((x) => x.caseId === caseId && x.status !== 'closed');
    return r ? clone(r) : undefined;
  }
  async listUndelivered(maxAttempts: number) {
    return clone(
      [...this.rows.values()].filter((t) => (t.status === 'created' || t.status === 'failed') && t.attempts < maxAttempts),
    );
  }
  async findBySupportMessage(supportChatId: string, supportMessageId: number) {
    const r = [...this.rows.values()].find(
      (t) => t.supportChatId === supportChatId && t.supportMessageId === supportMessageId,
    );
    return r ? clone(r) : undefined;
  }
}

class MemoryOutbox implements OutboxRepo {
  readonly rows = new Map<string, OutboxEntry>();
  async enqueue(e: Pick<OutboxEntry, 'key' | 'chatId' | 'text' | 'meta'> & Partial<Pick<OutboxEntry, 'userId' | 'replyToMessageId'>>) {
    const existing = [...this.rows.values()].find((r) => r.key === e.key);
    if (existing) return { entry: clone(existing), created: false };
    const row: OutboxEntry = { ...clone(e), id: randomUUID(), status: 'pending', attempts: 0, createdAt: new Date() };
    this.rows.set(row.id, row);
    return { entry: clone(row), created: true };
  }
  async markSent(id: string, telegramMessageId: number) {
    const r = this.rows.get(id);
    if (r) Object.assign(r, { status: 'sent', telegramMessageId, sentAt: new Date(), attempts: r.attempts + 1 });
  }
  async markFailed(id: string, error: string) {
    const r = this.rows.get(id);
    if (r) Object.assign(r, { status: 'failed', lastError: error, attempts: r.attempts + 1 });
  }
  async listPending(maxAttempts: number) {
    return clone([...this.rows.values()].filter((r) => r.status !== 'sent' && r.attempts < maxAttempts));
  }
  async getByKey(key: string) {
    const r = [...this.rows.values()].find((x) => x.key === key);
    return r ? clone(r) : undefined;
  }
}

export class MemoryStore implements Store {
  readonly kind = 'memory' as const;
  users = new MemoryUsers();
  messages = new MemoryMessages();
  turns = new MemoryTurns();
  cases = new MemoryCases();
  evidence = new MemoryEvidence();
  tickets = new MemoryTickets();
  outbox = new MemoryOutbox();
  async healthy() {
    return true;
  }
  async close() {}
}
