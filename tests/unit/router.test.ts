import { describe, expect, it } from 'vitest';
import { routeTurn, type RouteInput } from '../../src/cases/router.js';
import { emptyFacts, type CaseRecord } from '../../src/domain/cases.js';
import type { EvidenceItem } from '../../src/domain/evidence.js';
import { computeSignals } from '../../src/nlu/signals.js';
import { NO_CLAIMS, type Interpretation } from '../../src/nlu/types.js';

const NOW = new Date('2026-09-11T12:00:00Z');

const kase = (over: Partial<CaseRecord> = {}): CaseRecord => ({
  id: over.id ?? 'c-w', userId: 'u', chatId: 'u', type: 'withdrawal', status: 'open', step: 'collecting', confidence: 0,
  missing: [], escalation: 'none', facts: emptyFacts(), version: 1, createdAt: NOW, updatedAt: NOW, lastActivityAt: NOW, ...over,
});

const interp = (over: Partial<Interpretation> = {}): Interpretation => ({
  intent: 'provide_info', relation: 'continue', claims: NO_CLAIMS, language: 'hinglish', confidence: 0.9, source: 'llm', ...over,
});

function input(text: string, over: Partial<RouteInput> = {}): RouteInput {
  return {
    cases: [], interp: interp(), signals: computeSignals([text], { awaitingPassword: false }), turnEvidence: [], now: NOW, reopenWindowHours: 48, ...over,
  };
}

const ev = (category: EvidenceItem['category'], extra: Partial<EvidenceItem> = {}): EvidenceItem => ({
  id: `e-${category}`, userId: 'u', chatId: 'u', messageId: 1, mediaKind: 'photo', fileRef: 'f', category, categoryConfidence: 0.9,
  status: 'processed', notes: [], createdAt: NOW, ...extra,
});

describe('case routing & topic switching', () => {
  it('continues the focused case', () => {
    const w = kase();
    expect(routeTurn(input('abhi tak nahi mila', { cases: [w], focused: w }))).toMatchObject({ kind: 'case', target: { id: 'c-w' } });
  });

  it('side topic → no case and unfocus (pause)', () => {
    const w = kase();
    const d = routeTurn(input('lineup de do', { cases: [w], focused: w, interp: interp({ intent: 'general_query', relation: 'side_topic' }) }));
    expect(d).toEqual({ kind: 'none', unfocus: true, why: 'side_topic' });
  });

  it('never drops an uploaded case screenshot even if the words look like small talk', () => {
    const w = kase();
    const d = routeTurn(input('hmm', { cases: [w], focused: w, interp: interp({ intent: 'acknowledgement', relation: 'none' }), turnEvidence: [ev('withdrawal_screenshot')] }));
    expect(d).toMatchObject({ kind: 'case', target: { id: 'c-w' } });
  });

  it('resumes the target case by id', () => {
    const d1 = kase({ id: 'c-d', type: 'deposit', status: 'paused' });
    const d = routeTurn(input('mera deposit wala', { cases: [d1], interp: interp({ relation: 'resume', targetCaseId: 'c-d', caseType: 'deposit' }) }));
    expect(d).toMatchObject({ kind: 'case', target: { id: 'c-d' } });
  });

  it('a new issue of another type creates a new case', () => {
    const w = kase();
    const d = routeTurn(input('deposit bhi nahi aaya', { cases: [w], focused: w, interp: interp({ intent: 'deposit_issue', relation: 'new_issue', caseType: 'deposit' }) }));
    expect(d).toMatchObject({ kind: 'create', type: 'deposit' });
  });

  it('restating the same issue does not create a duplicate case', () => {
    const w = kase({ withdrawalId: 'WD-11111-22' });
    const d = routeTurn(input('withdrawal nahi aaya', { cases: [w], focused: w, interp: interp({ intent: 'withdrawal_issue', relation: 'new_issue', caseType: 'withdrawal' }) }));
    expect(d).toMatchObject({ kind: 'case', target: { id: 'c-w' } });
  });

  it('a different withdrawal ID is a different transaction → new case (once the first was confirmed)', () => {
    const facts = { ...emptyFacts(), payout: { withdrawalId: 'WD-11111-22', status: 'SUCCESS' as const, fetchedAt: NOW.toISOString() } };
    const w = kase({ withdrawalId: 'WD-11111-22', facts });
    for (const relation of ['new_issue', 'continue'] as const) {
      const d = routeTurn(input('ek aur withdrawal WD-99999-88 nahi aaya', { cases: [w], focused: w, interp: interp({ intent: 'withdrawal_issue', relation, caseType: 'withdrawal' }) }));
      expect(d).toMatchObject({ kind: 'create', type: 'withdrawal' });
    }
  });

  it('re-typing an ID that was never found is a correction, not a new case', () => {
    const w = kase({ withdrawalId: 'WD-11111-00', facts: { ...emptyFacts(), notFoundCount: 1 } });
    const d = routeTurn(input('sorry, WD-11111-01', { cases: [w], focused: w, interp: interp({ intent: 'provide_info', relation: 'continue', caseType: 'withdrawal' }) }));
    expect(d).toMatchObject({ kind: 'case', target: { id: 'c-w' } });
  });

  it('a swipe-reply to a case message routes to that case', () => {
    const w = kase({ status: 'paused' });
    const d1 = kase({ id: 'c-d', type: 'deposit' });
    const d = routeTurn(input('ye wala', {
      cases: [w, d1], focused: d1,
      reply: { messageId: 5, fromSelf: true, caseId: 'c-w', candidates: [], evidence: [], unprocessedMedia: [] },
    }));
    expect(d).toMatchObject({ kind: 'case', target: { id: 'c-w' } });
  });

  it('a PDF password goes to the case waiting for it, whatever the focus', () => {
    const w = kase({ status: 'paused', facts: { ...emptyFacts(), pendingPdf: { evidenceId: 'e1', attempts: 0 } } });
    const other = kase({ id: 'c-x', type: 'technical' });
    const signals = computeSignals(['YENU1304'], { awaitingPassword: true });
    const d = routeTurn({ ...input(''), signals, cases: [w, other], focused: other, interp: interp({ intent: 'unclear', relation: 'none' }) });
    expect(d).toMatchObject({ kind: 'case', target: { id: 'c-w' } });
  });

  it('a bank statement goes to the case awaiting one', () => {
    const w = kase({ status: 'paused', step: 'awaiting_statement' });
    const d = routeTurn(input('', { cases: [w], interp: interp({ relation: 'none', intent: 'unclear' }), turnEvidence: [ev('bank_statement', { mediaKind: 'document' })] }));
    expect(d).toMatchObject({ kind: 'case', target: { id: 'c-w' } });
  });

  it('retypes a clarify-step case once the type becomes clear', () => {
    const o = kase({ id: 'c-o', type: 'other', step: 'clarify_type' });
    const d = routeTurn(input('withdrawal ka', { cases: [o], focused: o, interp: interp({ intent: 'withdrawal_issue', relation: 'continue', caseType: 'withdrawal' }) }));
    expect(d).toMatchObject({ kind: 'case', target: { id: 'c-o' }, retypeTo: 'withdrawal' });
  });

  it('unclear money problem without context → clarify case', () => {
    const d = routeTurn(input('paisa nahi aaya', { interp: interp({ intent: 'payment_issue_unclear', relation: 'new_issue', caseType: 'other' }) }));
    expect(d).toMatchObject({ kind: 'create', type: 'other', step: 'clarify_type' });
  });
});
