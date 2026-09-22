import 'dotenv/config';
import { describe, expect, it } from 'vitest';
import { OpenAiLlm } from '../../src/llm/openai.js';
import type { CaseSummary, InterpreterInput } from '../../src/nlu/context.js';
import { LlmInterpreter } from '../../src/nlu/interpreter.js';
import { computeSignals } from '../../src/nlu/signals.js';
import type { Interpretation } from '../../src/nlu/types.js';
import { silentLogger } from '../../src/observability/logger.js';

/**
 * Live evaluation of the LLM interpreter against the real model. Opt-in (costs tokens):
 *   RUN_LLM_EVALS=1 OPENAI_API_KEY=… npm run test:llm
 * Each case checks only the properties that matter for routing/decisions.
 */
const enabled = process.env.RUN_LLM_EVALS === '1' && !!process.env.OPENAI_API_KEY;

const withdrawalCase = (over: Partial<CaseSummary> = {}): CaseSummary => ({
  id: 'case-w-1', type: 'withdrawal', status: 'open', step: 'collecting', lastAsked: [], known: [], lastActivityMinutesAgo: 2, ...over,
});

interface EvalCase {
  name: string;
  text: string;
  ctx?: Partial<InterpreterInput>;
  expect: (i: Interpretation) => void;
}

const CASES: EvalCase[] = [
  {
    name: '"upper wala" after a candidate list',
    text: 'upper wala',
    ctx: {
      focused: withdrawalCase({ step: 'awaiting_selection', lastAsked: ['withdrawal_choice'] }),
      lastBot: { text: 'Sir, screenshot mein 3 withdrawals dikh rahe hain. Kaunsa wala check karna hai?\n1. ₹1,450 · WD-1\n2. ₹700 · WD-2\n3. ₹300 · WD-3', acts: ['choose_candidate'] },
    },
    expect: (i) => {
      expect(i.relation).toBe('continue');
      expect(i.reference).toEqual({ kind: 'index', index: 1 });
    },
  },
  {
    name: 'unrelated request pauses the case',
    text: 'Sir lineup de diya karo',
    ctx: { focused: withdrawalCase() },
    expect: (i) => {
      expect(i.intent).toBe('general_query');
      expect(i.relation).toBe('side_topic');
    },
  },
  {
    name: 'returning to a paused case',
    text: 'mera withdrawal wala check karo',
    ctx: { others: [withdrawalCase({ status: 'paused' })] },
    expect: (i) => {
      expect(i.relation).toBe('resume');
      expect(i.targetCaseId).toBe('case-w-1');
    },
  },
  {
    name: '"credit nahi hua" after a success report',
    text: 'credit nahi hua bhai',
    ctx: {
      focused: withdrawalCase({ status: 'resolved', step: 'informed_success', known: ['withdrawal_id', 'payout_status:SUCCESS'] }),
      lastBot: { text: 'Sir, aapka ₹1,450 withdrawal successfully process ho chuka hai ✅', acts: ['withdrawal_success'] },
    },
    expect: (i) => {
      expect(i.relation).toBe('continue');
      expect(i.claims.notReceived).toBe(true);
    },
  },
  {
    name: 'cannot provide the statement',
    text: 'mere paas statement nahi hai bhai, jo hai usi se dekh lo',
    ctx: { focused: withdrawalCase({ lastAsked: ['bank_statement'], step: 'awaiting_statement' }) },
    expect: (i) => expect(i.claims.refusesDocuments).toBe(true),
  },
  {
    name: 'a promise is not a delivery',
    text: 'statement kal bhej dunga',
    ctx: { focused: withdrawalCase({ lastAsked: ['bank_statement'] }) },
    expect: (i) => {
      expect(i.claims.willSendLater).toBe(true);
      expect(i.claims.refusesDocuments).toBe(false);
    },
  },
  {
    name: 'ambiguous money problem with no context',
    text: 'paisa nahi aaya',
    expect: (i) => expect(['withdrawal_issue', 'payment_issue_unclear', 'unclear']).toContain(i.intent),
  },
  {
    name: 'Hindi script',
    text: 'मेरा पैसा अभी तक बैंक में नहीं आया',
    ctx: { focused: withdrawalCase() },
    expect: (i) => {
      expect(i.language).toBe('hindi');
      expect(i.claims.notReceived).toBe(true);
    },
  },
  {
    name: 'English, new withdrawal issue',
    text: 'I have not received my withdrawal yet',
    expect: (i) => {
      expect(i.intent).toBe('withdrawal_issue');
      expect(i.language).toBe('english');
    },
  },
  {
    name: 'number correction is information, not a new issue',
    text: 'number dusra hai 9810822372',
    ctx: { focused: withdrawalCase({ type: 'deposit', lastAsked: ['registration_number'] }) },
    expect: (i) => {
      expect(i.relation).toBe('continue');
      expect(i.proposed?.registrationNumber).toBe('9810822372');
    },
  },
];

describe.skipIf(!enabled)('LLM interpreter (live model)', () => {
  // Built lazily: skipped suites are still collected, and the client refuses to construct without a key.
  let interpreter: LlmInterpreter | undefined;
  const getInterpreter = () =>
    (interpreter ??= new LlmInterpreter(
      new OpenAiLlm({ apiKey: process.env.OPENAI_API_KEY ?? '', model: process.env.OPENAI_MODEL ?? 'gpt-5.6-terra', visionModel: process.env.OPENAI_VISION_MODEL ?? 'gpt-5.6-terra', timeoutMs: 60_000, log: silentLogger }),
      silentLogger,
    ));
  it.each(CASES)('$name', async (c) => {
    const input: InterpreterInput = {
      signals: computeSignals([c.text], { awaitingPassword: false }),
      others: [],
      history: [],
      evidence: [],
      ...c.ctx,
    };
    const result = await getInterpreter().interpret(input);
    expect(result.source).toBe('llm');
    c.expect(result);
  }, 60_000);
});
