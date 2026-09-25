import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { assemble, type App } from '../../src/app.js';
import { REPLIES } from '../../src/control/adminCommands.js';
import { silentLogger } from '../../src/observability/logger.js';
import { greetingText, requestText, solvedText } from '../../src/response/requests.js';
import { MemoryStore } from '../../src/storage/memory.js';
import { ADMIN, EXPORT_BOT, FakeTransport, NOW, SUPPORT, customerSends, pdf, photo } from '../helpers/fakeTransport.js';

/**
 * The complete flow, end to end, through the real app wiring over a fake Telegram:
 *   customer writes → issue identified → ONE request → silence → team confirms → ONE solved note → silence.
 * Plus every way the agent must stay out: a human in the chat (before or after), OFF, restarts.
 */
let dir: string;
let now: Date;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'e2e-'));
  now = NOW;
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

/** A "process": store files in `dir` survive between boots, everything else is fresh. */
function boot(): { app: App; t: FakeTransport; store: MemoryStore } {
  const store = new MemoryStore({ requestsFile: join(dir, 'requests.json'), usersFile: join(dir, 'users.json') });
  const t = new FakeTransport();
  const app = assemble({ store, transport: t, log: silentLogger, clock: () => now, readState: t }, { adminIds: [ADMIN], supportChatId: SUPPORT, exportChatId: EXPORT_BOT, staleSeconds: 300, reopenHours: 48 });
  return { app, t, store };
}
const confirmation = (userId: string, order = 'ILLUN-1') => `✅ PAYMENT CONFIRMED\n\n👤 Customer: P Kumar (User ID: ${userId}, no username)\n\n📱 Mobile: 9810822372\n\n💰 Amount: ₹500\n\n🧾 Order: ${order}`;
const minutes = (n: number) => (now = new Date(now.getTime() + n * 60_000));

describe('end to end', () => {
  it('deposit: request once → silence → PAYMENT CONFIRMED → solved note once → silence', async () => {
    const { app, t } = boot();
    const u = '6135570708';
    const say = (text?: string, media = [] as ReturnType<typeof photo>) => app.onMessage(t.inbound(u, text, media, now));
    expect(await say('hi')).toBe('greeted'); // a fresh chat: the one greeting
    expect(await say('bhai maine 500 add kiye the wallet me nahi aaye')).toBe('requested');
    expect(t.sent.map((s) => s.text)).toEqual([greetingText('hinglish'), requestText('deposit', 'hinglish')]);
    // Everything the customer does next: nothing.
    minutes(1);
    for (const m of ['9810822372', 'ye lo screenshot', 'sir jaldi karo', 'kitna time lagega', 'hello?', 'deposit nahi hua abhi tak', 'withdrawal bhi check karo']) expect(await say(m), m).toBe('already_requested');
    expect(await say(undefined, photo())).toBe('no_text');
    expect(await say('statement', pdf())).toBe('already_requested');
    expect(await say('thanks')).toBe('already_requested');
    expect(t.sent).toHaveLength(2);
    // The team confirms through the export bot.
    minutes(30);
    await app.onExportMessage({ messageId: 1, text: confirmation(u) });
    expect(t.sent.map((s) => s.text)).toEqual([greetingText('hinglish'), requestText('deposit', 'hinglish'), solvedText('hinglish', { name: 'P Kumar', amount: '₹500', issue: 'deposit' })]);
    expect(t.sent[2]).toMatchObject({ chatId: u, kind: 'payment_confirmed' });
    // Same confirmation again, a thank-you, a question: nothing.
    await app.onExportMessage({ messageId: 2, text: confirmation(u) });
    expect(await say('thank you sir')).toBe('not_an_issue');
    expect(await say('ok')).toBe('not_an_issue');
    expect(await say('hi')).toBe('greeting_skipped'); // the conversation is under way: no second greeting
    expect(t.sent).toHaveLength(3);
    // A brand-new deposit problem later: a new case, one request.
    expect(await say('phir se deposit nahi hua 300 ka')).toBe('requested');
    expect(t.sent).toHaveLength(4);
  });

  it('withdrawal: request once (only the two withdrawal items) → silence for good; no confirmation path exists', async () => {
    const { app, t } = boot();
    const u = '7000000001';
    const say = (text: string) => app.onMessage(t.inbound(u, text, [], now));
    expect(await say('mera withdrawal 3 din se nahi aaya bank me')).toBe('requested');
    const text = t.sent[0]!.text;
    expect(text).toBe(requestText('withdrawal', 'hinglish'));
    expect(text).toMatch(/Withdrawal ID ya withdrawal history ka screenshot/);
    expect(text).toMatch(/bank statement PDF/);
    expect(text).not.toMatch(/registered number|payment screenshot|screen recording/i);
    minutes(5);
    for (const m of ['WD-15436-64215', 'ye statement', 'kab tak aayega', 'sir please', 'withdrawal nahi aaya', 'deposit bhi karna hai', 'hello']) expect(await say(m), m).toBe('already_requested');
    minutes(24 * 60);
    expect(await say('abhi tak nahi aaya')).toBe('already_requested');
    expect(t.sent).toHaveLength(1);
  });

  it('the solved note goes only to the confirmed User ID, never before a confirmation, never to anyone else', async () => {
    const { app, t } = boot();
    await app.onMessage(t.inbound('6135570708', 'deposit nahi hua', [], now));
    await app.onMessage(t.inbound('6135570709', 'deposit nahi hua', [], now));
    expect(t.sent).toHaveLength(2); // two requests
    // Other export bot chatter: nothing.
    for (const text of ['Files received 👍', '⚠️ MANUAL REVIEW NEEDED\nUser ID: 6135570708', '🗂 Found case ILLUN-1 for mobile 9810822372', 'PAYMENT PENDING\nUser ID: 6135570708', '✅ PAYMENT CONFIRMED\n📱 Mobile: 9810822372']) {
      await app.onExportMessage({ messageId: t.nextId(EXPORT_BOT), text });
    }
    expect(t.sent).toHaveLength(2);
    await app.onExportMessage({ messageId: t.nextId(EXPORT_BOT), text: confirmation('6135570708') });
    expect(t.sent.filter((s) => s.kind === 'payment_confirmed').map((s) => s.chatId)).toEqual(['6135570708']);
    expect(t.sent.filter((s) => s.chatId === '6135570709')).toHaveLength(1); // only their request
  });

  it('a human in the chat wins — before the agent ever saw the customer, or after the request', async () => {
    const { app, t } = boot();
    // Existing conversation: the team replied to this customer yesterday by hand.
    t.humanWroteEarlier('8000000001');
    expect(await app.onMessage(t.inbound('8000000001', 'deposit nahi hua', [], now))).toBe('existing_conversation');
    expect(await app.onMessage(t.inbound('8000000001', 'deposit nahi hua?', [], now))).toBe('human');
    // A fresh customer gets the request; then a human answers them; the agent stays out for 24 hours from the human's last message.
    expect(await app.onMessage(t.inbound('8000000002', 'withdrawal nahi aaya', [], now))).toBe('requested');
    await app.onOwnOutgoing({ chatId: '8000000002', messageId: t.nextId('8000000002'), text: 'Sir, checking' });
    minutes(20 * 60);
    expect(await app.onMessage(t.inbound('8000000002', 'deposit nahi hua', [], now))).toBe('human');
    await app.onOwnOutgoing({ chatId: '8000000002', messageId: t.nextId('8000000002'), text: 'ho jayega' }); // the human is still on it: the clock restarts
    minutes(20 * 60);
    expect(await app.onMessage(t.inbound('8000000002', 'deposit nahi hua', [], now))).toBe('human');
    minutes(10 * 60); // 30 hours after the human's last message (and the old case has aged past its window)
    expect(await app.onMessage(t.inbound('8000000002', 'deposit nahi hua', [], now))).toBe('requested');
    // Telegram unreachable for the history check: silent this turn, checked again next time.
    const { app: app2, t: t2 } = boot();
    t2.failHistoryChecks = 1;
    expect(await app2.onMessage(t2.inbound('8000000003', 'deposit nahi hua', [], now))).toBe('conversation_unverified');
    expect(await app2.onMessage(t2.inbound('8000000003', 'deposit nahi hua', [], now))).toBe('requested');
    expect(customerSends(t)).toHaveLength(2);
  });

  it('restart in the middle: the request is not repeated, a human takeover is remembered, the language is kept', async () => {
    let p = boot();
    expect(await p.app.onMessage(p.t.inbound('9000000001', 'I deposited money but wallet is empty', [], now))).toBe('requested');
    expect(await p.app.onMessage(p.t.inbound('9000000002', 'withdrawal nahi aaya', [], now))).toBe('requested');
    await p.app.onOwnOutgoing({ chatId: '9000000002', messageId: p.t.nextId('9000000002'), text: 'dekh raha hoon' });
    // Restart (only the files in `dir` survive).
    p = boot();
    minutes(10);
    expect(await p.app.onMessage(p.t.inbound('9000000001', 'still nothing in my wallet', [], now))).toBe('already_requested');
    expect(await p.app.onMessage(p.t.inbound('9000000002', 'withdrawal nahi aaya', [], now))).toBe('human');
    await p.app.onExportMessage({ messageId: 1, text: confirmation('9000000001') });
    expect(p.t.sent.map((s) => s.text)).toEqual([solvedText('english', { name: 'P Kumar', amount: '₹500', issue: 'deposit' })]); // language remembered across the restart
  });

  it('/botoff: nothing goes out — not a request, not a solved note; /boton: new messages only', async () => {
    const { app, t } = boot();
    await app.onMessage(t.inbound(ADMIN, '/botoff', [], now));
    expect(t.sent.at(-1)).toMatchObject({ chatId: ADMIN, text: REPLIES.off });
    expect(await app.onMessage(t.inbound('9100000001', 'deposit nahi hua', [], now))).toBe('bot_off');
    t.profiles.set('9100000002', { id: '9100000002', firstName: 'P', lastName: 'Kumar' });
    await app.onExportMessage({ messageId: 1, text: confirmation('9100000002') });
    expect(customerSends(t)).toHaveLength(0);
    await app.onMessage(t.inbound(ADMIN, '/boton', [], now));
    minutes(1);
    expect(await app.onMessage(t.inbound('9100000001', 'deposit nahi hua', [], now))).toBe('requested');
    await app.onExportMessage({ messageId: 2, text: confirmation('9100000002') });
    expect(customerSends(t).map((s) => [s.chatId, s.kind])).toEqual([['9100000001', 'evidence_request'], ['9100000002', 'payment_confirmed']]);
  });

  it('old messages are never answered: a stale message on arrival is stored and ignored', async () => {
    const { app, t } = boot();
    expect(await app.onMessage(t.inbound('9200000001', 'deposit nahi hua', [], new Date(now.getTime() - 20 * 60_000)))).toBe('stale');
    expect(t.sent).toHaveLength(0);
  });
});

describe('/status and old-bot detection', () => {
  it('/status reports ON/OFF, version, what was sent, and any old-bot replies seen in customer chats', async () => {
    const store = new MemoryStore();
    const t = new FakeTransport();
    const app = assemble({ store, transport: t, log: silentLogger, clock: () => now }, { adminIds: [ADMIN], supportChatId: SUPPORT, exportChatId: EXPORT_BOT, version: 'abc1234', transportStats: () => ({ reconnects: 5, lastUpdateAt: new Date(now.getTime() - 12_000) }) });
    await app.onMessage(t.inbound('6135570708', 'deposit nahi hua', [], now));
    // The account sends something this process did not: a human's short line, then the OLD bot's wording.
    await app.onOwnOutgoing({ chatId: '6135570708', messageId: 50, text: 'dekh raha hoon' });
    expect(app.otherCopy.sightings).toHaveLength(0);
    await app.onOwnOutgoing({ chatId: '6135570709', messageId: 51, text: 'Samajh sakta hoon sir, pareshani ke liye sorry 🙏' });
    await app.onOwnOutgoing({ chatId: '6135570710', messageId: 52, text: 'Samajh gaya sir 👍 Deposit ka issue hai ya withdrawal ka?' });
    expect(app.otherCopy.sightings.map((s) => s.chatId)).toEqual(['6135570709', '6135570710']);
    await app.onMessage(t.inbound(ADMIN, '/status', [], now));
    const reply = t.sent.at(-1)!;
    expect(reply.chatId).toBe(ADMIN);
    expect(reply.text).toMatch(/✅ Bot is ON/);
    expect(reply.text).toMatch(/Code: abc1234/);
    expect(reply.text).toMatch(/1 evidence request, 0 solved notes, 0 greetings/);
    expect(reply.text).toMatch(/stream taken over 5× since start ⚠️ another connection is using this session/);
    expect(reply.text).toMatch(/OLD bot wording seen 2× in the last 24h/);
    // A customer typing /status gets nothing and learns nothing.
    const before = t.sent.length;
    expect(await app.onMessage(t.inbound('6135570711', '/status', [], now))).toBe('not_an_issue');
    expect(t.sent).toHaveLength(before);
  });
});
