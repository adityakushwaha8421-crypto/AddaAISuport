import { beforeEach, describe, expect, it } from 'vitest';
import { DisabledAdminGateway } from '../../src/admin/fixture.js';
import { SCREENSHOTS } from '../helpers/fakeVision.js';
import { ADMIN_FIXTURES } from '../helpers/fixtures.js';
import { Harness } from '../helpers/harness.js';

/**
 * The bot answers a message only while it is still unread on Telegram. Once a human on the account
 * has read it, the message is theirs, whatever it says. Only the latest message of a turn counts,
 * and nothing about the customer's cases changes that.
 */
let h: Harness;
beforeEach(() => {
  h = new Harness({ caseReplies: 'conversational', fixtures: ADMIN_FIXTURES });
  h.vision.set('pay500', SCREENSHOTS.payment500);
});

describe('reply only to unread messages', () => {
  it('unread "hi" → reply; read "hi" → nothing; the next unread "hi" → reply again', async () => {
    const u = h.user('greet');
    expect(await u.say('hi')).toMatch(/Hello/);
    expect(await u.readByHuman().say('hi')).toBe('');
    expect(await u.say('hi')).not.toBe('');
    expect(await u.readByHuman().say('hello')).toBe('');
  });

  it.each([
    ['deposit nahi aaya'],
    ['withdrawal nahi aaya'],
    ['WD-15436-64215 ka status batao'],
    ['thanks'],
  ])('a read "%s" gets no reply', async (text) => {
    const u = h.user(`read-${text}`);
    expect(await u.readByHuman().say(text)).toBe('');
    expect(h.transport.sent).toHaveLength(0);
  });

  it('a read message is left entirely to the human: no request recorded, no ticket', async () => {
    const u = h.user('left');
    expect(await u.readByHuman().say('withdrawal nahi aaya WD-15436-59990')).toBe('');
    expect(h.supportMessages).toHaveLength(0);
    // The same complaint, unread this time, starts from the beginning.
    expect(await u.say('withdrawal nahi aaya')).toMatch(/withdrawal check karne ke liye/);
  });

  it('a read message is still filed in its folder', async () => {
    const s = h.user('fold-s');
    const m = h.user('fold-m');
    await s.readByHuman().say('deposit nahi aaya');
    await m.readByHuman().say('points galat hai');
    expect([h.folderOf(s.id), h.folderOf(m.id)]).toEqual(['support', 'match']);
  });

  it('a read message gets no reply even when it would have been answered: a new issue during a pending case', async () => {
    const d = new Harness({ caseReplies: 'conversational', adminGateway: new DisabledAdminGateway() });
    const u = d.user('pending');
    await u.say('deposit nahi aaya');
    expect(await u.readByHuman().say('withdrawal nahi aaya')).toBe('');
    expect(await u.say('withdrawal nahi aaya')).toMatch(/withdrawal check karne ke liye/);
  });

  it('only the latest message of a burst counts', async () => {
    const u = h.user('burst');
    const send = async (readUpTo: 'first' | 'last') => {
      const a = u.build({ text: 'hi' });
      const b = u.build({ text: 'deposit nahi aaya' });
      for (const m of [a, b]) await h.app.processor.receive(m);
      h.transport.readUpTo.set(u.id, readUpTo === 'first' ? a.messageId : b.messageId);
      const before = u.replies.length;
      await h.app.processor.process(u.id, [a, b]);
      return u.replies.length > before;
    };
    expect(await send('last')).toBe(false);
    expect(await send('first')).toBe(true);
  });

  it('a human who reads the message while the reply is being prepared gets it: the reply is dropped', async () => {
    expect(await h.user('control').say('WD-15436-64215 ka status batao')).toMatch(/Withdrawal/);
    const u = h.user('race');
    const lookup = h.admin.findPayout.bind(h.admin);
    h.admin.findPayout = async (id: string) => {
      h.transport.humanReads(u.id);
      return lookup(id);
    };
    expect(await u.say('WD-15436-64215 ka status batao')).toBe('');
  });

  it('when Telegram cannot tell, a fresh message counts as unread', async () => {
    const u = h.user('unknown');
    h.transport.failReadChecks = 5;
    expect(await u.say('hi')).toMatch(/Hello/);
  });
});
