import { beforeEach, describe, expect, it } from 'vitest';
import { DisabledAdminGateway } from '../../src/admin/fixture.js';
import { SCREENSHOTS } from '../helpers/fakeVision.js';
import { Harness } from '../helpers/harness.js';

/**
 * Every reply is decided against the conversation, not the latest words alone: what was already
 * asked and received, what the customer already said, what they point at, and what the bot said last.
 */
let h: Harness;
beforeEach(() => {
  h = new Harness({ adminGateway: new DisabledAdminGateway(), knowledge: [{ id: 'l', keywords: ['lineup'], answer: 'Sir, lineup match se pehle app ke contest page par dikhta hai 👍' }] });
  h.vision.set('wdhist', SCREENSHOTS.withdrawalHistory);
});

describe('the reply is built from the whole conversation', () => {
  it('the same small-talk answer is not sent twice in a row for nothing new', async () => {
    const u = h.user('cr1');
    expect(await u.say('kaise ho')).toBe('Hello sir 👋 Kaise help karun?'); // first message of the day
    expect(await u.say('kaise ho')).toMatch(/Main theek hoon/);
    expect(await u.say('kaise ho')).toBe(''); // word for word what the bot just said: a repeat, dropped
    expect(u.replies).toHaveLength(2);
  });

  it('an answer the customer asks for again is given again', async () => {
    const u = h.user('cr2');
    expect(await u.say('lineup kab aayega')).toMatch(/contest page/);
    expect(await u.say('lineup kab aayega?')).toMatch(/contest page/);
  });

  it('a standing evidence request is never re-sent for a turn that brings nothing', async () => {
    const u = h.user('cr3');
    expect(await u.say('withdrawal nahi aaya')).toMatch(/withdrawal check karne ke liye/);
    for (const t of ['hmm', 'sir', 'ok']) expect(await u.say(t)).toBe('');
    expect((await h.caseOf(u.id))?.facts.asks.withdrawal_ref).toBe(1);
    // A question about what to send earns the list — it is genuinely required, and not a new ask.
    expect(await u.say('kya bhejna hai?')).toMatch(/Withdrawal ID/);
    expect((await h.caseOf(u.id))?.facts.asks.withdrawal_ref).toBe(1);
    // A nudge ("check karo") with nothing sent is answered with what is still needed (that one counts).
    expect(await u.say('dekho na')).toMatch(/Withdrawal ID/);
    expect((await h.caseOf(u.id))?.facts.asks.withdrawal_ref).toBe(2);
  });

  it('what the customer already gave is never asked for again, and "upar wala" is read against the screenshot they sent', async () => {
    const u = h.user('cr4');
    await u.say('mera withdrawal pending hai');
    expect(await u.photo('wdhist')).toMatch(/3 withdrawals/);
    const r = await u.say('upar wala');
    expect(r).toMatch(/upar wala/);
    expect(r).not.toMatch(/Withdrawal ID ya withdrawal history/);
    expect((await h.caseOf(u.id))?.withdrawalId).toBeDefined();
  });

  it('the interpreter is told what each case already asked and received', async () => {
    const u = h.user('cr5');
    await u.say('deposit nahi hua');
    await u.say('9810822372');
    const c = (await h.caseOf(u.id))!;
    const { summariseCase } = await import('../../src/nlu/context.js');
    const s = summariseCase(c, h.clock());
    expect(s.asked?.registration_number).toBe(1);
    expect(s.known).toContain('registration_number');
  });
});
