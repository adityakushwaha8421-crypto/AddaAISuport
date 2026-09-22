import type { Logger } from 'pino';
import type { EvidenceCategory, EvidenceItem, WithdrawalCandidate } from '../domain/evidence.js';
import type { MediaRef } from '../domain/messages.js';
import { LlmUnavailableError } from '../llm/client.js';
import type { EntityPatterns } from '../nlu/entities.js';
import type { Metrics } from '../observability/metrics.js';
import { sha256 } from '../security/crypto.js';
import { scrubber } from '../security/scrubber.js';
import type { NewEvidence, Store } from '../storage/types.js';
import { MediaTooLargeError } from '../telegram/transport.js';
import { inspectPdf } from './pdf.js';
import { isLikelyStatement, parseStatement, statementScore } from './statement.js';
import { finaliseImageAnalysis, type ImageEvidenceFields, type VisionAnalyzer, type VisionHint } from './vision.js';
import type { FrameExtractor } from './video.js';

export interface EvidenceOwner {
  userId: string;
  chatId: string;
  messageId: number;
  caseId?: string;
}

export interface IngestResult {
  evidence: EvidenceItem;
  /** Same file was already processed earlier (re-sent / forwarded again). */
  duplicate: boolean;
}

export interface UnlockResult {
  evidenceId: string;
  ok: boolean;
  /** true when the PDF opened but was not a readable statement */
  unreadable?: boolean;
  tried: number;
}

export interface EvidenceDeps {
  store: Store;
  download: (ref: MediaRef) => Promise<Buffer>;
  vision: VisionAnalyzer;
  frames: FrameExtractor;
  patterns: EntityPatterns;
  log: Logger;
  metrics?: Metrics;
}

const VIDEO_CATEGORY: Partial<Record<EvidenceCategory, EvidenceCategory>> = {
  payment_screenshot: 'payment_recording',
  withdrawal_screenshot: 'withdrawal_recording',
  technical_screenshot: 'technical_recording',
};

const SUPPORTED_IMAGE = /^image\/(jpeg|jpg|png|webp|gif)$/i;
const PENDING_PDF_TTL_MS = 2 * 60 * 60 * 1000;

function kindOf(ref: MediaRef): 'image' | 'pdf' | 'video' | 'audio' | 'sticker' | 'other' {
  const mime = (ref.mimeType ?? '').toLowerCase();
  const name = (ref.fileName ?? '').toLowerCase();
  if (ref.kind === 'photo') return 'image';
  if (ref.kind === 'video' || ref.kind === 'video_note') return 'video';
  if (ref.kind === 'voice' || ref.kind === 'audio') return 'audio';
  if (ref.kind === 'sticker' || ref.kind === 'animation') return 'sticker';
  if (mime === 'application/pdf' || name.endsWith('.pdf')) return 'pdf';
  if (mime.startsWith('image/') || /\.(jpe?g|png|webp|gif|heic)$/.test(name)) return 'image';
  if (mime.startsWith('video/') || /\.(mp4|mov|mkv|webm|3gp)$/.test(name)) return 'video';
  return 'other';
}

/** What the bytes say the file is, whatever its name or mime type (".uu" statements, images sent as files). */
export function sniffKind(data: Buffer): 'image' | 'pdf' | 'video' | undefined {
  const head = data.subarray(0, 16);
  if (head.subarray(0, 5).toString('latin1') === '%PDF-') return 'pdf';
  if (head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) return 'image'; // JPEG
  if (head.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image'; // PNG
  if (head.subarray(0, 4).toString('latin1') === 'RIFF' && head.subarray(8, 12).toString('latin1') === 'WEBP') return 'image';
  if (head.subarray(0, 4).toString('latin1') === 'GIF8') return 'image';
  if (head.subarray(4, 8).toString('latin1') === 'ftyp') return 'video'; // MP4 / MOV / 3GP
  if (head.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3]))) return 'video'; // WebM / MKV
  return undefined;
}

/**
 * Universal evidence pipeline: download → hash → dedupe → classify → extract → persist.
 * Never assumes an attachment is relevant just because it was uploaded — classification decides.
 */
export class EvidenceService {
  /** Encrypted PDFs waiting for a password; bytes stay in memory only, never on disk. */
  private readonly pendingPdfBytes = new Map<string, { data: Buffer; expires: number }>();

  constructor(private readonly deps: EvidenceDeps) {}

  async ingest(ref: MediaRef, owner: EvidenceOwner, hint?: VisionHint): Promise<IngestResult> {
    const { store } = this.deps;
    if (ref.fileUniqueId) {
      const existing = await store.evidence.findByFile(owner.userId, ref.fileUniqueId);
      if (existing) return { evidence: existing, duplicate: true };
    }

    const base: NewEvidence = {
      userId: owner.userId,
      chatId: owner.chatId,
      caseId: owner.caseId,
      messageId: owner.messageId,
      mediaKind: ref.kind,
      fileRef: ref.fileRef,
      fileUniqueId: ref.fileUniqueId,
      mimeType: ref.mimeType,
      fileName: ref.fileName,
      category: 'unknown',
      categoryConfidence: 0,
      status: 'processed',
      notes: [],
    };

    let kind = kindOf(ref);
    if (kind === 'audio') return this.save({ ...base, status: 'unsupported', notes: ['voice_or_audio'] });
    if (kind === 'sticker') return this.save({ ...base, category: 'unrelated', categoryConfidence: 0.9, notes: ['sticker_or_gif'] });
    // A video we cannot analyse is kept for the team as the original message: no point pulling
    // tens of megabytes from Telegram first (that alone can take minutes).
    if (kind === 'video' && (!(await this.deps.frames.available()) || !this.deps.vision.available)) {
      return this.save({ ...base, status: 'unsupported', notes: ['video_analysis_unavailable'] });
    }

    const started = Date.now();
    let data: Buffer;
    try {
      data = await this.deps.download(ref);
    } catch (err) {
      const tooLarge = err instanceof MediaTooLargeError;
      this.deps.log.warn({ err, kind }, 'media download failed');
      return this.save({ ...base, status: tooLarge ? 'unsupported' : 'failed', notes: [tooLarge ? 'too_large' : 'download_failed'] });
    }
    // A file's bytes beat its name: a ".uu" that is a PDF is a PDF.
    if (ref.kind === 'document') {
      const sniffed = sniffKind(data);
      if (sniffed && sniffed !== kind) {
        this.deps.log.info({ declared: kind, actual: sniffed, fileName: ref.fileName }, 'file type taken from content');
        kind = sniffed;
      }
    }
    if (kind === 'other') return this.save({ ...base, category: 'other_document', categoryConfidence: 0.5, status: 'unsupported', notes: ['unsupported_file_type'] });
    const hash = sha256(data);
    const sameBytes = await store.evidence.findBySha(owner.userId, hash);
    if (sameBytes) return { evidence: sameBytes, duplicate: true };
    base.sha256 = hash;
    this.deps.log.info({ kind, bytes: data.length, downloadMs: Date.now() - started }, 'evidence downloaded');

    try {
      if (kind === 'pdf') return await this.processPdf(base, data);
      if (kind === 'image') return await this.processImage(base, data, ref.mimeType ?? 'image/jpeg', hint);
      return await this.processVideo(base, data, ref.durationSec, hint);
    } catch (err) {
      const unavailable = err instanceof LlmUnavailableError;
      this.deps.log.error({ err, kind }, 'evidence processing failed');
      return this.save({ ...base, status: unavailable ? 'unsupported' : 'failed', notes: [unavailable ? 'analysis_unavailable' : 'processing_error'] });
    }
  }

  private async save(e: NewEvidence): Promise<IngestResult> {
    const evidence = await this.deps.store.evidence.insert(e);
    this.deps.metrics?.evidence.inc({ category: evidence.category, status: evidence.status });
    return { evidence, duplicate: false };
  }

  private async processPdf(base: NewEvidence, data: Buffer): Promise<IngestResult> {
    const insp = await inspectPdf(data);
    if (insp.status === 'needs_password' || insp.status === 'wrong_password') {
      const looksLikeStatement = /statement|stmt|account|a\/c|acc|bank|passbook|e-?stat/i.test(base.fileName ?? '');
      const res = await this.save({
        ...base,
        category: 'bank_statement',
        categoryConfidence: looksLikeStatement ? 0.5 : 0.3,
        status: 'needs_password',
        notes: ['password_protected'],
      });
      this.pendingPdfBytes.set(res.evidence.id, { data, expires: Date.now() + PENDING_PDF_TTL_MS });
      return res;
    }
    // Every PDF a customer sends is taken as their bank statement: a scanned one is kept for the
    // team (nothing can be read from it), a text one is parsed as far as it goes.
    if (insp.status === 'unreadable') {
      return this.save({ ...base, category: 'bank_statement', categoryConfidence: 0.4, status: 'unreadable', notes: [`pdf_${insp.reason}`] });
    }
    return this.save({ ...base, ...this.classifyPdfText(insp.lines) });
  }

  private classifyPdfText(lines: string[]): Pick<NewEvidence, 'category' | 'categoryConfidence' | 'statement' | 'transcript' | 'notes' | 'status'> {
    if (isLikelyStatement(lines)) {
      const score = statementScore(lines);
      return {
        category: 'bank_statement',
        categoryConfidence: Math.min(0.95, 0.5 + score * 0.05),
        statement: parseStatement(lines),
        transcript: scrubber.scrub(lines.slice(0, 25).join('\n')),
        status: 'processed',
        notes: [],
      };
    }
    // Not recognisably a statement, but accepted as the customer's statement all the same.
    this.deps.log.info({ score: statementScore(lines), lines: lines.length }, 'PDF accepted as bank statement without statement cues');
    return {
      category: 'bank_statement',
      categoryConfidence: 0.4,
      statement: parseStatement(lines),
      transcript: scrubber.scrub(lines.slice(0, 25).join('\n')),
      status: 'processed',
      notes: ['no_statement_cues'],
    };
  }

  /** Try password candidates against a pending encrypted PDF. Passwords are never stored. */
  async unlockPdf(evidence: EvidenceItem, candidates: string[], refetch: (ref: MediaRef) => Promise<Buffer>): Promise<UnlockResult> {
    let data = this.pendingPdfBytes.get(evidence.id)?.data;
    if (!data) {
      data = await refetch({ kind: evidence.mediaKind, fileRef: evidence.fileRef, fileUniqueId: evidence.fileUniqueId, mimeType: evidence.mimeType });
    }
    let tried = 0;
    for (const pw of candidates.slice(0, 5)) {
      tried++;
      const insp = await inspectPdf(data, pw);
      if (insp.status === 'wrong_password' || insp.status === 'needs_password') continue;
      this.pendingPdfBytes.delete(evidence.id);
      if (insp.status === 'unreadable') {
        await this.deps.store.evidence.update({ ...evidence, status: 'unreadable', notes: [...evidence.notes, `pdf_${insp.reason}`] });
        return { evidenceId: evidence.id, ok: true, unreadable: true, tried };
      }
      const fields = this.classifyPdfText(insp.lines);
      await this.deps.store.evidence.update({ ...evidence, ...fields, notes: [...evidence.notes, 'unlocked', ...fields.notes] });
      this.deps.metrics?.evidence.inc({ category: fields.category, status: 'unlocked' });
      return { evidenceId: evidence.id, ok: true, tried };
    }
    return { evidenceId: evidence.id, ok: false, tried };
  }

  private async processImage(base: NewEvidence, data: Buffer, mimeType: string, hint?: VisionHint): Promise<IngestResult> {
    if (!SUPPORTED_IMAGE.test(mimeType)) {
      return this.save({ ...base, status: 'unsupported', notes: ['unsupported_image_format'] });
    }
    if (!this.deps.vision.available) return this.save({ ...base, status: 'unsupported', notes: ['analysis_unavailable'] });
    const analysis = finaliseImageAnalysis(await this.deps.vision.analyze(data, mimeType, hint), this.deps.patterns);
    return this.save({ ...base, ...this.imageFields(analysis) });
  }

  private imageFields(a: ImageEvidenceFields): Partial<NewEvidence> {
    return {
      category: a.category,
      categoryConfidence: a.categoryConfidence,
      transcript: a.transcript,
      payment: a.payment,
      withdrawals: a.withdrawals,
      statement: a.statement,
      technical: a.technical,
      notes: a.notes,
      status: a.category === 'unknown' && a.categoryConfidence < 0.3 ? 'unreadable' : 'processed',
    };
  }

  private async processVideo(base: NewEvidence, data: Buffer, durationSec?: number, hint?: VisionHint): Promise<IngestResult> {
    if (!(await this.deps.frames.available()) || !this.deps.vision.available) {
      return this.save({ ...base, status: 'unsupported', notes: ['video_analysis_unavailable'] });
    }
    const frames = await this.deps.frames.extract(data, durationSec, 4);
    if (!frames.length) return this.save({ ...base, status: 'unreadable', notes: ['no_frames'] });
    const analyses: ImageEvidenceFields[] = [];
    for (const f of frames) analyses.push(finaliseImageAnalysis(await this.deps.vision.analyze(f, 'image/jpeg', hint), this.deps.patterns));
    return this.save({ ...base, ...mergeFrameAnalyses(analyses) });
  }
}

/** Combine per-frame analyses: majority category, best-confidence fields, richest withdrawal list. */
function mergeFrameAnalyses(frames: ImageEvidenceFields[]): Partial<NewEvidence> {
  const weight = new Map<EvidenceCategory, number>();
  for (const f of frames) weight.set(f.category, (weight.get(f.category) ?? 0) + f.categoryConfidence);
  const [cat, w] = [...weight.entries()].filter(([c]) => c !== 'unknown').sort((a, b) => b[1] - a[1])[0] ?? ['unknown', 0];
  const category = VIDEO_CATEGORY[cat] ?? cat;
  const relevant = frames.filter((f) => f.category === cat);
  const payment = relevant.map((f) => f.payment).filter(Boolean).reduce<NonNullable<ImageEvidenceFields['payment']>>((acc, p) => {
    for (const [k, v] of Object.entries(p!)) {
      const cur = acc[k as keyof typeof acc] as { confidence?: number } | undefined;
      if (v && (typeof v !== 'object' || !cur || (v as { confidence: number }).confidence > (cur.confidence ?? 0))) (acc as Record<string, unknown>)[k] = v;
    }
    return acc;
  }, {});
  const withdrawals: WithdrawalCandidate[] | undefined = relevant
    .map((f) => f.withdrawals ?? [])
    .sort((a, b) => b.filter((r) => r.withdrawalId).length - a.filter((r) => r.withdrawalId).length || b.length - a.length)[0];
  return {
    category,
    categoryConfidence: relevant.length ? w / relevant.length : 0,
    transcript: relevant.map((f) => f.transcript).join('\n---\n').slice(0, 8000),
    payment: Object.keys(payment).length ? payment : undefined,
    withdrawals: withdrawals?.length ? withdrawals : undefined,
    notes: [`frames:${frames.length}`],
    status: category === 'unknown' ? 'unreadable' : 'processed',
  };
}
