import { beforeEach, describe, expect, it } from 'vitest';
import { EvidenceService, sniffKind } from '../../src/evidence/service.js';
import { inspectPdf } from '../../src/evidence/pdf.js';
import { finaliseImageAnalysis } from '../../src/evidence/vision.js';
import { NoFrameExtractor, type FrameExtractor } from '../../src/evidence/video.js';
import type { MediaRef } from '../../src/domain/messages.js';
import { DEFAULT_PATTERNS } from '../../src/nlu/entities.js';
import { silentLogger } from '../../src/observability/logger.js';
import { MemoryStore } from '../../src/storage/memory.js';
import { analysisOf, FakeVision, SCREENSHOTS } from '../helpers/fakeVision.js';
import { buildPdf } from '../helpers/pdfFactory.js';

const STATEMENT_LINES = [
  'HDFC Bank Ltd', 'Statement of Account', 'Account Holder Name: RAHUL KUMAR', 'Account No : 50100123456789',
  'IFSC : HDFC0001234', 'Statement From : 01/09/2026 To : 10/09/2026', 'Date Narration Chq/Ref Withdrawal Deposit Closing Balance',
  '02/09/2026 UPI-FANTASY ADDA 612345678901 500.00 1,200.00', '05/09/2026 IMPS-523456789012-FANTASYADDA 1,450.00 2,650.00',
  '07/09/2026 ATM WDL 1,000.00 1,650.00', 'Opening Balance 1,700.00 Closing Balance 1,650.00',
];

describe('PDF password detection', () => {
  it('opens unprotected PDFs without a password', async () => {
    const r = await inspectPdf(buildPdf(STATEMENT_LINES));
    expect(r.status).toBe('ok');
    if (r.status === 'ok') expect(r.lines).toContain('Account No : 50100123456789');
  });
  it('detects protection, rejects wrong passwords, accepts the right one', async () => {
    const pdf = buildPdf(STATEMENT_LINES, { userPassword: 'YENU1304' });
    expect((await inspectPdf(pdf)).status).toBe('needs_password');
    expect((await inspectPdf(pdf, 'WRONG1')).status).toBe('wrong_password');
    expect((await inspectPdf(pdf, 'YENU1304')).status).toBe('ok');
  });
  it('reports corrupt files as unreadable', async () => {
    expect(await inspectPdf(Buffer.from('%PDF-1.4 garbage'))).toMatchObject({ status: 'unreadable' });
  });
});

describe('vision post-processing (anti-hallucination)', () => {
  it('keeps values confirmed by the transcript and down-weights unconfirmed ones', () => {
    const f = finaliseImageAnalysis(SCREENSHOTS.payment500, DEFAULT_PATTERNS);
    expect(f.payment?.utr).toMatchObject({ value: '612345678901', origin: 'both' });
    expect(f.payment?.amount?.value).toBe(500);

    const hallucinated = finaliseImageAnalysis(
      analysisOf({ category: 'payment_screenshot', transcript: 'Payment Successful ₹500', payment: { ...SCREENSHOTS.payment500.payment, utr: '999988887777', utr_confidence: 0.9 } }),
    );
    expect(hallucinated.payment?.utr).toMatchObject({ origin: 'vision' });
    expect(hallucinated.payment!.utr!.confidence).toBeLessThanOrEqual(0.4);
    expect(hallucinated.notes).toContain('utr_not_confirmed_by_transcript');
  });

  it('preserves visual order of withdrawal rows and drops IDs not in the transcript', () => {
    const f = finaliseImageAnalysis(SCREENSHOTS.withdrawalHistory);
    expect(f.withdrawals?.map((w) => [w.position, w.withdrawalId])).toEqual([
      [1, 'WD-15436-64215'], [2, 'WD-15436-61002'], [3, 'WD-15436-59990'],
    ]);
    const bad = finaliseImageAnalysis(analysisOf({
      category: 'withdrawal_screenshot', transcript: 'WD-1111-22 ₹100 Success',
      withdrawals: [{ position: 1, withdrawal_id: 'WD-9999-99', amount: 100, status: 'Success', datetime: null, confidence: 0.9 }],
    }));
    // The model's ID isn't in the transcript → transcript parse wins.
    expect(bad.withdrawals?.[0]?.withdrawalId).toBe('WD-1111-22');
  });

  it('parses withdrawal rows from the transcript when the model returns none', () => {
    const f = finaliseImageAnalysis(analysisOf({ category: 'withdrawal_screenshot', transcript: 'WD-10001-111 ₹200 Success\nWD-10001-222 ₹300 Pending' }));
    expect(f.withdrawals?.map((w) => [w.position, w.withdrawalId, w.amount])).toEqual([[1, 'WD-10001-111', 200], [2, 'WD-10001-222', 300]]);
  });
});

describe('EvidenceService', () => {
  let store: MemoryStore;
  let vision: FakeVision;
  let files: Map<string, Buffer>;
  let downloads: number;
  let svc: EvidenceService;
  const owner = { userId: 'u1', chatId: 'c1', messageId: 1 };

  beforeEach(() => {
    store = new MemoryStore();
    vision = new FakeVision().set('pay', SCREENSHOTS.payment500).set('wd', SCREENSHOTS.withdrawalHistory).set('selfie', SCREENSHOTS.selfie);
    files = new Map([
      ['pay', Buffer.from('pay')], ['wd', Buffer.from('wd')], ['selfie', Buffer.from('selfie')],
      ['stmt', buildPdf(STATEMENT_LINES)], ['locked', buildPdf(STATEMENT_LINES, { userPassword: 'YENU1304' })],
      ['doc', buildPdf(['Rent agreement between parties', 'This agreement is made on 1st day of the month', 'Signed'])],
    ]);
    downloads = 0;
    svc = new EvidenceService({
      store, vision, frames: new NoFrameExtractor(), patterns: DEFAULT_PATTERNS, log: silentLogger,
      download: async (ref) => {
        downloads++;
        return files.get(ref.fileRef)!;
      },
    });
  });

  const photo = (key: string): MediaRef => ({ kind: 'photo', fileRef: key, fileUniqueId: `u-${key}`, mimeType: 'image/jpeg' });
  const pdf = (key: string, name = 'statement.pdf'): MediaRef => ({ kind: 'document', fileRef: key, fileUniqueId: `u-${key}`, mimeType: 'application/pdf', fileName: name });

  it('classifies screenshots', async () => {
    expect((await svc.ingest(photo('pay'), owner)).evidence).toMatchObject({ category: 'payment_screenshot', status: 'processed' });
    expect((await svc.ingest(photo('wd'), { ...owner, messageId: 2 })).evidence.withdrawals).toHaveLength(3);
    expect((await svc.ingest(photo('selfie'), { ...owner, messageId: 3 })).evidence.category).toBe('unrelated');
  });

  it('never re-processes the same file', async () => {
    const a = await svc.ingest(photo('pay'), owner);
    const b = await svc.ingest(photo('pay'), { ...owner, messageId: 9 });
    expect(b.duplicate).toBe(true);
    expect(b.evidence.id).toBe(a.evidence.id);
    expect(vision.calls).toHaveLength(1);
    // Same bytes under a different Telegram file id (forwarded copy) is caught by the hash.
    const c = await svc.ingest({ ...photo('pay'), fileUniqueId: 'other' }, { ...owner, messageId: 10 });
    expect(c.duplicate).toBe(true);
    expect(vision.calls).toHaveLength(1);
  });

  it('parses an unprotected statement PDF without asking for a password', async () => {
    const { evidence } = await svc.ingest(pdf('stmt'), owner);
    expect(evidence).toMatchObject({ category: 'bank_statement', status: 'processed' });
    expect(evidence.statement?.accountNumbers).toContain('50100123456789');
    expect(evidence.statement?.ifsc).toBe('HDFC0001234');
  });

  it('accepts a PDF without statement cues as the bank statement (any PDF counts)', async () => {
    const { evidence } = await svc.ingest(pdf('doc', 'agreement.pdf'), owner);
    expect(evidence).toMatchObject({ category: 'bank_statement', status: 'processed', notes: ['no_statement_cues'] });
  });

  it('a PDF sent with a strange extension and mime type (".uu" wallet statement) is still read as a PDF', async () => {
    files.set('uu', buildPdf(['ACCOUNT DETAILS', 'Transaction statement for 2026-09-13 to 2026-09-13', '13/09/2026 Paid to Fantasy Adda 208.82']));
    const ref: MediaRef = { kind: 'document', fileRef: 'uu', fileUniqueId: 'u-uu', mimeType: 'application/octet-stream', fileName: 'MobiKwik Txn Statement 13_Sept_2026-13_Sept_2026.uu' };
    const { evidence } = await svc.ingest(ref, owner);
    expect(evidence).toMatchObject({ category: 'bank_statement', status: 'processed' });
    expect(evidence.transcript).toMatch(/Transaction statement/);
  });

  it('a file whose bytes are nothing recognisable stays unsupported', async () => {
    files.set('bin', Buffer.from('just some text, not a pdf'));
    const ref: MediaRef = { kind: 'document', fileRef: 'bin', fileUniqueId: 'u-bin', mimeType: 'application/octet-stream', fileName: 'notes.uu' };
    const { evidence } = await svc.ingest(ref, owner);
    expect(evidence).toMatchObject({ status: 'unsupported', notes: ['unsupported_file_type'] });
  });

  it('sniffKind reads magic bytes', () => {
    expect(sniffKind(Buffer.from('%PDF-1.4\n'))).toBe('pdf');
    expect(sniffKind(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0]))).toBe('image');
    expect(sniffKind(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0]))).toBe('image');
    expect(sniffKind(Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from('ftypmp42')]))).toBe('video');
    expect(sniffKind(Buffer.from('hello'))).toBeUndefined();
  });

  it('holds protected PDFs until a correct password unlocks them', async () => {
    const { evidence } = await svc.ingest(pdf('locked'), owner);
    expect(evidence.status).toBe('needs_password');
    const bad = await svc.unlockPdf(evidence, ['nope1', 'nope2'], async () => files.get('locked')!);
    expect(bad).toMatchObject({ ok: false, tried: 2 });
    const good = await svc.unlockPdf(evidence, ['YENU1304'], async () => files.get('locked')!);
    expect(good.ok).toBe(true);
    const updated = await store.evidence.get(evidence.id);
    expect(updated).toMatchObject({ status: 'processed', category: 'bank_statement' });
    expect(JSON.stringify(updated)).not.toContain('YENU1304');
    expect(downloads).toBe(1); // bytes were kept in memory while waiting
  });

  it('marks voice notes / stickers without downloading', async () => {
    const v = await svc.ingest({ kind: 'voice', fileRef: 'x', fileUniqueId: 'v1' }, owner);
    expect(v.evidence.status).toBe('unsupported');
    const s = await svc.ingest({ kind: 'sticker', fileRef: 'y', fileUniqueId: 's1' }, owner);
    expect(s.evidence.category).toBe('unrelated');
    expect(downloads).toBe(0);
  });

  it('degrades gracefully when video analysis is unavailable, and merges frames when it is', async () => {
    files.set('vid', Buffer.from('video-bytes'));
    const video: MediaRef = { kind: 'video', fileRef: 'vid', fileUniqueId: 'u-vid', mimeType: 'video/mp4', durationSec: 8 };
    expect((await svc.ingest(video, owner)).evidence.status).toBe('unsupported');

    const frames: FrameExtractor = { available: async () => true, extract: async () => [Buffer.from('wd'), Buffer.from('selfie'), Buffer.from('wd')] };
    const svc2 = new EvidenceService({ store, vision, frames, patterns: DEFAULT_PATTERNS, log: silentLogger, download: async () => Buffer.from('video-2') });
    const r = await svc2.ingest({ ...video, fileUniqueId: 'u-vid2' }, owner);
    expect(r.evidence.category).toBe('withdrawal_recording');
    expect(r.evidence.withdrawals?.[0]?.withdrawalId).toBe('WD-15436-64215');
  });
});
