import type { InboundMessage, MediaRef } from '../domain/messages.js';

export interface SendOptions {
  replyToMessageId?: number;
  /** Text carries Telegram HTML markup (produced only by response/format.ts). */
  html?: boolean;
}

/** A message posted in the support group (used to relay human replies back to customers). */
export interface SupportGroupMessage {
  chatId: string;
  messageId: number;
  fromUserId: string;
  fromName?: string;
  text?: string;
  replyToMessageId?: number;
}

/** The account itself forwarded something into the export bot's chat, and it was not the bot's own export: a human did. */
export interface ExportForwardEvent {
  /** Id of the forward in the export bot's chat. */
  messageId: number;
  /** Original sender, when Telegram shows it (a customer may hide their account on forwards). */
  fromUserId?: string;
  fromName?: string;
  kind: 'text' | 'photo' | 'video' | 'document' | 'other';
  text?: string;
  mimeType?: string;
  fileName?: string;
  /** Same value the original customer message carried (photo / document id survives a forward). */
  fileUniqueId?: string;
}

export interface TransportHandlers {
  onMessage(msg: InboundMessage): Promise<void>;
  onSupportMessage?(msg: SupportGroupMessage): Promise<void>;
  /** A human sent a message from our own account → the chat is theirs until they hand it back. */
  onOwnOutgoing?(ev: { chatId: string; messageId: number; text?: string }): Promise<void>;
  /** The export bot wrote to us (e.g. a payment confirmation). */
  onExportMessage?(msg: { messageId: number; text?: string; replyToMessageId?: number }): Promise<void>;
  /** A human forwarded a customer's message to the export bot from the account. */
  onExportForward?(ev: ExportForwardEvent): Promise<void>;
}

export class MediaTooLargeError extends Error {}

/**
 * Everything the application needs from Telegram. Implemented by the GramJS account transport;
 * swapping the account/session mechanism only touches the implementation.
 */
export interface Transport {
  start(handlers: TransportHandlers): Promise<void>;
  stop(): Promise<void>;
  sendText(chatId: string, text: string, opts?: SendOptions): Promise<{ messageId: number }>;
  /** Forward an existing message (e.g. customer's screenshot) to the support group. */
  forwardMessage(fromChatId: string, messageId: number, toChatId: string): Promise<{ messageId: number } | undefined>;
  downloadMedia(ref: MediaRef): Promise<Buffer>;
  /** Which of these message ids exist in the chat, as Telegram reports it (delivery verification). */
  messagesExist(chatId: string, messageIds: number[]): Promise<number[]>;
  sendTyping(chatId: string): Promise<void>;
  /** Delete one of our own messages for both sides (a human's "/ai" command, not meant for the customer). */
  deleteMessage?(chatId: string, messageId: number): Promise<void>;
  healthy(): boolean;
}

/**
 * Telegram chat folders ("dialog filters") on the account. Used to organise chats for the human
 * team; it never sends anything to the customer.
 */
export interface ChatFolderApi {
  /** Chat ids in the folder with this title ([] when no such folder exists). */
  folderChats(title: string): Promise<string[]>;
  /** Add a chat, creating the folder when it does not exist yet. Idempotent. */
  addChatToFolder(title: string, chatId: string): Promise<void>;
  /** Remove a chat. Telegram rejects an empty folder, so removing the last chat deletes it. */
  removeChatFromFolder(title: string, chatId: string): Promise<void>;
}

/** Telegram read state of customer chats on the account. */
export interface ReadStateApi {
  /** Has a human on this account already read this incoming message (opened the chat)? */
  seenByHuman(chatId: string, messageId: number): Promise<boolean>;
}

/** Telegram hard limit for a single text message. */
export const TELEGRAM_TEXT_LIMIT = 4096;
