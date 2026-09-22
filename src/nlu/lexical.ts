import type { CaseType } from '../domain/cases.js';
import { EVIDENCE_CASE_TYPE, type InterpreterInput } from './context.js';
import { detectMatchIssue } from './matchIssue.js';
import { moneyDirection } from './moneyDirection.js';
import { lexicalForm } from './normalize.js';
import type { Claims, Intent, Interpretation, TopicRelation } from './types.js';

/**
 * Degraded-mode interpreter used when the LLM is unavailable (and as a deterministic baseline in
 * tests). It scores multilingual lexicons and combines them with structural signals — evidence
 * types, extracted entities, reply context and the focused case — which carry most of the weight.
 * Its confidence is deliberately capped so downstream decisions stay conservative.
 */

type Lex = RegExp[];

/**
 * Deposit vs withdrawal is decided by `moneyDirection` (which way the money was meant to move);
 * these lexicons cover the other topics. Strong cues name the topic outright; weak cues are shared words.
 */
const TOPIC: Record<'account' | 'technical', { strong: Lex; weak: Lex }> = {
  account: {
    strong: [
      /\bkyc\b/, /\blogin\s*(nahi|nhi|not|problem|issue)/, /\bpassword\s*(reset|change|bhool|forgot)/,
      /\baccount\s*(block\w*|band|suspend\w*|ban\w*|delete\w*|lock\w*|verify)/, /\bpan\s*card\b/, /\baadhaar|aadhar\b/,
      /\botp\s*(nahi|nhi|not)\s*(aa|aaya|aya|mil)/, /\bmobile\s*number\s*(change|update)/,
    ],
    weak: [/\bprofile\b/],
  },
  technical: {
    strong: [
      /\bapp\s*(crash\w*|band\s*ho|nahi\s*chal|not\s*working|open\s*nahi|hang\w*|slow)/, /\bnot\s*working\b/,
      /\bchal\s*(nahi|nhi)\s*raha/, /\bscreen\s*(black|white|blank)/, /\bcontest\s*(join\s*nahi|nahi\s*join)/,
      /\bapp\b[^.]{0,20}\b(band|close|crash\w*|hang\w*|freeze|atak|ruk)\s*(ho|ja)/,
    ],
    weak: [/\berror\b/, /\bbug\b/, /\bload\s*(nahi|nhi|not)/, /\bstuck\b/, /\bglitch\w*/],
  },
};

const CLAIMS: Record<keyof Claims, Lex> = {
  notReceived: [
    /\b(nahi|nhi|nahin|na|not|nai)\s*(aaya|aya|aaye|aye|aayi|ayi|aai|mila|mili|mile|hua|huwa|hue|received?|credit(ed)?|reflect(ed)?|pahuncha|pohcha|dikha|dikh\s*raha|show\s*ho)/,
    /\b(credit|receive|reflect|add)\s*(nahi|nhi|not)\b/, /\bnot\s*(yet\s*)?(received|credited|reflected|added)/,
    /\babhi\s*tak\s*(nahi|nhi)/, /\bpaisa\s*(kat|cut)/, /\bkat\s*(gaya|gya|liya)\b/, /\bdeduct\w*/, /\bmissing\b/,
    /नहीं आया|नहीं मिला|नहीं हुआ/,
  ],
  refusesDocuments: [
    /\bstatement\s*(nahi|nhi|nahin)\s*(hai|h|he|de\s*sakta|de\s*sakti|milega|bhej\s*sakta|nikal\s*sakta|nikalta|dunga)/,
    /\b(nahi|nhi|nahin)\s*(de|bhej)\s*(sakta|sakti|paunga|paaunga|sakte|payenge)/, /\b(mere|mera)\s*pass\s*(nahi|nhi)\b/,
    /\bdon'?t\s*have\b/, /\bcan'?t\s*(send|provide|share|give)/, /\bno\s*statement\b/, /\bkyu\s*(du|dun|bheju|bhejun)\b/,
    /\bjo\s*(hai|details|diya)\s*(usi|us)\s*se\b/, /\bstatement\s*nahi\s*milta\b/, /\bpdf\s*(nahi|nhi)\s*(hai|h|milta|nikalta)/,
  ],
  wantsHuman: [
    /\b(human|agent|executive|customer\s*care|real\s*person|insaan|kisi\s*(se|insaan\s*se)\s*baat|call\s*(karo|kijiye|me|back)|baat\s*karao|baat\s*karni|manager|senior|team\s*se\s*baat)\b/,
  ],
  frustrated: [
    /\bkitni\s*baar\b/, /\bkab\s*tak\b/, /\bfraud\b/, /\bscam\b/, /\bbekar\b/, /\bwaste\b/, /\bchor\w*/, /\bharass\w*/,
    /\bconsumer\s*court\b/, /\bpolice\b/, /\bbaar\s*baar\b/, /\bdobara\s*(kyu|kyon|kitna)/, /\bpagal\b/, /\bbewakoof\b/,
  ],
  alreadySent: [
    // "(bhej|de) diya karo" is a habitual request ("please do send"), not a past action.
    /\b(already|pehle\s*hi|pahle\s*hi)\b/, /\bbhej\s*(diya|diye|di|chuka|chuki)\b(?!\s*kar)/, /\bbheja\s*(hai|tha|h)\b/,
    /\bde\s*(diya|chuka)\b(?!\s*kar)/, /\bupar\s*(hai|bheja|dekho)\b/, /\bsent\s*(already|it)\b/,
  ],
  willSendLater: [
    /\bbaad\s*(me|mein|m)\b/, /\bthodi\s*der\b/, /\bkal\s*(bhej\w*|dunga|de\s*dunga)/, /\blater\b/, /\bbhejta\s*(hu|hoon|hun)\b/,
    /\bbhej\s*raha\b/, /\bbhejunga\b/, /\bnikal\s*ke\s*(bhejta|deta)/,
  ],
  asksWhatIsNeeded: [
    /\bkya\s*(kya\s*)?(bhejna|bhejun|bheju|send|chahiye|dena)\b/, /\baur\s*kya\s*(chahiye|bhejna|bheju)\b/,
    /\bkaunsa\s*(document|file|cheez)\b/, /\bkonsa\s*(document|file)\b/, /\bwhat\s*(do you|should i|else)\s*(need|send|want)\b/,
    /\bwhat\s*is\s*(still\s*)?(missing|needed|required)\b/, /\bkya\s*chahiye\b/, /\bkya\s*missing\b/,
  ],
  confirmsDetails: [/\b(sahi|correct|right|yahi)\s*(hai|h|number|he)\b/, /\bnumber\s*(sahi|correct|same)\b/, /\bwahi\s*number\b/],
};

const GREETING = /^(hi+|hello|hey+|hlo|helo|namaste|namaskar|good\s*(morning|afternoon|evening|night)|gm|kya\s*haal|kaise\s*ho|sab\s*(theek|thik|badhiya))\b/;
const THANKS = /\b(thanks?|thank\s*you|thx|tysm|shukriya|dhanyavad|dhanyawad)\b/;
const ACK = /^(ok+|okay|k|haan|han|ha|hmm+|theek\s*hai|thik\s*hai|thik|theek|acha|accha|achha|ji|done|fine|sure|yes|yup|got\s*it|samajh\s*gaya|alright|good|great|nice|perfect|cool)\b/;
const NO = /^(nahi|nhi|no|nope|na|nahin)\b/;
const QUESTION = /\?|\b(kya|kaise|kab|kyu|kyon|kitna|kitne|kaun|what|how|when|why|where|can you|please|plz|pls|karo|kar\s*do|de\s*do|dijiye|batao)\b/;
/** Nudges/follow-ups that only make sense about the case already being discussed. */
/** The customer says this is one more problem, not the one already open. */
const ANOTHER = /\b(ek\s*(aur|or)|dusra|dusri|doosra|another|one\s*more|second|2nd|naya|nayi|new)\b/i;
const NUDGE = /\b(check|dekh|dekho|dekhiye|status|update|kya\s*hua|jaldi|solve|abhi\s*tak|same|wahi|isme|iska|iski|uska|uski|reply|jawab)\b|\b(kitna|kitni)\s*(time|der|deri|wait)\b|\bkab\s*tak\b|\bhow\s*long\b|\b(paisa|paise|amount|refund|balance|payment)\b.*\bkab\b|\bkab\b.*\b(paisa|paise|amount|refund|balance|payment)\b/;
const RESUME = /\b(mera|meri|mere|wo|woh|us|pehle\s*wala|purana|previous|old)\b.*\b(withdraw\w*|deposit\w*|payment|case|issue)\b|\b(withdrawal|deposit|payment)\s*(wala|wali|ka)\b/;

const hits = (lex: Lex, t: string) => lex.reduce((n, re) => n + (re.test(t) ? 1 : 0), 0);

export function lexicalInterpret(input: InterpreterInput): Interpretation {
  const { signals, focused, others } = input;
  const t = lexicalForm(signals.text);
  const words = t ? t.split(' ').length : 0;

  const claims = Object.fromEntries(
    (Object.keys(CLAIMS) as Array<keyof Claims>).map((k) => [k, hits(CLAIMS[k], t) > 0]),
  ) as unknown as Claims;
  // "refuses" only makes sense in reply to a document request.
  if (claims.refusesDocuments && !(focused?.lastAsked.length || /statement|pdf|screenshot|document/.test(t))) {
    claims.refusesDocuments = false;
  }

  // Topic evidence: words, then structural signals (evidence type / entity type / reply context).
  const scores: Record<string, number> = {};
  for (const [k, lex] of Object.entries(TOPIC)) scores[k] = 2 * hits(lex.strong, t) + 0.5 * hits(lex.weak, t);
  // Money: the direction it should have moved, from natural phrasing in any of the three languages.
  const money = moneyDirection(t);
  scores.deposit = money.deposit;
  scores.withdrawal = money.withdrawal;
  const structural: Record<string, number> = {};
  for (const ev of input.evidence) {
    let ct = EVIDENCE_CASE_TYPE[ev.category];
    // Payment and withdrawal screens of the app look alike: inside a withdrawal case a screenshot
    // the classifier called "payment" is the history screenshot the bot asked for, not a new deposit.
    if (ct === 'deposit' && ev.category === 'payment_screenshot' && focused?.type === 'withdrawal') ct = 'withdrawal';
    if (ct) structural[ct] = (structural[ct] ?? 0) + 2 * ev.confidence;
  }
  if (signals.entities.withdrawalIds.length) structural.withdrawal = (structural.withdrawal ?? 0) + 2;
  if (signals.entities.orderIds.length) structural.deposit = (structural.deposit ?? 0) + 1.5;
  if (input.reply?.caseType) structural[input.reply.caseType] = (structural[input.reply.caseType] ?? 0) + 1;
  for (const [k, v] of Object.entries(structural)) scores[k] = (scores[k] ?? 0) + v;
  const ranked = Object.entries(scores).sort((a, b) => b[1] - a[1]);
  const [bestType, bestScore] = ranked[0] ?? ['', 0];
  const [secondType, secondScore] = ranked[1] ?? ['', 0];
  const isMoney = (k: string) => k === 'deposit' || k === 'withdrawal';
  // Deposit and withdrawal cues that nearly tie describe a money problem whose direction is unknown: ask, don't guess.
  const moneyTie = isMoney(bestType) && isMoney(secondType) && bestScore - secondScore < 1;
  const caseTypeFromSignals = bestScore > 0 && bestScore > secondScore && !moneyTie ? (bestType as CaseType) : undefined;
  // Leaving a focused case for another topic takes a cue that names it: a screenshot, an ID, a
  // topic word or a named money direction — never just "paise nahi aaye", which is a follow-up.
  const namedTopic = !isMoney(bestType) || money.named || (structural[bestType] ?? 0) > 0;
  const matchIssue = detectMatchIssue(signals.text, input.evidence);

  // Identifiers/amounts are case data; a relative date ("aaj", "kal") on its own is not.
  const { dates: _dates, ...idEntities } = signals.entities;
  const hasData =
    signals.hasMedia ||
    signals.passwordCandidates.length > 0 ||
    Object.values(idEntities).some((l) => (l as unknown[]).length > 0) ||
    !!signals.reference;
  const hasIdData = hasData && (signals.passwordCandidates.length > 0 || Object.values(idEntities).some((l) => (l as unknown[]).length > 0) || !!signals.reference);
  const caseAnswer =
    claims.notReceived || claims.refusesDocuments || claims.alreadySent || claims.willSendLater || claims.confirmsDetails || claims.frustrated || claims.asksWhatIsNeeded;

  let intent: Intent;
  if (claims.wantsHuman) intent = 'human_request';
  // A match problem goes to the human team, unless the turn is clearly about a deposit/withdrawal case.
  else if (matchIssue && !(caseTypeFromSignals && bestScore >= 1.5) && !hasIdData) intent = 'match_issue';
  // A focused case is only left for another topic on a strong cue (keyword, evidence, entity).
  else if (caseTypeFromSignals && (caseTypeFromSignals === focused?.type || (bestScore >= 1.5 && namedTopic) || (!focused && bestScore >= 1)))
    intent = `${caseTypeFromSignals}_issue` as Intent;
  // A money problem with no readable direction (or cues both ways): one clarification, not a guess.
  else if ((claims.notReceived || moneyTie || (money.moneyTopic && !hasData && (words <= 8 || /issue|problem|dikkat|pareshani|help|complain/.test(t)))) && !focused && !caseTypeFromSignals)
    intent = 'payment_issue_unclear';
  else if (hasData || (focused && (caseAnswer || signals.skipPassword))) intent = 'provide_info';
  else if (focused && NUDGE.test(t) && words <= 8) intent = 'provide_info';
  else if (THANKS.test(t)) intent = 'thanks';
  else if (GREETING.test(t) && words <= 3) intent = 'greeting';
  else if ((ACK.test(t) || NO.test(t)) && words <= 4) intent = 'acknowledgement';
  else if (words >= 3 || QUESTION.test(t)) intent = 'general_query';
  else intent = 'unclear';

  // Map intent → case type
  const intentType: CaseType | undefined =
    intent === 'deposit_issue' ? 'deposit'
    : intent === 'withdrawal_issue' ? 'withdrawal'
    : intent === 'account_issue' ? 'account'
    : intent === 'technical_issue' ? 'technical'
    : undefined;

  let relation: TopicRelation = 'none';
  let targetCaseId: string | undefined;
  const pausedOfType = (ct: CaseType) => others.find((c) => c.type === ct);

  switch (intent) {
    case 'human_request':
      relation = focused ? 'continue' : 'new_issue';
      break;
    case 'deposit_issue':
    case 'withdrawal_issue':
    case 'account_issue':
    case 'technical_issue': {
      const ct = intentType!;
      const retypable = focused && focused.type === 'other' && focused.step === 'clarify_type';
      // "ek aur deposit ka issue hai": a second problem of the same kind, not the same one again.
      if (focused && (focused.type === ct || retypable) && !ANOTHER.test(t)) relation = 'continue';
      else if (pausedOfType(ct) && (RESUME.test(t) || !hasData || focused)) {
        relation = 'resume';
        targetCaseId = pausedOfType(ct)!.id;
      } else relation = 'new_issue';
      break;
    }
    case 'payment_issue_unclear':
      relation = focused ? 'continue' : 'new_issue';
      break;
    case 'provide_info':
      if (focused) relation = 'continue';
      else if (caseTypeFromSignals && pausedOfType(caseTypeFromSignals)) {
        relation = 'resume';
        targetCaseId = pausedOfType(caseTypeFromSignals)!.id;
      } else if (input.reply?.caseId) {
        relation = 'resume';
        targetCaseId = input.reply.caseId;
      } else relation = caseTypeFromSignals ? 'new_issue' : 'none';
      break;
    case 'acknowledgement':
      // "haan"/"nahi" answering the case's own question continues it.
      relation = focused && focused.lastAsked.length > 0 ? 'continue' : 'none';
      break;
    case 'general_query':
      relation = focused ? 'side_topic' : 'none';
      break;
    case 'unclear':
      relation = focused ? 'continue' : 'none';
      break;
    default:
      relation = 'none';
  }

  // A follow-up inside a real case is about that case ("paise nahi aaye" in a deposit case is not
  // a withdrawal); a case still waiting to learn its type takes the type the signals suggest.
  const continuingReal = intent === 'provide_info' && relation === 'continue' && focused && focused.type !== 'other';
  const caseType = intentType ?? (intent === 'provide_info' ? (continuingReal ? focused.type : caseTypeFromSignals ?? focused?.type) : intent === 'payment_issue_unclear' || intent === 'human_request' ? focused?.type ?? 'other' : undefined);

  return {
    intent,
    caseType,
    relation,
    targetCaseId,
    claims,
    reference: signals.reference,
    affirmation: ACK.test(t) || claims.confirmsDetails ? 'yes' : NO.test(t) ? 'no' : undefined,
    language: signals.language ?? 'hinglish',
    gist: signals.text.slice(0, 160),
    matchIssue,
    confidence: Math.min(0.6, 0.35 + 0.1 * bestScore),
    source: 'lexical',
  };
}
