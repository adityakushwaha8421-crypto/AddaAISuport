import { beforeEach, describe, expect, it } from 'vitest';
import { DisabledAdminGateway } from '../../src/admin/fixture.js';
import { Harness } from '../helpers/harness.js';

/**
 * A human handling the customer always wins. Once a human has written in the chat from the account,
 * the bot is completely silent there — for greetings, follow-ups and brand-new issues alike — and
 * starts nothing, until the human hands the chat back with the resume command.
 */
let h: Harness;
beforeEach(() => {
  h = new Harness({ adminGateway: new DisabledAdminGateway() });
});

const humanTypes = (chatId: string, text: string, messageId = 900) => h.app.relay.onOwnOutgoing({ chatId, messageId, text });

describe('a human is handling the customer', () => {
  it('the bot falls silent for everything, and the pending case is closed, not continued', async () => {
    const u = h.user('hh1');
    expect(await u.say('deposit nahi aaya')).toMatch(/deposit check karne ke liye/);
    await humanTypes(u.id, 'Sir, main khud check kar raha hoon, 10 minute dijiye.');
    expect((await h.casesOf(u.id)).map((c) => c.status)).toEqual(['closed']);
    const sent = h.transport.sent.length;
    expect(await u.say('9810822372')).toBe(''); // the answer to the bot's request goes to the human now
    expect(await u.say('hi')).toBe('');
    expect(await u.say('withdrawal bhi nahi aaya')).toBe(''); // a clearly different issue: still the human's
    expect(await u.say('kya bhejna hai?')).toBe('');
    expect(h.transport.sent).toHaveLength(sent);
    expect(await h.casesOf(u.id)).toHaveLength(1); // no new workflow was started
  });

  it('the silence does not expire on its own', async () => {
    const u = h.user('hh2');
    await u.say('withdrawal nahi aaya');
    await humanTypes(u.id, 'Checking sir');
    h.advance(3 * 24 * 60);
    expect(await u.say('hello')).toBe('');
    expect(await u.say('deposit nahi hua')).toBe('');
    expect(await h.casesOf(u.id)).toHaveLength(1);
  });

  it('the human hands the chat back with the resume command, and the bot takes the next message', async () => {
    const u = h.user('hh3');
    await u.say('withdrawal nahi aaya');
    await humanTypes(u.id, 'Sir aapka issue solve kar diya hai.');
    expect(await u.say('thank you')).toBe('');
    await humanTypes(u.id, '/ai', 901);
    expect(await u.say('ek deposit ka issue bhi hai')).toMatch(/deposit check karne ke liye/);
    expect((await h.casesOf(u.id)).map((c) => c.type).sort()).toEqual(['deposit', 'withdrawal']);
  });

  it('"/bot" hands back too, and the command itself never takes the chat over', async () => {
    const u = h.user('hh4');
    expect(await u.say('hi')).toMatch(/Hello sir/);
    await humanTypes(u.id, '/bot', 902); // typed with no takeover in place: nothing changes
    expect(await u.say('deposit nahi aaya')).toMatch(/deposit check karne ke liye/);
    await humanTypes(u.id, 'ek minute');
    expect(await u.say('9810822372')).toBe('');
    await humanTypes(u.id, '/BOT ', 903);
    expect(await u.say('deposit nahi aaya')).toMatch(/deposit check karne ke liye/);
  });

  it('a human writing first, before the bot ever replied, also owns the chat', async () => {
    const u = h.user('hh5');
    await humanTypes(u.id, 'Hello sir, kaise help karun?');
    expect(await u.say('deposit nahi aaya')).toBe('');
    expect(await h.casesOf(u.id)).toHaveLength(0);
  });
});
