import type { Logger } from 'pino';
import type { LlmClient } from '../llm/client.js';
import { detectMatchIssue } from './matchIssue.js';
import { moneyDirection } from './moneyDirection.js';
import { lexicalForm } from './normalize.js';

export type IssueType = 'deposit' | 'withdrawal';
/** Everything a customer message can be about, as far as the agent needs to know. */
export type IssueCategory = IssueType | 'match' | 'other' | 'unclear';

export interface IssueVerdict {
  /** Set only for a deposit or a withdrawal — the two issues the agent acts on. */
  type?: IssueType;
  category: IssueCategory;
  /** How it was decided. */
  source: 'lexical' | 'context' | 'llm' | 'none';
}

export interface IssueContext {
  /** The customer's earlier messages in this chat, oldest first (recent ones only). */
  history?: string[];
}

const SYSTEM = `You classify the LATEST message a customer sent to the support account of an Indian fantasy-sports app (Fantasy Adda).
Messages are in Hinglish (Hindi in Latin letters), Hindi (Devanagari) or English, often misspelled, unpunctuated, and short. Earlier messages from the same customer may be given as context: a vague latest message ("paisa nahi aaya", "kab tak?", "abhi tak nahi hua") means whatever the earlier messages were about.

Decide from the DIRECTION the money was meant to move, never from the mere presence of a word:
- "deposit": the customer paid / added / recharged money INTO the app wallet and the wallet or balance does not show it.
  Examples: "Paise add nahi hue", "Deposit nahi hua", "Payment kiya but balance nahi aaya", "Wallet me amount nahi dikh raha", "500 add kiye the nahi aaye", "paisa kat gaya wallet me nahi aaya", "recharge nahi hua", "UPI se bheja app me nahi aaya".
- "withdrawal": money LEFT the wallet (withdraw / nikala / payout / winnings) and has not REACHED the customer's bank account.
  Examples: "Withdrawal ka paisa nahi aaya", "Mere paise account me nahi aaye", "Withdraw kiya tha but receive nahi hua", "Mere paise kaha gaye", "Amount bank me credit nahi hua", "winning nahi mili", "payout pending".
- "match": anything about a match, contest, points, lineup, players, result, ranking or prize distribution — even when money is also mentioned (a refund for a cancelled match is "match").
- "other": login, OTP, KYC, app problems, account ban, general questions, greetings, thanks, complaints with no money direction, bonus/cashback questions.
- "unclear": money is the topic but even with the context you cannot tell which way it moved ("amount credit nahi hua" alone).

"Mere paise nahi aaye" with no other clue is a withdrawal: money the customer was waiting to receive. Reply with JSON only.`;

const SCHEMA = {
  name: 'issue_type',
  schema: {
    type: 'object',
    additionalProperties: false,
    properties: { issue: { type: 'string', enum: ['deposit', 'withdrawal', 'match', 'other', 'unclear'] } },
    required: ['issue'],
  },
};

const RECENT_HISTORY = 6;

/**
 * What is this message about? Match cues first (a match problem is never a payment case). Then the
 * deterministic direction scorer on the message; a vague money message borrows the direction the
 * customer's recent messages named. When neither is decisive and the text is more than a word or
 * two, the model is asked once, with the recent history as context. Nothing decisive → left alone.
 */
export async function classifyIssue(text: string, llm: LlmClient | undefined, log: Logger, ctx: IssueContext = {}): Promise<IssueVerdict> {
  const lexical = lexicalForm(text);
  if (!lexical) return { category: 'other', source: 'none' };
  if (detectMatchIssue(text)) return { category: 'match', source: 'lexical' };

  const dir = moneyDirection(lexical);
  if (dir.type && dir.named) return { type: dir.type, category: dir.type, source: 'lexical' };

  // Context: "paisa nahi aaya" / "abhi tak nahi hua" after "kal withdraw kiya tha" is about that withdrawal.
  const history = (ctx.history ?? []).slice(-RECENT_HISTORY);
  const vague = dir.moneyTopic || /\b(?:abhi|abi|ab)\s+tak\b|\bkab\s+tak\b|\bstill\b|\byet\b|\bpending\b|\bstatus\b|\bupdate\b|\bkuch\s+hua\b|\bhua\s+kya\b|\bkya\s+hua\b/.test(lexical);
  if (vague) {
    for (const earlier of [...history].reverse()) {
      const e = lexicalForm(earlier);
      if (!e || detectMatchIssue(earlier)) continue;
      const d = moneyDirection(e);
      if (d.type && d.named) return { type: d.type, category: d.type, source: 'context' };
    }
  }

  const words = lexical.split(' ').filter(Boolean).length;
  if (llm?.available && words >= 2) {
    try {
      const user = history.length
        ? `Earlier messages from this customer (oldest first):\n${history.map((h) => `- ${h.slice(0, 300)}`).join('\n')}\n\nLatest message:\n${text.slice(0, 1500)}`
        : text.slice(0, 1500);
      const r = await llm.json<{ issue: IssueCategory }>({ purpose: 'issue_type', system: SYSTEM, user, schema: SCHEMA, maxTokens: 20 });
      if (r.issue === 'deposit' || r.issue === 'withdrawal') return { type: r.issue, category: r.issue, source: 'llm' };
      if (r.issue === 'match' || r.issue === 'other' || r.issue === 'unclear') return { category: r.issue, source: 'llm' };
    } catch (err) {
      log.warn({ err }, 'issue classification by the model failed; using the lexical reading only');
    }
  }
  // No model (or it failed): the scorer's unnamed lean stands ("mere paise nahi aaye" → withdrawal).
  if (dir.type) return { type: dir.type, category: dir.type, source: 'lexical' };
  return { category: dir.moneyTopic ? 'unclear' : 'other', source: 'none' };
}
