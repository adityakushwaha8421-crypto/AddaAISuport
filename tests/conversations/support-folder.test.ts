import { beforeEach, describe, expect, it } from 'vitest';
import { SCREENSHOTS } from '../helpers/fakeVision.js';
import { ADMIN_FIXTURES } from '../helpers/fixtures.js';
import { Harness } from '../helpers/harness.js';

/**
 * Two folders for the human team, decided by the latest customer message alone:
 * match problems → "Match issues", every other support matter → "Support", small talk → neither.
 * A chat is never in both.
 */
let h: Harness;
beforeEach(() => {
  h = new Harness({ fixtures: ADMIN_FIXTURES });
  h.vision.set('pay500', SCREENSHOTS.payment500);
});

describe('non-match support issues go to "Support"', () => {
  it.each([
    ['deposit nahi aaya', 'deposit'],
    ['withdrawal abhi tak nahi aaya', 'withdrawal'],
    ['KYC verify nahi ho raha', 'account'],
    ['login nahi ho raha', 'login'],
    ['app crash ho raha hai', 'technical'],
    ['paisa nahi aaya', 'payment'],
    ['mujhe kisi insaan se baat karni hai', 'human request'],
  ])('"%s" (%s) → Support only', async (text) => {
    const u = h.user(`s-${text}`);
    await u.say(text);
    expect(h.folderOf(u.id)).toBe('support');
  });

  it('small talk with no issue behind it goes in neither folder', async () => {
    await h.user('hi').say('hello');
    await h.user('ty').say('thanks');
    expect([h.folderOf('hi'), h.folderOf('ty')]).toEqual(['none', 'none']);
  });

  it('answers, documents and an "ok" inside a deposit case keep it in Support', async () => {
    const u = h.user('docs');
    await u.say('deposit nahi aaya');
    await u.say('ok');
    expect(h.folderOf(u.id)).toBe('support');
    await u.photo('pay500');
    expect(h.folderOf(u.id)).toBe('support');
    await u.say('9810822372');
    expect(h.folderOf(u.id)).toBe('support');
  });
});

describe('the latest message always decides', () => {
  it('match → support → match → support → neither, never in both', async () => {
    const u = h.user('flip');
    const steps: Array<[string, 'match' | 'support' | 'none']> = [
      ['points galat hai', 'match'],
      ['deposit nahi aaya', 'support'], // earlier match issue, now a deposit: moved to Support
      ['lineup galat hai sir', 'match'], // match again: moved back
      ['withdrawal nahi aaya', 'support'],
      ['hello', 'none'],
      ['player missing hai team me', 'match'],
    ];
    for (const [text, folder] of steps) {
      await u.say(text);
      expect(h.folderOf(u.id), text).toBe(folder);
    }
  });

  it('a message with both a deposit and a match problem is match-related: Match issues, no reply', async () => {
    const u = h.user('both');
    expect(await u.say('deposit nahi aaya aur points bhi galat hai')).toBe('');
    expect(h.folderOf(u.id)).toBe('match');
  });

  it('keeps different customers in their own folders', async () => {
    await h.user('a').say('points galat hai');
    await h.user('b').say('deposit nahi aaya');
    await h.user('c').say('hello');
    expect([h.folderOf('a'), h.folderOf('b'), h.folderOf('c')]).toEqual(['match', 'support', 'none']);
  });
});

describe('humans, restarts and failures', () => {
  it('a human reply takes a chat out of Support as well as Match issues', async () => {
    const s = h.user('human-s');
    const m = h.user('human-m');
    await s.say('deposit nahi aaya');
    await m.say('points galat hai');
    await h.app.relay.onOwnOutgoing({ chatId: s.id });
    await h.app.relay.onOwnOutgoing({ chatId: m.id });
    expect([h.folderOf(s.id), h.folderOf(m.id)]).toEqual(['none', 'none']);
    await s.say('withdrawal bhi nahi aaya'); // a later support message files it again
    expect(h.folderOf(s.id)).toBe('support');
  });

  it('while a human has the chat, the latest message still decides — and the bot stays quiet', async () => {
    const u = h.user('takeover');
    await u.say('deposit nahi aaya');
    await h.app.relay.onOwnOutgoing({ chatId: u.id });
    const sent = h.transport.sent.length;
    await u.say('points galat hai');
    expect(h.folderOf(u.id)).toBe('match');
    await u.say('deposit abhi tak nahi aaya');
    expect(h.folderOf(u.id)).toBe('support');
    expect(h.transport.sent).toHaveLength(sent);
  });

  it('after a restart the chat still moves out of the folder the previous process chose', async () => {
    const u = h.user('restart');
    await u.say('deposit nahi aaya');
    h.restart();
    await u.say('points galat hai');
    expect(h.folderOf(u.id)).toBe('match');
  });

  it('a failed move leaves the chat where it was, and the next message completes it', async () => {
    const u = h.user('flood');
    await u.say('deposit nahi aaya');
    h.folders.failNext = 1;
    expect(await u.say('points galat hai')).toBe('');
    expect(h.folderOf(u.id)).toBe('support');
    await u.say('lineup galat hai sir');
    expect(h.folderOf(u.id)).toBe('match');
  });
});
