import { beforeEach, describe, expect, it } from 'vitest';
import { DisabledAdminGateway } from '../../src/admin/fixture.js';
import { Harness } from '../helpers/harness.js';

/**
 * The bot answers only a genuinely new conversation. A chat where a human on this account has
 * already written (before the bot ever saw it) is theirs: the bot stays out — no reply, no request,
 * no case — until they hand it back with the resume command. When the history cannot be checked,
 * the bot stays silent and tries again on the next message.
 */
let h: Harness;
beforeEach(() => {
  h = new Harness({ adminGateway: new DisabledAdminGateway() });
});

describe('fresh conversation only', () => {
  it('a brand-new chat is answered; a chat a human already wrote in is not', async () => {
    expect(await h.user('new1').say('deposit nahi hua')).toMatch(/deposit check karne ke liye/);
    const existing = h.user('old1');
    h.transport.humanWroteEarlier(existing.id); // the team replied to this customer yesterday, by hand
    expect(await existing.say('deposit nahi hua')).toBe('');
    expect(await existing.say('hello? koi hai?')).toBe('');
    expect(existing.replies).toHaveLength(0);
    expect(await h.casesOf(existing.id)).toHaveLength(0);
    expect((await h.store.users.get(existing.id))?.humanTakeoverUntil).toBeDefined();
  });

  it('the history is checked once per customer; the bot\'s own earlier messages do not count as a human\'s', async () => {
    const u = h.user('own1');
    expect(await u.say('withdrawal nahi aaya')).toMatch(/withdrawal check karne ke liye/);
    h.restart(); // same store: the check is remembered, the bot's own reply in the chat changes nothing
    expect(await u.say('9810822372')).toBe(''); // request-only: silent follow-up, not a takeover
    expect((await h.store.users.get(u.id))?.humanTakeoverUntil).toBeUndefined();
  });

  it('when Telegram cannot be asked, the bot stays silent and asks again next time', async () => {
    const u = h.user('doubt1');
    h.transport.failHistoryChecks = 1;
    expect(await u.say('deposit nahi hua')).toBe('');
    expect(await h.casesOf(u.id)).toHaveLength(0);
    expect(await u.say('deposit nahi hua')).toMatch(/deposit check karne ke liye/);
  });

  it('a human hands the chat back with the resume command; only then does the bot answer again', async () => {
    const u = h.user('back1');
    h.transport.humanWroteEarlier(u.id);
    expect(await u.say('deposit nahi hua')).toBe('');
    await h.app.relay.onOwnOutgoing({ chatId: u.id, messageId: h.transport.nextId(u.id), text: '/ai' });
    h.advance(1);
    expect(await u.say('deposit nahi hua')).toMatch(/deposit check karne ke liye/);
  });
});
