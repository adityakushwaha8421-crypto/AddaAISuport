import type { OrdinalRef } from '../context/references.js';
import type { CaseType } from '../domain/cases.js';
import type { ExtractedEntities } from './entities.js';
import type { MatchIssue } from './matchIssue.js';

export type Language = 'hinglish' | 'english' | 'hindi';

export type Intent =
  | 'deposit_issue'
  | 'withdrawal_issue'
  | 'payment_issue_unclear' // "paisa nahi aaya" without knowing deposit vs withdrawal
  | 'account_issue'
  | 'technical_issue'
  | 'provide_info' // answering / sending requested details
  | 'general_query' // unrelated question or request (e.g. "lineup de diya karo")
  | 'match_issue' // a problem with a match: points, review, lineup, extension, player, result
  | 'greeting'
  | 'thanks'
  | 'acknowledgement' // ok / haan / theek hai
  | 'human_request'
  | 'unclear';

/** How this turn relates to the conversation's cases. */
export type TopicRelation =
  | 'continue' // about the focused case
  | 'new_issue' // a new independent support issue
  | 'resume' // returning to a paused/older case
  | 'side_topic' // unrelated to any case → pause focus, answer it
  | 'none'; // smalltalk / ack: don't touch cases

export interface Claims {
  /** "paisa nahi aaya", "credit nahi hua", "receive nahi hua" */
  notReceived: boolean;
  /** User declines / cannot provide more documents. */
  refusesDocuments: boolean;
  wantsHuman: boolean;
  frustrated: boolean;
  /** "already bheja", "upar bheja hai" */
  alreadySent: boolean;
  /** "baad mein bhejta hoon" — promises, not deliveries. */
  willSendLater: boolean;
  /** User confirms the registration number they gave is correct. */
  confirmsDetails: boolean;
  /** "kya bhejna hai?", "what should I send?", "aur kya chahiye?" */
  asksWhatIsNeeded: boolean;
}

export const NO_CLAIMS: Claims = {
  notReceived: false,
  refusesDocuments: false,
  wantsHuman: false,
  frustrated: false,
  alreadySent: false,
  willSendLater: false,
  confirmsDetails: false,
  asksWhatIsNeeded: false,
};

export interface Interpretation {
  intent: Intent;
  /** Support-case type this turn concerns, when it concerns one. */
  caseType?: CaseType;
  relation: TopicRelation;
  /** For relation=resume: id of the case being returned to (validated against the user's cases). */
  targetCaseId?: string;
  claims: Claims;
  reference?: OrdinalRef;
  affirmation?: 'yes' | 'no';
  language: Language;
  /** One-line English gist (used for general answers and handoff summaries). */
  gist?: string;
  /** LLM-proposed entities — accepted only if they literally occur in the user's text. */
  proposed?: { registrationNumber?: string; withdrawalId?: string; orderId?: string; utr?: string; amount?: number };
  /** Set when the turn raises a match-related problem (possibly alongside another issue). */
  matchIssue?: MatchIssue;
  confidence: number;
  source: 'llm' | 'lexical';
}

/** Deterministic signals computed before interpretation. */
export interface Signals {
  /** Combined user text of the turn, with passwords/OTPs redacted. Safe for storage and LLM. */
  text: string;
  entities: ExtractedEntities;
  reference?: OrdinalRef;
  passwordCandidates: string[];
  passwordExplicit: boolean;
  skipPassword: boolean;
  hasMedia: boolean;
  /** Undefined when the words carry no clear language signal (IDs, numbers, "ok"). */
  language?: Language;
}
