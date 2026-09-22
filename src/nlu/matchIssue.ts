import { lexicalForm } from './normalize.js';

export const MATCH_ISSUE_CATEGORIES = [
  'wrong_points',
  'match_under_review',
  'late_points',
  'lineup',
  'match_extension',
  'player_missing',
  'match_result',
  'other_match',
] as const;

export type MatchIssueCategory = (typeof MATCH_ISSUE_CATEGORIES)[number];

/** A problem with a match or contest outcome. These chats are organised for humans, never answered. */
export interface MatchIssue {
  category: MatchIssueCategory;
}

/**
 * `a`, then within `gap` words `b` — so "points … galat" counts, but a "points" early in a long
 * message and an unrelated "galat" at its end do not. Lookarounds instead of \b so Devanagari works.
 */
const near = (a: string, b: string, gap = 4) => new RegExp(`(?<!\\w)(?:${a})(?:\\s+\\S+){0,${gap}}?\\s+(?:${b})(?!\\w)`, 'u');

const POINTS = 'points?|pts|पॉइंट\\S*|अंक';
const WRONG = 'galat|glat|wrong|incorrect|kam|less|mismatch|minus|deduct\\w*|sahi\\s+(?:nahi|nhi)|गलत|कम';
const NOT_UPDATED =
  '(?:update\\w*|add\\w*|aaye|aaya|aye|reflect\\w*|credit\\w*|dikh\\w*)\\s+(?:nahi|nhi|not|na)|(?:nahi|nhi|not)\\s+(?:update\\w*|aaye|aaya|dikh\\w*)|late|der\\s+se|slow|stuck|atak\\w*|atka|ruk\\w*|अपडेट\\s+नहीं|देर';
const LINEUP = 'lineup|line\\s+up|playing\\s+(?:11|xi|eleven)|लाइनअप';
const LINEUP_PROBLEM = 'galat|glat|wrong|incorrect|nahi|nhi|not|late|change\\w*|missing|issue|problem|गलत|नहीं';

/** Checked in order: the most specific reading wins ("points under review" is a review, not wrong points). */
const RULES: Array<[MatchIssueCategory, RegExp[]]> = [
  ['match_under_review', [/(?<!\w)(?:under|in)\s+review(?!\w)/, /(?<!\w)review\s+(?:me|mein|mai|m|pe|par|ho\w*|chal\w*|lag\w*)(?!\w)/, /रिव्यू|समीक्षा/]],
  ['match_extension', [near('match|deadline|contest|मैच', 'extend\\w*|extension|delay\\w*|postpone\\w*|badha\\w*|बढ़ा\\S*', 3)]],
  [
    'player_missing',
    [
      near('player\\w*|khiladi\\w*|खिलाड़ी', 'missing|gayab|(?:nahi|nhi)\\s+(?:dikh\\w*|aa\\w*|mil\\w*|hai|show\\w*)|not\\s+(?:showing|available|visible|listed|there)|गायब|नहीं', 4),
      near('missing|gayab', 'player\\w*|khiladi\\w*', 1),
    ],
  ],
  ['lineup', [near(LINEUP, LINEUP_PROBLEM, 4), near('galat|glat|wrong|incorrect', LINEUP, 1)]],
  ['wrong_points', [near(POINTS, WRONG, 4), near(WRONG, POINTS, 2)]],
  ['late_points', [near(POINTS, NOT_UPDATED, 4), near('score\\w*', 'update\\w*\\s+(?:nahi|nhi|not)|stuck|atak\\w*', 3)]],
  [
    'match_result',
    [
      near('result\\w*|winner\\w*|rank\\w*|leaderboard|prize\\w*|रिजल्ट', 'galat|glat|wrong|incorrect|nahi|nhi|not|pending|declare\\w*|missing|गलत|नहीं', 4),
      /(?<!\w)(?:match|contest)\s+(?:abandon\w*|cancel\w*|washed\s+out|no\s+result)(?!\w)/,
    ],
  ],
  ['other_match', [near('match\\w*|contest|मैच', 'issue|problem|dikkat|gadbad|galat|glat|wrong|error|(?:nahi|nhi)\\s+(?:dikh\\w*|chal\\w*|hua|aaya)|not\\s+(?:showing|working|updated)|समस्या|गलत|गड़बड़', 4)]],
];

/** "koi problem nahi", "theek ho gaya": talking about a match without a problem to review. */
const NO_PROBLEM = /(?<!\w)(?:koi|no)\s+(?:issue|problem|dikkat|gadbad)(?!\w)|(?<!\w)(?:issue|problem|dikkat)\s+(?:nahi|nhi)\s+(?:hai|h|he)(?!\w)|(?<!\w)(?:theek|thik|solve|resolve)\w*\s+ho\s+gaya(?!\w)|(?<!\w)resolved(?!\w)/;

/**
 * Degraded-mode detector, used when the LLM is unavailable (the LLM interpreter is the primary
 * reader). A match screenshot the customer sent counts as a match problem even without words.
 */
export function detectMatchIssue(text: string, evidence: ReadonlyArray<{ category: string; confidence: number }> = []): MatchIssue | undefined {
  const t = lexicalForm(text);
  if (t && NO_PROBLEM.test(t)) return undefined;
  for (const [category, patterns] of RULES) if (t && patterns.some((p) => p.test(t))) return { category };
  if (evidence.some((e) => e.category === 'match_screenshot' && e.confidence >= 0.6)) return { category: 'other_match' };
  return undefined;
}
