import { readFile } from 'node:fs/promises';
import type { Logger } from 'pino';
import type { LlmClient } from '../llm/client.js';
import type { Language } from '../nlu/types.js';
import type { Metrics } from '../observability/metrics.js';
import type { Act } from './acts.js';
import { actFacts } from './acts.js';
import { toTelegramHtml } from './format.js';
import { guardResponse } from './guard.js';
import { polish, renderActs } from './templates.js';

export interface ComposeInput {
  acts: Act[];
  language: Language;
  userText: string;
  history: Array<{ role: 'user' | 'bot'; text: string }>;
  /** Learned from this customer: how they address us, and whether they like it very short. */
  address?: 'sir' | 'bhai';
  brief?: boolean;
}

export interface Composed {
  /** Telegram HTML: amounts in bold, IDs in monospace. */
  text: string;
  source: 'template' | 'llm';
  guardRejection?: string;
}

export interface StyleGuide {
  conversation_style?: unknown;
  core_rules?: unknown;
  response_patterns?: unknown;
  bad_patterns_to_avoid?: unknown;
  golden_rule?: unknown;
  [k: string]: unknown;
}

export async function loadStyleGuide(path: string): Promise<StyleGuide> {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as StyleGuide;
  } catch {
    return {};
  }
}

function systemPrompt(style: StyleGuide): string {
  const s = JSON.stringify({
    conversation_style: style.conversation_style,
    core_rules: style.core_rules,
    response_patterns: style.response_patterns,
    bad_patterns_to_avoid: style.bad_patterns_to_avoid,
    golden_rule: style.golden_rule,
  });
  return `You write the final chat reply of Fantasy Adda's Telegram support assistant.
Style guide (follow it): ${s}

You receive a DRAFT produced from verified data and the PLAN it came from.
- Rewrite the DRAFT so it reads naturally in the user's language (the "language" field), like a polite Indian support agent: short, direct, 1–3 sentences (a numbered list of options may stay a list).
- Keep every number, amount, ID, UTR, date and masked account EXACTLY as in the draft. Never add numbers, IDs, dates, timelines, policies or promises that are not in the draft.
- Never claim something was forwarded, received, verified or successful unless the draft says so.
- Never mention the team, escalation, forwarding, "manual check", or ask the customer to wait. Those cases are handled silently in the background.
- Use "sir" at most once; 0–2 fitting emojis, only where they fit the meaning. Never say you are a human.
- Keep the DRAFT's layout: same line breaks, same blank lines between paragraphs, and keep any "•" list with one item per line. Short paragraphs, no wall of text.
- Write plain text only: no markdown, no *asterisks*, no backticks. Amounts, IDs and status are highlighted automatically afterwards.
- For a general_answer act: answer the user's question using ONLY the knowledge snippets in the plan. If they don't cover it, reply politely without inventing facts.
Output only the reply text.`;
}

/**
 * Turns a response plan into text. Deterministic templates are always computed; LLM phrasing is
 * used for richer turns and must pass the guard, otherwise the template is sent.
 */
export class ResponseComposer {
  constructor(
    private readonly deps: { llm: LlmClient; mode: 'template' | 'llm'; style: StyleGuide; log: Logger; metrics?: Metrics },
  ) {}

  async compose(input: ComposeInput): Promise<Composed> {
    const draft = renderActs(input.acts, input.language, input.address);
    // Templates cover every act in all three languages and carry the message layout (titles, fact
    // lines, next steps), which rephrasing would flatten. The model only writes answers from the
    // knowledge base, where the wording has to fit the customer's question.
    const worthRephrasing = !input.brief && input.acts.some((a) => a.type === 'general_answer');
    const format = (t: string) => toTelegramHtml(t, actFacts(input.acts));
    if (this.deps.mode === 'template' || !this.deps.llm.available || !worthRephrasing || !draft) {
      return { text: format(draft), source: 'template' };
    }
    try {
      const text = await this.deps.llm.text({
        purpose: 'compose',
        system: systemPrompt(this.deps.style),
        user: JSON.stringify({
          language: input.language,
          user_message: input.userText,
          recent_conversation: input.history.slice(-6),
          plan: input.acts,
          draft,
        }),
        maxTokens: 400,
      });
      const verdict = guardResponse(text, { acts: input.acts, draft, userText: input.userText });
      if (!verdict.ok) {
        this.deps.metrics?.guardRejections.inc({ reason: verdict.reason?.split(':')[0] });
        this.deps.log.info({ reason: verdict.reason }, 'llm phrasing rejected by guard; using template');
        return { text: format(draft), source: 'template', guardRejection: verdict.reason };
      }
      return { text: format(polish(text, input.address, { fromModel: true })), source: 'llm' };
    } catch (err) {
      this.deps.log.debug({ err }, 'llm phrasing unavailable; using template');
      return { text: format(draft), source: 'template' };
    }
  }
}
