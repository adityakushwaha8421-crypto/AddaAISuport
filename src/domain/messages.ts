/** Transport-agnostic message model. The Telegram account transport maps MTProto messages to this. */

export type MediaKind = 'photo' | 'document' | 'video' | 'animation' | 'voice' | 'audio' | 'sticker' | 'video_note';

export interface MediaRef {
  kind: MediaKind;
  /** Opaque, transport-specific handle usable with Transport.downloadMedia(). */
  fileRef: string;
  /** Stable across re-sends of the same file (Telegram file_unique_id / document id). */
  fileUniqueId?: string;
  mimeType?: string;
  fileName?: string;
  fileSize?: number;
  width?: number;
  height?: number;
  durationSec?: number;
}

/** Snapshot of the message a user swiped/replied to, as reported by the transport. */
export interface ReplySnapshot {
  messageId: number;
  text?: string;
  caption?: string;
  media: MediaRef[];
  /** True when the replied-to message was sent by us (bot / our user account). */
  fromSelf: boolean;
}

export interface SenderInfo {
  username?: string;
  firstName?: string;
  lastName?: string;
  languageCode?: string;
}

export interface InboundMessage {
  chatId: string;
  userId: string;
  messageId: number;
  date: Date;
  text?: string;
  caption?: string;
  media: MediaRef[];
  mediaGroupId?: string;
  replyTo?: ReplySnapshot;
  sender: SenderInfo;
}

/** Text of a message as the user sees it (text or media caption). */
export function messageBody(m: { text?: string; caption?: string }): string {
  return [m.text, m.caption].filter((s): s is string => !!s && s.trim().length > 0).join('\n').trim();
}
