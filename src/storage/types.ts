import type { MediaRef } from '../domain/messages.js';

// ── Users ──────────────────────────────────────────────────────────────────

export interface UserRecord {
  id: string;
  chatId: string;
  username?: string;
  firstName?: string;
  languageCode?: string;
  /** Language of the customer's own messages, as last detected (the solved note is written in it). */
  preferredLanguage?: 'hinglish' | 'english' | 'hindi';
  /** A human wrote in this chat from the account: theirs until this time. */
  humanTakeoverUntil?: Date;
  /** When the chat's history was checked once for an existing human conversation. */
  conversationChecked?: Date;
  /** When the agent last answered this customer's greeting (one greeting per conversation). */
  greetedAt?: Date;
  /** Mobile numbers this customer typed in the chat (the export bot's fallback when a confirmation has no User ID). */
  mobileNumbers?: string[];
  createdAt: Date;
  updatedAt: Date;
}

export interface UserRepo {
  upsert(u: Pick<UserRecord, 'id' | 'chatId'> & Partial<UserRecord>): Promise<UserRecord>;
  get(id: string): Promise<UserRecord | undefined>;
  setPreferredLanguage(userId: string, lang: UserRecord['preferredLanguage']): Promise<void>;
  setHumanTakeover(userId: string, until: Date | undefined): Promise<void>;
  setConversationChecked(userId: string, at: Date): Promise<void>;
  setGreetedAt(userId: string, at: Date): Promise<void>;
  /** Remember that this customer typed this mobile number. Idempotent. */
  addMobileNumber(userId: string, number: string, at: Date): Promise<void>;
  /** Every customer who typed this exact number. */
  findByMobileNumber(number: string): Promise<UserRecord[]>;
}

// ── Evidence requests (one per case) ───────────────────────────────────────

export type EvidenceRequestStatus = 'sending' | 'sent' | 'solved';

export interface EvidenceRequest {
  id: string;
  chatId: string;
  userId: string;
  issueType: 'deposit' | 'withdrawal';
  language: 'hinglish' | 'english' | 'hindi';
  status: EvidenceRequestStatus;
  /** Telegram id of the request message, once sent. */
  telegramMessageId?: number;
  createdAt: Date;
  solvedAt?: Date;
}

export interface EvidenceRequestRepo {
  create(r: Pick<EvidenceRequest, 'chatId' | 'userId' | 'issueType' | 'language'> & { createdAt?: Date }): Promise<EvidenceRequest>;
  markSent(id: string, telegramMessageId: number): Promise<void>;
  /** The request never went out: forget it so the next message may ask again. */
  remove(id: string): Promise<void>;
  /** Requests in a chat that are not solved, newest first. */
  listOpen(chatId: string): Promise<EvidenceRequest[]>;
  /** Close every open request of a user (the team confirmed the payment). Returns how many. */
  markSolved(userId: string, at: Date): Promise<number>;
}

// ── Messages ───────────────────────────────────────────────────────────────

/** Small metadata kept on a stored message. */
export interface MessageMeta {
  /** Inbound: text contained a secret that was scrubbed. */
  scrubbed?: boolean;
  /** Outbound: the text carries Telegram HTML markup. */
  html?: boolean;
  /** Inbound: what happened to it (e.g. `requested`, `already_requested`, `bot_off`). Outbound: what it is (`evidence_request`, `payment_confirmed`, `greeting`). */
  kind?: string;
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
  requests: EvidenceRequestRepo;
  healthy(): Promise<boolean>;
  close(): Promise<void>;
}
