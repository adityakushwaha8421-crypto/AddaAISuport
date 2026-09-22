import type { StatementFacts } from '../domain/evidence.js';
import { extractEntities } from '../nlu/entities.js';
import { bankFromIfsc, detectBank } from './banks.js';

/**
 * Deterministic bank-statement understanding. Statements vary wildly between banks, so rather
 * than parsing every table we extract the header facts (account, IFSC, bank, holder, period) and
 * keep transaction-looking lines for *targeted* verification later (search for a known UTR /
 * amount / date).
 */

const STATEMENT_CUES: RegExp[] = [
  /statement\s+of\s+account/i, /account\s+statement/i, /\bopening\s+balance\b/i, /\bclosing\s+balance\b/i,
  /\bifsc\b/i, /\bbranch\b/i, /\bnarration\b/i, /\bparticulars\b/i, /\bvalue\s+date\b/i, /\btxn\s+date\b|\btransaction\s+date\b/i,
  /\bwithdrawal(s)?\b.*\bdeposit(s)?\b|\bdebit\b.*\bcredit\b|\bdr\b.*\bcr\b/i, /\bbalance\b/i, /\bchq|cheque\b/i,
  /\bcustomer\s+id\b|\bcif\b/i, /\ba\/c\s*(no|number)|\baccount\s*(no|number)\b/i,
];

const MONEY = /(?<![\d.])\d{1,3}(?:,\d{2,3})*(?:\.\d{2})(?![\d])|(?<![\d.,])\d+\.\d{2}(?![\d])/g;
const DATE_LIKE = /\b\d{1,2}[/.-](?:\d{1,2}|[A-Za-z]{3})[/.-]\d{2,4}\b|\b\d{4}-\d{2}-\d{2}\b|\b\d{1,2}\s+[A-Za-z]{3}\s+\d{2,4}\b/;

export function statementScore(lines: string[]): number {
  const text = lines.slice(0, 400).join('\n');
  let score = STATEMENT_CUES.reduce((n, re) => n + (re.test(text) ? 1 : 0), 0);
  const txnLines = lines.filter((l) => DATE_LIKE.test(l) && (l.match(MONEY) ?? []).length >= 1).length;
  if (txnLines >= 3) score += 2;
  if (/\b[A-Z]{4}0[A-Z0-9]{6}\b/.test(text)) score += 1;
  return score;
}

export function isLikelyStatement(lines: string[]): boolean {
  return statementScore(lines) >= 4;
}

function normaliseAccount(raw: string): string | undefined {
  const v = raw.replace(/[\s-]/g, '').replace(/\*/g, 'X').toUpperCase();
  const digits = (v.match(/\d/g) ?? []).length;
  if (digits < 4 || v.length < 6 || v.length > 20) return undefined;
  if (!/^[X\d]+$/.test(v)) return undefined;
  return v;
}

export function parseStatement(lines: string[]): StatementFacts {
  const header = lines.slice(0, 40).join('\n');
  const all = lines.join('\n');

  const accounts = new Set<string>();
  const ACC = /\b(?:a\/c|acct|account|ac)\.?\s*(?:no|number|num|#)?\.?\s*[:\-]?\s*([X*x\d][X*x\d\s-]{4,24}\d)\b/gi;
  for (const m of all.matchAll(ACC)) {
    const v = normaliseAccount(m[1]!);
    if (v) accounts.add(v);
  }
  // Masked account numbers anywhere: XXXXXX1234 / ******1234
  for (const m of header.matchAll(/\b[X*x]{2,}\d{3,6}\b/g)) {
    const v = normaliseAccount(m[0]);
    if (v) accounts.add(v);
  }

  const ifsc = header.match(/\b([A-Z]{4}0[A-Z0-9]{6})\b/i)?.[1]?.toUpperCase() ?? all.match(/\bIFSC\s*(?:code)?\s*[:\-]?\s*([A-Z]{4}0[A-Z0-9]{6})\b/i)?.[1]?.toUpperCase();
  const bankName = bankFromIfsc(ifsc) ?? detectBank(header);
  const holderName = header
    .match(/\b(?:account\s+holder(?:\s+name)?|customer\s+name|a\/c\s+name|name)\s*[:\-]\s*(?:mr\.?|mrs\.?|ms\.?|shri|smt\.?)?\s*([A-Z][A-Za-z.]*(?:\s+[A-Z][A-Za-z.]*){0,4})/i)?.[1]
    ?.trim();

  // Statement period: explicit "from X to Y", else the range of transaction dates.
  let periodFrom: string | undefined;
  let periodTo: string | undefined;
  const period = header.match(/(?:period|from)\s*[:\-]?\s*(.{6,20}?)\s*(?:to|-|–)\s*(.{6,20}?)(?:\s|$)/i);
  if (period) {
    periodFrom = extractEntities(period[1]!).dates[0]?.value;
    periodTo = extractEntities(period[2]!).dates[0]?.value;
  }
  const txnLines = lines.filter((l) => DATE_LIKE.test(l) && (l.match(MONEY) ?? []).length >= 1);
  if (!periodFrom || !periodTo) {
    const dates = txnLines.map((l) => extractEntities(l).dates[0]?.value).filter((d): d is string => !!d).sort();
    periodFrom ??= dates[0];
    periodTo ??= dates[dates.length - 1];
  }

  return {
    readable: true,
    accountNumbers: [...accounts],
    ifsc,
    bankName,
    holderName,
    periodFrom,
    periodTo,
    lines: txnLines.slice(0, 600).map((l) => l.slice(0, 300)),
  };
}

export function moneyValues(line: string): number[] {
  return (line.match(MONEY) ?? []).map((m) => Number(m.replace(/,/g, ''))).filter((n) => Number.isFinite(n));
}
