import type { CaseRecord, CaseType, HandoffReason } from '../domain/cases.js';
import type { UserMemory } from '../domain/memory.js';
import type { EvidenceItem, WithdrawalCandidate } from '../domain/evidence.js';
import type { MediaRef } from '../domain/messages.js';

export class ConflictError extends Error {
  constructor(message = 'Concurrent modification') {
    super(message);
    this.name = 'ConflictError';
  }
}

// ── Users ──────────────────────────────────────────────────────────────────

export interface UserRecord {
  id: string;
  chatId: string;
  username?: string;
  firstName?: string;
  languageCode?: string;
  preferredLanguage?: 'hinglish' | 'english' | 'hindi';
  humanTakeoverUntil?: Date;
  /** The case the conversation is currently about (undefined during side topics). */
  focusCaseId?: string;
  /** What we remember about this customer across cases (see domain/memory.ts). */
  memory: UserMemory;
  createdAt: Date;
  updatedAt: Date;
}

export interface UserRepo {
  upsert(u: Pick<UserRecord, 'id' | 'chatId'> & Partial<UserRecord>): Promise<UserRecord>;
  get(id: string): Promise<UserRecord | undefined>;
  setHumanTakeover(userId: string, until: Date | undefined): Promise<void>;
  setPreferredLanguage(userId: string, lang: UserRecord['preferredLanguage']): Promise<void>;
  setFocus(userId: string, caseId: string | undefined): Promise<void>;
  saveMemory(userId: string, memory: UserMemory): Promise<void>;
}

// ── Messages ───────────────────────────────────────────────────────────────

/** Metadata kept on messages so that later swipe-replies can be resolved. */
export interface MessageMeta {
  kind?: 'reply' | 'followup' | 'relay' | 'human' | 'payment_confirmed';
  caseId?: string;
  caseType?: CaseType;
  acts?: string[];
  /** Withdrawal rows listed/shown in this message (for "upar wala" replies). */
  candidates?: WithdrawalCandidate[];
  /** Identifiers this message was about. */
  refs?: { withdrawalId?: string; orderId?: string; amount?: number };
  /** Inbound: text contained a secret that was scrubbed. */
  scrubbed?: boolean;
  /** Outbound: the text carries Telegram HTML markup. */
  html?: boolean;
}

export interface StoredMessage {
  id: string;
  chatId: string;
  userId: string;
  telegramMessageId: number;
  direction: 'in' | 'out';
  text?: string;
  caption?: string;
  media: MediaRef[];
  replyToMessageId?: number;
  caseId?: string;
  turnId?: string;
  meta: MessageMeta;
  /** Inbound only: set once a turn has fully handled the message. */
  processedAt?: Date;
  createdAt: Date;
}

export type NewStoredMessage = Omit<StoredMessage, 'id' | 'createdAt' | 'processedAt'> & { createdAt?: Date };

export interface MessageRepo {
  /** Idempotent: returns inserted=false when (chat, telegram id, direction) already exists. */
  insert(m: NewStoredMessage): Promise<{ inserted: boolean; message: StoredMessage }>;
  find(chatId: string, telegramMessageId: number): Promise<StoredMessage | undefined>;
  /** Most recent messages, returned in chronological order. */
  recent(chatId: string, limit: number): Promise<StoredMessage[]>;
  update(id: string, patch: Partial<Pick<StoredMessage, 'caseId' | 'turnId' | 'meta' | 'text' | 'caption'>>): Promise<void>;
  markProcessed(chatId: string, telegramMessageIds: number[], patch: { turnId: string; caseId?: string }): Promise<void>;
  /** Inbound messages received after `since` that no turn has completed (crash recovery). */
  listUnprocessed(since: Date): Promise<StoredMessage[]>;
  /** Inbound messages of a chat by Telegram id, in id order (what a turn job works on). */
  listInbound(chatId: string, telegramMessageIds: number[]): Promise<StoredMessage[]>;
}

// ── Turns ──────────────────────────────────────────────────────────────────

export type TurnStatus = 'processing' | 'responded' | 'no_reply' | 'failed' | 'skipped';

export interface TurnRecord {
  id: string;
  chatId: string;
  userId: string;
  messageIds: number[];
  status: TurnStatus;
  caseId?: string;
  trace: Record<string, unknown>;
  error?: string;
  createdAt: Date;
  completedAt?: Date;
}

export interface TurnRepo {
  create(t: Pick<TurnRecord, 'chatId' | 'userId' | 'messageIds'>): Promise<TurnRecord>;
  update(id: string, patch: Partial<Omit<TurnRecord, 'id' | 'createdAt'>>): Promise<void>;
  get(id: string): Promise<TurnRecord | undefined>;
  listStuck(olderThan: Date, newerThan: Date): Promise<TurnRecord[]>;
}

// ── Cases ──────────────────────────────────────────────────────────────────

export type NewCase = Pick<CaseRecord, 'userId' | 'chatId' | 'type'> & Partial<CaseRecord>;

export interface CaseRepo {
  create(c: NewCase): Promise<CaseRecord>;
  get(id: string): Promise<CaseRecord | undefined>;
  /** open/paused/resolved/escalated cases for a user, most recently active first. */
  listActive(userId: string): Promise<CaseRecord[]>;
  /** Every case of a user including closed ones, newest first (support tooling, tests). */
  listByUser(userId: string): Promise<CaseRecord[]>;
  /** Optimistic save; throws ConflictError when version changed underneath. Returns the new version. */
  save(c: CaseRecord): Promise<CaseRecord>;
  listIdle(before: Date): Promise<CaseRecord[]>;
  /** Open cases whose last export attempt failed (for the retry worker). */
  listExportFailed(): Promise<CaseRecord[]>;
  /** Open cases the export bot has (to match its confirmations). */
  listExported(): Promise<CaseRecord[]>;
}

// ── Evidence ───────────────────────────────────────────────────────────────

export type NewEvidence = Omit<EvidenceItem, 'id' | 'createdAt'>;

export interface EvidenceRepo {
  insert(e: NewEvidence): Promise<EvidenceItem>;
  update(e: EvidenceItem): Promise<void>;
  get(id: string): Promise<EvidenceItem | undefined>;
  findByFile(userId: string, fileUniqueId: string): Promise<EvidenceItem | undefined>;
  findBySha(userId: string, sha256: string): Promise<EvidenceItem | undefined>;
  listByMessage(chatId: string, messageId: number): Promise<EvidenceItem[]>;
  listByIds(ids: string[]): Promise<EvidenceItem[]>;
}

// ── Tickets ────────────────────────────────────────────────────────────────

export type TicketStatus = 'created' | 'delivered' | 'failed' | 'closed';

export interface TicketRecord {
  id: string;
  caseId: string;
  userId: string;
  chatId: string;
  reason: HandoffReason;
  summary: Record<string, unknown>;
  status: TicketStatus;
  attempts: number;
  supportChatId?: string;
  supportMessageId?: number;
  lastError?: string;
  userNotified: boolean;
  createdAt: Date;
  deliveredAt?: Date;
}

export interface TicketRepo {
  /** One non-closed ticket per case. Returns the existing one if present. */
  createIfAbsent(t: Pick<TicketRecord, 'caseId' | 'userId' | 'chatId' | 'reason' | 'summary'>): Promise<{ ticket: TicketRecord; created: boolean }>;
  update(id: string, patch: Partial<Omit<TicketRecord, 'id' | 'caseId' | 'createdAt'>>): Promise<TicketRecord>;
  get(id: string): Promise<TicketRecord | undefined>;
  findOpenByCase(caseId: string): Promise<TicketRecord | undefined>;
  listUndelivered(maxAttempts: number): Promise<TicketRecord[]>;
  findBySupportMessage(supportChatId: string, supportMessageId: number): Promise<TicketRecord | undefined>;
}

// ── Outbox ─────────────────────────────────────────────────────────────────

/** `cancelled`: the agent was switched OFF before the send; the message is never sent later. */
export type OutboxStatus = 'pending' | 'sent' | 'failed' | 'cancelled';

export interface OutboxEntry {
  id: string;
  /** Idempotency key, e.g. `turn:<id>`, `ticket-confirm:<id>`. */
  key: string;
  chatId: string;
  userId?: string;
  text: string;
  replyToMessageId?: number;
  meta: MessageMeta;
  status: OutboxStatus;
  attempts: number;
  telegramMessageId?: number;
  lastError?: string;
  createdAt: Date;
  sentAt?: Date;
}

export interface OutboxRepo {
  enqueue(e: Pick<OutboxEntry, 'key' | 'chatId' | 'text' | 'meta'> & Partial<Pick<OutboxEntry, 'userId' | 'replyToMessageId'>>): Promise<{ entry: OutboxEntry; created: boolean }>;
  markSent(id: string, telegramMessageId: number): Promise<void>;
  markFailed(id: string, error: string): Promise<void>;
  /** Withdraw a message for good (the agent was switched OFF): it is not pending, not failed, never retried. */
  markCancelled(id: string, reason: string): Promise<void>;
  /** Withdraw every unsent message at once (/botoff): returns how many. */
  cancelPending(reason: string): Promise<number>;
  /** Unsent messages still worth a retry (never sent or cancelled ones). */
  listPending(maxAttempts: number): Promise<OutboxEntry[]>;
  getByKey(key: string): Promise<OutboxEntry | undefined>;
}

// ── Aggregate ──────────────────────────────────────────────────────────────

/** Small durable key/value settings shared by every process (e.g. the bot's ON/OFF switch). */
export interface SettingsRepo {
  get(key: string): Promise<unknown | undefined>;
  set(key: string, value: unknown): Promise<void>;
}

export interface Store {
  readonly kind: 'memory' | 'postgres';
  settings: SettingsRepo;
  users: UserRepo;
  messages: MessageRepo;
  turns: TurnRepo;
  cases: CaseRepo;
  evidence: EvidenceRepo;
  tickets: TicketRepo;
  outbox: OutboxRepo;
  healthy(): Promise<boolean>;
  close(): Promise<void>;
}
