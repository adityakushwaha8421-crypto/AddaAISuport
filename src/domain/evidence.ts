import type { MediaKind } from './messages.js';

export type EvidenceCategory =
  // images
  | 'payment_screenshot'
  | 'withdrawal_screenshot'
  | 'technical_screenshot'
  | 'account_screenshot'
  | 'match_screenshot' // scorecard, fantasy points, lineup, player list, leaderboard, match status
  | 'bank_statement' // PDF or image of a statement
  // documents
  | 'other_document'
  // videos
  | 'payment_recording'
  | 'withdrawal_recording'
  | 'technical_recording'
  // anything
  | 'unrelated'
  | 'unknown';

export type EvidenceStatus =
  | 'processed'
  | 'needs_password' // encrypted PDF waiting for a password
  | 'unreadable' // corrupt / scanned-without-text / blank
  | 'unsupported' // media type we cannot analyse (voice, sticker, no ffmpeg for video)
  | 'failed'; // transient processing error

export type FieldOrigin = 'vision' | 'transcript' | 'both' | 'pdf_text';

/** An extracted value plus how much we trust it. Never invented: absent means "not visible". */
export interface Field<T> {
  value: T;
  confidence: number; // 0..1
  origin: FieldOrigin;
}

export type PaymentStatusSeen = 'success' | 'pending' | 'failed' | 'unknown';

export interface PaymentFacts {
  amount?: Field<number>;
  /** ISO date (YYYY-MM-DD) */
  date?: Field<string>;
  /** 24h HH:mm */
  time?: Field<string>;
  utr?: Field<string>;
  transactionId?: Field<string>;
  referenceNumber?: Field<string>;
  status?: Field<PaymentStatusSeen>;
  payer?: Field<string>;
  payee?: Field<string>;
  app?: string;
}

/** One row of a withdrawal-history screenshot. position 1 = top-most. */
export interface WithdrawalCandidate {
  position: number;
  withdrawalId?: string;
  amount?: number;
  status?: string;
  datetime?: string;
  confidence: number;
}

export interface StatementFacts {
  readable: boolean;
  accountNumbers: string[];
  ifsc?: string;
  bankName?: string;
  holderName?: string;
  /** ISO dates when detectable */
  periodFrom?: string;
  periodTo?: string;
  /** Transaction-looking lines (capped) kept for later targeted verification. */
  lines: string[];
}

export interface EvidenceItem {
  id: string;
  userId: string;
  chatId: string;
  caseId?: string;
  /** Telegram message id that carried the media. */
  messageId: number;
  mediaKind: MediaKind;
  fileRef: string;
  fileUniqueId?: string;
  mimeType?: string;
  fileName?: string;
  sha256?: string;
  category: EvidenceCategory;
  categoryConfidence: number;
  status: EvidenceStatus;
  /** Visible text transcript (OCR / PDF text excerpt), top-to-bottom order. Secrets scrubbed. */
  transcript?: string;
  payment?: PaymentFacts;
  withdrawals?: WithdrawalCandidate[];
  statement?: StatementFacts;
  technical?: { errorText?: string; screen?: string };
  notes: string[];
  createdAt: Date;
}

export const isPaymentEvidence = (e: EvidenceItem): boolean =>
  e.status === 'processed' && (e.category === 'payment_screenshot' || e.category === 'payment_recording');

export const isWithdrawalEvidence = (e: EvidenceItem): boolean =>
  e.status === 'processed' && (e.category === 'withdrawal_screenshot' || e.category === 'withdrawal_recording');

const VIDEO_KINDS = new Set(['video', 'video_note', 'animation']);
const isVideo = (e: EvidenceItem): boolean => VIDEO_KINDS.has(e.mediaKind) || /^video\//.test(e.mimeType ?? '');

/** A real video we could not analyse (no ffmpeg / vision): still evidence for the human team. */
export const isUnanalysedVideo = (e: EvidenceItem): boolean =>
  isVideo(e) && e.mediaKind !== 'animation' && (e.status === 'unsupported' || e.status === 'unreadable') && !e.notes.includes('too_large');
