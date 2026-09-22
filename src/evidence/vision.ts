import { z } from 'zod';
import type { EvidenceCategory, Field, PaymentFacts, PaymentStatusSeen, StatementFacts, WithdrawalCandidate } from '../domain/evidence.js';
import type { LlmClient } from '../llm/client.js';
import { DEFAULT_PATTERNS, type EntityPatterns } from '../nlu/entities.js';
import { scrubber } from '../security/scrubber.js';
import { bankFromIfsc, canonicalBank } from './banks.js';
import { parsePaymentTranscript, parseWithdrawalRows, transcriptContains } from './transcript.js';

/** Raw output of an image-understanding model. Values are "as seen"; null when not visible. */
export interface VisionAnalysis {
  category: Exclude<EvidenceCategory, 'other_document' | 'payment_recording' | 'withdrawal_recording' | 'technical_recording'>;
  confidence: number;
  transcript: string;
  payment: {
    amount: number | null; amount_confidence: number;
    date: string | null; time: string | null; utr: string | null; utr_confidence: number;
    transaction_id: string | null; reference_number: string | null;
    status: 'success' | 'pending' | 'failed' | 'unknown' | null;
    payer: string | null; payee: string | null; app: string | null;
  };
  withdrawals: Array<{ position: number; withdrawal_id: string | null; amount: number | null; status: string | null; datetime: string | null; confidence: number }>;
  statement: { account_number: string | null; ifsc: string | null; bank_name: string | null; holder_name: string | null };
  technical: { error_text: string | null; screen: string | null };
}

export interface VisionHint {
  caseType?: string;
  expecting?: string;
}

export interface VisionAnalyzer {
  readonly available: boolean;
  analyze(image: Buffer, mimeType: string, hint?: VisionHint): Promise<VisionAnalysis>;
}

const n = (t: string) => ({ type: [t, 'null'] });
const CATS = ['payment_screenshot', 'withdrawal_screenshot', 'technical_screenshot', 'account_screenshot', 'bank_statement', 'match_screenshot', 'unrelated', 'unknown'] as const;

const VISION_SCHEMA = {
  name: 'image_evidence',
  schema: {
    type: 'object', additionalProperties: false,
    required: ['category', 'confidence', 'transcript', 'payment', 'withdrawals', 'statement', 'technical'],
    properties: {
      category: { type: 'string', enum: CATS },
      confidence: { type: 'number' },
      transcript: { type: 'string' },
      payment: {
        type: 'object', additionalProperties: false,
        required: ['amount', 'amount_confidence', 'date', 'time', 'utr', 'utr_confidence', 'transaction_id', 'reference_number', 'status', 'payer', 'payee', 'app'],
        properties: {
          amount: n('number'), amount_confidence: { type: 'number' }, date: n('string'), time: n('string'),
          utr: n('string'), utr_confidence: { type: 'number' }, transaction_id: n('string'), reference_number: n('string'),
          status: { type: ['string', 'null'], enum: ['success', 'pending', 'failed', 'unknown', null] },
          payer: n('string'), payee: n('string'), app: n('string'),
        },
      },
      withdrawals: {
        type: 'array',
        items: {
          type: 'object', additionalProperties: false,
          required: ['position', 'withdrawal_id', 'amount', 'status', 'datetime', 'confidence'],
          properties: {
            position: { type: 'integer' }, withdrawal_id: n('string'), amount: n('number'), status: n('string'),
            datetime: n('string'), confidence: { type: 'number' },
          },
        },
      },
      statement: {
        type: 'object', additionalProperties: false,
        required: ['account_number', 'ifsc', 'bank_name', 'holder_name'],
        properties: { account_number: n('string'), ifsc: n('string'), bank_name: n('string'), holder_name: n('string') },
      },
      technical: {
        type: 'object', additionalProperties: false, required: ['error_text', 'screen'],
        properties: { error_text: n('string'), screen: n('string') },
      },
    },
  },
};

const visionOutput = z.object({
  category: z.enum(CATS),
  confidence: z.number().min(0).max(1),
  transcript: z.string(),
  payment: z.object({
    amount: z.number().nullable(), amount_confidence: z.number(), date: z.string().nullable(), time: z.string().nullable(),
    utr: z.string().nullable(), utr_confidence: z.number(), transaction_id: z.string().nullable(), reference_number: z.string().nullable(),
    status: z.enum(['success', 'pending', 'failed', 'unknown']).nullable(), payer: z.string().nullable(), payee: z.string().nullable(), app: z.string().nullable(),
  }),
  withdrawals: z.array(z.object({
    position: z.number().int(), withdrawal_id: z.string().nullable(), amount: z.number().nullable(), status: z.string().nullable(),
    datetime: z.string().nullable(), confidence: z.number(),
  })),
  statement: z.object({ account_number: z.string().nullable(), ifsc: z.string().nullable(), bank_name: z.string().nullable(), holder_name: z.string().nullable() }),
  technical: z.object({ error_text: z.string().nullable(), screen: z.string().nullable() }),
});

const VISION_SYSTEM = `You analyse images sent to the customer support of Fantasy Adda (Indian fantasy-sports app). Be literal and conservative.

1. category:
   - payment_screenshot: a UPI/bank/wallet payment receipt (PhonePe, GPay, Paytm, bank app…) for money PAID (a deposit into the app).
   - withdrawal_screenshot: the app's withdrawal/redeem history or a withdrawal request/status screen.
   - technical_screenshot: an app error, crash or broken screen. account_screenshot: profile/KYC/login screens.
   - bank_statement: a photo/screenshot of a bank statement or passbook page.
   - match_screenshot: a match or contest screen — scorecard, fantasy points breakdown, lineup/playing XI, player list, leaderboard/rank, or match status (live, under review, abandoned, completed).
   - unrelated: anything else (selfies, memes, random chats). unknown: unreadable.
2. transcript: transcribe ALL visible text exactly, top to bottom, one visual line per line. Do not correct or complete numbers.
3. Fill fields ONLY with values clearly visible in the image, copied exactly. If a value is not clearly visible, use null. Never infer, guess or complete an ID, UTR, amount, date or account number. Dates as YYYY-MM-DD, times as HH:mm (24h).
4. withdrawals: every withdrawal row in VISUAL ORDER, position 1 = top-most row. Include rows even if the ID is not visible (withdrawal_id null).
5. confidence values are 0..1 and must reflect legibility.`;

export class LlmVisionAnalyzer implements VisionAnalyzer {
  constructor(private readonly llm: LlmClient) {}
  get available() {
    return this.llm.available;
  }
  async analyze(image: Buffer, mimeType: string, hint?: VisionHint): Promise<VisionAnalysis> {
    const context = hint?.caseType || hint?.expecting
      ? `Conversation context: the customer is discussing a ${hint.caseType ?? 'support'} issue${hint.expecting ? `; we asked for: ${hint.expecting}` : ''}. Classify by what the image actually shows, not by what we expected.`
      : 'No conversation context. Classify by what the image shows.';
    const raw = await this.llm.json<unknown>({
      purpose: 'vision',
      model: 'vision',
      system: VISION_SYSTEM,
      user: [
        { type: 'text', text: context },
        { type: 'image', mimeType, data: image, detail: 'high' },
      ],
      schema: VISION_SCHEMA,
      maxTokens: 3000,
    });
    return visionOutput.parse(raw) as VisionAnalysis;
  }
}

// ── Post-processing: cross-validate against the transcript ─────────────────

export interface ImageEvidenceFields {
  category: EvidenceCategory;
  categoryConfidence: number;
  transcript: string;
  payment?: PaymentFacts;
  withdrawals?: WithdrawalCandidate[];
  statement?: StatementFacts;
  technical?: { errorText?: string; screen?: string };
  notes: string[];
}

/**
 * A vision value is trusted only as far as the transcript supports it:
 *   seen in transcript  → origin "both", confidence ≥ 0.85
 *   vision only         → origin "vision", confidence ≤ 0.4 (possible hallucination)
 *   transcript parser only → origin "transcript"
 */
function reconcile<T extends string | number>(
  visionValue: T | null | undefined,
  visionConf: number,
  parsed: Field<T> | undefined,
  transcript: string,
): Field<T> | undefined {
  if (visionValue !== null && visionValue !== undefined && visionValue !== '') {
    if (transcriptContains(transcript, visionValue)) {
      return { value: visionValue, confidence: Math.min(0.98, Math.max(visionConf, 0.85)), origin: 'both' };
    }
    if (parsed) return parsed; // deterministic read of the transcript beats an unsupported vision value
    return { value: visionValue, confidence: Math.min(visionConf, 0.4), origin: 'vision' };
  }
  return parsed;
}

export function finaliseImageAnalysis(a: VisionAnalysis, patterns: EntityPatterns = DEFAULT_PATTERNS): ImageEvidenceFields {
  const transcript = scrubber.scrub(a.transcript).slice(0, 8000);
  const notes: string[] = [];
  const out: ImageEvidenceFields = { category: a.category, categoryConfidence: a.confidence, transcript, notes };

  if (a.category === 'payment_screenshot' || a.payment.amount !== null || a.payment.utr !== null) {
    const parsed = parsePaymentTranscript(transcript, patterns);
    const p = a.payment;
    const payment: PaymentFacts = {
      amount: reconcile(p.amount, p.amount_confidence, parsed.amount, transcript),
      utr: reconcile(p.utr?.replace(/\s/g, '') ?? null, p.utr_confidence, parsed.utr, transcript),
      date: p.date && /^\d{4}-\d{2}-\d{2}$/.test(p.date) ? { value: p.date, confidence: 0.8, origin: 'vision' } : parsed.date,
      time: p.time && /^\d{2}:\d{2}$/.test(p.time) ? { value: p.time, confidence: 0.75, origin: 'vision' } : parsed.time,
      transactionId: reconcile(p.transaction_id, 0.8, parsed.transactionId, transcript),
      referenceNumber: reconcile(p.reference_number, 0.8, undefined, transcript),
      status:
        p.status && p.status !== 'unknown'
          ? { value: p.status as PaymentStatusSeen, confidence: parsed.status?.value === p.status ? 0.9 : 0.7, origin: parsed.status?.value === p.status ? 'both' : 'vision' }
          : parsed.status,
      payer: p.payer ? { value: p.payer, confidence: 0.6, origin: 'vision' } : undefined,
      payee: p.payee ? { value: p.payee, confidence: 0.6, origin: 'vision' } : undefined,
      app: p.app ?? parsed.app,
    };
    for (const k of Object.keys(payment) as Array<keyof PaymentFacts>) if (payment[k] === undefined) delete payment[k];
    if (a.category === 'payment_screenshot') out.payment = payment;
    if (payment.utr?.origin === 'vision') notes.push('utr_not_confirmed_by_transcript');
  }

  if (a.category === 'withdrawal_screenshot') {
    let rows: WithdrawalCandidate[] = [...a.withdrawals]
      .sort((x, y) => x.position - y.position)
      .map((r, i) => {
        const idSeen = r.withdrawal_id && transcriptContains(transcript, r.withdrawal_id);
        if (r.withdrawal_id && !idSeen) notes.push(`dropped_unconfirmed_withdrawal_id_row_${i + 1}`);
        return {
          position: i + 1,
          withdrawalId: idSeen ? r.withdrawal_id!.toUpperCase().replace(/\s/g, '') : undefined,
          amount: r.amount ?? undefined,
          status: r.status ?? undefined,
          datetime: r.datetime ?? undefined,
          confidence: idSeen ? Math.max(r.confidence, 0.85) : Math.min(r.confidence, 0.5),
        };
      });
    const parsedRows = parseWithdrawalRows(transcript, patterns);
    if (rows.length === 0 || (rows.every((r) => !r.withdrawalId) && parsedRows.length > 0)) rows = parsedRows;
    out.withdrawals = rows;
  }

  if (a.category === 'bank_statement') {
    const acct = a.statement.account_number?.replace(/[\s-]/g, '').replace(/\*/g, 'X').toUpperCase();
    const ifsc = a.statement.ifsc?.toUpperCase();
    out.statement = {
      readable: true,
      accountNumbers: acct && transcriptContains(transcript, acct.replace(/X/g, '')) ? [acct] : [],
      ifsc: ifsc && transcriptContains(transcript, ifsc) ? ifsc : undefined,
      bankName: bankFromIfsc(ifsc) ?? canonicalBank(a.statement.bank_name ?? undefined) ?? undefined,
      holderName: a.statement.holder_name ?? undefined,
      lines: transcript.split('\n').filter((l) => /\d/.test(l)).slice(0, 300),
    };
  }

  if (a.category === 'technical_screenshot' || a.category === 'account_screenshot') {
    out.technical = { errorText: a.technical.error_text ?? undefined, screen: a.technical.screen ?? undefined };
  }
  return out;
}
