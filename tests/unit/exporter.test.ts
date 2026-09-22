import { describe, expect, it } from 'vitest';
import { emptyFacts, type CaseRecord } from '../../src/domain/cases.js';
import type { EvidenceItem } from '../../src/domain/evidence.js';
import { parseConfirmation } from '../../src/handoff/confirmations.js';
import { exportPlan, missingForExport, waitsForItems } from '../../src/handoff/exporter.js';

const now = new Date('2026-09-11T12:00:00+05:30');
const kase = (over: Partial<CaseRecord> = {}, facts: Partial<CaseRecord['facts']> = {}): CaseRecord => ({
  id: 'abcdef12-0000', userId: '8939686943', chatId: '8939686943', type: 'deposit', status: 'open', step: 'collecting', confidence: 0.5, missing: [],
  escalation: 'none', version: 1, createdAt: now, updatedAt: now, lastActivityAt: now, facts: { ...emptyFacts(), ...facts }, ...over,
});
const ev = (id: string, messageId: number, category: EvidenceItem['category'], status: EvidenceItem['status'] = 'processed'): EvidenceItem =>
  ({ id, messageId, category, status, mediaKind: 'photo', userId: 'u', chatId: 'c', categoryConfidence: 0.9, notes: [] }) as unknown as EvidenceItem;

describe('missingForExport: everything the bot asked for in the case', () => {
  it('nothing asked → nothing missing', () => {
    expect(missingForExport(kase())).toEqual([]);
  });

  it('the deposit request: number, screenshot, statement, video', () => {
    const c = kase({ registrationNumber: '9810822372' }, { asks: { registration_number: 1, payment_proof: 1, bank_statement: 1, payment_video: 1 } });
    expect(missingForExport(c)).toEqual(['payment_proof', 'payment_video', 'bank_statement']);
    c.facts.paymentEvidenceId = 'p';
    c.facts.paymentVideoEvidenceId = 'v';
    expect(missingForExport(c)).toEqual(['bank_statement']);
    c.facts.statementEvidenceId = 's';
    c.facts.pendingPdf = { evidenceId: 's', attempts: 0 }; // still locked: not usable yet
    expect(missingForExport(c)).toEqual(['bank_statement']);
    c.facts.pendingPdf = undefined;
    expect(missingForExport(c)).toEqual([]);
  });

  it('a withdrawal reference is the ID or the history screenshot', () => {
    const c = kase({ type: 'withdrawal' }, { asks: { withdrawal_ref: 1 } });
    expect(missingForExport(c)).toEqual(['withdrawal_ref']);
    c.facts.withdrawalEvidenceId = 'w';
    expect(missingForExport(c)).toEqual([]);
  });

  it('password, choice and description are not items to wait for', () => {
    const c = kase({}, { asks: { pdf_password: 2, withdrawal_choice: 1, issue_description: 1, screenshot: 1 } });
    expect(missingForExport(c)).toEqual([]);
  });
});

describe('waitsForItems', () => {
  it('waits on verification handoffs, not when the customer stopped', () => {
    const c = kase();
    expect(waitsForItems({ reason: 'verification_unavailable' }, c)).toBe(true);
    expect(waitsForItems({ reason: 'deposit_not_reflected' }, c)).toBe(true);
    expect(waitsForItems({ reason: 'user_declined_more_info', declined: true }, c)).toBe(false);
    expect(waitsForItems({ reason: 'max_asks_reached' }, c)).toBe(false);
    expect(waitsForItems({ reason: 'user_requested_human' }, c)).toBe(false);
    c.facts.claims.refusesDocuments = true;
    expect(waitsForItems({ reason: 'verification_unavailable' }, c)).toBe(false);
  });
});

describe('exportPlan: only the requested items, forwarded as they are', () => {
  it('the number message and the case files, in order; nothing else', () => {
    const c = kase({ registrationNumber: '9117231129', amount: 3499.67, utr: '698765432109' }, {
      evidenceIds: ['p', 's', 'v', 'selfie'], paymentEvidenceId: 'p', statementEvidenceId: 's', paymentVideoEvidenceId: 'v', description: ['deposit nahi aaya sir'],
      sources: { registrationNumber: { source: 'text', confidence: 0.9, messageId: 2 } },
    });
    const plan = exportPlan(c, [ev('selfie', 4, 'unrelated'), ev('v', 7, 'payment_recording'), ev('p', 3, 'payment_screenshot'), ev('s', 5, 'bank_statement', 'needs_password')]);
    expect(plan.messageIds).toEqual([2, 3, 5, 7]); // the selfie is not forwarded
    expect(plan.labels).toEqual(['registration number', 'payment screenshot', 'bank statement PDF', 'payment video']);
  });

  it('withdrawal: the history screenshot', () => {
    const c = kase({ type: 'withdrawal', withdrawalId: 'WD-15436-64215' }, { evidenceIds: ['w'], withdrawalEvidenceId: 'w' });
    expect(exportPlan(c, [ev('w', 9, 'withdrawal_screenshot')])).toEqual({ messageIds: [9], labels: ['withdrawal history screenshot'] });
  });

  it('withdrawal: only the ID message (or history screenshot) and the statement — never a typed number or a payment shot', () => {
    const c = kase({ type: 'withdrawal', withdrawalId: 'WD-15436-64215', registrationNumber: '9117231129' }, {
      evidenceIds: ['p', 's'], paymentEvidenceId: 'p', statementEvidenceId: 's', paymentVideoEvidenceId: 'p',
      sources: { registrationNumber: { source: 'text', confidence: 0.9, messageId: 2 }, withdrawalId: { source: 'text', confidence: 0.9, messageId: 3 } },
    });
    const plan = exportPlan(c, [ev('p', 4, 'payment_screenshot'), ev('s', 5, 'bank_statement')]);
    expect(plan.messageIds).toEqual([3, 5]);
    expect(plan.labels).toEqual(['withdrawal ID', 'bank statement PDF']);
  });

  it('a number remembered from an earlier case has no message to forward', () => {
    const fromMemory = kase({ registrationNumber: '9117231129' }, { sources: { registrationNumber: { source: 'memory', confidence: 0.8 } } });
    expect(exportPlan(fromMemory, []).messageIds).toEqual([]);
  });
});

describe('parseConfirmation', () => {
  const sample = [
    '✅ PAYMENT CONFIRMED', '', '👤 Customer: N K (User ID: 8939686943, no username)', '', '📱 Mobile: 9117231129', '', '💰 Amount: ₹3,499.67',
    '', '🧾 Order: ILLUN-178923603882201', '', '✅ Confirmed by: Betix System', '', '🤖 @betixpay_cs_bot', '', '🕒 Time: 11:04', '', '🙏 Payment successfully confirmed.',
  ].join('\n');

  it('reads the User ID and the mobile from a confirmation', () => {
    expect(parseConfirmation(sample)).toEqual({ userId: '8939686943', mobile: '9117231129' });
    expect(parseConfirmation('payment confirmed\nuser id: 12345678')).toEqual({ userId: '12345678', mobile: undefined });
    expect(parseConfirmation('✅ PAYMENT CONFIRMED\n📱 Mobile: +91 9117231129\n💰 Amount: ₹3,499.67')).toEqual({ userId: undefined, mobile: '9117231129' });
  });

  it('ignores anything that is not a PAYMENT CONFIRMED', () => {
    expect(parseConfirmation('❌ PAYMENT REJECTED\n👤 Customer: N K (User ID: 8939686943)')).toBeUndefined();
    expect(parseConfirmation('Received your files 👍')).toBeUndefined();
    expect(parseConfirmation('')).toBeUndefined();
  });
});
