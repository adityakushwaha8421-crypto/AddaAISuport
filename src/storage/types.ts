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
  createdAt: Date;
  updatedAt: Date;
}

export interface UserRepo {
  upsert(u: Pick<UserRecord, 'id' | 'chatId'> & Partial<UserRecord>): Promise<UserRecord>;
  get(id: string): Promise<UserRecord | undefined>;
}

// ── Messages ───────────────────────────────────────────────────────────────

/** Small metadata kept on a stored message. */
export interface MessageMeta {
  /** Inbound: text contained a secret that was scrubbed. */
  scrubbed?: boolean;
  /** Outbound: the text carries Telegram HTML markup. */
  html?: boolean;
  /** Why an inbound message was left alone (e.g. `bot_off`). */
  ignored?: string;
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
  meta: MessageMeta;
  /** Inbound only: set once the message has been looked at (today: on arrival — nothing answers it). */
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
  markProcessed(chatId: string, telegramMessageIds: number[]): Promise<void>;
}

// ── Settings ───────────────────────────────────────────────────────────────

/** Small durable key/value settings shared by every process (e.g. the bot's ON/OFF switch). */
export interface SettingsRepo {
  get(key: string): Promise<unknown | undefined>;
  set(key: string, value: unknown): Promise<void>;
}

// ── Aggregate ──────────────────────────────────────────────────────────────

export interface Store {
  readonly kind: 'memory' | 'postgres';
  settings: SettingsRepo;
  users: UserRepo;
  messages: MessageRepo;
  healthy(): Promise<boolean>;
  close(): Promise<void>;
}
