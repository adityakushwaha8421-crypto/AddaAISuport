import { beforeEach, describe, expect, it } from 'vitest';
import { assemble, type App } from '../../src/app.js';
import { REPLIES } from '../../src/control/adminCommands.js';
import { ScriptedLlm } from '../../src/llm/fake.js';
import { silentLogger } from '../../src/observability/logger.js';
import { requestText, solvedText } from '../../src/response/requests.js';
import { MemoryStore } from '../../src/storage/memory.js';
import { ADMIN, EXPORT_BOT, FakeTransport, NOW, SUPPORT, customerSends, pdf, photo } from '../helpers/fakeTransport.js';

/**
 * The one workflow: deposit or withdrawal is read from the message, the evidence request goes out
 * ONCE per case, then the case is silent whatever the customer writes. The team handles it. The
 * only other customer message is the solved note after the export bot's PAYMENT CONFIRMED with a
 * User ID — once per payment, in the customer's language. Nothing else, ever.
 */
let store: MemoryStore;
let t: FakeTransport;
let app: App;
let now: Date;
const build = (opts: { llm?: ScriptedLlm; staleSeconds?: number } = {}) => {
  store = new MemoryStore();
  t = new FakeTransport();
  now = NOW;
  app = assemble(
    { store, transport: t, log: silentLogger, clock: () => now, llm: opts.llm, readState: t },
    { adminIds: [ADMIN], supportChatId: SUPPORT, exportChatId: EXPORT_BOT, staleSeconds: opts.staleSeconds ?? 0, reopenHours: 48 },
  );
};
const say = (userId: string, text?: string, media = [] as ReturnType<typeof photo>) => app.onMessage(t.inbound(userId, text, media, now));
const repliesTo = (userId: string) => t.sent.filter((s) => s.chatId === userId).map((s) => s.text);
const advance = (minutes: number) => (now = new Date(now.getTime() + minutes * 60_000));

beforeEach(() => build());

describe('identify the issue, request once, then silence', () => {
  it('deposit: one request, then nothing for anything the customer writes or sends', async () => {
    expect(await say('d1', 'paise add nahi hue wallet me')).toBe('requested');
    expect(repliesTo('d1')).toEqual([requestText('deposit', 'hinglish')]);
    for (const m of ['hi', 'hello sir', '9810822372', 'ok', 'kya bhejna hai?', 'kitna time lagega', 'sir jaldi karo', 'deposit abhi tak nahi hua', 'paise add nahi hue', 'thanks']) {
      expect(await say('d1', m), m).toBe('already_requested');
    }
    expect(await say('d1', undefined, photo())).toBe('no_text');
    expect(await say('d1', 'statement', pdf())).toBe('already_requested');
    expect(repliesTo('d1')).toHaveLength(1);
  });

  it('withdrawal: the request lists only the Withdrawal ID / history screenshot and the bank statement PDF', async () => {
    expect(await say('w1', 'mera withdrawal abhi tak bank me nahi aaya')).toBe('requested');
    const text = repliesTo('w1')[0]!;
    expect(text).toBe(requestText('withdrawal', 'hinglish'));
    expect(text).toMatch(/Withdrawal ID ya withdrawal history ka screenshot/);
    expect(text).toMatch(/bank statement PDF/);
    expect(text).not.toMatch(/registered number|screen recording|payment screenshot/i);
    expect(await say('w1', 'WD-15436-64215')).toBe('already_requested');
    expect(repliesTo('w1')).toHaveLength(1);
  });

  it('reads the direction of the money in Hinglish, Hindi and English, misspellings and all', async () => {
    const deposits = ['Maine payment kar diya but balance nahi aaya', 'Money deducted but balance nahi aaya', 'Amount add kiya balance nahi badha', 'मैंने पैसे डाले लेकिन वॉलेट में नहीं आए', 'I added money but it is not showing in my wallet', 'recharge nhi hua paisa kat gya', 'depost nahi hua'];
    const withdrawals = ['Mera withdrawal nahi aaya', 'Bank me paise nahi aaye', 'Winnings withdraw kiya par account me nahi aaya', 'मेरा विड्रॉल अभी तक बैंक में नहीं आया', 'I withdrew my winnings but nothing reached my bank account', 'widrawal pending hai 3 din se', 'mere paise nahi aaye'];
    for (const [i, m] of deposits.entries()) {
      const u = `dep${i}`;
      expect(await say(u, m), m).toBe('requested');
      expect(repliesTo(u)[0], m).toMatch(/deposit|Deposit|डिपॉज़िट/);
    }
    for (const [i, m] of withdrawals.entries()) {
      const u = `wd${i}`;
      expect(await say(u, m), m).toBe('requested');
      expect(repliesTo(u)[0], m).toMatch(/withdrawal|Withdrawal|विड्रॉल/);
    }
  });

  it('answers in the customer\'s language', async () => {
    await say('en', 'I deposited 500 rupees but it is not showing in my wallet');
    expect(repliesTo('en')[0]).toBe(requestText('deposit', 'english'));
    await say('hi', 'मेरा विड्रॉल बैंक में नहीं आया');
    expect(repliesTo('hi')[0]).toBe(requestText('withdrawal', 'hindi'));
  });

  it('anything that is not clearly a deposit or withdrawal gets nothing: no question, no guess (a bare greeting opening a chat is the one exception, tested in greeting.test.ts)', async () => {
    for (const m of ['hi sir kuch puchna tha', 'thanks', 'match cancel ho gaya points nahi mile', 'lineup kab aayega', 'otp nahi aaya', 'app crash ho raha hai', 'login nahi ho raha', 'amount credit nahi hua', 'kuch bhi random', '/start', 'human se baat karao']) {
      expect(await say('n1', m), m).toBe('not_an_issue');
    }
    expect(repliesTo('n1')).toHaveLength(0);
    expect(await store.requests.listOpen('n1')).toHaveLength(0);
  });

  it('when the scorer cannot tell, the model is asked once; its "other"/"unclear" means silence', async () => {
    const llm = new ScriptedLlm();
    llm.on('issue_type', (req) => ({ issue: /500 ka/i.test(String(req.user)) ? 'deposit' : 'unclear' }));
    build({ llm });
    expect(await say('m1', 'bhai 500 ka kiya tha kuch dikh nahi raha yaar')).toBe('requested');
    expect(repliesTo('m1')[0]).toMatch(/deposit/);
    expect(await say('m2', 'amount credit nahi hua abhi tak')).toBe('not_an_issue');
    expect(repliesTo('m2')).toHaveLength(0);
    expect(llm.calls.filter((c) => c.purpose === 'issue_type')).toHaveLength(2);
  });

  it('after the request the chat is completely silent — even for a different kind of problem — until the case is old', async () => {
    expect(await say('two', 'deposit nahi hua')).toBe('requested');
    expect(await say('two', 'aur mera withdrawal bhi nahi aaya')).toBe('already_requested');
    expect(await say('two', 'deposit nahi hua')).toBe('already_requested');
    expect(repliesTo('two')).toHaveLength(1);
    advance(49 * 60); // two days later: a fresh problem
    expect(await say('two', 'withdrawal nahi aaya')).toBe('requested');
    expect(repliesTo('two')).toHaveLength(2);
  });

  it('a human in the chat wins: their message silences the agent for 24 hours; a message they already read is theirs', async () => {
    await say('h1', 'hello sir ek problem hai');
    await app.onOwnOutgoing({ chatId: 'h1', messageId: t.nextId('h1'), text: 'Sir, main dekh raha hoon' });
    expect(await say('h1', 'deposit nahi hua')).toBe('human');
    advance(23 * 60);
    expect(await say('h1', 'deposit nahi hua')).toBe('human');
    advance(2 * 60); // 25 hours after the human's message: the agent may act again
    expect(await say('h1', 'deposit nahi hua')).toBe('requested');
    // Read before the agent got to it.
    const m = t.inbound('h2', 'withdrawal nahi aaya', [], now);
    t.humanReads('h2');
    expect(await app.onMessage(m)).toBe('seen_by_human');
    expect(repliesTo('h2')).toHaveLength(0);
  });

  it('/botoff: nothing, including for a case that would get its request; /boton answers only new messages', async () => {
    await say(ADMIN, '/botoff');
    expect(t.sent.at(-1)).toMatchObject({ chatId: ADMIN, text: REPLIES.off });
    expect(await say('off1', 'deposit nahi hua')).toBe('bot_off');
    expect(customerSends(t)).toHaveLength(0);
    expect(await store.requests.listOpen('off1')).toHaveLength(0); // nothing half-done
    await say(ADMIN, '/boton');
    expect(await say('off1', 'deposit nahi hua')).toBe('requested');
  });

  it('a stale message (a restart, a catch-up) is never answered', async () => {
    build({ staleSeconds: 300 });
    expect(await app.onMessage(t.inbound('s1', 'deposit nahi hua', [], new Date(now.getTime() - 10 * 60_000)))).toBe('stale');
    expect(repliesTo('s1')).toHaveLength(0);
  });

  it('a failed send leaves no half-open case: the next message asks again', async () => {
    t.failSends = 1;
    expect(await say('f1', 'deposit nahi hua')).toBe('send_failed');
    expect(await store.requests.listOpen('f1')).toHaveLength(0);
    expect(await say('f1', 'deposit nahi hua?')).toBe('requested');
    expect(repliesTo('f1')).toHaveLength(1);
  });

  it('the request is recorded in the transcript as an outgoing message', async () => {
    await say('r1', 'deposit nahi hua');
    const rows = await store.messages.recent('r1', 5);
    expect(rows.map((r) => [r.direction, r.meta.kind])).toEqual([['in', undefined], ['out', 'evidence_request']]);
    expect(t.sent[0]).toMatchObject({ kind: 'evidence_request', replyTo: 1 });
  });
});

describe('PAYMENT CONFIRMED → one solved note', () => {
  const confirmation = (userId: string, extra = '') => `✅ PAYMENT CONFIRMED\n\n👤 Customer: P Kumar (User ID: ${userId}, no username)\n\n📱 Mobile: 9810822372\n\n💰 Amount: ₹500${extra}`;

  it('tells exactly that user once, in their language, and closes their case', async () => {
    await say('6135570708', 'I deposited money but my wallet does not show it');
    await say('6135570709', 'deposit nahi hua');
    await app.onExportMessage({ messageId: 1, text: confirmation('6135570708', '\n\n🧾 Order: ILLUN-178923603882201') });
    expect(repliesTo('6135570708')).toEqual([requestText('deposit', 'english'), solvedText('english', { name: 'P Kumar', amount: '₹500', issue: 'deposit' })]);
    expect(repliesTo('6135570709')).toHaveLength(1); // only their own request
    expect(await store.requests.listOpen('6135570708')).toHaveLength(0);
    // Re-sent, re-worded, same order → nothing more.
    await app.onExportMessage({ messageId: 2, text: confirmation('6135570708', '\n\n🧾 Order: ILLUN-178923603882201') });
    await app.onExportMessage({ messageId: 3, text: confirmation('6135570708', '\n\n🧾 Order: illun-178923603882201').replace('P Kumar', 'P. Kumar') });
    expect(repliesTo('6135570708')).toHaveLength(2);
    // After being solved, the case is over: a new deposit problem gets a new request.
    expect(await say('6135570708', 'deposit again not showing in wallet')).toBe('requested');
  });

  it('works for a customer with no stored conversation (exact User ID), dedupes by text when there is no order line', async () => {
    t.profiles.set('7777777001', { id: '7777777001', firstName: 'Pankaj', lastName: 'Kumar' }); // Telegram knows them even though nothing is stored
    const text = confirmation('7777777001');
    expect(await app.confirmations.onExportMessage({ messageId: 10, text })).toBe('solved');
    expect(t.sent).toEqual([{ chatId: '7777777001', text: solvedText('hinglish', { name: 'Pankaj Kumar', amount: '₹500', issue: 'deposit' }), kind: 'payment_confirmed', replyTo: undefined }]);
    expect(await app.confirmations.onExportMessage({ messageId: 11, text })).toBe('duplicate');
    expect(await app.confirmations.onExportMessage({ messageId: 12, text: text.replace('₹500', '₹350') })).toBe('solved'); // a different payment
    expect(t.sent).toHaveLength(2);
  });

  it('no User ID, not a confirmation, or bot OFF: nobody is messaged', async () => {
    expect(await app.confirmations.onExportMessage({ messageId: 1, text: '✅ PAYMENT CONFIRMED\n📱 Mobile: 9810822372' })).toBe('ignored');
    expect(await app.confirmations.onExportMessage({ messageId: 2, text: 'Files received 👍' })).toBe('ignored');
    expect(await app.confirmations.onExportMessage({ messageId: 3, text: '⚠️ MANUAL REVIEW NEEDED\nUser ID: 6135570708' })).toBe('ignored');
    await app.botSwitch.set(false);
    t.profiles.set('6135570708', { id: '6135570708', firstName: 'P', lastName: 'Kumar' });
    expect(await app.confirmations.onExportMessage({ messageId: 4, text: confirmation('6135570708') })).toBe('bot_off');
    expect(t.sent).toHaveLength(0);
    await app.botSwitch.set(true);
    expect(await app.confirmations.onExportMessage({ messageId: 5, text: confirmation('6135570708') })).toBe('solved'); // not lost: told once ON
  });
});

describe('deposit: asked once, across restarts too', () => {
  it('a process restart does not ask the same customer again (the ledger is on disk with the in-memory store)', async () => {
    const { mkdtempSync, rmSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const dir = mkdtempSync(join(tmpdir(), 'requests-'));
    const file = join(dir, 'requests.json');
    try {
      const boot = () => {
        const s = new MemoryStore({ requestsFile: file });
        const tr = new FakeTransport();
        const a = assemble({ store: s, transport: tr, log: silentLogger, clock: () => NOW }, { adminIds: [ADMIN], supportChatId: SUPPORT, exportChatId: EXPORT_BOT });
        return { s, tr, a };
      };
      const first = boot();
      expect(await first.a.onMessage(first.tr.inbound('6135570777', 'deposit nahi hua', [], NOW))).toBe('requested');
      // The process restarts: new store, new transport, only the file survives.
      const second = boot();
      second.tr.nextId('6135570777'); // the customer's earlier message id is taken
      for (const m of ['deposit nahi hua', 'paise add nahi hue abhi tak', 'hello?', 'kitna time lagega']) {
        expect(await second.a.onMessage(second.tr.inbound('6135570777', m, [], NOW)), m).toBe('already_requested');
      }
      expect(second.tr.sent).toHaveLength(0);
      // Solved by the team → the ledger closes it, and a later new deposit problem gets its own request.
      await second.a.onExportMessage({ messageId: 1, text: '✅ PAYMENT CONFIRMED\n👤 Customer: P Kumar (User ID: 6135570777)\n💰 Amount: ₹500' });
      const third = boot();
      expect(await third.a.onMessage(third.tr.inbound('6135570777', 'deposit phir se nahi hua', [], new Date(NOW.getTime() + 60_000)))).toBe('requested');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('no reminder exists: days of silence from the customer, then any message — still nothing', async () => {
    build();
    expect(await say('quiet', 'deposit nahi hua')).toBe('requested');
    advance(47 * 60); // just inside the case window
    for (const m of ['?', 'hello', 'koi hai', 'deposit ka kya hua', 'abhi tak nahi hua']) expect(await say('quiet', m), m).toBe('already_requested');
    expect(repliesTo('quiet')).toHaveLength(1);
  });
});

/**
 * Root causes found on the live account on 2026-09-25 (log + data/users.json): customers with a
 * clear deposit message got no request because (1) a takeover from the older "until the resume
 * command" rule was stored as never expiring, and (2) a human reply from any time in the past made
 * the chat "an existing conversation". Both must never silence a customer again.
 */
describe('a clear deposit message is answered: nothing stale silences the customer', () => {
  const DEPOSITS = ['Deposit is not done yet after transfer money', 'deposit not done', 'I transferred money but deposit is pending', 'money transferred but not deposited', 'deposit not received', 'Paise add nahi hue', 'payment cut my account 300 not available my wallet'];

  it('the screenshot phrase and its variants each get the deposit request', async () => {
    build();
    for (const [i, m] of DEPOSITS.entries()) {
      expect(await say(`dep-${i}`, m), m).toBe('requested');
      expect(repliesTo(`dep-${i}`), m).toHaveLength(1);
      expect(repliesTo(`dep-${i}`)[0], m).toMatch(/deposit|Deposit/); // in the customer's language
    }
  });

  it('a takeover that could never expire (stored by the older rule) is dropped and the customer is answered', async () => {
    build();
    await store.users.upsert({ id: '803897666', chatId: '803897666', humanTakeoverUntil: new Date('9999-12-31T00:00:00Z'), conversationChecked: now });
    expect(await say('803897666', 'Deposit is not done yet after transfer money')).toBe('requested');
    expect((await store.users.get('803897666'))?.humanTakeoverUntil).toBeUndefined();
    // A genuine, current takeover is still honoured.
    await app.onOwnOutgoing({ chatId: '803897666', messageId: t.nextId('803897666'), text: 'dekh raha hoon' });
    advance(60);
    expect(await say('803897666', 'deposit nahi hua')).toBe('human');
    advance(48 * 60); // the takeover expires like any other (and the first case is past its window)
    expect(await say('803897666', 'deposit nahi hua')).toBe('requested');
  });

  it("a human's reply from days ago does not make the chat theirs today; one from an hour ago does, until 24 h after it", async () => {
    build();
    t.humanWroteEarlier('old', new Date(now.getTime() - 3 * 24 * 3_600_000));
    expect(await say('old', 'deposit not received')).toBe('requested');
    t.humanWroteEarlier('recent', new Date(now.getTime() - 60 * 60_000));
    expect(await say('recent', 'deposit not received')).toBe('existing_conversation');
    advance(23 * 60 + 1); // 24 h after the human's message, not after the check
    expect(await say('recent', 'deposit not received')).toBe('requested');
  });

  it('with HUMAN_TAKEOVER_HOURS=0 (for good) the old rules still hold: any human message ever, and a forever takeover, keep the chat theirs', async () => {
    store = new MemoryStore();
    t = new FakeTransport();
    app = assemble({ store, transport: t, log: silentLogger, clock: () => now, readState: t }, { adminIds: [ADMIN], supportChatId: SUPPORT, exportChatId: EXPORT_BOT, takeoverHours: 0 });
    t.humanWroteEarlier('ever', new Date(now.getTime() - 30 * 24 * 3_600_000));
    expect(await say('ever', 'deposit nahi hua')).toBe('existing_conversation');
    await store.users.upsert({ id: 'f', chatId: 'f', humanTakeoverUntil: new Date('9999-12-31T00:00:00Z'), conversationChecked: now });
    expect(await say('f', 'deposit nahi hua')).toBe('human');
  });
});
