import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { EvidenceRequest, EvidenceRequestRepo, MessageRepo, NewStoredMessage, SettingsRepo, Store, StoredMessage, UserRecord, UserRepo } from './types.js';

/** Deep copy so callers can't mutate stored state without saving (mirrors DB semantics). */
const clone = <T>(v: T): T => structuredClone(v);

class MemoryUsers implements UserRepo {
  readonly rows = new Map<string, UserRecord>();
  async upsert(u: Pick<UserRecord, 'id' | 'chatId'> & Partial<UserRecord>): Promise<UserRecord> {
    const now = new Date();
    const prev = this.rows.get(u.id);
    const defined = Object.fromEntries(Object.entries(u).filter(([, v]) => v !== undefined));
    const next: UserRecord = { createdAt: now, ...prev, ...defined, updatedAt: now } as UserRecord;
    this.rows.set(u.id, clone(next));
    return clone(next);
  }
  async get(id: string) {
    const r = this.rows.get(id);
    return r ? clone(r) : undefined;
  }
  async setPreferredLanguage(userId: string, lang: UserRecord['preferredLanguage']) {
    const r = this.rows.get(userId);
    if (r) r.preferredLanguage = lang;
  }
  async setHumanTakeover(userId: string, until: Date | undefined) {
    const r = this.rows.get(userId);
    if (r) r.humanTakeoverUntil = until;
  }
}

/**
 * The ledger of evidence requests. "Ask once" must survive a process restart even without a
 * database, so with a `file` every change is written to disk and read back at start-up; a request
 * caught mid-send by a crash is dropped on load (it may not have gone out — the next message asks).
 */
class MemoryRequests implements EvidenceRequestRepo {
  readonly rows: EvidenceRequest[] = [];
  constructor(private readonly file?: string) {
    if (!file) return;
    try {
      const raw = JSON.parse(readFileSync(file, 'utf8')) as Array<Omit<EvidenceRequest, 'createdAt' | 'solvedAt'> & { createdAt: string; solvedAt?: string }>;
      for (const r of raw) if (r.status !== 'sending') this.rows.push({ ...r, createdAt: new Date(r.createdAt), solvedAt: r.solvedAt ? new Date(r.solvedAt) : undefined });
    } catch {
      // no file yet, or unreadable: start empty
    }
  }
  private save() {
    if (!this.file) return;
    mkdirSync(dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.rows));
    renameSync(tmp, this.file);
  }
  async create(r: Pick<EvidenceRequest, 'chatId' | 'userId' | 'issueType' | 'language'> & { createdAt?: Date }) {
    const { createdAt, ...rest } = r;
    const row: EvidenceRequest = { ...rest, id: randomUUID(), status: 'sending', createdAt: createdAt ?? new Date() };
    this.rows.push(row);
    this.save();
    return clone(row);
  }
  async markSent(id: string, telegramMessageId: number) {
    const r = this.rows.find((x) => x.id === id);
    if (r) Object.assign(r, { status: 'sent', telegramMessageId });
    this.save();
  }
  async remove(id: string) {
    const i = this.rows.findIndex((x) => x.id === id);
    if (i >= 0) this.rows.splice(i, 1);
    this.save();
  }
  async listOpen(chatId: string) {
    return clone(this.rows.filter((r) => r.chatId === chatId && r.status !== 'solved').sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime()));
  }
  async markSolved(userId: string, at: Date) {
    let n = 0;
    for (const r of this.rows) if (r.userId === userId && r.status !== 'solved') Object.assign(r, { status: 'solved', solvedAt: at }), n++;
    if (n) this.save();
    return n;
  }
}

class MemoryMessages implements MessageRepo {
  readonly rows: StoredMessage[] = [];
  async insert(m: NewStoredMessage) {
    const existing = this.rows.find((r) => r.chatId === m.chatId && r.telegramMessageId === m.telegramMessageId && r.direction === m.direction);
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
  async markProcessed(chatId: string, ids: number[]) {
    const now = new Date();
    for (const r of this.rows) if (r.chatId === chatId && r.direction === 'in' && ids.includes(r.telegramMessageId)) r.processedAt = now;
  }
}

class MemorySettings implements SettingsRepo {
  readonly rows = new Map<string, unknown>();
  async get(key: string) {
    return this.rows.get(key);
  }
  async set(key: string, value: unknown) {
    this.rows.set(key, structuredClone(value));
  }
}

export class MemoryStore implements Store {
  readonly kind = 'memory' as const;
  settings = new MemorySettings();
  users = new MemoryUsers();
  messages = new MemoryMessages();
  requests: MemoryRequests;
  /** `requestsFile`: keep the evidence-request ledger on disk so "ask once" survives a restart. */
  constructor(opts: { requestsFile?: string } = {}) {
    this.requests = new MemoryRequests(opts.requestsFile);
  }
  async healthy() {
    return true;
  }
  async close() {}
}
