import 'dotenv/config';
import { describe, expect, it } from 'vitest';
import { OpenAiLlm } from '../../src/llm/openai.js';
import { classifyIssue, type IssueCategory } from '../../src/nlu/issueType.js';
import { silentLogger } from '../../src/observability/logger.js';
import { AMBIGUOUS, DEPOSIT, MATCH, OTHER, WITHDRAWAL } from '../helpers/issuePhrases.js';

/**
 * Live evaluation against the real model (RUN_LLM_EVALS=1, OPENAI_API_KEY): the full path — scorer,
 * context, model — on every phrase in the tables, plus phrasings the scorer alone cannot read.
 * Prints the misses so they can be judged, and fails below 95% on deposit/withdrawal.
 */
const run = process.env.RUN_LLM_EVALS === '1' && !!process.env.OPENAI_API_KEY;

/** Phrasings with no cue word at all: only understanding gets these right. */
const HARD_DEPOSIT = ['bhai 500 ka kiya tha kuch dikh nahi raha yaar', 'screenshot bhej raha hu, amount gaya par game me nahi aaya', 'माझे पैसे गेले पण बॅलन्स नाही वाढला', 'transaction id ye hai, wallet me kuch nahi', 'two hundred bheja tha app ko'];
const HARD_WITHDRAWAL = ['bhai mera paisa 4 din se atka hua hai bank ka', 'jo jeeta tha wo abhi tak nahi aaya', 'aaj 5 din ho gaye bank me kuch nahi aaya', 'mera amount kab tak aayega account me', 'paise kaha hai mere'];

describe.skipIf(!run)('issue detection (live model)', () => {
  it('classifies the tables', { timeout: 600_000 }, async () => {
    const llm = new OpenAiLlm({ apiKey: process.env.OPENAI_API_KEY!, baseURL: process.env.OPENAI_BASE_URL, model: process.env.OPENAI_MODEL ?? 'gpt-5.6-terra', timeoutMs: 45_000, log: silentLogger, maxConcurrency: 6 });
    const cases: Array<[string, IssueCategory[]]> = [
      ...DEPOSIT.map((t): [string, IssueCategory[]] => [t, ['deposit']]), ...HARD_DEPOSIT.map((t): [string, IssueCategory[]] => [t, ['deposit']]),
      ...WITHDRAWAL.map((t): [string, IssueCategory[]] => [t, ['withdrawal']]), ...HARD_WITHDRAWAL.map((t): [string, IssueCategory[]] => [t, ['withdrawal']]),
      ...MATCH.map((t): [string, IssueCategory[]] => [t, ['match']]),
      ...OTHER.map((t): [string, IssueCategory[]] => [t, ['other', 'unclear']]),
      ...AMBIGUOUS.map((t): [string, IssueCategory[]] => [t, ['unclear', 'other']]),
    ];
    const results = await Promise.all(cases.map(async ([t, want]) => ({ t, want, got: await classifyIssue(t, llm, silentLogger) })));
    const misses = results.filter((r) => !r.want.includes(r.got.category));
    const money = results.filter((r) => r.want[0] === 'deposit' || r.want[0] === 'withdrawal');
    const moneyMisses = misses.filter((r) => r.want[0] === 'deposit' || r.want[0] === 'withdrawal');
    const bySource = results.reduce<Record<string, number>>((acc, r) => ((acc[r.got.source] = (acc[r.got.source] ?? 0) + 1), acc), {});
    console.log(`\nlive issue detection: ${results.length - misses.length}/${results.length} correct; deposit/withdrawal ${money.length - moneyMisses.length}/${money.length}; decided by ${JSON.stringify(bySource)}`);
    for (const m of misses) console.log(`  MISS ${JSON.stringify(m.t)} want ${m.want.join('|')} got ${m.got.category} (${m.got.source})`);
    expect((money.length - moneyMisses.length) / money.length).toBeGreaterThanOrEqual(0.95);
    // Never the wrong side, and never a case out of a match or other topic.
    expect(misses.filter((m) => m.got.type && !m.want.includes(m.got.type))).toEqual([]);
  });
});
