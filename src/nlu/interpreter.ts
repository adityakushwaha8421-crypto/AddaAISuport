import type { Logger } from 'pino';
import { z } from 'zod';
import type { OrdinalRef } from '../context/references.js';
import { LlmUnavailableError, type LlmClient } from '../llm/client.js';
import { cleanText } from './normalize.js';
import type { InterpreterInput } from './context.js';
import { lexicalInterpret } from './lexical.js';
import { moneyDirection } from './moneyDirection.js';
import { lexicalForm } from './normalize.js';
import { MATCH_ISSUE_CATEGORIES } from './matchIssue.js';
import { NO_CLAIMS, type Interpretation } from './types.js';

const INTENTS = [
  'deposit_issue', 'withdrawal_issue', 'payment_issue_unclear', 'account_issue', 'technical_issue', 'provide_info',
  'general_query', 'match_issue', 'greeting', 'thanks', 'acknowledgement', 'human_request', 'unclear',
] as const;
const CASE_TYPES = ['deposit', 'withdrawal', 'technical', 'account', 'other'] as const;
const RELATIONS = ['continue', 'new_issue', 'resume', 'side_topic', 'none'] as const;

const nullable = (type: string | string[]) => ({ type: [...(Array.isArray(type) ? type : [type]), 'null'] });

/** Strict JSON schema for OpenAI structured outputs (every key required; optionals are nullable). */
const INTERPRETATION_SCHEMA = {
  name: 'turn_interpretation',
  schema: {
    type: 'object',
    additionalProperties: false,
    required: ['intent', 'case_type', 'relation', 'target_case_id', 'claims', 'reference', 'affirmation', 'language', 'gist', 'proposed', 'match_issue', 'confidence'],
    properties: {
      intent: { type: 'string', enum: INTENTS },
      case_type: { type: ['string', 'null'], enum: [...CASE_TYPES, null] },
      relation: { type: 'string', enum: RELATIONS },
      target_case_id: nullable('string'),
      claims: {
        type: 'object',
        additionalProperties: false,
        required: Object.keys(NO_CLAIMS),
        properties: Object.fromEntries(Object.keys(NO_CLAIMS).map((k) => [k, { type: 'boolean' }])),
      },
      reference: {
        type: 'object',
        additionalProperties: false,
        required: ['kind', 'index'],
        properties: {
          kind: { type: 'string', enum: ['none', 'index', 'last', 'this'] },
          index: nullable('integer'),
        },
      },
      affirmation: { type: 'string', enum: ['yes', 'no', 'none'] },
      language: { type: 'string', enum: ['hinglish', 'english', 'hindi'] },
      gist: { type: 'string' },
      proposed: {
        type: 'object',
        additionalProperties: false,
        required: ['registration_number', 'withdrawal_id', 'order_id', 'utr', 'amount'],
        properties: {
          registration_number: nullable('string'),
          withdrawal_id: nullable('string'),
          order_id: nullable('string'),
          utr: nullable('string'),
          amount: nullable('number'),
        },
      },
      match_issue: {
        type: 'object',
        additionalProperties: false,
        required: ['detected', 'category'],
        properties: {
          detected: { type: 'boolean' },
          category: { type: ['string', 'null'], enum: [...MATCH_ISSUE_CATEGORIES, null] },
        },
      },
      confidence: { type: 'number' },
    },
  },
};

const llmOutput = z.object({
  intent: z.enum(INTENTS),
  case_type: z.enum(CASE_TYPES).nullable(),
  relation: z.enum(RELATIONS),
  target_case_id: z.string().nullable(),
  claims: z.object(Object.fromEntries(Object.keys(NO_CLAIMS).map((k) => [k, z.boolean()])) as Record<keyof typeof NO_CLAIMS, z.ZodBoolean>),
  reference: z.object({ kind: z.enum(['none', 'index', 'last', 'this']), index: z.number().int().nullable() }),
  affirmation: z.enum(['yes', 'no', 'none']),
  language: z.enum(['hinglish', 'english', 'hindi']),
  gist: z.string(),
  proposed: z.object({
    registration_number: z.string().nullable(),
    withdrawal_id: z.string().nullable(),
    order_id: z.string().nullable(),
    utr: z.string().nullable(),
    amount: z.number().nullable(),
  }),
  match_issue: z.object({ detected: z.boolean(), category: z.enum(MATCH_ISSUE_CATEGORIES).nullable() }).default({ detected: false, category: null }),
  confidence: z.number().min(0).max(1),
});

const INTERPRETER_SYSTEM = `You are the understanding layer of a customer-support assistant for Fantasy Adda, an Indian fantasy-sports app. Users write in Hinglish, Hindi or English, often in very short fragments ("upar wala", "same", "haan", "isme", "abhi tak nahi mila").

Your job: interpret the CURRENT user turn using ALL context given — recent history, the bot's last message, the message the user swiped/replied to, evidence they just uploaded, and the user's cases (each case lists what was already asked, how many times, what has been received and what is still missing). Never interpret a short message in isolation: first work out what the conversation is about, whether an issue is already pending, what the bot last asked, what the user already provided, and whether this message continues that or starts something new. "ye wala", "upar wala", "isi ka", "same", "haan" only mean something against that context.

Output fields:
- intent: what the user is doing in this turn.
  • deposit_issue: money the user pushed INTO the app wallet — paid, added, recharged, "paise daale", UPI/GPay/PhonePe/Paytm payment, "bank se kat gaye" — and the wallet/balance does not show it.
  • withdrawal_issue: money going OUT of the app to the user's bank — withdrew, "nikale", payout, winnings, "wallet se paise chale gaye", "bank/account me nahi aaye", "transfer nahi hua", a withdrawal pending/stuck.
  • payment_issue_unclear: a money problem whose direction cannot be read from the text or the context.

  Decide deposit vs withdrawal from the DIRECTION the money was meant to move, never from the presence of the words "deposit"/"withdrawal". Users rarely use those words: they write in Hindi, Hinglish or English, with spelling mistakes (withdrawl, widrawal, deposite, recieve, pese, nhi, aya), slang and fragments.
  Deposit phrasings: "paise add nahi hue", "maine payment kar diya but balance nahi aaya", "wallet me amount show nahi ho raha", "paise account me add nahi hue", "money deducted but balance nahi aaya", "payment successful hai but wallet empty hai", "sir paise daale the, abhi tak nahi aaye".
  Withdrawal phrasings: "mere paise nahi aaye", "mere paise kaha gaye", "withdraw kiya tha but amount receive nahi hua", "wallet se paise chale gaye but account me nahi aaye", "withdrawal ka paisa nahi mila", "money abhi tak receive nahi hua", "bank me payment nahi aayi", "mera withdrawal pending hai", "paise account me transfer nahi hue". Money the user was WAITING TO RECEIVE ("nahi aaya", "nahi mila", "receive nahi hua") with nothing said about paying in is a withdrawal.
  Fits both sides — "amount credit nahi hua", "reflect nahi hua", "payment problem": use the conversation (the bot's last question, the focused case, evidence); if nothing decides it, payment_issue_unclear so the bot asks one short question instead of guessing.
  • account_issue (KYC, login, blocked account…), technical_issue (app errors, crashes).
  • provide_info: user is answering the bot or sending details/documents for the current case (numbers, IDs, "haan same number", "statement nahi hai", "upar wala").
  • general_query: an unrelated request/question (e.g. "sir lineup de diya karo", offers, match timings).
  • match_issue: the turn is about a problem with a match or contest result and nothing else — wrong or missing fantasy points, points updated late, match "under review", lineup/playing XI wrong or not updated, match extended/delayed/abandoned, a player missing, wrong result/rank/prize distribution.
  • greeting / thanks / acknowledgement (ok, theek hai, haan with nothing to answer) / human_request / unclear.
- case_type: which support case the turn concerns (null for general/smalltalk).
- relation to the user's cases:
  • continue: about the focused case (including follow-ups like "credit nahi hua" after the bot reported a successful withdrawal).
  • new_issue: a new, independent support problem.
  • resume: the user returns to a paused/older case — set target_case_id to that case's id exactly as given.
  • side_topic: unrelated to the focused case (the case gets paused, NOT closed).
  • none: smalltalk/acks that should not touch any case.
- claims (booleans): notReceived (money not received/credited), refusesDocuments (cannot/will not give requested documents), wantsHuman, frustrated, alreadySent (says they already sent something), willSendLater (promises to send later — this is NOT a delivery), confirmsDetails (confirms given details are correct), asksWhatIsNeeded (asks what to send / what is still missing, e.g. "kya bhejna hai?").
- reference: if the user points at an item of a list/screenshot: index (1 = top/upar/pehla/first, 2 = second/dusra …), last (neeche/last/bottom), this (ye wala/isi ka). Otherwise kind "none".
- affirmation: yes/no when the message answers a yes/no question, else none.
- language: the user's language/script.
- gist: one short English sentence describing what the user means in context.
- proposed: identifiers ONLY if they appear verbatim in the user's current text. Never invent, complete or reformat them. The system discards any value not found literally.
- match_issue: detected=true whenever the turn raises a match-related problem, even alongside another issue (then keep the other intent). category: wrong_points, match_under_review, late_points, lineup, match_extension, player_missing, match_result, or other_match. Asking for lineup tips or match timings is NOT a match issue. Otherwise detected=false and category null.
- confidence: 0..1.

Rules: evidence the user just uploaded and the replied-to message are strong signals. A document/password is only received if it is actually attached — a promise to send is not a delivery. Do not fabricate anything.`;

export interface Interpreter {
  interpret(input: InterpreterInput): Promise<Interpretation>;
}

/** Keep only LLM-proposed identifiers that literally occur in the user's text. */
function literal(value: string | null, text: string): string | undefined {
  if (!value) return undefined;
  const norm = (s: string) => cleanText(s).toUpperCase().replace(/[\s-]/g, '');
  const v = norm(value);
  return v.length >= 3 && norm(text).includes(v) ? value.trim() : undefined;
}

function toRef(r: { kind: string; index: number | null }): OrdinalRef | undefined {
  if (r.kind === 'index' && r.index && r.index > 0) return { kind: 'index', index: r.index };
  if (r.kind === 'last') return { kind: 'last', strict: true };
  if (r.kind === 'this') return { kind: 'this' };
  return undefined;
}

export class LlmInterpreter implements Interpreter {
  constructor(
    private readonly llm: LlmClient,
    private readonly log: Logger,
  ) {}

  async interpret(input: InterpreterInput): Promise<Interpretation> {
    if (!this.llm.available) return lexicalInterpret(input);
    try {
      const raw = await this.llm.json<unknown>({
        purpose: 'interpret',
        system: INTERPRETER_SYSTEM,
        user: JSON.stringify(buildPromptPayload(input)),
        schema: INTERPRETATION_SCHEMA,
        maxTokens: 800,
      });
      return finalize(llmOutput.parse(raw), input);
    } catch (err) {
      if (!(err instanceof LlmUnavailableError)) this.log.warn({ err }, 'interpretation invalid; using lexical fallback');
      return lexicalInterpret(input);
    }
  }
}

function buildPromptPayload(input: InterpreterInput) {
  return {
    current_user_turn: input.signals.text || '(no text)',
    customer_history: input.customer ?? null,
    attachments_this_turn: input.evidence,
    replied_to_message: input.reply ?? null,
    last_bot_message: input.lastBot ?? null,
    focused_case: input.focused ?? null,
    other_cases: input.others,
    recent_history: input.history.slice(-12),
    customer_day: { first_message_today: input.firstMessageOfDay ?? null, already_greeted_today: input.firstMessageOfDay === undefined ? null : !input.firstMessageOfDay },
    deterministic_hints: {
      reference: input.signals.reference ?? null,
      has_media: input.signals.hasMedia,
      entities_found: {
        registration_numbers: input.signals.entities.registrationNumbers.map((e) => e.value),
        withdrawal_ids: input.signals.entities.withdrawalIds.map((e) => e.value),
        order_ids: input.signals.entities.orderIds.map((e) => e.value),
        utrs: input.signals.entities.utrs.map((e) => e.value),
        amounts: input.signals.entities.amounts.map((e) => e.value),
      },
      pdf_password_supplied: input.signals.passwordCandidates.length > 0,
      // Deterministic reading of which way the money was meant to move (cue scores; 0/0 = no direction in the text).
      money_direction_cues: (() => {
        const m = moneyDirection(lexicalForm(input.signals.text));
        return { deposit: m.deposit, withdrawal: m.withdrawal };
      })(),
    },
  };
}

type LlmOutput = z.infer<typeof llmOutput>;

/** Validate/merge raw LLM output with deterministic signals. `match_issue` may be absent in older outputs. */
export function finalize(o: Omit<LlmOutput, 'match_issue'> & Partial<Pick<LlmOutput, 'match_issue'>>, input: InterpreterInput): Interpretation {
  const knownIds = new Set([input.focused?.id, ...input.others.map((c) => c.id)].filter(Boolean) as string[]);
  const text = input.signals.text;
  const lexical = lexicalInterpret(input);
  let relation = o.relation;
  let targetCaseId = o.target_case_id && knownIds.has(o.target_case_id) ? o.target_case_id : undefined;
  if (relation === 'resume' && !targetCaseId) {
    // Model said resume but gave no valid id: resume the most recent case of that type, if any.
    targetCaseId = input.others.find((c) => c.type === o.case_type)?.id;
    if (!targetCaseId) relation = o.case_type ? 'new_issue' : 'none';
  }
  if (relation === 'continue' && !input.focused) relation = o.case_type ? 'new_issue' : 'none';

  const amount = o.proposed.amount;
  const amountLiteral = amount !== null && cleanText(text).replace(/,/g, '').includes(String(amount)) ? amount : undefined;

  // The text names the money's direction outright (a withdraw/deposit word, "bank me nahi aaya",
  // "wallet me add nahi hua") and nothing in the text says the opposite: with no case in focus that
  // reading beats a model that shrugged ("unclear") or picked the other side.
  let intent = o.intent;
  let caseType = o.case_type ?? undefined;
  const money = moneyDirection(lexicalForm(text));
  const direction = money.type;
  const decisive = money.named && Math.min(money.deposit, money.withdrawal) === 0;
  const moneyIntents = new Set(['deposit_issue', 'withdrawal_issue', 'payment_issue_unclear', 'unclear']);
  if (direction && decisive && !input.focused && moneyIntents.has(intent) && caseType !== direction) {
    intent = direction === 'deposit' ? 'deposit_issue' : 'withdrawal_issue';
    caseType = direction;
    if (relation === 'none' || relation === 'side_topic') relation = 'new_issue';
  }

  return {
    intent,
    caseType,
    relation,
    targetCaseId,
    claims: { ...o.claims, wantsHuman: o.claims.wantsHuman || lexical.claims.wantsHuman },
    // Deterministic ordinal parse wins when present; otherwise take the model's reading.
    reference: input.signals.reference ?? toRef(o.reference),
    affirmation: o.affirmation === 'none' ? undefined : o.affirmation,
    language: o.language,
    gist: o.gist.slice(0, 300),
    proposed: {
      registrationNumber: literal(o.proposed.registration_number, text),
      withdrawalId: literal(o.proposed.withdrawal_id, text),
      orderId: literal(o.proposed.order_id, text),
      utr: literal(o.proposed.utr, text),
      amount: amountLiteral,
    },
    matchIssue: o.match_issue?.detected || o.intent === 'match_issue' ? { category: o.match_issue?.category ?? 'other_match' } : undefined,
    confidence: o.confidence,
    source: 'llm',
  };
}
