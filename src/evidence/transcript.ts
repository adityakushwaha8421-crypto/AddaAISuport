import type { Field, PaymentFacts, PaymentStatusSeen, WithdrawalCandidate } from '../domain/evidence.js';
import { bestEntities, DEFAULT_PATTERNS, extractEntities, parseAmount, type EntityPatterns } from '../nlu/entities.js';

/**
 * Deterministic parsing of screenshot transcripts (OCR text). Used both as a primary extractor
 * and to cross-check values proposed by the vision model.
 */

const PAYMENT_APPS: Array<[RegExp, string]> = [
  [/phone\s*pe/i, 'PhonePe'], [/google\s*pay|\bgpay\b|g\s*pay/i, 'Google Pay'], [/paytm/i, 'Paytm'],
  [/\bbhim\b/i, 'BHIM'], [/amazon\s*pay/i, 'Amazon Pay'], [/\bcred\b/i, 'CRED'], [/mobikwik/i, 'MobiKwik'],
  [/navi\b/i, 'Navi'], [/super\.?money/i, 'super.money'],
];

function paymentStatusFrom(text: string): PaymentStatusSeen | undefined {
  const t = text.toLowerCase();
  if (/\b(failed|failure|declined|unsuccessful|cancelled|reversed)\b/.test(t)) return 'failed';
  if (/\b(pending|processing|in progress|awaiting)\b/.test(t)) return 'pending';
  if (/\b(successful|success|completed|paid|payment done|money sent|sent successfully|debited)\b/.test(t)) return 'success';
  return undefined;
}

function to24h(h: number, m: number, ampm?: string): string | undefined {
  if (m > 59 || h > 23) return undefined;
  let hh = h;
  if (ampm) {
    const pm = /p/i.test(ampm);
    if (h > 12 || h === 0) return undefined;
    hh = pm ? (h % 12) + 12 : h % 12;
  }
  return `${String(hh).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

function parseTime(text: string): string | undefined {
  const m = text.match(/\b(\d{1,2}):(\d{2})(?::\d{2})?\s*(am|pm|AM|PM)?\b/);
  return m ? to24h(Number(m[1]), Number(m[2]), m[3]) : undefined;
}

const field = <T>(value: T, confidence: number): Field<T> => ({ value, confidence, origin: 'transcript' });

export function parsePaymentTranscript(transcript: string, patterns: EntityPatterns = DEFAULT_PATTERNS): PaymentFacts {
  const e = extractEntities(transcript, { patterns });
  const best = bestEntities(e);
  const facts: PaymentFacts = {};
  if (best.utr) facts.utr = field(best.utr.value, best.utr.confidence >= 0.9 ? 0.85 : 0.6);
  if (best.amount) facts.amount = field(best.amount.value, best.amount.confidence >= 0.9 ? 0.8 : 0.5);
  if (best.date) facts.date = field(best.date.value, 0.75);
  const time = parseTime(transcript);
  if (time) facts.time = field(time, 0.7);
  const status = paymentStatusFrom(transcript);
  if (status) facts.status = field(status, 0.7);
  const txn = transcript.match(/\b(?:transaction|txn)\s*(?:id|no\.?)\s*[:\-]?\s*([A-Z0-9]{8,30})\b/i)?.[1];
  if (txn) facts.transactionId = field(txn.toUpperCase(), 0.8);
  const app = PAYMENT_APPS.find(([re]) => re.test(transcript))?.[1];
  if (app) facts.app = app;
  return facts;
}

/**
 * Rows of a withdrawal-history screenshot, top to bottom. A row starts at each line holding a
 * withdrawal-ID-looking token; amount/status/time are taken from that line and the following
 * lines until the next row begins.
 */
export function parseWithdrawalRows(transcript: string, patterns: EntityPatterns = DEFAULT_PATTERNS): WithdrawalCandidate[] {
  const lines = transcript.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const rows: Array<{ id?: string; text: string[] }> = [];
  for (const line of lines) {
    const id = extractEntities(line, { patterns }).withdrawalIds[0]?.value;
    if (id) rows.push({ id, text: [line] });
    else if (rows.length) rows[rows.length - 1]!.text.push(line);
  }
  return rows.map((r, i) => {
    const block = r.text.join(' ');
    const amountHit = extractEntities(block, { patterns }).amounts[0];
    const bareAmount = !amountHit ? block.match(/(?:^|\s)(\d{2,7}(?:\.\d{1,2})?)(?:\s|$)/)?.[1] : undefined;
    const status = block.match(/\b(success(?:ful)?|completed|processing|pending|failed|rejected|reversed|in progress)\b/i)?.[1];
    const dt = extractEntities(block).dates[0]?.value;
    const time = parseTime(block);
    return {
      position: i + 1,
      withdrawalId: r.id,
      amount: amountHit?.value ?? (bareAmount ? parseAmount(bareAmount) : undefined),
      status: status?.toUpperCase(),
      datetime: dt ? (time ? `${dt} ${time}` : dt) : undefined,
      confidence: 0.75,
    };
  });
}

/** Loose containment used to cross-check vision values against the transcript. */
export function transcriptContains(transcript: string, value: string | number): boolean {
  if (typeof value === 'number') {
    const nums = (transcript.match(/\d[\d,]*(?:\.\d+)?/g) ?? []).map((n) => Number(n.replace(/,/g, '')));
    return nums.some((n) => Math.abs(n - value) < 0.01);
  }
  const norm = (s: string) => s.toUpperCase().replace(/[^A-Z0-9]/g, '');
  const v = norm(value);
  return v.length >= 3 && norm(transcript).includes(v);
}
