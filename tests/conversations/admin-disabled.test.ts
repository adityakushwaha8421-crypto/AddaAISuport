import { beforeEach, describe, expect, it } from 'vitest';
import { DisabledAdminGateway } from '../../src/admin/fixture.js';
import { SCREENSHOTS } from '../helpers/fakeVision.js';
import { HDFC_STATEMENT_WITH_CREDIT } from '../helpers/fixtures.js';
import { Harness } from '../helpers/harness.js';
import { buildPdf } from '../helpers/pdfFactory.js';

/**
 * The live setup: ADMIN_MODE=disabled, so no deposit or withdrawal can be verified automatically.
 * Agreed behaviour: ask once, then say nothing more while collecting. With everything the bot asked
 * for in hand, the case goes to the export bot and the customer gets one confirmation; later files
 * and remarks reach the team without flooding it, and nothing ever claims a check that did not happen.
 */
const CONFIRMED = /shared with our team successfully/;

let h: Harness;
beforeEach(() => {
  h = new Harness({ adminGateway: new DisabledAdminGateway() });
  h.vision.set('pay500', SCREENSHOTS.payment500);
  h.vision.set('pay500-later', SCREENSHOTS.payment500);
  h.vision.set('wdhist', SCREENSHOTS.withdrawalHistory);
});

describe('deposit without the admin panel', () => {
  it('collects the four items silently, exports once, then ignores pings', async () => {
    const u = h.user('d1');
    expect(await u.say('deposit nahi aaya')).toMatch(/deposit check karne ke liye/);
    expect(await u.say('9810822372')).toBe('');
    expect(await u.photo('pay500')).toBe('');
    expect(h.supportMessages).toHaveLength(0); // statement and video still outstanding: nothing for the team yet
    expect((await h.caseOf(u.id))?.status).toBe('open');
    expect(await u.pdf(buildPdf(HDFC_STATEMENT_WITH_CREDIT))).toBe('');

    expect(await u.video()).toMatch(CONFIRMED);
    expect(h.exportedFiles).toHaveLength(4);
    expect(h.supportMessages).toHaveLength(0); // exported cases never post to the support group
    expect(await h.caseOf(u.id)).toMatchObject({ status: 'escalated', facts: { handoffReason: 'verification_unavailable' } });

    expect(await u.say('kya hua sir?')).toBe('');
    expect(await u.say('sir jaldi karo')).toBe('');
    expect(h.exportedFiles).toHaveLength(4); // pings are not forwarded
  });

  it('takes the items in any order', async () => {
    const u = h.user('d2');
    await u.say('deposit nahi aaya');
    expect(await u.video()).toBe('');
    expect(await u.photo('pay500')).toBe('');
    expect(await u.pdf(buildPdf(HDFC_STATEMENT_WITH_CREDIT))).toBe('');
    expect(h.exportedFiles).toHaveLength(0);
    expect(await u.say('9810822372')).toMatch(CONFIRMED);
    expect(h.exportedFiles).toHaveLength(4);
  });

  it('a number in the first message still gets the one-time request, without asking for the number', async () => {
    const u = h.user('d3');
    const r = await u.say('deposit nahi aaya, mera number 9810822372');
    expect(r).toMatch(/deposit check karne ke liye/);
    expect(r).not.toMatch(/registered number/);
    expect(h.supportMessages).toHaveLength(0);
  });

  it('a document sent after the export is forwarded to the bot, silently', async () => {
    const u = h.user('d4');
    await u.say('deposit nahi aaya 9810822372');
    await u.photo('pay500');
    await u.video();
    await u.pdf(buildPdf(HDFC_STATEMENT_WITH_CREDIT));
    expect(h.exportedFiles).toHaveLength(4);
    expect(await u.photo('pay500-later')).toBe('');
    expect(h.exportedFiles).toHaveLength(5);
    expect(h.supportMessages).toHaveLength(0);
  });

  it('the same complaint repeated after the export goes nowhere: no reply, nothing forwarded', async () => {
    const u = h.user('d5');
    await u.say('deposit nahi aaya 9810822372');
    await u.photo('pay500');
    await u.pdf(buildPdf(HDFC_STATEMENT_WITH_CREDIT));
    await u.video();
    for (const t of ['abhi tak nahi aaya', 'paisa abhi bhi nahi aaya', 'nahi aaya sir']) expect(await u.say(t)).toBe('');
    expect(h.supportMessages).toHaveLength(0);
    expect(h.exportedFiles).toHaveLength(4);
  });

  it('a customer without a screenshot is handed off with what they gave: ticket only, no export', async () => {
    const u = h.user('d6');
    await u.say('deposit nahi aaya 9810822372');
    expect(await u.say('mere pass nahi hai screenshot')).toBe('');
    expect(h.supportMessages).toHaveLength(1);
    expect(h.exports).toHaveLength(0);
    expect((await h.caseOf(u.id))?.facts.handoffReason).toBe('user_declined_more_info');
  });
});

describe('withdrawal without the admin panel', () => {
  it('waits for the statement after the ID, exports once (ID message + PDF); chasing messages go nowhere', async () => {
    const u = h.user('w1');
    expect(await u.say('withdrawal nahi aaya')).toMatch(/withdrawal check karne ke liye/);
    expect(await u.say('WD-15436-64215')).toBe('');
    expect(h.exportedFiles).toHaveLength(0);
    expect(await u.pdf(buildPdf(HDFC_STATEMENT_WITH_CREDIT))).toMatch(CONFIRMED);
    expect(h.exportedFiles).toHaveLength(2);
    expect(h.supportMessages).toHaveLength(0);
    expect((await h.caseOf(u.id))?.facts.handoffReason).toBe('verification_unavailable');
    for (const t of ['abhi tak nahi aaya', 'kya hua?', 'abhi tak nahi aaya sir']) expect(await u.say(t)).toBe('');
    expect(h.exportedFiles).toHaveLength(2);
  });

  it('picking a row from the history screenshot never claims a check that did not happen', async () => {
    const u = h.user('w2');
    await u.say('mera withdrawal pending hai');
    expect(await u.photo('wdhist')).toMatch(/3 withdrawals/);
    const r = await u.say('upar wala');
    expect(r).toMatch(/upar wala/);
    expect(r).not.toMatch(/check/i);
    expect(h.exportedFiles).toHaveLength(0); // the statement is still outstanding
    expect(await u.pdf(buildPdf(HDFC_STATEMENT_WITH_CREDIT))).toMatch(CONFIRMED);
    expect(h.exportedFiles).toHaveLength(2); // the history screenshot and the PDF
  });

  it('a statement sent with the ID completes the case at once', async () => {
    const u = h.user('w3');
    expect(await u.say('WD-15436-64215 nahi aaya')).toMatch(/bank statement/i);
    expect(await u.pdf(buildPdf(HDFC_STATEMENT_WITH_CREDIT))).toMatch(CONFIRMED);
    expect(h.exportedFiles).toHaveLength(2); // the message with the ID, and the PDF
    expect(h.supportMessages).toHaveLength(0);
  });
});
