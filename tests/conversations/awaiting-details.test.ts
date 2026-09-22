import { beforeEach, describe, expect, it } from 'vitest';
import { DisabledAdminGateway } from '../../src/admin/fixture.js';
import { SCREENSHOTS } from '../helpers/fakeVision.js';
import { ADMIN_FIXTURES, HDFC_STATEMENT_WITH_CREDIT } from '../helpers/fixtures.js';
import { Harness } from '../helpers/harness.js';
import { buildPdf } from '../helpers/pdfFactory.js';

/**
 * Once the bot has asked for details, it waits. A hello, ok or thanks is not an answer: no reply,
 * no greeting restart, and the case stays pending. The requested details, a clearly new issue, or a
 * human reply move things on.
 */
const SMALL_TALK = ['hi', 'hello', 'hey', 'ok', 'okay', 'thanks', 'hi sir', 'kaise ho'];

let h: Harness;
beforeEach(() => {
  h = new Harness({ fixtures: ADMIN_FIXTURES });
  h.vision.set('pay500', SCREENSHOTS.payment500);
});

describe('after the request, small talk gets no reply', () => {
  it('deposit: silent through greetings, then the number and the proof continue the case', async () => {
    const u = h.user('dep');
    expect(await u.say('Deposit issue hai')).toMatch(/deposit check karne ke liye/);
    for (const t of SMALL_TALK) expect(await u.say(t), t).toBe('');
    const c = await h.caseOf(u.id);
    expect(c).toMatchObject({ type: 'deposit', status: 'open' });
    expect(await u.say('9810822372')).toBe('');
    expect((await h.caseOf(u.id))?.registrationNumber).toBe('9810822372');
    expect(await u.photo('pay500')).toMatch(/Deposit Successful/);
  });

  it('withdrawal: silent through greetings, then the Withdrawal ID continues the case', async () => {
    const u = h.user('wd');
    expect(await u.say('withdrawal nahi aaya')).toMatch(/withdrawal check karne ke liye/);
    for (const t of SMALL_TALK) expect(await u.say(t), t).toBe('');
    expect((await h.caseOf(u.id))?.status).toBe('open');
    expect(await u.say('WD-15436-64215')).toMatch(/Withdrawal Successful/);
  });

  it('any other workflow waits the same way', async () => {
    const u = h.user('kyc');
    await u.say('KYC verify nahi ho raha');
    const c = await h.caseOf(u.id);
    expect(c && ['open', 'escalated'].includes(c.status)).toBe(true);
    for (const t of SMALL_TALK) expect(await u.say(t), t).toBe('');
  });

  it('a case with the team (admin panel disabled) waits the same way', async () => {
    const d = new Harness({ adminGateway: new DisabledAdminGateway() });
    d.vision.set('pay500', SCREENSHOTS.payment500);
    const u = d.user('esc');
    await u.say('deposit nahi aaya 9810822372');
    await u.photo('pay500');
    await u.video();
    await u.pdf(buildPdf(HDFC_STATEMENT_WITH_CREDIT));
    expect((await d.caseOf(u.id))?.status).toBe('escalated');
    for (const t of SMALL_TALK) expect(await u.say(t), t).toBe('');
    expect(d.supportMessages).toHaveLength(0);
  });

  it('a greeting with the details in it is the details', async () => {
    const u = h.user('mixed');
    await u.say('deposit nahi aaya');
    expect(await u.say('hi sir 9810822372')).toBe('');
    expect((await h.caseOf(u.id))?.registrationNumber).toBe('9810822372');
  });

  it('a clearly new issue is handled', async () => {
    const u = h.user('switch');
    await u.say('deposit nahi aaya');
    await u.say('hello');
    expect(await u.say('withdrawal bhi nahi aaya')).toMatch(/withdrawal check karne ke liye/);
  });

  it('once the case is completed, a greeting is answered again', async () => {
    const u = h.user('done');
    await u.say('deposit nahi aaya 9810822372');
    expect(await u.photo('pay500')).toMatch(/Deposit Successful/);
    expect(await u.say('thanks')).toMatch(/Welcome/);
    expect(await u.say('hi')).not.toBe('');
  });
});

describe('a human reply', () => {
  it('closes the pending case; the bot stays out of everything until the human hands the chat back', async () => {
    const u = h.user('human');
    await u.say('deposit nahi aaya');
    await h.app.relay.onOwnOutgoing({ chatId: u.id, messageId: 800, text: 'Sir main dekh raha hoon' });
    expect((await h.casesOf(u.id))[0]?.status).toBe('closed');
    expect(await h.caseOf(u.id)).toBeUndefined();
    // Greetings, answers, follow-ups and a clearly different new issue alike: the human's.
    for (const t of ['hi', 'ok', '9810822372', 'deposit abhi tak nahi aaya', 'withdrawal nahi aaya']) expect(await u.say(t), t).toBe('');
    expect(await h.casesOf(u.id)).toHaveLength(1);

    await h.app.relay.onOwnOutgoing({ chatId: u.id, messageId: 801, text: '/ai' }); // handed back
    expect(await u.say('withdrawal nahi aaya')).toMatch(/withdrawal check karne ke liye/);
    expect(await u.say('WD-15436-64215')).toMatch(/Withdrawal Successful/); // the bot owns this one now
  });

  it('from the support group closes the case too', async () => {
    const d = new Harness({ adminGateway: new DisabledAdminGateway() });
    const u = d.user('relay');
    await u.say('withdrawal nahi aaya WD-15436-64215, agent se baat karao'); // wants a person: a support-group ticket
    const ticket = d.supportMessages[0]!;
    await d.app.relay.onSupportMessage({ chatId: '-100999', messageId: 9100, fromUserId: 'agent1', text: 'Sir, dekh rahe hain.', replyToMessageId: ticket.messageId });
    expect((await d.casesOf(u.id))[0]?.status).toBe('closed');
    expect(await u.say('hello')).toBe('');
  });
});
