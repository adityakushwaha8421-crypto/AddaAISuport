import { describe, expect, it } from 'vitest';
import { ScriptedLlm } from '../../src/llm/fake.js';
import type { CaseSummary, InterpreterInput } from '../../src/nlu/context.js';
import { finalize, LlmInterpreter } from '../../src/nlu/interpreter.js';
import { lexicalInterpret } from '../../src/nlu/lexical.js';
import { detectMatchIssue } from '../../src/nlu/matchIssue.js';
import { computeSignals } from '../../src/nlu/signals.js';
import { NO_CLAIMS } from '../../src/nlu/types.js';
import { silentLogger } from '../../src/observability/logger.js';

function input(text: string, over: Partial<InterpreterInput> = {}): InterpreterInput {
  return {
    signals: computeSignals([text], { awaitingPassword: false, now: new Date('2026-09-11T10:00:00Z'), hasMedia: false }),
    others: [],
    history: [],
    evidence: [],
    ...over,
  };
}

const depositCase: CaseSummary = { id: 'case-d', type: 'deposit', status: 'open', step: 'collecting', lastAsked: ['registration_number'], known: [], lastActivityMinutesAgo: 1 };

describe('match issue detection (degraded-mode fallback)', () => {
  it.each([
    ['mere points galat update hue hain', 'wrong_points'],
    ['sir virat ke points kam aaye', 'wrong_points'],
    ['wrong points given in yesterday match', 'wrong_points'],
    ['पॉइंट गलत है', 'wrong_points'],
    ['match under review dikha raha hai', 'match_under_review'],
    ['contest review me hai kab tak', 'match_under_review'],
    ['points abhi tak update nahi hue', 'late_points'],
    ['live points stuck hai', 'late_points'],
    ['lineup galat hai sir', 'lineup'],
    ['playing 11 update nahi hua', 'lineup'],
    ['match extend kyu kiya', 'match_extension'],
    ['deadline extend ho gaya bina bataye', 'match_extension'],
    ['mera player missing hai team me', 'player_missing'],
    ['rohit player list me nahi dikh raha', 'player_missing'],
    ['result galat declare hua', 'match_result'],
    ['match abandoned ho gaya paisa?', 'match_result'],
    ['kal wale match me problem hai', 'other_match'],
  ])('"%s" → %s', (text, category) => {
    expect(detectMatchIssue(text)?.category).toBe(category);
  });

  it.each([
    'deposit nahi aaya',
    'withdrawal abhi tak nahi aaya',
    'Sir lineup de diya karo', // asking for lineup tips, not reporting a problem
    'sir lineup kab aayega?',
    'match kab start hoga?',
    'hello sir',
    'mera number 9810822372 hai',
    'points galat the ab theek ho gaya thanks',
    'match me koi problem nahi hai',
  ])('"%s" → not a match issue', (text) => {
    expect(detectMatchIssue(text)).toBeUndefined();
  });

  it('a match screenshot counts even without words; the words decide the category when present', () => {
    const shot = [{ category: 'match_screenshot', confidence: 0.9 }];
    expect(detectMatchIssue('', shot)).toEqual({ category: 'other_match' });
    expect(detectMatchIssue('lineup galat hai', shot)).toEqual({ category: 'lineup' });
    expect(detectMatchIssue('', [{ category: 'match_screenshot', confidence: 0.3 }])).toBeUndefined();
  });
});

describe('lexical interpreter', () => {
  it('a pure match problem is a match_issue turn that touches no case', () => {
    const r = lexicalInterpret(input('mere points galat update hue'));
    expect(r).toMatchObject({ intent: 'match_issue', matchIssue: { category: 'wrong_points' }, relation: 'none' });
    expect(r.caseType).toBeUndefined();
  });

  it('an open deposit case does not swallow a match complaint', () => {
    expect(lexicalInterpret(input('lineup galat hai sir', { focused: depositCase })).intent).toBe('match_issue');
  });

  it('a deposit problem that also mentions a match keeps the deposit intent and still flags the match', () => {
    const r = lexicalInterpret(input('deposit nahi aaya aur points bhi galat hai'));
    expect(r.intent).toBe('deposit_issue');
    expect(r.matchIssue).toEqual({ category: 'wrong_points' });
  });
});

describe('LLM interpretation', () => {
  const base = {
    intent: 'match_issue' as const, case_type: null, relation: 'none' as const, target_case_id: null, claims: { ...NO_CLAIMS },
    reference: { kind: 'none' as const, index: null }, affirmation: 'none' as const, language: 'hinglish' as const, gist: 'match problem',
    proposed: { registration_number: null, withdrawal_id: null, order_id: null, utr: null, amount: null }, confidence: 0.9,
  };

  it("takes the model's category", () => {
    const r = finalize({ ...base, match_issue: { detected: true, category: 'player_missing' } }, input('mera player nahi hai'));
    expect(r.matchIssue).toEqual({ category: 'player_missing' });
  });

  it('keeps a match_issue intent consistent even if the model left the category out', () => {
    expect(finalize({ ...base, match_issue: { detected: false, category: null } }, input('match ka kuch karo')).matchIssue).toEqual({ category: 'other_match' });
  });

  it('flags a match problem raised next to a deposit issue without changing the intent', () => {
    const r = finalize({ ...base, intent: 'deposit_issue', case_type: 'deposit', relation: 'new_issue', match_issue: { detected: true, category: 'wrong_points' } }, input('deposit nahi aaya, points bhi galat'));
    expect(r.intent).toBe('deposit_issue');
    expect(r.matchIssue).toEqual({ category: 'wrong_points' });
  });

  it('the model is authoritative: keywords alone do not flag a chat it read as something else', () => {
    const r = finalize({ ...base, intent: 'general_query', match_issue: { detected: false, category: null } }, input('lineup galat hai kya pata'));
    expect(r.matchIssue).toBeUndefined();
  });

  it('asks the model for the field, and still accepts output that lacks it', async () => {
    const llm = new ScriptedLlm().on('interpret', () => ({ ...base, intent: 'greeting' }));
    const r = await new LlmInterpreter(llm, silentLogger).interpret(input('hello'));
    expect(r).toMatchObject({ source: 'llm', intent: 'greeting' });
    expect(r.matchIssue).toBeUndefined();
    const schema = (llm.calls[0]!.req as { schema?: { schema: { required: string[] } } }).schema;
    expect(schema?.schema.required).toContain('match_issue');
  });
});
