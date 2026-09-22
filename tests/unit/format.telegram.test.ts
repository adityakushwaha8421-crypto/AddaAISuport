import { describe, expect, it } from 'vitest';
import type { Act } from '../../src/response/acts.js';
import { actFacts } from '../../src/response/acts.js';
import { plainText, stripHtml, toTelegramHtml } from '../../src/response/format.js';
import { renderActs } from '../../src/response/templates.js';
import type { Language } from '../../src/nlu/types.js';

const CANDIDATE = { position: 1, amount: 1450, withdrawalId: 'WD-15436-64215', status: 'Success', datetime: '12 Sep', confidence: 0.9 };

/** One example of every act, so no message shape escapes the formatting rules. */
const ALL: Act[] = [
  { type: 'greeting' }, { type: 'thanks' }, { type: 'ack' }, { type: 'frustration_ack' }, { type: 'export_confirmed' }, { type: 'deposit_solved' },
  { type: 'received', items: ['payment_screenshot', 'bank_statement'] },
  { type: 'ask', slots: ['registration_number', 'payment_proof', 'bank_statement', 'payment_video'], mode: 'initial', caseType: 'deposit' },
  { type: 'ask', slots: ['withdrawal_ref', 'bank_statement'], mode: 'initial', caseType: 'withdrawal' },
  { type: 'ask', slots: ['registration_number'], mode: 'followup', caseType: 'deposit' },
  { type: 'ask', slots: ['bank_statement'], mode: 'reminder', caseType: 'withdrawal' },
  { type: 'ask', slots: ['payment_proof'], mode: 'not_found_yet', caseType: 'deposit' },
  { type: 'promise_noted' }, { type: 'clarify_issue_type' },
  { type: 'deposit_success', orderId: 'ORD771001', amount: 500 },
  { type: 'deposit_not_matched', askStatement: true },
  { type: 'deposit_failed', orderId: 'ORD771002', amount: 1000 },
  { type: 'deposit_pending', orderId: 'ORD771003', amount: 250 },
  { type: 'withdrawal_success', amount: 1450, bank: 'HDFC Bank', maskedAccount: 'XXXX6789', askStatement: true },
  { type: 'ask_statement_for_account', bank: 'HDFC Bank', maskedAccount: 'XXXX6789' },
  { type: 'withdrawal_processing', amount: 900 },
  { type: 'withdrawal_failed', amount: 900, reason: 'Bank declined' },
  { type: 'withdrawal_not_found', withdrawalId: 'WD-99999-11' },
  { type: 'choose_candidate', candidates: [CANDIDATE, { ...CANDIDATE, position: 2, amount: 700, withdrawalId: 'WD-15436-64216' }] },
  { type: 'candidate_selected', candidate: CANDIDATE },
  { type: 'pdf_password_needed' }, { type: 'pdf_password_wrong' },
  { type: 'statement_account_mismatch', bank: 'SBI', maskedAccount: 'XXXX1234' },
  { type: 'statement_credit_found', amount: 1450, date: '2026-09-10', utr: '123456789012' },
  { type: 'statement_outdated', payoutDate: '2026-09-10' },
  { type: 'statement_unreadable' }, { type: 'not_a_statement' },
  { type: 'evidence_unrelated' }, { type: 'evidence_unsupported', what: 'voice' },
  { type: 'general_answer', question: 'lineup kab aayega?', knowledge: ['Lineup match se 30 min pehle update hota hai.'] },
];

const ALLOWED = /^(b|i|u|s|code|pre)$/;
const LANGS: Language[] = ['hinglish', 'english', 'hindi'];

describe('every reply is valid Telegram HTML', () => {
  for (const act of ALL) {
    for (const lang of LANGS) {
      it(`${act.type} · ${lang}`, () => {
        const html = toTelegramHtml(renderActs([act], lang), actFacts([act]));

        // Only tags Telegram understands, each one opened and closed in order.
        const stack: string[] = [];
        for (const [, slash, tag] of html.matchAll(/<(\/?)([a-z]+)>/g)) {
          expect(tag).toMatch(ALLOWED);
          if (slash) expect(stack.pop()).toBe(tag);
          else stack.push(tag!);
        }
        expect(stack).toHaveLength(0);

        // Everything outside those tags is escaped: no stray < > &, so Telegram cannot reject it.
        const text = html.replace(/<\/?[a-z]+>/g, '');
        expect(text).not.toMatch(/[<>]/);
        expect(text.replace(/&(amp|lt|gt);/g, '')).not.toContain('&');

        // Layout: readable lines, at most one blank line, no markdown left behind.
        expect(html).not.toMatch(/\n{3,}/);
        expect(html).not.toMatch(/\*\*|`|^\s*[-*]\s/m);
        expect(stripHtml(html)).toBe(plainText(renderActs([act], lang)));
        for (const line of stripHtml(html).split('\n')) expect(line.length).toBeLessThanOrEqual(160);
        expect(html).not.toContain('**'); // every template title became real bold
      });
    }
  }
});
