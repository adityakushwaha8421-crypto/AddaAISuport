import { describe, expect, it } from 'vitest';
import type { CaseSummary, InterpreterInput } from '../../src/nlu/context.js';
import { finalize, LlmInterpreter } from '../../src/nlu/interpreter.js';
import { lexicalInterpret } from '../../src/nlu/lexical.js';
import { computeSignals } from '../../src/nlu/signals.js';
import { ScriptedLlm } from '../../src/llm/fake.js';
import { silentLogger } from '../../src/observability/logger.js';
import { NO_CLAIMS } from '../../src/nlu/types.js';

const caseSummary = (over: Partial<CaseSummary> = {}): CaseSummary => ({
  id: 'case-w', type: 'withdrawal', status: 'open', step: 'collecting', lastAsked: [], known: [], lastActivityMinutesAgo: 1, ...over,
});

function input(text: string, over: Partial<InterpreterInput> = {}): InterpreterInput {
  return {
    signals: computeSignals([text], { awaitingPassword: false, now: new Date('2026-09-11T10:00:00Z'), hasMedia: false }),
    others: [],
    history: [],
    evidence: [],
    ...over,
  };
}

describe('lexical fallback: intent detection', () => {
  it.each([
    ['deposit kiya tha wallet mein nahi aaya', 'deposit_issue', 'deposit'],
    ['maine 500 add money kiya balance update nahi hua', 'deposit_issue', 'deposit'],
    ['withdrawal abhi tak nahi aaya', 'withdrawal_issue', 'withdrawal'],
    ['paise nikale the bank mein nahi aaye', 'withdrawal_issue', 'withdrawal'],
    ['mera withdrawal id WD-15436-64215 hai sir', 'withdrawal_issue', 'withdrawal'],
    ['KYC verify nahi ho raha', 'account_issue', 'account'],
    ['app crash ho raha hai', 'technical_issue', 'technical'],
  ])('%s → %s', (text, intent, caseType) => {
    const r = lexicalInterpret(input(text));
    expect(r.intent).toBe(intent);
    expect(r.caseType).toBe(caseType);
    expect(r.relation).toBe('new_issue');
    expect(r.source).toBe('lexical');
  });

  it('"paisa nahi aaya" with no context: money the customer was waiting for → withdrawal', () => {
    const r = lexicalInterpret(input('paisa nahi aaya'));
    expect(r.intent).toBe('withdrawal_issue');
    expect(r.claims.notReceived).toBe(true);
  });

  it('a money problem that fits both sides is asked about, not guessed', () => {
    for (const text of ['amount credit nahi hua', 'payment problem hai', 'paise ka issue hai sir', 'reflect nahi hua abhi tak']) {
      const r = lexicalInterpret(input(text));
      expect([text, r.intent]).toEqual([text, 'payment_issue_unclear']);
    }
  });

  it('"paise nahi aaye" inside a deposit case is a follow-up, not a switch to withdrawal', () => {
    const focused = caseSummary({ type: 'deposit', lastAsked: ['payment_proof'] });
    for (const text of ['paise abhi tak nahi aaye', 'mere paise nahi aaye sir', 'amount receive nahi hua']) {
      const r = lexicalInterpret(input(text, { focused }));
      expect([text, r.relation, r.caseType]).toEqual([text, 'continue', 'deposit']);
    }
  });

  it('a named direction does switch away from a focused case of the other type', () => {
    const focused = caseSummary({ type: 'deposit' });
    const r = lexicalInterpret(input('ek aur problem: withdrawal bhi bank me nahi aaya', { focused }));
    expect(r.intent).toBe('withdrawal_issue');
    expect(r.relation).toBe('new_issue');
  });

  it('continues the focused case for short follow-ups', () => {
    const focused = caseSummary();
    for (const text of ['abhi tak nahi mila', 'bhai check karo', 'same', 'payment abhi tak nahi aaya']) {
      const r = lexicalInterpret(input(text, { focused }));
      expect([text, r.relation]).toEqual([text, 'continue']);
    }
  });

  it('continues with a registration number embedded in text', () => {
    const focused = caseSummary({ type: 'deposit', lastAsked: ['registration_number'] });
    const r = lexicalInterpret(input('number dusra hai 9810822372', { focused }));
    expect(r.intent).toBe('provide_info');
    expect(r.relation).toBe('continue');
  });

  it('pauses for an unrelated topic and resumes on return', () => {
    const focused = caseSummary();
    const side = lexicalInterpret(input('Sir lineup de diya karo', { focused }));
    expect(side.intent).toBe('general_query');
    expect(side.relation).toBe('side_topic');

    const paused = caseSummary({ status: 'paused' });
    const back = lexicalInterpret(input('mera withdrawal wala check karo', { others: [paused] }));
    expect(back.relation).toBe('resume');
    expect(back.targetCaseId).toBe('case-w');
  });

  it('recognises smalltalk and human requests', () => {
    expect(lexicalInterpret(input('thank you sir')).intent).toBe('thanks');
    expect(lexicalInterpret(input('ok')).relation).toBe('none');
    expect(lexicalInterpret(input('mujhe kisi insaan se baat karni hai')).intent).toBe('human_request');
  });

  it('flags refusal only in the context of a document request', () => {
    const focused = caseSummary({ lastAsked: ['bank_statement'] });
    expect(lexicalInterpret(input('statement nahi hai mere pass', { focused })).claims.refusesDocuments).toBe(true);
    expect(lexicalInterpret(input('mere pass nahi hai time')).claims.refusesDocuments).toBe(false);
  });

  it('uses evidence type to pick the case type', () => {
    const r = lexicalInterpret({
      ...input('ye dekho'),
      evidence: [{ category: 'withdrawal_screenshot', confidence: 0.9, summary: '2 rows' }],
    });
    expect(r.caseType).toBe('withdrawal');
    expect(r.relation).toBe('new_issue');
  });
});

describe('LLM interpreter: validation and fallback', () => {
  const base = {
    intent: 'provide_info', case_type: 'withdrawal', relation: 'continue', target_case_id: null,
    claims: { ...NO_CLAIMS }, reference: { kind: 'none', index: null }, affirmation: 'none',
    language: 'hinglish', gist: 'user gives id', confidence: 0.9,
    proposed: { registration_number: null, withdrawal_id: null, order_id: null, utr: null, amount: null },
  } as const;

  it('drops identifiers that are not literally present in the text (anti-hallucination)', () => {
    const inp = input('mera withdrawal WD-111-22 hai', { focused: caseSummary() });
    const r = finalize(
      { ...base, proposed: { ...base.proposed, withdrawal_id: 'WD-111-22', utr: '999999999999', amount: 500 } },
      inp,
    );
    expect(r.proposed?.withdrawalId).toBe('WD-111-22');
    expect(r.proposed?.utr).toBeUndefined();
    expect(r.proposed?.amount).toBeUndefined();
  });

  it('rejects unknown target case ids and repairs impossible relations', () => {
    const inp = input('mera deposit wala', { others: [caseSummary({ id: 'case-d', type: 'deposit', status: 'paused' })] });
    const r = finalize({ ...base, relation: 'resume', case_type: 'deposit', target_case_id: 'made-up' }, inp);
    expect(r.targetCaseId).toBe('case-d');
    const r2 = finalize({ ...base, relation: 'continue' }, input('hello'));
    expect(r2.relation).toBe('new_issue');
  });

  it('prefers the deterministic ordinal reference', () => {
    const r = finalize({ ...base, reference: { kind: 'index', index: 2 } }, input('upar wala', { focused: caseSummary() }));
    expect(r.reference).toEqual({ kind: 'index', index: 1 });
  });

  it('falls back to the lexical interpreter when the LLM fails or returns garbage', async () => {
    const llm = new ScriptedLlm().on('interpret', () => ({ nonsense: true }));
    const r = await new LlmInterpreter(llm, silentLogger).interpret(input('withdrawal nahi aaya'));
    expect(r.source).toBe('lexical');
    expect(r.intent).toBe('withdrawal_issue');
  });

  it('a direction named in the text beats a model that said "unclear" (no case in focus)', () => {
    const base = { relation: 'new_issue' as const, target_case_id: null, claims: NO_CLAIMS, reference: { kind: 'none' as const, index: null }, affirmation: 'none' as const, language: 'hinglish' as const, gist: '', proposed: { registration_number: null, withdrawal_id: null, order_id: null, utr: null, amount: null }, confidence: 0.4 };
    const w = finalize({ ...base, intent: 'payment_issue_unclear', case_type: 'other' }, input('widrawal kiya tha bank me nhi aya'));
    expect([w.intent, w.caseType]).toEqual(['withdrawal_issue', 'withdrawal']);
    const d = finalize({ ...base, intent: 'withdrawal_issue', case_type: 'withdrawal' }, input('pese add kiye wallet me nhi dikh rahe'));
    expect([d.intent, d.caseType]).toEqual(['deposit_issue', 'deposit']); // the text says the opposite of the model, outright
    // With a case in focus the model's contextual reading stands.
    const f = finalize({ ...base, intent: 'payment_issue_unclear', case_type: 'other', relation: 'continue' }, input('widrawal kiya tha bank me nhi aya', { focused: caseSummary({ type: 'deposit' }) }));
    expect(f.intent).toBe('payment_issue_unclear');
  });

  it('uses the LLM result when valid', async () => {
    const llm = new ScriptedLlm().on('interpret', () => ({ ...base, intent: 'general_query', case_type: null, relation: 'side_topic' }));
    const r = await new LlmInterpreter(llm, silentLogger).interpret(input('lineup de do', { focused: caseSummary() }));
    expect(r).toMatchObject({ source: 'llm', intent: 'general_query', relation: 'side_topic' });
    const payload = JSON.parse(llm.calls[0]!.req.user as string);
    expect(payload.focused_case.id).toBe('case-w');
  });

  it('never sends a PDF password to the LLM', async () => {
    const llm = new ScriptedLlm().on('interpret', () => base);
    const signals = computeSignals(['Password:- YENU1304'], { awaitingPassword: true });
    await new LlmInterpreter(llm, silentLogger).interpret({ ...input(''), signals });
    expect(JSON.stringify(llm.calls[0]!.req)).not.toContain('YENU1304');
    expect(signals.passwordCandidates).toEqual(['YENU1304']);
  });
});
