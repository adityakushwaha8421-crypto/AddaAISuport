import type { LlmClient } from '../llm/client.js';
import type { Logger } from 'pino';
import { moneyDirection } from './moneyDirection.js';
import { lexicalForm } from './normalize.js';

export type IssueType = 'deposit' | 'withdrawal';

export interface IssueVerdict {
  type?: IssueType;
  /** How it was decided: the deterministic direction scorer, the model, or nothing decisive. */
  source: 'lexical' | 'llm' | 'none';
}

const SYSTEM = `You classify ONE customer message sent to the support account of an Indian fantasy-sports app.
Messages are in Hinglish (Hindi written in Latin letters), Hindi (Devanagari) or English, often with spelling mistakes and no punctuation.

Decide the issue type from the DIRECTION the money was meant to move — never from the mere presence of a word:
- "deposit": the customer paid / added / recharged money INTO the app wallet and the wallet or balance does not show it ("paise add nahi hue", "payment kiya balance nahi aaya", "amount kat gaya wallet me nahi aaya", "recharge nahi hua").
- "withdrawal": money LEFT the wallet (withdraw / nikala / payout / winnings) and has not REACHED the bank account ("withdrawal nahi aaya", "bank me paise nahi aaye", "mere paise nahi aaye", "payout pending").
- "other": any other topic (match, points, login, OTP, app, general question, greeting, thanks, complaint without a payment direction).
- "unclear": money is the topic but the direction cannot be told ("amount credit nahi hua", "paisa nahi aaya" with nothing else that says which way).

Reply with JSON only.`;

const SCHEMA = {
  name: 'issue_type',
  schema: {
    type: 'object',
    additionalProperties: false,
    properties: { issue: { type: 'string', enum: ['deposit', 'withdrawal', 'other', 'unclear'] } },
    required: ['issue'],
  },
};

/**
 * Deposit or withdrawal? First the deterministic direction scorer (fast, offline, tested on the
 * phrasing tables); when it cannot tell and the text is more than a word or two, the model is asked
 * once. Anything that is not clearly one of the two is left alone: no guess, no question.
 */
export async function classifyIssue(text: string, llm: LlmClient | undefined, log: Logger): Promise<IssueVerdict> {
  const lexical = lexicalForm(text);
  if (!lexical) return { source: 'none' };
  const dir = moneyDirection(lexical);
  if (dir.type && dir.named) return { type: dir.type, source: 'lexical' };
  const words = lexical.split(' ').filter(Boolean).length;
  if (!llm?.available || words < 2) return dir.type ? { type: dir.type, source: 'lexical' } : { source: 'none' };
  try {
    const r = await llm.json<{ issue: 'deposit' | 'withdrawal' | 'other' | 'unclear' }>({ purpose: 'issue_type', system: SYSTEM, user: text.slice(0, 1500), schema: SCHEMA, maxTokens: 20 });
    if (r.issue === 'deposit' || r.issue === 'withdrawal') return { type: r.issue, source: 'llm' };
    return { source: 'llm' };
  } catch (err) {
    log.warn({ err }, 'issue classification by the model failed; using the lexical reading only');
    return dir.type ? { type: dir.type, source: 'lexical' } : { source: 'none' };
  }
}
