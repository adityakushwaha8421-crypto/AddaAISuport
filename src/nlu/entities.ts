import { cleanText } from './normalize.js';

/**
 * Deterministic entity extraction. Identifiers (registration number, withdrawal/order IDs, UTR,
 * account, IFSC) are ONLY ever taken from text that literally contains them — the LLM may help
 * interpret, but never supplies an identifier that is not here.
 *
 * Extractors run in priority order and claim character spans, so a 10-digit number labelled
 * "a/c" is an account number and not also a registration number.
 */

export interface EntityHit<T = string> {
  value: T;
  raw: string;
  index: number;
  confidence: number;
}

export interface ExtractedEntities {
  registrationNumbers: EntityHit[];
  withdrawalIds: EntityHit[];
  orderIds: EntityHit[];
  utrs: EntityHit[];
  amounts: EntityHit<number>[];
  dates: EntityHit<string>[];
  accountNumbers: EntityHit[];
  ifscs: EntityHit[];
}

export interface EntityPatterns {
  registration: RegExp;
  withdrawalId: RegExp;
  orderId: RegExp;
}

export function compilePatterns(p: { registration: string; withdrawalId: string; orderId: string }): EntityPatterns {
  return {
    registration: new RegExp(p.registration, 'g'),
    withdrawalId: new RegExp(p.withdrawalId, 'gi'),
    orderId: new RegExp(p.orderId, 'gi'),
  };
}

export const DEFAULT_PATTERNS = compilePatterns({
  registration: '(?<![\\d])[6-9]\\d{9}(?![\\d])',
  withdrawalId: '\\b(?:WD|WDR|WID)[-_]?\\d{3,}(?:[-_]\\d{2,})*\\b',
  orderId: '\\b(?:ORD|ORDER|DEP|TXN)[-_]?(?=[A-Z0-9]*\\d)[A-Z0-9]{4,}(?:[-_][A-Z0-9]+)*\\b',
});

class SpanTracker {
  private spans: Array<[number, number]> = [];
  free(start: number, end: number): boolean {
    return this.spans.every(([s, e]) => end <= s || start >= e);
  }
  claim(start: number, end: number): void {
    this.spans.push([start, end]);
  }
}

function* matches(re: RegExp, text: string): Generator<RegExpExecArray> {
  const r = new RegExp(re.source, re.flags.includes('g') ? re.flags : re.flags + 'g');
  let m: RegExpExecArray | null;
  while ((m = r.exec(text))) {
    yield m;
    if (m[0].length === 0) r.lastIndex++;
  }
}

/** Index of capture group `g` within the full text. */
function groupIndex(m: RegExpExecArray, g: number): number {
  const full = m[0];
  const part = m[g] ?? '';
  const offset = full.lastIndexOf(part);
  return m.index + (offset >= 0 ? offset : 0);
}

const hasDigit = (s: string) => /\d/.test(s);

const MONTHS: Record<string, number> = {
  jan: 1, january: 1, feb: 2, february: 2, mar: 3, march: 3, apr: 4, april: 4, may: 5, jun: 6, june: 6,
  jul: 7, july: 7, aug: 8, august: 8, sep: 9, sept: 9, september: 9, oct: 10, october: 10, nov: 11,
  november: 11, dec: 12, december: 12,
};

function isoDate(y: number, m: number, d: number): string | undefined {
  if (y < 100) y += 2000;
  if (m < 1 || m > 12 || d < 1 || d > 31 || y < 2000 || y > 2100) return undefined;
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (dt.getUTCMonth() !== m - 1) return undefined;
  return dt.toISOString().slice(0, 10);
}

export function parseAmount(raw: string): number | undefined {
  const n = Number(raw.replace(/[,\s]/g, ''));
  return Number.isFinite(n) && n > 0 && n < 10_000_000 ? n : undefined;
}

export interface ExtractOptions {
  patterns?: EntityPatterns;
  /** Reference "today" for relative dates. */
  now?: Date;
}

export function extractEntities(input: string, opts: ExtractOptions = {}): ExtractedEntities {
  const text = cleanText(input);
  const patterns = opts.patterns ?? DEFAULT_PATTERNS;
  const spans = new SpanTracker();
  const out: ExtractedEntities = {
    registrationNumbers: [], withdrawalIds: [], orderIds: [], utrs: [], amounts: [], dates: [], accountNumbers: [], ifscs: [],
  };
  const push = <T>(list: EntityHit<T>[], hit: EntityHit<T>, len: number) => {
    if (!spans.free(hit.index, hit.index + len)) return;
    spans.claim(hit.index, hit.index + len);
    if (!list.some((h) => h.value === hit.value)) list.push(hit);
  };

  // 1. Contextual UTR / bank reference: "UTR 412345678901", "ref no: ABCD1234567"
  for (const m of matches(/\b(?:utr|rrn|upi\s*ref(?:erence)?(?:\s*(?:no|number|id))?|ref(?:erence)?(?:\.?\s*(?:no|number|id))?|transaction\s*(?:id|no|number)|txn\s*(?:id|no))\b\.?\s*(?:is|hai|:|-|#|=)*\s*([A-Z0-9]{8,22})\b/gi, text)) {
    const v = m[1]!;
    if (hasDigit(v)) push(out.utrs, { value: v.toUpperCase(), raw: m[0], index: groupIndex(m, 1), confidence: 0.95 }, v.length);
  }

  // 2. Contextual withdrawal id: "withdrawal id 12345678", "payout no: WDX99"
  for (const m of matches(/\b(?:withdrawal|withdraw|withdrawl|widraw|wd|payout|redeem)\s*(?:request\s*)?(?:id|no|number|#)\s*(?:is|hai|:|-|#|=)*\s*([A-Z0-9][A-Z0-9_-]{3,})\b/gi, text)) {
    const v = m[1]!;
    if (hasDigit(v)) push(out.withdrawalIds, { value: v.toUpperCase(), raw: m[0], index: groupIndex(m, 1), confidence: 0.9 }, v.length);
  }
  // 3. Contextual order id
  for (const m of matches(/\border\s*(?:id|no|number|#)\s*(?:is|hai|:|-|#|=)*\s*([A-Z0-9][A-Z0-9_-]{3,})\b/gi, text)) {
    const v = m[1]!;
    if (hasDigit(v)) push(out.orderIds, { value: v.toUpperCase(), raw: m[0], index: groupIndex(m, 1), confidence: 0.9 }, v.length);
  }
  // 4. Pattern ids
  for (const m of matches(patterns.withdrawalId, text)) {
    push(out.withdrawalIds, { value: m[0].toUpperCase(), raw: m[0], index: m.index, confidence: 0.95 }, m[0].length);
  }
  for (const m of matches(patterns.orderId, text)) {
    push(out.orderIds, { value: m[0].toUpperCase(), raw: m[0], index: m.index, confidence: 0.85 }, m[0].length);
  }

  // 5. IFSC
  for (const m of matches(/\b([A-Z]{4}0[A-Z0-9]{6})\b/gi, text)) {
    push(out.ifscs, { value: m[1]!.toUpperCase(), raw: m[0], index: m.index, confidence: 0.95 }, m[0].length);
  }

  // 6. Contextual account numbers (may be masked: XXXX1234)
  for (const m of matches(/\b(?:a\/c|a\/c\.|acc(?:ount)?|khata)\s*(?:no\.?|number|num)?\s*(?:is|hai|:|-|#)*\s*([X*x\d][X*x\d\s-]{3,22}\d)\b/gi, text)) {
    const v = m[1]!.replace(/[\s-]/g, '').toUpperCase().replace(/\*/g, 'X');
    if ((v.match(/\d/g) ?? []).length >= 4) push(out.accountNumbers, { value: v, raw: m[0], index: groupIndex(m, 1), confidence: 0.9 }, m[1]!.length);
  }

  // 7. Registration number (Indian mobile by default). Accept "+91 98108 22372" / "98108-22372".
  for (const m of matches(/(?<![\d])(?:\+?91[\s-]?)?([6-9]\d{4})[\s-]?(\d{5})(?![\d])/g, text)) {
    const digits = `${m[1]}${m[2]}`;
    if (!new RegExp(patterns.registration.source).test(digits)) continue;
    const before = text.slice(Math.max(0, m.index - 30), m.index).toLowerCase();
    const labelled = /(number|num|no\b|mobile|mob|phone|registered|reg|registration|login|account\s*number\s*on\s*app)/.test(before);
    push(out.registrationNumbers, { value: digits, raw: m[0], index: m.index, confidence: labelled ? 0.95 : 0.8 }, m[0].length);
  }
  // Custom (non-mobile) registration patterns configured via env.
  for (const m of matches(patterns.registration, text)) {
    push(out.registrationNumbers, { value: m[0], raw: m[0], index: m.index, confidence: 0.8 }, m[0].length);
  }

  // 8. Bare 12-digit numbers are most likely UPI UTRs.
  for (const m of matches(/(?<![\d])(\d{12})(?![\d])/g, text)) {
    push(out.utrs, { value: m[1]!, raw: m[0], index: m.index, confidence: 0.65 }, m[0].length);
  }

  // 9. Dates: 12/08/2026, 12-08-26, 12 Aug 2026, Aug 12, 2026, 2026-08-12
  for (const m of matches(/\b(\d{4})-(\d{1,2})-(\d{1,2})\b/g, text)) {
    const iso = isoDate(+m[1]!, +m[2]!, +m[3]!);
    if (iso) push(out.dates, { value: iso, raw: m[0], index: m.index, confidence: 0.95 }, m[0].length);
  }
  for (const m of matches(/\b(\d{1,2})[/.-](\d{1,2})[/.-](\d{2,4})\b/g, text)) {
    const iso = isoDate(+m[3]!, +m[2]!, +m[1]!); // Indian D/M/Y
    if (iso) push(out.dates, { value: iso, raw: m[0], index: m.index, confidence: 0.9 }, m[0].length);
  }
  for (const m of matches(/\b(\d{1,2})(?:st|nd|rd|th)?\s+([A-Za-z]{3,9})\.?,?\s+(\d{2,4})\b/g, text)) {
    const mon = MONTHS[m[2]!.toLowerCase()];
    const iso = mon ? isoDate(+m[3]!, mon, +m[1]!) : undefined;
    if (iso) push(out.dates, { value: iso, raw: m[0], index: m.index, confidence: 0.9 }, m[0].length);
  }
  for (const m of matches(/\b([A-Za-z]{3,9})\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{4})\b/g, text)) {
    const mon = MONTHS[m[1]!.toLowerCase()];
    const iso = mon ? isoDate(+m[3]!, mon, +m[2]!) : undefined;
    if (iso) push(out.dates, { value: iso, raw: m[0], index: m.index, confidence: 0.9 }, m[0].length);
  }
  const now = opts.now ?? new Date();
  const lower = text.toLowerCase();
  const rel = (days: number) => new Date(now.getTime() - days * 86_400_000).toISOString().slice(0, 10);
  const relIdx = lower.search(/\b(aaj|today)\b|आज/);
  if (relIdx >= 0 && out.dates.length === 0) out.dates.push({ value: rel(0), raw: 'today', index: relIdx, confidence: 0.7 });
  const yIdx = lower.search(/\b(kal|yesterday)\b|कल/);
  if (yIdx >= 0 && out.dates.length === 0) out.dates.push({ value: rel(1), raw: 'yesterday', index: yIdx, confidence: 0.6 });

  // 10. Amounts: "₹500", "Rs. 1,200.50", "500 rs", "500/-", "500 rupaye"
  for (const m of matches(/(?:₹|\brs\.?|\binr)\s*([\d,]+(?:\.\d{1,2})?)/gi, text)) {
    const v = parseAmount(m[1]!);
    if (v !== undefined) push(out.amounts, { value: v, raw: m[0], index: m.index, confidence: 0.95 }, m[0].length);
  }
  for (const m of matches(/\b([\d,]+(?:\.\d{1,2})?)\s*(?:₹|rs\b\.?|inr\b|rupees?\b|rupaye\b|rupay\b|rupiya\b|\/-)/gi, text)) {
    const v = parseAmount(m[1]!);
    if (v !== undefined) push(out.amounts, { value: v, raw: m[0], index: m.index, confidence: 0.9 }, m[0].length);
  }
  // "500 ka deposit", "2000 withdraw kiya"
  for (const m of matches(/\b(\d{2,7}(?:\.\d{1,2})?)\s*(?:ka|ki|ke|ko)?\s*(?:deposit|withdraw|withdrawal|payment|add|recharge|dala|daala|nikala)/gi, text)) {
    const v = parseAmount(m[1]!);
    if (v !== undefined) push(out.amounts, { value: v, raw: m[0], index: m.index, confidence: 0.7 }, m[1]!.length);
  }

  return out;
}

/** Flatten to "best" single values (highest confidence, earliest). */
export function bestEntities(e: ExtractedEntities) {
  const best = <T>(l: EntityHit<T>[]) => [...l].sort((a, b) => b.confidence - a.confidence || a.index - b.index)[0];
  return {
    registrationNumber: best(e.registrationNumbers),
    withdrawalId: best(e.withdrawalIds),
    orderId: best(e.orderIds),
    utr: best(e.utrs),
    amount: best(e.amounts),
    date: best(e.dates),
    accountNumber: best(e.accountNumbers),
    ifsc: best(e.ifscs),
  };
}
