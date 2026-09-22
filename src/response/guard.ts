import { actFacts, type Act } from './acts.js';

export interface GuardVerdict {
  ok: boolean;
  reason?: string;
}

const norm = (s: string) => s.replace(/[,\s]/g, '');

const FORWARD_CLAIM = /\b(forward|forwarded|escalat\w*|handed over|transferred|our team|the team|team ko|team ke paas|team check|team dekh|manually check)\b|टीम/i;
const RECEIPT_CLAIM = /\b(statement|screenshot|pdf|document|details?)\b[^.!?\n]{0,25}\b(mil gaya|mil gayi|mil gye|received|mila hai|aa gaya|aa gayi)\b/i;
const SUCCESS_CLAIM = /\b(successful(ly)?|success|credit ho gaya|credited|process ho chuka|processed|verify ho gaya|verified)\b/i;
const HUMAN_CLAIM = /\b(main|mai|mein)\s+(ek\s+)?(insaan|human|real person|aadmi)\b|\bi\s*(am|'m)\s+(a\s+)?(human|real person)\b/i;
const TIMELINE_PROMISE = /\b(\d+\s*(minute|min|hour|ghante|ghanta|hrs?|din|days?)|24\s*(hours|ghante)|within\b|andar)\b/i;
/** A reply that opens with a welcome: only the plan decides when the customer is greeted (once a day). */
const OPENING_GREETING = /^\W*(hi+|hello|hey+|hlo|namaste|namaskar|good\s*(morning|afternoon|evening|night)|नमस्ते|नमस्कार|सुप्रभात)\b/i;

/**
 * Reject LLM phrasing that adds facts or claims the plan does not contain. Any digit run of 3+
 * digits must come from the plan, the deterministic draft, or the user's own words.
 */
export function guardResponse(text: string, ctx: { acts: Act[]; draft: string; userText: string }): GuardVerdict {
  const t = text.trim();
  if (!t) return { ok: false, reason: 'empty' };
  if (t.length > 700) return { ok: false, reason: 'too_long' };

  const allowed = norm([ctx.draft, ctx.userText, ...actFacts(ctx.acts)].join(' ')).toUpperCase();
  for (const m of t.matchAll(/\d[\d,]*(?:\.\d+)?/g)) {
    const digits = norm(m[0]).replace(/\.0+$/, '');
    if (digits.replace(/\D/g, '').length >= 3 && !allowed.includes(digits.toUpperCase())) {
      return { ok: false, reason: `unverified_number:${digits}` };
    }
  }
  for (const m of t.matchAll(/\b(?=[A-Z0-9-]*\d)(?=[A-Z0-9-]*[A-Z])[A-Z0-9][A-Z0-9-]{5,}\b/g)) {
    if (!allowed.includes(norm(m[0]).toUpperCase())) return { ok: false, reason: `unverified_identifier:${m[0]}` };
  }

  const types = new Set(ctx.acts.map((a) => a.type));
  // Handoffs are silent: the customer is never told about escalation, forwarding or waiting.
  if (FORWARD_CLAIM.test(t)) return { ok: false, reason: 'mentions_team_or_escalation' };
  const receiptOk = types.has('received');
  if (!receiptOk && RECEIPT_CLAIM.test(t)) return { ok: false, reason: 'receipt_claim_without_receipt' };
  const successOk = ['deposit_success', 'withdrawal_success', 'statement_credit_found'].some((k) => types.has(k as Act['type']));
  if (!successOk && SUCCESS_CLAIM.test(t) && !SUCCESS_CLAIM.test(ctx.draft)) return { ok: false, reason: 'success_claim_without_verification' };
  if (HUMAN_CLAIM.test(t)) return { ok: false, reason: 'claims_human_identity' };
  if (!types.has('greeting') && OPENING_GREETING.test(t)) return { ok: false, reason: 'unplanned_greeting' };
  if (TIMELINE_PROMISE.test(t) && !TIMELINE_PROMISE.test(ctx.draft) && !ctx.acts.some((a) => a.type === 'general_answer')) {
    return { ok: false, reason: 'invented_timeline' };
  }
  return { ok: true };
}
