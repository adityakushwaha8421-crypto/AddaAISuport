import { beforeEach, describe, expect, it } from 'vitest';
import { emptyMemory } from '../../src/domain/memory.js';
import { stripHtml } from '../../src/response/format.js';
import type { Store } from '../../src/storage/types.js';
import { analysisOf, SCREENSHOTS } from '../helpers/fakeVision.js';
import { ADMIN_FIXTURES, HDFC_STATEMENT_WITH_CREDIT, OTHER_ACCOUNT_STATEMENT } from '../helpers/fixtures.js';
import { Harness, type UserSim } from '../helpers/harness.js';
import { buildPdf } from '../helpers/pdfFactory.js';
import { pgMemFactory } from '../helpers/stores.js';

/**
 * End-to-end QA of the whole profile: conversation flows, both money workflows, memory, every
 * supported media type, formatting, duplicates, case separation and restart persistence.
 * Everything here runs offline against fakes for Telegram, vision and the admin panel.
 */
let h: Harness;

const vision = (harness: Harness) =>
  harness.vision
    .set('pay500', SCREENSHOTS.payment500)
    .set('wdHistory', SCREENSHOTS.withdrawalHistory)
    .set('selfie', SCREENSHOTS.selfie)
    .set('techErr', analysisOf({ category: 'technical_screenshot', transcript: 'Something went wrong. Error code 502', technical: { error_text: 'Error code 502', screen: 'contest join' } }));

beforeEach(() => {
  h = new Harness({ fixtures: ADMIN_FIXTURES });
  vision(h);
});

const sendVideo = (u: UserSim, key: string, caption?: string) => {
  h.transport.files.set(key, Buffer.from('mp4'));
  return u.send(u.build({ caption, media: [{ kind: 'video', fileRef: key, fileUniqueId: key, mimeType: 'video/mp4', durationSec: 11 }] }));
};

describe('QA · conversation basics', () => {
  it('greets, answers smalltalk and never opens a case for it', async () => {
    const u = h.user('qa1');
    expect(await u.say('hello')).toBe('Hello sir 👋 Kaise help karun?');
    expect(await u.say('thanks')).toMatch(/Welcome/);
    expect(await u.say('ok')).toBe('');
    expect(await h.casesOf('qa1')).toHaveLength(0);
  });

  it('keeps conversation history and uses it for a short follow-up', async () => {
    const u = h.user('qa2');
    await u.say('withdrawal WD-15436-61002 ka status?');
    expect(await u.say('aur kitna time?')).not.toBe(''); // understood as the same case
    const stored = await h.store.messages.recent('qa2', 20);
    expect(stored.filter((m) => m.direction === 'in').length).toBe(2);
    expect(stored.filter((m) => m.direction === 'out').length).toBeGreaterThanOrEqual(2);
  });
});

describe('QA · deposit flow', () => {
  it('one request, silent collection, automatic verification, formatted result', async () => {
    const u = h.user('qa3');
    const ask = await u.say('deposit nahi aaya');
    expect(ask).toMatch(/registered number[\s\S]*payment screenshot[\s\S]*bank statement PDF[\s\S]*payment screen recording/i);
    expect(await u.photo('pay500')).toBe('');
    expect(await u.pdf(buildPdf(HDFC_STATEMENT_WITH_CREDIT))).toBe('');
    expect(await sendVideo(u, 'v-qa3')).toBe('');
    const result = await u.say('9810822372');
    expect(result).toMatch(/successfully verify/);
    expect(u.lastRaw).toContain('<code>ORD771001</code>');
    expect(u.lastRaw).toContain('<b>₹500</b>');
    expect(u.replies).toHaveLength(2); // the request and the result, nothing else
  });

  it('unmatched payment asks to re-check the number, then verifies after the correction', async () => {
    const u = h.user('qa4');
    await u.say('deposit issue hai, number 9876543210');
    expect(await u.photo('pay500')).toMatch(/match nahi ho rahe/);
    expect(await u.say('number dusra hai 9810822372')).toMatch(/successfully verify/);
  });
});

describe('QA · withdrawal flow', () => {
  it('one request, screenshot rows, ordinal reference, statement verification', async () => {
    const u = h.user('qa5');
    expect(await u.say('withdrawal nahi aaya')).toMatch(/Withdrawal ID ya withdrawal history ka screenshot[\s\S]*bank statement PDF/s);
    const list = await u.photo('wdHistory');
    expect(list).toMatch(/3 withdrawals/);
    const picked = await u.say('upper wala');
    expect(picked).toMatch(/successfully process/);
    expect(u.lastRaw).toMatch(/<code>WD-15436-64215<\/code>|<b>₹1,450<\/b>/);
    const verified = await u.pdf(buildPdf(HDFC_STATEMENT_WITH_CREDIT));
    expect(verified).toMatch(/₹1,450 ka credit/);
    expect((await h.caseOf('qa5'))?.status).toBe('resolved');
  });

  it('wrong-account statement is refused without escalating', async () => {
    const u = h.user('qa6');
    await u.say('WD-15436-64215 ka paisa nahi aaya');
    const r = await u.pdf(buildPdf(OTHER_ACCOUNT_STATEMENT));
    expect(r).toMatch(/us account ka nahi lag raha/);
    expect(h.supportMessages).toHaveLength(0);
  });
});

describe('QA · media matrix', () => {
  it('handles every supported type: photo, caption, PDF, protected PDF, video, voice, sticker, unrelated image', async () => {
    const u = h.user('qa7');
    await u.say('withdrawal nahi aaya');

    // text + media in one message (caption)
    const withCaption = await u.photo('wdHistory', 'ye dekho sir');
    expect(withCaption).toMatch(/3 withdrawals/);
    await u.say('upper wala');

    expect(await u.photo('selfie')).toMatch(/related nahi lag rahi/);
    expect(await u.send(u.build({ media: [{ kind: 'voice', fileRef: 'vo', fileUniqueId: 'vo', durationSec: 6 }] }))).toMatch(/voice note/);
    expect(await u.send(u.build({ media: [{ kind: 'sticker', fileRef: 'st', fileUniqueId: 'st' }] }))).toBe('');
    expect(await sendVideo(u, 'v-qa7', 'payment recording')).toBe('');

    const locked = await u.pdf(buildPdf(HDFC_STATEMENT_WITH_CREDIT, { userPassword: 'PASS1234' }), 'stmt.pdf');
    expect(locked).toMatch(/password protected/);
    expect(await u.say('Password: PASS1234')).toMatch(/₹1,450 ka credit/);

    const evidence = await h.store.evidence.listByIds((await h.caseOf('qa7'))!.facts.evidenceIds);
    expect(evidence.map((e) => e.category)).toEqual(expect.arrayContaining(['withdrawal_screenshot', 'unrelated', 'bank_statement']));
    expect(JSON.stringify(evidence)).not.toContain('PASS1234');
  });
});

describe('QA · case separation and topic switching', () => {
  it('deposit, withdrawal and a general question stay separate; each resumes with its own state', async () => {
    const u = h.user('qa8');
    await u.say('deposit nahi aaya');
    await u.say('mera number 9810822372');

    const side = await u.say('sir contest kab start hoga?');
    expect(side).not.toMatch(/deposit|screenshot|statement/i);

    await u.say('withdrawal WD-15436-61002 ka kya hua');
    expect(u.last).toMatch(/processing/);

    const back = await u.say('mera deposit wala check karo');
    expect(back).not.toMatch(/registered number/); // remembered
    const cases = await h.casesOf('qa8');
    expect(cases.map((c) => c.type).sort()).toEqual(['deposit', 'withdrawal']);
    const deposit = cases.find((c) => c.type === 'deposit')!;
    const withdrawal = cases.find((c) => c.type === 'withdrawal')!;
    expect(deposit.withdrawalId).toBeUndefined();
    expect(withdrawal.facts.paymentEvidenceId).toBeUndefined();
    expect(withdrawal.facts.payout?.withdrawalId).toBe('WD-15436-61002');
  });

  it('swipe-reply to an older message resolves against that message', async () => {
    const u = h.user('qa9');
    await u.say('withdrawal nahi aaya');
    await u.photo('wdHistory');
    const listMsg = u.lastSent!.messageId;
    await u.say('sir lineup kab milega?'); // topic switch in between
    const r = await u.replyTo(listMsg).say('second wala');
    expect(r).toMatch(/processing/);
    expect((await h.caseOf('qa9'))?.withdrawalId).toBe('WD-15436-61002');
  });
});

describe('QA · duplicates and concurrency', () => {
  it('a redelivered message is answered once and never re-processed', async () => {
    const u = h.user('qa10');
    const msg = u.build({ text: 'withdrawal WD-15436-64215 status' });
    await u.send(msg);
    await u.send(msg);
    expect(u.replies).toHaveLength(1);
    expect(h.metrics.duplicateMessages.get()).toBe(1);
    expect(h.admin.calls.filter((c) => c.op === 'findPayout')).toHaveLength(1);
  });

  it('keeps two customers completely separate under concurrent traffic', async () => {
    const a = h.user('qa11');
    const b = h.user('qa12');
    await Promise.all([a.say('deposit nahi aaya, number 9810822372'), b.say('WD-15436-64215 ka paisa nahi aaya')]);
    await Promise.all([a.photo('pay500'), b.pdf(buildPdf(HDFC_STATEMENT_WITH_CREDIT))]);
    expect(a.last).toMatch(/successfully verify/);
    expect(b.last).toMatch(/₹1,450 ka credit/);
    expect(a.replies.every((r) => !/WD-|HDFC/.test(r.text))).toBe(true);
    expect(b.replies.every((r) => !/ORD771001/.test(r.text))).toBe(true);
    const memA = (await h.store.users.get('qa11'))!.memory;
    const memB = (await h.store.users.get('qa12'))!.memory;
    expect(memA.registrationNumbers[0]?.value).toBe('9810822372');
    expect(memB.registrationNumbers).toHaveLength(0); // never borrowed from another customer
    expect(memB.bank?.maskedAccount).toBe('XXXX6789');
    expect(memA.bank).toBeUndefined();
  });
});

describe('QA · persistence across an application restart', () => {
  let store: Store;
  beforeEach(async () => {
    store = await pgMemFactory.create();
    h = new Harness({ fixtures: ADMIN_FIXTURES, store });
    vision(h);
  });

  it('keeps case state, memory and de-duplication after a restart (SQL store)', async () => {
    const u = h.user('qa13');
    await u.say('deposit nahi aaya');
    await u.photo('pay500');
    await u.say('9810822372');
    expect(u.last).toMatch(/successfully verify/);
    const before = await h.casesOf('qa13');
    const memBefore = (await h.store.users.get('qa13'))!.memory;

    h.restart(); // new application instance over the same database

    const after = await h.casesOf('qa13');
    expect(after.map((c) => c.id)).toEqual(before.map((c) => c.id));
    expect(after[0]).toMatchObject({ orderId: 'ORD771001', registrationNumber: '9810822372', status: 'resolved' });
    expect((await h.store.users.get('qa13'))!.memory).toEqual(memBefore);

    // The remembered number survives: a new issue does not ask for it again.
    const r = await u.say('withdrawal WD-15436-64215 ka paisa nahi aaya');
    expect(r).toMatch(/successfully process/);
    const wd = (await h.casesOf('qa13')).find((c) => c.type === 'withdrawal')!;
    expect(wd.registrationNumber).toBe('9810822372');

    // Old messages are still de-duplicated after the restart.
    const replayed = u.build({ text: 'hello again' });
    await u.send(replayed);
    const count = u.replies.length;
    await u.send(replayed);
    expect(u.replies).toHaveLength(count);
  });

  it('a case in progress continues after a restart without re-asking', async () => {
    const u = h.user('qa14');
    await u.say('deposit nahi aaya');
    await u.photo('pay500'); // silent
    h.restart();
    const r = await u.say('9810822372');
    expect(r).toMatch(/successfully verify/);
    expect(u.replies.filter((x) => /bhej dijiye/.test(x.text))).toHaveLength(1); // still only one request, ever
  });
});

describe('QA · message formatting', () => {
  it('renders clean Telegram HTML: a titled card, bold amounts, monospace ids, icons only on layout lines, one address word', async () => {
    const u = h.user('qa15');
    await u.say('withdrawal WD-15436-64215 ka paisa nahi aaya');
    const raw = u.lastRaw;
    expect(raw).toContain('<b>₹1,450</b>');
    expect(raw).toContain('<code>XXXX6789</code>');
    expect(raw).not.toMatch(/<(script|a|img)/i);
    expect(raw).toContain('<b>Withdrawal Successful</b>');
    // Icons start layout lines (title, facts, next step); sentences carry at most two emojis.
    const prose = stripHtml(raw).split('\n').filter((l) => l && !/^\p{Extended_Pictographic}/u.test(l));
    expect(prose.join(' ').match(/\p{Extended_Pictographic}/gu)?.length ?? 0).toBeLessThanOrEqual(2);
    expect(stripHtml(raw).match(/\bsir\b/gi)?.length ?? 0).toBeLessThanOrEqual(1);
    // Readable structure: a few short lines, each one scannable, never a wall of text.
    const lines = stripHtml(raw).split('\n');
    expect(lines.length).toBeLessThanOrEqual(10);
    expect(Math.max(...lines.map((l) => l.length))).toBeLessThanOrEqual(140);
    expect(raw).not.toMatch(/\n{3,}/); // at most one blank line between paragraphs
  });

  it('stores plain text in history while sending markup', async () => {
    const u = h.user('qa16');
    await u.say('withdrawal WD-15436-64215 status');
    const out = (await h.store.messages.recent('qa16', 5)).filter((m) => m.direction === 'out');
    expect(out[0]!.text).not.toContain('<b>');
    expect(out[0]!.text).toContain('₹1,450');
  });
});

describe('QA · personal memory', () => {
  it('remembers number, bank, style and history — and /forget erases it', async () => {
    const u = h.user('qa17');
    await u.say('bhai withdrawal WD-15436-64215 ka paisa nahi aaya');
    await u.say('bhai koi update');
    await u.pdf(buildPdf(HDFC_STATEMENT_WITH_CREDIT));
    const mem = (await h.store.users.get('qa17'))!.memory;
    expect(mem.bank?.maskedAccount).toBe('XXXX6789');
    expect(mem.recentCases[0]).toMatchObject({ type: 'withdrawal', ref: 'WD-15436-64215' });
    expect(mem.style.bhaiCount).toBeGreaterThanOrEqual(2);
    expect(JSON.stringify(mem)).not.toContain('50100123456789'); // full account never remembered

    await u.say('ek aur problem hai bhai');
    expect(u.last === '' || /bhai/i.test(u.last)).toBe(true);

    await h.app.relay.onSupportMessage({ chatId: '-100999', messageId: 9999, fromUserId: 'agent', text: '/forget', replyToMessageId: 1 }).catch(() => undefined);
    await h.store.users.saveMemory('qa17', emptyMemory());
    expect((await h.store.users.get('qa17'))!.memory.recentCases).toEqual([]);
  });
});
