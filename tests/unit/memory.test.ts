import { describe, expect, it } from 'vitest';
import { emptyFacts, type CaseRecord } from '../../src/domain/cases.js';
import { addressTerm, describeMemory, emptyMemory, learnStyle, preferredRegistrationNumber, prefersBrief, rememberCase, rememberNumber } from '../../src/domain/memory.js';

const NOW = new Date('2026-09-11T12:00:00Z');
const LATER = new Date('2026-09-12T09:00:00Z');

const kase = (over: Partial<CaseRecord> = {}): CaseRecord => ({
  id: 'case-1', userId: 'u1', chatId: 'u1', type: 'withdrawal', status: 'resolved', step: 'done', confidence: 1,
  missing: [], escalation: 'none', facts: emptyFacts(), version: 1, createdAt: NOW, updatedAt: NOW, lastActivityAt: NOW, ...over,
});

describe('customer memory', () => {
  it('keeps the most useful registration number (verified first, then most recent)', () => {
    let m = rememberNumber(emptyMemory(), '9810822372', false, NOW);
    m = rememberNumber(m, '9876543210', true, NOW);
    expect(preferredRegistrationNumber(m)?.value).toBe('9876543210');
    m = rememberNumber(m, '9810822372', true, LATER);
    expect(preferredRegistrationNumber(m)?.value).toBe('9810822372');
    expect(m.registrationNumbers).toHaveLength(2);
    // A number stays verified once proved.
    expect(rememberNumber(m, '9810822372', false, LATER).registrationNumbers[0]?.verified).toBe(true);
  });

  it('learns number, payout bank (masked) and case history from a finished case', () => {
    const c = kase({
      registrationNumber: '9810822372', withdrawalId: 'WD-15436-64215', amount: 1450,
      facts: { ...emptyFacts(), payout: { withdrawalId: 'WD-15436-64215', status: 'SUCCESS', amount: 1450, accountNumber: '50100123456789', bankName: 'HDFC Bank', ifsc: 'HDFC0001234', fetchedAt: NOW.toISOString() } },
    });
    const m = rememberCase(emptyMemory(), c, NOW);
    expect(preferredRegistrationNumber(m)).toMatchObject({ value: '9810822372', verified: true });
    expect(m.bank).toMatchObject({ name: 'HDFC Bank', maskedAccount: 'XXXX6789' });
    expect(JSON.stringify(m)).not.toContain('50100123456789'); // never the full account
    expect(m.recentCases[0]).toMatchObject({ type: 'withdrawal', ref: 'WD-15436-64215', status: 'resolved' });
    expect(m.stats).toMatchObject({ cases: 1, resolved: 1, escalated: 0, lastIssueType: 'withdrawal' });
  });

  it('updates a case in place instead of counting it twice', () => {
    const open = kase({ status: 'open' });
    let m = rememberCase(emptyMemory(), open, NOW);
    m = rememberCase(m, { ...open, status: 'escalated' }, LATER);
    expect(m.stats).toMatchObject({ cases: 1, escalated: 1 });
    expect(m.recentCases).toHaveLength(1);
  });

  it('describes the customer in one line for the model and the support team', () => {
    expect(describeMemory(emptyMemory())).toBeUndefined();
    const m = rememberCase(rememberNumber(emptyMemory(), '9810822372', true, NOW), kase({ withdrawalId: 'WD-1' }), NOW);
    const line = describeMemory(m)!;
    expect(line).toMatch(/1 earlier case\(s\): 1 resolved/);
    expect(line).toMatch(/known registration number \(verified\)/);
    expect(line).not.toContain('9810822372'); // the number itself stays out of prompts
  });
});

describe('style memory', () => {
  const say = (m: ReturnType<typeof emptyMemory>, ...texts: string[]) => texts.reduce(learnStyle, m);

  it('mirrors how the customer addresses us, defaulting to "sir"', () => {
    expect(addressTerm(emptyMemory())).toBe('sir');
    expect(addressTerm(say(emptyMemory(), 'bhai paisa nahi aaya'))).toBe('sir'); // one mention isn't a preference
    expect(addressTerm(say(emptyMemory(), 'bhai paisa nahi aaya', 'bhai check karo'))).toBe('bhai');
    expect(addressTerm(say(emptyMemory(), 'bhai dekho', 'sir please check', 'sir koi update'))).toBe('sir');
  });

  it('notices customers who write in very short bursts', () => {
    expect(prefersBrief(say(emptyMemory(), 'ok', 'haan', 'kab tak'))).toBe(true);
    expect(prefersBrief(say(emptyMemory(), 'ok', 'haan'))).toBe(false); // too little to tell
    expect(prefersBrief(say(emptyMemory(), 'sir mera deposit abhi tak wallet me nahi aaya hai please check kijiye'))).toBe(false);
  });
});
