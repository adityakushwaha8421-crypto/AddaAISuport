import { describe, expect, it } from 'vitest';
import type { Act } from '../../src/response/acts.js';
import { actFacts } from '../../src/response/acts.js';
import { ResponseComposer } from '../../src/response/composer.js';
import { plainText, stripHtml, toTelegramHtml } from '../../src/response/format.js';
import { guardResponse } from '../../src/response/guard.js';
import { KnowledgeBase } from '../../src/response/knowledge.js';
import { polish, renderActs } from '../../src/response/templates.js';
import { ScriptedLlm } from '../../src/llm/fake.js';
import { silentLogger } from '../../src/observability/logger.js';

const success: Act[] = [{ type: 'withdrawal_success', amount: 1450, bank: 'HDFC Bank', maskedAccount: 'XXXX6789', askStatement: false }];

describe('templates', () => {
  it('batch-then-confirm phrasing matches the style guide', () => {
    expect(renderActs([{ type: 'received', items: ['payment_screenshot'] }, { type: 'ask', slots: ['registration_number'], mode: 'followup', caseType: 'deposit' }], 'hinglish'))
      .toBe('Payment screenshot mil gaya sir ✅\n\nAb 10-digit registered number bhej dijiye, phir main aage check karta hoon.');
  });
  it('uses "sir" once and at most two emojis', () => {
    const t = polish('Sir, a hai ✅ Sir, b hai 🙏 c sir 👍 d ✅');
    expect(t.match(/sir/gi)).toHaveLength(1);
    expect([...t.matchAll(/\p{Extended_Pictographic}/gu)]).toHaveLength(2);
  });
  it('renders all three languages', () => {
    expect(renderActs(success, 'english')).toMatch(/processed successfully/);
    expect(renderActs(success, 'hindi')).toMatch(/सफलतापूर्वक/);
    expect(renderActs(success, 'hinglish')).toMatch(/successfully process/);
  });
});

describe('response guard (anti-hallucination)', () => {
  const draft = renderActs(success, 'hinglish');
  const ok = (t: string, acts: Act[] = success) => guardResponse(t, { acts, draft, userText: 'withdrawal nahi aaya' });

  it('accepts faithful rephrasing', () => {
    expect(ok('Sir, aapka ₹1,450 ka withdrawal success ho gaya hai ✅ Paisa HDFC Bank ke XXXX6789 account mein gaya hai.').ok).toBe(true);
  });
  it('rejects invented amounts, IDs and account numbers', () => {
    expect(ok('Sir, ₹1,500 bheja gaya hai.')).toMatchObject({ ok: false });
    expect(ok('Sir, UTR 999988887777 hai.')).toMatchObject({ ok: false });
    expect(ok('Sir, WD-99999-11 success hai.')).toMatchObject({ ok: false });
  });
  it('rejects claims of forwarding / receipt / success without the matching act', () => {
    const ask: Act[] = [{ type: 'ask', slots: ['bank_statement'], mode: 'followup', caseType: 'withdrawal' }];
    const d = renderActs(ask, 'hinglish');
    expect(guardResponse('Sir, maine case team ko forward kar diya hai.', { acts: ask, draft: d, userText: '' })).toMatchObject({ ok: false, reason: 'mentions_team_or_escalation' });
    expect(guardResponse('Sir, our team will check this manually, please wait.', { acts: ask, draft: d, userText: '' })).toMatchObject({ ok: false });
    expect(guardResponse('Sir, statement mil gaya hai.', { acts: ask, draft: d, userText: '' })).toMatchObject({ ok: false, reason: 'receipt_claim_without_receipt' });
    expect(guardResponse('Sir, aapka withdrawal successful hai.', { acts: ask, draft: d, userText: '' })).toMatchObject({ ok: false });
  });
  it('rejects fake human identity and invented timelines', () => {
    expect(ok('Main insaan hoon sir, ₹1,450 aa jayega.')).toMatchObject({ ok: false, reason: 'claims_human_identity' });
    expect(ok('Sir, ₹1,450 24 ghante mein aa jayega.')).toMatchObject({ ok: false, reason: 'invented_timeline' });
  });
});

describe('ResponseComposer', () => {
  const knowledge: Act[] = [{ type: 'general_answer', question: 'lineup kab aata hai?', knowledge: ['Lineup match shuru hone se pehle contest page par dikhta hai.'] }];
  it('phrases knowledge-base answers with the model when they pass the guard', async () => {
    const llm = new ScriptedLlm().on('compose', () => 'Sir, lineup **match shuru hone se pehle** contest page par dikh jata hai 👍');
    const c = new ResponseComposer({ llm, mode: 'llm', style: {}, log: silentLogger });
    const r = await c.compose({ acts: knowledge, language: 'hinglish', userText: 'lineup kab aata hai?', history: [] });
    expect(r.source).toBe('llm');
    expect(r.text).toBe('Sir, lineup match shuru hone se pehle contest page par dikh jata hai 👍'); // model markdown stripped
  });
  it('falls back to the template when the model invents facts', async () => {
    const llm = new ScriptedLlm().on('compose', () => 'Sir, lineup 7:30 baje ₹500 wale contest me aayega.');
    const c = new ResponseComposer({ llm, mode: 'llm', style: {}, log: silentLogger });
    const r = await c.compose({ acts: knowledge, language: 'hinglish', userText: '', history: [] });
    expect(r.source).toBe('template');
    expect(r.guardRejection).toMatch(/unverified_number/);
    expect(r.text).toBe(toTelegramHtml(renderActs(knowledge, 'hinglish'), actFacts(knowledge)));
  });
  it('never lets the model rewrite a result card, whose layout the template owns', async () => {
    const llm = new ScriptedLlm().on('compose', () => 'rewritten');
    const c = new ResponseComposer({ llm, mode: 'llm', style: {}, log: silentLogger });
    const acts: Act[] = [{ type: 'received', items: ['withdrawal_id'] }, ...success];
    const r = await c.compose({ acts, language: 'english', userText: 'WD-15436-64215', history: [] });
    expect(r.source).toBe('template');
    expect(llm.calls).toHaveLength(0);
    expect(r.text).toContain('<b>Withdrawal Successful</b>');
  });
  it('does not spend an LLM call on single simple Hinglish acts', async () => {
    const llm = new ScriptedLlm();
    const c = new ResponseComposer({ llm, mode: 'llm', style: {}, log: silentLogger });
    await c.compose({ acts: [{ type: 'pdf_password_needed' }], language: 'hinglish', userText: '', history: [] });
    expect(llm.calls).toHaveLength(0);
  });
});

describe('knowledge base', () => {
  it('matches by keywords', () => {
    const kb = new KnowledgeBase([{ id: 'l', keywords: ['lineup', 'playing 11'], answer: 'Lineup answer' }, { id: 'k', keywords: ['kyc'], answer: 'KYC answer' }]);
    expect(kb.search('Sir lineup de diya karo').map((e) => e.id)).toEqual(['l']);
    expect(kb.search('hello')).toEqual([]);
  });
});

describe('Telegram formatting', () => {
  it('bolds amounts, puts IDs and masked accounts in monospace', () => {
    const acts: Act[] = [{ type: 'deposit_success', orderId: 'ORD771001', amount: 500 }];
    const html = toTelegramHtml(renderActs(acts, 'hinglish'), actFacts(acts));
    expect(html).toContain('<code>ORD771001</code>');
    expect(html).toContain('<b>₹500</b>');
    const wd = toTelegramHtml(renderActs(success, 'hinglish'), actFacts(success));
    expect(wd).toContain('<b>₹1,450</b>');
    expect(wd).toContain('<code>XXXX6789</code>');
    expect(stripHtml(wd)).toBe(plainText(renderActs(success, 'hinglish'))); // plain text unchanged underneath
  });

  it('escapes anything the customer or an agent wrote, so text can never inject markup', () => {
    expect(toTelegramHtml('a <b>bold</b> & <script>x</script>')).toBe('a &lt;b&gt;bold&lt;/b&gt; &amp; &lt;script&gt;x&lt;/script&gt;');
  });

  it('never nests markup when one id contains another', () => {
    const html = toTelegramHtml('WD-15436-64215 and 15436-64215', ['WD-15436-64215', '15436-64215']);
    expect(html).toBe('<code>WD-15436-64215</code> and 15436-64215');
  });
});

describe('message presentation', () => {
  const html = (acts: Act[], lang: 'hinglish' | 'english' | 'hindi' = 'hinglish') => toTelegramHtml(renderActs(acts, lang), actFacts(acts));
  const CAND = { position: 1, amount: 1450, withdrawalId: 'WD-15436-64215', status: 'Success', datetime: '2026-09-05', confidence: 0.9 };

  it('asks for several documents with one icon per item', () => {
    const t = renderActs([{ type: 'ask', slots: ['registration_number', 'payment_proof', 'bank_statement', 'payment_video'], mode: 'initial', caseType: 'deposit' }], 'hinglish');
    expect(t.split('\n')).toEqual([
      'Sir, deposit check karne ke liye ye details bhej dijiye 🙏', '',
      '📱 Apna 10-digit registered number', '🧾 Payment screenshot', '📄 Bank statement PDF', '🎥 Payment screen recording',
    ]);
  });

  it('keeps a single-item request as a sentence, not a one-item list', () => {
    const t = renderActs([{ type: 'ask', slots: ['registration_number'], mode: 'initial', caseType: 'deposit' }], 'hinglish');
    expect(t).not.toContain('\n');
    expect(t).toContain('10-digit registered number');
  });

  it('does not ask for a bank statement that already arrived', () => {
    const t = renderActs([{ type: 'ask', slots: ['withdrawal_ref'], mode: 'initial', caseType: 'withdrawal' }], 'hinglish');
    expect(t).toMatch(/Withdrawal ID/);
    expect(t).not.toMatch(/statement/i);
  });

  it('shows an outcome as a card: bold title, one sentence, a fact per line, then the next step', () => {
    expect(html([{ type: 'deposit_success', orderId: 'ORD771001', amount: 500 }])).toBe(
      '✅ <b>Deposit Successful</b>\n\nSir, aapka payment successfully verify ho gaya hai.\n\n🧾 Order ID: <code>ORD771001</code>\n💰 Amount: <b>₹500</b>\n\n👉 Wallet balance refresh karke check kar lijiye.',
    );
  });

  it('leaves out facts it does not have instead of printing empty labels', () => {
    const t = html([{ type: 'withdrawal_failed', amount: 300 }]);
    expect(t).toContain('<b>Withdrawal Failed</b>');
    expect(t).not.toMatch(/Reason/);
  });

  it('lists screenshot rows with a number, a status mark and a short date', () => {
    const t = stripHtml(html([{ type: 'choose_candidate', candidates: [CAND, { ...CAND, position: 2, amount: 700, withdrawalId: 'WD-15436-61002', status: 'Processing', datetime: '2026-09-03T10:00:00+05:30' }] }]));
    expect(t).toContain('1️⃣ ₹1,450 · WD-15436-64215 · ✅ Success · 5 Sep');
    expect(t).toContain('2️⃣ ₹700 · WD-15436-61002 · ⏳ Processing · 3 Sep');
  });

  it('puts UTRs in monospace', () => {
    expect(html([{ type: 'statement_credit_found', amount: 1450, date: '2026-09-05', utr: '523456789012' }])).toContain('🔢 UTR: <code>523456789012</code>');
  });

  it('keeps icons on layout lines, at most two emojis inside sentences, and one "sir"', () => {
    const t = renderActs([{ type: 'frustration_ack', hasDetails: true }, { type: 'withdrawal_success', amount: 1450, bank: 'HDFC Bank', maskedAccount: 'XXXX6789', askStatement: true }], 'hinglish');
    const prose = t.split('\n').filter((l) => l && !/^\p{Extended_Pictographic}/u.test(l));
    expect(prose.join(' ').match(/\p{Extended_Pictographic}/gu)?.length ?? 0).toBeLessThanOrEqual(2);
    expect(t).toMatch(/^✅ \*\*Withdrawal Successful\*\*$/m);
    expect(t.match(/\bsir\b/gi)).toHaveLength(1);
  });

  it('mentions resending only when something was actually sent', () => {
    expect(renderActs([{ type: 'frustration_ack', hasDetails: false }], 'hinglish')).not.toMatch(/dobara/);
    expect(renderActs([{ type: 'frustration_ack', hasDetails: true }], 'hinglish')).toMatch(/dobara bhejne ki zarurat nahi/);
  });

  it('separates distinct thoughts into paragraphs, but keeps a short ack inline', () => {
    expect(renderActs([{ type: 'received', items: ['bank_statement'] }, { type: 'pdf_password_needed' }], 'hinglish'))
      .toBe('Bank statement mil gaya sir ✅\n\n🔐 Ye PDF password protected hai.\n\n👉 PDF ka password bhej dijiye. Password nahi hai to **Skip** likh dijiye.');
    expect(renderActs([{ type: 'ack' }, { type: 'promise_noted' }], 'hinglish')).not.toContain('\n');
  });

  it('never leaks markdown written by the model into a Telegram message', () => {
    expect(polish('Sir, **₹500** ka *payment* `ORD771001` verify ho gaya', 'sir', { fromModel: true })).toBe('Sir, ₹500 ka payment ORD771001 verify ho gaya');
    expect(polish('Ye bhejiye:\n- number\n- screenshot', 'sir', { fromModel: true })).toBe('Ye bhejiye:\n• number\n• screenshot');
  });

  it('survives the round trip to stored plain text with its layout intact', () => {
    const acts: Act[] = [{ type: 'withdrawal_success', amount: 1450, bank: 'HDFC Bank', maskedAccount: 'XXXX6789', askStatement: true }];
    const rendered = html(acts);
    expect(stripHtml(rendered)).toBe(plainText(renderActs(acts, 'hinglish')));
    expect(rendered).not.toMatch(/\n{3,}|\*\*/);
  });
});
