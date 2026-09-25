import type { InboundMessage } from '../domain/messages.js';

export interface SendOptions {
  replyToMessageId?: number;
  /** Text carries Telegram HTML markup (always escaped by response/html.ts). */
  html?: boolean;
  /** What this message is (`evidence_request`, `payment_confirmed`): the guard lets allowed kinds through. */
  kind?: string;
}

/** A message posted in the support group. Received and logged; no handler acts on it today. */
export interface SupportGroupMessage {
  chatId: string;
  messageId: number;
  fromUserId: string;
  fromName?: string;
  text?: string;
  replyToMessageId?: number;
}

export interface TransportHandlers {
  onMessage(msg: InboundMessage): Promise<void>;
  onSupportMessage?(msg: SupportGroupMessage): Promise<void>;
  /** A human sent a message from our own account in a customer chat → the chat is theirs until they hand it back. */
  onOwnOutgoing?(ev: { chatId: string; messageId: number; text?: string }): Promise<void>;
  /** The account owner typed in Saved Messages (a chat with themselves): admin commands live there. */
  onAdminCommand?(ev: { chatId: string; messageId: number; fromUserId: string; text?: string }): Promise<void>;
  /** The export bot wrote to us (e.g. a payment confirmation). */
  onExportMessage?(msg: { messageId: number; text?: string; replyToMessageId?: number }): Promise<void>;
}

/**
 * Everything the application needs from Telegram. Implemented by the GramJS account transport;
 * swapping the account/session mechanism only touches the implementation.
 */
export interface Transport {
  start(handlers: TransportHandlers): Promise<void>;
  stop(): Promise<void>;
  sendText(chatId: string, text: string, opts?: SendOptions): Promise<{ messageId: number }>;
  /** Ids of the messages this account sent in the chat, among its most recent `limit` messages (is a human already talking to this customer?). */
  recentOutgoing?(chatId: string, limit: number): Promise<number[]>;
  /**
   * Take the chat out of every one of the account's chat folders with these titles that it is in.
   * Returns the titles it left. Telegram rejects an empty folder, so removing the last chat deletes it.
   */
  removeChatFromFolders?(chatId: string, titles: string[]): Promise<string[]>;
  healthy(): boolean;
}

/** Telegram read state of customer chats on the account. */
export interface ReadStateApi {
  /** Has a human on this account already read this incoming message (opened the chat)? */
  seenByHuman(chatId: string, messageId: number): Promise<boolean>;
}

/** Telegram hard limit for a single text message. */
export const TELEGRAM_TEXT_LIMIT = 4096;
