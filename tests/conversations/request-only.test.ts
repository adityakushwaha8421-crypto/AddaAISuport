import { beforeEach, describe, expect, it } from 'vitest';
import { DisabledAdminGateway } from '../../src/admin/fixture.js';
import { SCREENSHOTS } from '../helpers/fakeVision.js';
import { HDFC_STATEMENT_WITH_CREDIT } from '../helpers/fixtures.js';
import { Harness } from '../helpers/harness.js';
import { buildPdf } from '../helpers/pdfFactory.js';

/**
 * Production default (CASE_REPLIES=request_only): a deposit or withdrawal case gets exactly one
 * message from the bot — the evidence request — and then nothing, whatever the customer writes.
 * The work still happens underneath: facts are absorbed, files are exported to the team, the
 * export bot's confirmation closes the case. The human team talks to the customer from there.
 */
const DEPOSIT_REQUEST = /deposit check karne ke liye[\s\S]*registered number[\s\S]*screenshot[\s\S]*statement[\s\S]*recording/i;
const WITHDRAWAL_REQUEST = /withdrawal check karne ke liye[\s\S]*Withdrawal ID ya withdrawal history ka screenshot[\s\S]*bank statement PDF/;

let h: Harness;
beforeEach(() => {
  h = new Harness({ adminGateway: new DisabledAdminGateway() });
  h.vision.set('pay500', SCREENSHOTS.payment500);
  h.vision.set('wdhist', SCREENSHOTS.withdrawalHistory);
  h.vision.set('selfie', SCREENSHOTS.selfie);
});

describe('deposit: one request, then silence', () => {
  it('every follow-up is silent, the items are still collected and exported; only the payment confirmation is told', async () => {
    const u = h.user('d1');
    expect(await u.say('paise add nahi hue')).toMatch(DEPOSIT_REQUEST);
    for (const t of ['hi', 'hello', 'okay', 'please check', 'karwaiye', 'kya bhejna hai?', 'kitni baar bolu', 'sir jaldi karo']) expect(await u.say(t), t).toBe('');
    expect(await u.say('9810822372')).toBe(''); // no "number mil gaya"
    expect(await u.photo('pay500')).toBe(''); // no "screenshot mil gaya"
    expect(await u.photo('selfie')).toBe(''); // no "related nahi lag rahi"
    expect(await u.pdf(buildPdf(HDFC_STATEMENT_WITH_CREDIT))).toBe('');
    expect(await u.video()).toBe(''); // the last item: exported, but NOT "shared with our team"
    expect(u.replies).toHaveLength(1);
    expect(h.exportedFiles).toHaveLength(4); // number message, screenshot, PDF, video went to the team
    const c = (await h.caseOf(u.id))!;
    expect(c.facts.export?.status).toBe('verified'); // never "confirmed": the customer was not told
    expect(c.status).toBe('escalated');
    expect(await u.say('hello?')).toBe('');
    expect(await u.say('kya hua mere case ka')).toBe('');
    expect(u.replies).toHaveLength(1);
  });

  it('a request when the number came in the first message asks only for the rest, once', async () => {
    const u = h.user('d2');
    const r = await u.say('deposit nahi aaya 9810822372');
    expect(r).toMatch(/deposit check karne ke liye/);
    expect(r).not.toMatch(/registered number/);
    expect(await u.say('9810822372')).toBe('');
    expect(u.replies).toHaveLength(1);
  });

  it('the export bot\'s PAYMENT CONFIRMED closes the case without a message to the customer', async () => {
    const u = h.user('8939686943');
    await u.say('deposit nahi aaya');
    await u.say('9810822372');
    await u.photo('pay500');
    await u.pdf(buildPdf(HDFC_STATEMENT_WITH_CREDIT));
    await u.video();
    expect(h.exportedFiles).toHaveLength(4);
    // The export bot's PAYMENT CONFIRMED is the one exception: that customer is told, once, in the agreed words.
    expect(await h.botSays('✅ PAYMENT CONFIRMED\n\n👤 Customer: N K (User ID: 8939686943)\n📱 Mobile: 9810822372')).toBe('solved');
    expect((await h.casesOf(u.id))[0]?.status).toBe('resolved');
    expect(u.replies).toHaveLength(2);
    expect(u.last).toBe('Sir, aapka issue solved ho gaya hai. Sorry for the inconvenience. 🙏');
  });

  it('a second, different issue after the first is with the team gets its own single request', async () => {
    const u = h.user('d3');
    await u.say('deposit nahi aaya');
    await u.say('9810822372');
    await u.photo('pay500');
    await u.pdf(buildPdf(HDFC_STATEMENT_WITH_CREDIT));
    await u.video();
    expect(await u.say('ek aur deposit ka issue hai')).toMatch(/deposit check karne ke liye/); // the number is remembered: the rest is asked once
    expect(await u.say('ok')).toBe('');
    expect(u.replies).toHaveLength(2);
  });
});

describe('withdrawal: one request, then silence', () => {
  it('no choosing between rows, no reminders, no status; the reference and the PDF go to the team quietly', async () => {
    const u = h.user('w1');
    expect(await u.say('mere paise nahi aaye')).toMatch(WITHDRAWAL_REQUEST);
    expect(await u.photo('wdhist')).toBe(''); // three rows: no "kaunsa wala?"
    for (const t of ['upar wala', 'please check', 'hello', 'kab tak hoga', 'kya bhejna hai?']) expect(await u.say(t), t).toBe('');
    expect(await u.pdf(buildPdf(HDFC_STATEMENT_WITH_CREDIT))).toBe('');
    expect(u.replies).toHaveLength(1);
    expect(h.exportedFiles).toHaveLength(2); // history screenshot + PDF
    expect((await h.caseOf(u.id))?.facts.export?.status).toBe('verified');
  });

  it('a typed ID then the PDF: still just the one request', async () => {
    const u = h.user('w2');
    expect(await u.say('withdrawal nahi aaya')).toMatch(WITHDRAWAL_REQUEST);
    expect(await u.say('WD-15436-64215')).toBe('');
    expect(await u.pdf(buildPdf(HDFC_STATEMENT_WITH_CREDIT))).toBe('');
    expect(u.replies).toHaveLength(1);
    expect(h.exportedFiles).toHaveLength(2);
  });

  it('an unclear money problem gets the one clarifying question, then the one request, then silence', async () => {
    const u = h.user('w3');
    expect(await u.say('amount credit nahi hua')).toMatch(/Deposit ka issue hai ya withdrawal ka/);
    expect(await u.say('withdrawal ka')).toMatch(WITHDRAWAL_REQUEST);
    expect(await u.say('ok bhejta hu')).toBe('');
    expect(await u.say('hi')).toBe('');
    expect(u.replies).toHaveLength(2);
  });
});

describe('what still happens underneath', () => {
  it('a customer who wants a person gets a support-group ticket, silently', async () => {
    const u = h.user('t1');
    await u.say('withdrawal nahi aaya');
    expect(await u.say('agent se baat karao')).toBe('');
    expect(h.supportMessages.length).toBeGreaterThan(0);
    expect(u.replies).toHaveLength(1);
  });

  it('the chat is still filed in the Support folder, and a human reply still takes it over', async () => {
    const u = h.user('t2');
    await u.say('deposit nahi aaya');
    expect(h.folderOf(u.id)).toBe('support');
    await h.app.relay.onOwnOutgoing({ chatId: u.id, messageId: 5, text: 'Sir main dekh raha hoon' });
    expect((await h.casesOf(u.id))[0]?.status).toBe('closed');
    expect(await u.say('9810822372')).toBe('');
  });
});
