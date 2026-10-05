import { describe, expect, it, vi } from 'vitest';
import { assemble, type App } from '../../src/app.js';
import type { ContentPart } from '../../src/llm/client.js';
import { ScriptedLlm } from '../../src/llm/fake.js';
import type { MediaRef } from '../../src/domain/messages.js';
import { normaliseWithdrawalStatus, type WithdrawalLookup } from '../../src/evidence/withdrawalScreenshot.js';
import { extractWithdrawalIds, sameWithdrawalId } from '../../src/nlu/withdrawalId.js';
import { silentLogger } from '../../src/observability/logger.js';
import { requestText, statementRequestText, withdrawalPendingText } from '../../src/response/requests.js';
import { MemoryStore } from '../../src/storage/memory.js';
import { ADMIN, EXPORT_BOT, FakeTransport, NOW, SUPPORT, customerSends } from '../helpers/fakeTransport.js';

/**
 * A withdrawal is checked in steps:
 *   1. the customer is asked for the Withdrawal ID or a screenshot of the withdrawal history;
 *   2. what that shows decides the one next message —
 *        Pending  → "usually credited within 12–24 hours" (straight from the screenshot, no panel);
 *        Success  → the bank statement is asked for;
 *        anything else, or nothing readable → silence, the team looks.
 * An id typed on its own needs the team's panel; with none wired it is left to the team.
 */
type Row = { id?: string; status?: string; amount?: number };
/** A screenshot, named by what it shows (the scripted model "reads" these bytes). */
const shot = (rows: Row[] | 'not-a-withdrawal-screen') => Buffer.from(JSON.stringify(rows));

let store: MemoryStore;
let t: FakeTransport;
let app: App;
let llm: ScriptedLlm;
const build = (opts: { lookup?: WithdrawalLookup; store?: MemoryStore; llm?: ScriptedLlm | null } = {}) => {
  store = opts.store ?? new MemoryStore();
  t = new FakeTransport();
  llm = new ScriptedLlm();
  llm.on('withdrawal_screenshot', (req) => {
    const image = (req.user as ContentPart[]).find((p) => p.type === 'image') as Extract<ContentPart, { type: 'image' }>;
    const seen = JSON.parse(image.data.toString()) as Row[] | 'not-a-withdrawal-screen';
    if (seen === 'not-a-withdrawal-screen') return { is_withdrawal_screen: false, rows: [] };
    return { is_withdrawal_screen: true, rows: seen.map((r, i) => ({ position: i + 1, withdrawal_id: r.id ?? null, status: r.status ?? null, amount: r.amount ?? null })) };
  });
  llm.on('issue_type', () => ({ issue: 'other' }));
  app = assemble(
    { store, transport: t, log: silentLogger, clock: () => NOW, llm: opts.llm === null ? undefined : (opts.llm ?? llm), readState: t, withdrawalLookup: opts.lookup },
    { adminIds: [ADMIN], supportChatId: SUPPORT, exportChatId: EXPORT_BOT, reopenHours: 48 },
  );
};
const say = (userId: string, text?: string) => app.onMessage(t.inbound(userId, text, [], NOW));
/** The customer sends a photo (optionally with a caption). */
const sendShot = (userId: string, image: Buffer, caption?: string) => {
  const m = t.inbound(userId, undefined, [], NOW);
  const ref: MediaRef = { kind: 'photo', fileRef: `${userId}:${m.messageId}`, fileUniqueId: `p${m.messageId}`, mimeType: 'image/jpeg' };
  t.media.set(ref.fileRef, image);
  return app.onMessage({ ...m, caption, media: [ref] });
};
const repliesTo = (userId: string) => t.sent.filter((s) => s.chatId === userId).map((s) => s.text);
const reads = () => llm.calls.filter((c) => c.purpose === 'withdrawal_screenshot').length;

describe('step 1: the Withdrawal ID or a screenshot, nothing else yet', () => {
  it('the first message of a withdrawal case asks only for the id / the history screenshot', async () => {
    build();
    expect(await say('w1', 'mera withdrawal bank me nahi aaya')).toBe('requested');
    expect(repliesTo('w1')).toEqual([requestText('withdrawal', 'hinglish')]);
    expect(repliesTo('w1')[0]).toBe('Sir, withdrawal check karne ke liye please ye detail bhej dijiye 🙏\n\n🧾 Withdrawal ID\nApni Withdrawal ID ya withdrawal history ka screenshot bhej dijiye.');
    expect((await store.requests.listOpen('w1'))[0]).toMatchObject({ issueType: 'withdrawal', stage: 'awaiting_evidence' });
  });
});

describe('step 2 from the screenshot', () => {
  it('Pending → the 12–24 hours note, once; after it the case is silent', async () => {
    build();
    await say('p1', 'I withdrew my money but it has not reached my bank account');
    expect(await sendShot('p1', shot([{ id: 'WD-19106-67317', status: 'Pending', amount: 2660 }]))).toBe('pending_told');
    expect(repliesTo('p1').at(-1)).toBe('Hello 👋\n\nAfter placing a withdrawal request, the amount is usually credited to your bank account within 12–24 hours.\n\nThank you for playing with us and for your patience.');
    expect(t.sent.at(-1)).toMatchObject({ kind: 'withdrawal_pending' });
    expect((await store.requests.listOpen('p1'))[0]?.stage).toBe('pending_told');
    // More screenshots, questions, ids: nothing, and nothing is read any more.
    const before = reads();
    expect(await sendShot('p1', shot([{ status: 'Pending' }]))).toBe('no_text');
    expect(await say('p1', 'kab tak aayega?')).toBe('already_requested');
    expect(await say('p1', 'WD-19106-67317')).toBe('already_requested');
    expect(repliesTo('p1')).toHaveLength(2);
    expect(reads()).toBe(before);
  });

  it('Processing counts as pending; a Hinglish or Hindi customer gets the note in their language', async () => {
    build();
    await say('p2', 'withdrawal nahi aaya abhi tak');
    expect(await sendShot('p2', shot([{ status: 'Processing' }]))).toBe('pending_told');
    expect(repliesTo('p2').at(-1)).toBe(withdrawalPendingText('hinglish'));
    expect(repliesTo('p2').at(-1)).toMatch(/12–24 hours ke andar aapke bank account me credit/);
    await say('p3', 'मेरा विड्रॉल बैंक में नहीं आया');
    expect(await sendShot('p3', shot([{ status: 'Pending' }]))).toBe('pending_told');
    expect(repliesTo('p3').at(-1)).toBe(withdrawalPendingText('hindi'));
  });

  it('Success → the bank statement is asked for, once; after it the case is silent', async () => {
    build();
    await say('s1', 'withdrawal nahi aaya');
    expect(await sendShot('s1', shot([{ id: 'WD-19106-67317', status: 'Success', amount: 2660 }, { id: 'WD-19106-66139', status: 'Success' }]))).toBe('statement_requested');
    expect(repliesTo('s1').at(-1)).toBe(statementRequestText('hinglish'));
    expect(repliesTo('s1').at(-1)).toBe('Sir, aapka withdrawal successful dikh raha hai. Check karne ke liye please ye bhej dijiye 🙏\n\n📄 Bank Statement\nJis bank account me amount aana tha, uska Bank Statement PDF bhej dijiye.');
    expect(t.sent.at(-1)).toMatchObject({ kind: 'statement_request' });
    expect(await say('s1', 'ye lo statement')).toBe('already_requested');
    expect(await sendShot('s1', shot([{ status: 'Success' }]))).toBe('no_text');
    expect(repliesTo('s1')).toHaveLength(2);
  });

  it('several rows: the top-most (latest) one decides — unless the customer names another by its id', async () => {
    build();
    await say('r1', 'withdrawal nahi aaya');
    expect(await sendShot('r1', shot([{ id: 'WD-10001-111', status: 'Pending' }, { id: 'WD-10001-222', status: 'Success' }]))).toBe('pending_told');
    await say('r2', 'withdrawal nahi aaya');
    expect(await sendShot('r2', shot([{ id: 'WD-10001-111', status: 'Pending' }, { id: 'WD-10001-222', status: 'Success' }]), 'ye wala WD-10001-222')).toBe('statement_requested');
  });

  it('the screenshot arrives with the complaint itself: the next step is the first message, the id is not asked for', async () => {
    build();
    expect(await sendShot('f1', shot([{ status: 'Pending' }]), 'mera withdrawal bank me nahi aaya')).toBe('pending_told');
    expect(repliesTo('f1')).toEqual([withdrawalPendingText('hinglish')]);
    expect(await sendShot('f2', shot([{ status: 'Success' }]), 'withdrawal nahi aaya')).toBe('statement_requested');
    expect(repliesTo('f2')).toEqual([statementRequestText('hinglish')]);
    // An unreadable picture with the complaint: the normal first request.
    expect(await sendShot('f3', shot('not-a-withdrawal-screen'), 'withdrawal nahi aaya')).toBe('requested');
    expect(repliesTo('f3')).toEqual([requestText('withdrawal', 'hinglish')]);
  });

  it('failed, rejected, reversed, no status, not a withdrawal screen, an unreadable or missing photo: silence, and the case still waits', async () => {
    build();
    await say('x1', 'withdrawal nahi aaya');
    for (const image of [shot([{ status: 'Failed' }]), shot([{ status: 'Rejected' }]), shot([{ status: 'Reversed' }]), shot([{ id: 'WD-10001-1' }]), shot([{ status: 'Weird word' }]), shot('not-a-withdrawal-screen'), shot([])]) {
      expect(await sendShot('x1', image)).toBe('already_requested');
    }
    t.failDownloads = 1;
    expect(await sendShot('x1', shot([{ status: 'Pending' }]))).toBe('already_requested'); // could not be fetched
    expect(repliesTo('x1')).toHaveLength(1);
    expect((await store.requests.listOpen('x1'))[0]?.stage).toBe('awaiting_evidence');
    // A readable one later still gets its step.
    expect(await sendShot('x1', shot([{ status: 'Pending' }]))).toBe('pending_told');
  });

  it('without the model nothing is read: the case is silent, as before', async () => {
    build({ llm: null });
    await say('n1', 'withdrawal nahi aaya');
    expect(await sendShot('n1', shot([{ status: 'Pending' }]))).toBe('already_requested');
    expect(repliesTo('n1')).toHaveLength(1);
  });

  it('a human who already read the screenshot, or the bot being OFF: nothing is sent and the step is not used up', async () => {
    build();
    await say('h1', 'withdrawal nahi aaya');
    const m = t.inbound('h1', undefined, [], NOW);
    const ref: MediaRef = { kind: 'photo', fileRef: `h1:${m.messageId}`, mimeType: 'image/jpeg' };
    t.media.set(ref.fileRef, shot([{ status: 'Pending' }]));
    t.humanReads('h1');
    expect(await app.onMessage({ ...m, media: [ref] })).toBe('seen_by_human');
    await say('o1', 'withdrawal nahi aaya');
    await app.botSwitch.set(false);
    expect(await sendShot('o1', shot([{ status: 'Pending' }]))).toBe('bot_off');
    await app.botSwitch.set(true);
    expect(await sendShot('o1', shot([{ status: 'Pending' }]))).toBe('pending_told');
    expect(customerSends(t).filter((s) => s.kind === 'withdrawal_pending').map((s) => s.chatId)).toEqual(['o1']);
  });

  it('a deposit case is untouched: its photos are never read, its one request stays the only message', async () => {
    build();
    await say('d1', 'deposit nahi hua');
    expect(await sendShot('d1', shot([{ status: 'Pending' }]))).toBe('no_text');
    expect(reads()).toBe(0);
    expect(repliesTo('d1')).toEqual([requestText('deposit', 'hinglish')]);
  });

  it('the step survives a restart: told once, not again', async () => {
    const { mkdtempSync, rmSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const dir = mkdtempSync(join(tmpdir(), 'wd-'));
    try {
      build({ store: new MemoryStore({ requestsFile: join(dir, 'requests.json') }) });
      await say('k1', 'withdrawal nahi aaya');
      expect(await sendShot('k1', shot([{ status: 'Pending' }]))).toBe('pending_told');
      build({ store: new MemoryStore({ requestsFile: join(dir, 'requests.json') }) });
      for (let i = 0; i < 4; i++) t.nextId('k1');
      expect(await sendShot('k1', shot([{ status: 'Pending' }]))).toBe('no_text');
      expect(t.sent).toHaveLength(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('step 2 from a Withdrawal ID on its own', () => {
  it('with no panel wired, an id alone says nothing about the status: silence, the team looks', async () => {
    build();
    await say('i1', 'withdrawal nahi aaya');
    expect(await say('i1', 'WD-19106-67317')).toBe('already_requested');
    expect(repliesTo('i1')).toHaveLength(1);
    expect((await store.requests.listOpen('i1'))[0]?.stage).toBe('awaiting_evidence');
  });

  it('with a panel: pending → the 12–24 hours note; successful → the bank statement; unknown or failing → silence', async () => {
    const statuses: Record<string, 'pending' | 'success' | 'unknown'> = { 'WD-10001-111': 'pending', 'WD-10001-222': 'success', 'WD-10001-333': 'unknown' };
    const lookup = { withdrawalStatus: vi.fn(async (id: string) => { if (id === 'WD-10001-444') throw new Error('panel down'); return statuses[id]; }) };
    build({ lookup });
    await say('l1', 'withdrawal nahi aaya');
    expect(await say('l1', 'meri id WD-10001-111 hai')).toBe('pending_told');
    await say('l2', 'withdrawal nahi aaya');
    expect(await say('l2', 'wd-10001-222')).toBe('statement_requested');
    await say('l3', 'withdrawal nahi aaya');
    expect(await say('l3', 'WD-10001-333')).toBe('already_requested');
    expect(await say('l3', 'WD-10001-444')).toBe('already_requested');
    expect(await say('l3', 'WD-10001-999')).toBe('already_requested'); // the panel does not know it
    expect(repliesTo('l3')).toHaveLength(1);
  });

  it('a screenshot that shows the status settles it: the panel is not asked', async () => {
    const lookup = { withdrawalStatus: vi.fn(async () => 'success' as const) };
    build({ lookup });
    await say('l4', 'withdrawal nahi aaya');
    expect(await sendShot('l4', shot([{ id: 'WD-10001-111', status: 'Pending' }]), 'WD-10001-111')).toBe('pending_told');
    expect(lookup.withdrawalStatus).not.toHaveBeenCalled();
  });
});

describe('reading ids and status words', () => {
  it('withdrawal ids as the app and the team\'s tools print them', () => {
    expect(extractWithdrawalIds('meri id WD-19106-67317 hai')).toEqual(['WD-19106-67317']);
    expect(extractWithdrawalIds('bxwd-49437-70854 aur wd_19106_67317')).toEqual(['BXWD-49437-70854', 'WD-19106-67317']);
    expect(extractWithdrawalIds('order ILLUN-179030843478237, number 9810822372, 2660 rupees')).toEqual([]);
    expect(sameWithdrawalId('BXWD-49437-70854', 'wd-49437-70854')).toBe(true);
    expect(sameWithdrawalId('WD-10001-111', 'WD-10001-112')).toBe(false);
  });

  it('status words: what is certain is named, the rest is unknown', () => {
    for (const w of ['Success', 'successful', 'Completed', 'PAID']) expect(normaliseWithdrawalStatus(w)).toBe('success');
    for (const w of ['Pending', 'processing', 'In Progress', 'Under Review', 'Requested']) expect(normaliseWithdrawalStatus(w)).toBe('pending');
    for (const w of ['Failed', 'Rejected', 'cancelled']) expect(normaliseWithdrawalStatus(w)).toBe('failed');
    expect(normaliseWithdrawalStatus('Reversed')).toBe('reversed');
    for (const w of ['', undefined, null, 'Amount Withdrawn', 'Success maybe']) expect(normaliseWithdrawalStatus(w)).toBe('unknown');
  });
});
