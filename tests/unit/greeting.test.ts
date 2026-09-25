import { beforeEach, describe, expect, it } from 'vitest';
import { assemble, type App } from '../../src/app.js';
import { isGreeting } from '../../src/nlu/greeting.js';
import { silentLogger } from '../../src/observability/logger.js';
import { greetingText, requestText, solvedText } from '../../src/response/requests.js';
import { MemoryStore } from '../../src/storage/memory.js';
import { ADMIN, EXPORT_BOT, FakeTransport, NOW, SUPPORT, customerSends } from '../helpers/fakeTransport.js';

/**
 * A bare "Hi" / "Hello" / "Hlo" is answered with one greeting — ONLY when it opens a fresh
 * conversation: no open deposit/withdrawal case, nothing asked of the customer, nothing said in the
 * chat either way recently, no greeting already answered. Inside a case, or once a conversation is
 * under way, a greeting is as silent as everything else.
 */
let store: MemoryStore;
let t: FakeTransport;
let app: App;
let now: Date;
const build = (s = new MemoryStore()) => {
  store = s;
  t = new FakeTransport();
  now = NOW;
  app = assemble({ store, transport: t, log: silentLogger, clock: () => now, readState: t }, { adminIds: [ADMIN], supportChatId: SUPPORT, exportChatId: EXPORT_BOT, staleSeconds: 0, reopenHours: 48 });
};
const say = (userId: string, text: string) => app.onMessage(t.inbound(userId, text, [], now));
const repliesTo = (userId: string) => t.sent.filter((s) => s.chatId === userId).map((s) => s.text);
const advance = (minutes: number) => (now = new Date(now.getTime() + minutes * 60_000));

beforeEach(() => build());

describe('what counts as a greeting', () => {
  it('a greeting and nothing else, in any script, with punctuation, emoji and honorifics', () => {
    for (const m of ['Hi', 'hi', 'HI!!', 'Hii', 'hiii', 'Hlo', 'hlw', 'Hello', 'hello?', 'Helloo sir', 'Hey', 'hy', 'Hello sir ji', 'hi bhai', 'Namaste', 'namaste ji 🙏', 'Namaskar', 'Good morning', 'gm', 'good evening team', 'Hi 👋', 'नमस्ते', 'हेलो सर', 'हाय', 'Ram Ram', 'jai shree krishna', 'hello support', 'Hi Fantasy Adda']) {
      expect(isGreeting(m), m).toBe(true);
    }
  });

  it('one content word and it is a message about something, not a greeting', () => {
    for (const m of ['hi deposit nahi hua', 'hello sir paise nahi aaye', 'hi 9810822372', 'hello kya haal hai', 'hi sir help', 'good morning withdrawal pending', 'hai', 'ok', 'thanks', '?', 'hello sir mera paisa', '', '   ', 'hi hi hi hi hi hi hi']) {
      expect(isGreeting(m), m).toBe(false);
    }
  });
});

describe('a greeting opening a fresh conversation is answered once', () => {
  it('"Hi" from a new customer: one greeting, in their language; a second "hello" gets nothing', async () => {
    expect(await say('g1', 'Hi')).toBe('greeted');
    expect(repliesTo('g1')).toEqual([greetingText('hinglish')]);
    expect(t.sent[0]).toMatchObject({ chatId: 'g1', kind: 'greeting', replyTo: 1 });
    expect(await say('g1', 'hello')).toBe('greeting_skipped');
    expect(await say('g1', 'hlo sir')).toBe('greeting_skipped');
    expect(repliesTo('g1')).toHaveLength(1);
    expect((await store.users.get('g1'))?.greetedAt).toEqual(NOW);
    // The greeting is in the transcript like any other outgoing message.
    expect((await store.messages.recent('g1', 10)).map((m) => [m.direction, m.meta.kind])).toEqual([['in', undefined], ['out', 'greeting'], ['in', undefined], ['in', undefined]]);
  });

  it('Hindi and English greetings are answered in kind', async () => {
    expect(await say('g2', 'नमस्ते')).toBe('greeted');
    expect(repliesTo('g2')).toEqual([greetingText('hindi')]);
    expect(await say('g3', 'Hello')).toBe('greeted');
    expect(repliesTo('g3')).toEqual([greetingText('hinglish')]); // no language signal in "Hello": the default
  });

  it('then the issue comes: the greeting does not stand in the way of the one evidence request', async () => {
    expect(await say('g4', 'hi')).toBe('greeted');
    expect(await say('g4', 'deposit nahi hua wallet me')).toBe('requested');
    expect(repliesTo('g4')).toEqual([greetingText('hinglish'), requestText('deposit', 'hinglish')]);
    expect(await say('g4', 'hello?')).toBe('already_requested');
    expect(repliesTo('g4')).toHaveLength(2);
  });
});

describe('a greeting inside a case or an ongoing conversation is silent', () => {
  it('an open deposit case: "Hi" / "Hello" get nothing, like everything else in the case', async () => {
    expect(await say('c1', 'paise add nahi hue')).toBe('requested');
    for (const m of ['Hi', 'Hello', 'hlo', 'namaste', 'good morning sir']) expect(await say('c1', m), m).toBe('already_requested');
    expect(repliesTo('c1')).toEqual([requestText('deposit', 'hinglish')]);
  });

  it('an open withdrawal case, days later, still inside the case window: nothing', async () => {
    expect(await say('c2', 'withdrawal nahi aaya')).toBe('requested');
    advance(47 * 60);
    expect(await say('c2', 'Hi')).toBe('already_requested');
    expect(repliesTo('c2')).toHaveLength(1);
  });

  it('a solved case: a "hi" soon after is not a new conversation', async () => {
    const u = '6135570733';
    await say(u, 'deposit nahi hua');
    await app.onExportMessage({ messageId: 1, text: `✅ PAYMENT CONFIRMED\n👤 Customer: X (User ID: ${u})` });
    expect(repliesTo(u)).toEqual([requestText('deposit', 'hinglish'), solvedText('hinglish')]);
    advance(60);
    expect(await say(u, 'hi')).toBe('greeting_skipped');
    expect(repliesTo(u)).toHaveLength(2);
  });

  it('the customer already wrote something (unanswered): a later "hi" is not a new conversation', async () => {
    expect(await say('c4', 'amount credit nahi hua')).toBe('not_an_issue'); // unclear: silent
    advance(10);
    expect(await say('c4', 'Hello?')).toBe('greeting_skipped');
    expect(repliesTo('c4')).toHaveLength(0);
  });

  it('a human is in the chat, or read the message first: theirs to answer', async () => {
    await app.onOwnOutgoing({ chatId: 'c5', messageId: t.nextId('c5'), text: 'Sir, main dekh raha hoon' });
    expect(await say('c5', 'hi')).toBe('human');
    const m = t.inbound('c6', 'hello', [], now);
    t.humanReads('c6');
    expect(await app.onMessage(m)).toBe('seen_by_human');
    t.humanWroteEarlier('c7');
    expect(await say('c7', 'hi')).toBe('existing_conversation');
    expect(customerSends(t)).toHaveLength(0);
  });

  it('/botoff: no greeting either; a "hi" that arrived while OFF is never answered, the next one after /boton is', async () => {
    await say(ADMIN, '/botoff');
    expect(await say('c8', 'Hi')).toBe('bot_off');
    expect(customerSends(t)).toHaveLength(0);
    await say(ADMIN, '/boton');
    expect(await say('c8', 'Hi')).toBe('greeted'); // an earlier bare greeting does not make a conversation
    expect(customerSends(t)).toHaveLength(1);
  });

  it('after the case window a greeting opens a new conversation again', async () => {
    expect(await say('c9', 'hi')).toBe('greeted');
    advance(49 * 60);
    expect(await say('c9', 'hi')).toBe('greeted');
    expect(repliesTo('c9')).toHaveLength(2);
  });

  it('a restart does not greet the same customer twice (the record is on disk with the in-memory store)', async () => {
    const { mkdtempSync, rmSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const dir = mkdtempSync(join(tmpdir(), 'greeting-'));
    try {
      build(new MemoryStore({ usersFile: join(dir, 'users.json') }));
      expect(await say('r1', 'hi')).toBe('greeted');
      build(new MemoryStore({ usersFile: join(dir, 'users.json') }));
      t.nextId('r1');
      t.nextId('r1');
      expect(await say('r1', 'hello')).toBe('greeting_skipped');
      expect(t.sent).toHaveLength(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
