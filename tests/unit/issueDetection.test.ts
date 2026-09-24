import { describe, expect, it } from 'vitest';
import { silentLogger } from '../../src/observability/logger.js';
import { classifyIssue } from '../../src/nlu/issueType.js';
import { AMBIGUOUS, DEPOSIT, MATCH, OTHER, WITHDRAWAL } from '../helpers/issuePhrases.js';

/**
 * Issue detection without the model (what runs when OPENAI_API_KEY is missing, and the first pass
 * always): deposit and withdrawal read from the direction of the money; match problems recognised
 * first; everything else left alone. Context from the customer's earlier messages resolves vague
 * follow-ups.
 */
const classify = (text: string, history?: string[]) => classifyIssue(text, undefined, silentLogger, { history });

describe('issue detection (offline)', () => {
  it('every deposit phrase is a deposit', async () => {
    const wrong: string[] = [];
    for (const t of DEPOSIT) if ((await classify(t)).type !== 'deposit') wrong.push(t);
    expect(wrong).toEqual([]);
  });

  it('every withdrawal phrase is a withdrawal', async () => {
    const wrong: string[] = [];
    for (const t of WITHDRAWAL) if ((await classify(t)).type !== 'withdrawal') wrong.push(t);
    expect(wrong).toEqual([]);
  });

  it('a match problem is a match, even when money is mentioned', async () => {
    const wrong: string[] = [];
    for (const t of MATCH) if ((await classify(t)).category !== 'match') wrong.push(t);
    expect(wrong).toEqual([]);
  });

  it('other support topics and small talk are never a deposit or withdrawal', async () => {
    const wrong: string[] = [];
    for (const t of [...OTHER, ...AMBIGUOUS]) {
      const v = await classify(t);
      if (v.type) wrong.push(`${t} -> ${v.type}`);
    }
    expect(wrong).toEqual([]);
  });

  it('a vague follow-up takes the direction from the customer\'s earlier messages', async () => {
    expect(await classify('paisa nahi aaya', ['kal 500 add kiye the'])).toMatchObject({ type: 'deposit', source: 'context' });
    expect(await classify('abhi tak nahi hua', ['maine withdraw kiya tha 2000'])).toMatchObject({ type: 'withdrawal', source: 'context' });
    expect(await classify('kab tak aayega', ['payment kar diya hai wallet me nahi aaya', 'hello?'])).toMatchObject({ type: 'deposit', source: 'context' });
    expect(await classify('amount credit nahi hua', ['nikala tha paisa'])).toMatchObject({ type: 'withdrawal', source: 'context' });
    // The latest message that names a side wins over older ones; a match message in between is skipped.
    expect(await classify('status kya hai', ['deposit nahi hua', 'lineup galat thi', 'withdraw kiya tha'])).toMatchObject({ type: 'withdrawal', source: 'context' });
    // A clear message needs no context and is not overridden by it.
    expect(await classify('deposit nahi hua', ['withdraw kiya tha'])).toMatchObject({ type: 'deposit', source: 'lexical' });
    // No money talk at all: the history does not turn small talk into a case.
    expect((await classify('hello sir', ['withdraw kiya tha'])).type).toBeUndefined();
  });

  it('with no context, the bare "mere paise nahi aaye" leans withdrawal (money the customer was waiting to receive)', async () => {
    expect((await classify('mere paise nahi aaye')).type).toBe('withdrawal');
    expect((await classify('paisa nahi aaya')).type).toBe('withdrawal');
  });
});
