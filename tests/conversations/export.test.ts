import { beforeEach, describe, expect, it } from 'vitest';
import { DisabledAdminGateway } from '../../src/admin/fixture.js';
import { SCREENSHOTS } from '../helpers/fakeVision.js';
import { ADMIN_FIXTURES, HDFC_STATEMENT_WITH_CREDIT } from '../helpers/fixtures.js';
import { EXPORT_BOT, Harness, type UserSim } from '../helpers/harness.js';
import { buildPdf } from '../helpers/pdfFactory.js';

/**
 * Evidence export. Once every item the bot asked for is in, the case header and the original files
 * go to the export bot; only a fully verified export earns the customer the confirmation. Then the
 * export bot's "PAYMENT CONFIRMED" (carrying our User ID line) tells the customer the deposit is
 * solved, in their own language.
 */
const CONFIRMED = 'Your details and documents have been shared with our team successfully. They will review your issue and work on resolving it as soon as possible. ✅';
const REQUEST = /deposit check karne ke liye/;

const confirmation = (userId: string, mobile = '9810822372') => [
  '✅ PAYMENT CONFIRMED', '', `👤 Customer: N K (User ID: ${userId}, no username)`, '', `📱 Mobile: ${mobile}`, '', '💰 Amount: ₹500',
  '', '🧾 Order: ILLUN-178923603882201', '', '✅ Confirmed by: Betix System', '', '🤖 @betixpay_cs_bot', '', '🕒 Time: 11:04', '', '🙏 Payment successfully confirmed.',
].join('\n');
/** What the bot sends when it only has the forwards (no User ID line). */
const confirmationByMobile = (mobile: string) => `✅ PAYMENT CONFIRMED\n\n📱 Mobile: ${mobile}\n\n💰 Amount: ₹500\n\n🧾 Order: ILLUN-178923603882201\n\n🙏 Payment successfully confirmed.`;

let h: Harness;
beforeEach(() => {
  h = new Harness({ adminGateway: new DisabledAdminGateway() }); // the live setup: nothing can be verified automatically
  h.vision.set('pay500', SCREENSHOTS.payment500);
  h.vision.set('pay500-later', SCREENSHOTS.payment500); // a second, different file with the same content
  h.vision.set('wdhist', SCREENSHOTS.withdrawalHistory);
  h.vision.set('selfie', SCREENSHOTS.selfie);
});

/** Deposit request answered in full: number, screenshot, statement, video. Returns the reply to the last item. */
async function completeDeposit(u: UserSim, order: Array<'number' | 'photo' | 'pdf' | 'video'> = ['number', 'photo', 'pdf', 'video']) {
  let r = '';
  for (const step of order) {
    r = step === 'number' ? await u.say('9810822372') : step === 'photo' ? await u.photo('pay500') : step === 'pdf' ? await u.pdf(buildPdf(HDFC_STATEMENT_WITH_CREDIT)) : await u.video();
  }
  return r;
}

describe('deposit: wait for everything, then export and confirm', () => {
  it('nothing goes out until the last item arrives; then the four forwards and the confirmation', async () => {
    const u = h.user('8939686943', { firstName: 'N K' });
    expect(await u.say('deposit nahi aaya')).toMatch(REQUEST);
    expect(await u.say('9810822372')).toBe('');
    expect(await u.photo('pay500')).toBe('');
    expect(await u.pdf(buildPdf(HDFC_STATEMENT_WITH_CREDIT))).toBe('');
    expect(h.exportedFiles).toHaveLength(0);
    expect(h.supportMessages).toHaveLength(0);
    expect((await h.caseOf(u.id))?.status).toBe('open');

    expect(await u.video()).toBe(CONFIRMED);
    expect(h.exports).toHaveLength(0); // no header, no summary: only the forwards
    expect(h.exportedFiles.map((f) => f.messageId)).toEqual([3, 4, 5, 6]); // the number's message, the screenshot, the PDF, the video: in order, nothing else
    const c = (await h.caseOf(u.id))!;
    expect(c.status).toBe('escalated');
    expect(c.facts.export).toMatchObject({ status: 'confirmed', attempts: 1, forwarded: { 3: 1, 4: 2, 5: 3, 6: 4 } });
    expect(h.supportMessages).toHaveLength(0); // an exported case never posts to the support group
  });

  it('items in any order; greetings, "ok" and a stray photo in between are neither answered nor forwarded', async () => {
    const u = h.user('any-order');
    await u.say('deposit nahi aaya');
    expect(await u.video()).toBe('');
    expect(await u.say('hi')).toBe('');
    expect(await u.pdf(buildPdf(HDFC_STATEMENT_WITH_CREDIT))).toBe('');
    expect(await u.say('ok')).toBe('');
    const selfie = h.transport.nextId(u.id) + 1; // the selfie's message id
    expect(await u.photo('selfie')).toMatch(/related nahi/); // a wrong file gets its notice
    expect(await u.say('9810822372')).toBe('');
    expect(h.exports).toHaveLength(0);
    expect(await u.photo('pay500')).toBe(CONFIRMED);
    expect(h.exportedFiles).toHaveLength(4);
    expect(h.exportedFiles.map((f) => f.messageId)).not.toContain(selfie);
  });

  it('the exact scenario: number → screenshot → video → PDF; forwards are the original messages, confirmation only after all four', async () => {
    const u = h.user('exact');
    await u.say('deposit nahi aaya');
    const number = h.transport.nextId(u.id) + 1;
    expect(await u.say('9810822372')).toBe('');
    expect(await u.photo('pay500')).toBe('');
    expect(await u.video()).toBe('');
    expect(h.exports).toHaveLength(0);
    expect(h.exportedFiles).toHaveLength(0);
    expect(u.replies).toHaveLength(1); // still only the request
    expect(await u.pdf(buildPdf(HDFC_STATEMENT_WITH_CREDIT))).toBe(CONFIRMED);
    expect(h.exportedFiles).toEqual([number, number + 1, number + 2, number + 3].map((messageId) => ({ from: u.id, messageId })));
    expect(u.replies.filter((r) => /shared with our team/.test(r.text))).toHaveLength(1);
  });

  it('the number in the first message counts', async () => {
    const u = h.user('num-first');
    expect(await u.say('deposit nahi aaya, mera number 9810822372')).toMatch(REQUEST);
    expect(await completeDeposit(u, ['photo', 'pdf', 'video'])).toBe(CONFIRMED);
  });

  it('after the confirmation: no greeting, no re-request, no second export; a later file is forwarded silently', async () => {
    const u = h.user('after');
    await u.say('deposit nahi aaya');
    await completeDeposit(u);
    for (const t of ['hi', 'hello', 'okay', 'thanks', 'kya hua?']) expect(await u.say(t), t).toBe('');
    expect(h.exportedFiles).toHaveLength(4);

    expect(await u.photo('pay500-later', 'ye wala')).toBe('');
    expect(h.exportedFiles).toHaveLength(5);
    expect(h.exports).toHaveLength(0);
    expect(h.supportMessages).toHaveLength(0);
    expect(u.replies.filter((r) => /shared with our team/.test(r.text))).toHaveLength(1); // never confirmed twice
  });

  it('a clearly new issue after the export is handled as a new case', async () => {
    const u = h.user('new-issue');
    await u.say('deposit nahi aaya');
    await completeDeposit(u);
    expect(await u.say('withdrawal bhi nahi aaya')).toMatch(/withdrawal check karne ke liye/);
  });

  it('a second deposit after the export starts a fresh case with its own request; a chaser about the first does not', async () => {
    const u = h.user('second-deposit');
    await u.say('deposit nahi aaya');
    await completeDeposit(u);
    expect(await u.say('bas thoda jaldi kara do')).toBe('');
    expect(await u.say('ek aur deposit ka issue hai')).toMatch(REQUEST);
    const cases = await h.casesOf(u.id);
    expect(cases).toHaveLength(2);
    expect(cases.map((c) => c.status).sort()).toEqual(['escalated', 'open']);
    expect(await completeDeposit(u, ['photo', 'pdf', 'video'])).toBe(CONFIRMED); // the number is remembered
    expect(h.exportedFiles).toHaveLength(7);
  });

  it('a customer who cannot send an item: no export, no confirmation, the team gets the ticket as before', async () => {
    const u = h.user('refuses');
    await u.say('deposit nahi aaya');
    await completeDeposit(u, ['number', 'photo', 'pdf']);
    expect(await u.say('mere pass nahi hai video')).toBe('');
    expect(h.exports).toHaveLength(0);
    expect(h.supportMessages).toHaveLength(1);
    expect(h.supportMessages[0]!.text).toMatch(/missing: payment_video/);
    expect((await h.caseOf(u.id))?.facts.handoffReason).toBe('user_declined_more_info');
  });
});

describe('the number sent in a burst with files', () => {
  it('forwards the message that carried the number, not the last message of the turn', async () => {
    const u = h.user('burst-number');
    await u.say('deposit nahi aaya');
    h.transport.files.set('pay500', Buffer.from('pay500'));
    h.transport.files.set('vid', Buffer.from('mp4'));
    const photo = u.build({ media: [{ kind: 'photo', fileRef: 'pay500', fileUniqueId: 'pay500-b', mimeType: 'image/jpeg' }] });
    const number = u.build({ text: '9810822372' });
    const video = u.build({ media: [{ kind: 'video', fileRef: 'vid', fileUniqueId: 'vid', mimeType: 'video/mp4', durationSec: 18 }] });
    for (const m of [photo, number, video]) await h.app.processor.receive(m);
    await h.app.processor.process(u.id, [photo, number, video]);
    expect((await h.caseOf(u.id))?.facts.sources.registrationNumber?.messageId).toBe(number.messageId);
    expect(await u.pdf(buildPdf(HDFC_STATEMENT_WITH_CREDIT))).toBe(CONFIRMED);
    expect(h.exportedFiles.map((f) => f.messageId)).toEqual([photo.messageId, number.messageId, video.messageId, video.messageId + 1]);
  });
});

describe('any PDF counts as the bank statement', () => {
  it('a PDF without statement wording, sent in the same burst as the screenshot, is accepted as the statement', async () => {
    const u = h.user('wrong-pdf');
    await u.say('deposit nahi aaya 9810822372');
    const photo = u.build({ media: [{ kind: 'photo', fileRef: 'pay500', fileUniqueId: 'pay500-burst', mimeType: 'image/jpeg' }] });
    h.transport.files.set('pay500', Buffer.from('pay500'));
    const notStatement = buildPdf(['Fantasy Adda', 'Contest winnings summary', 'Total: 1,250.00']);
    h.transport.files.set('junk-pdf', notStatement);
    const pdf = u.build({ media: [{ kind: 'document', fileRef: 'junk-pdf', fileUniqueId: 'junk-pdf', mimeType: 'application/pdf', fileName: 'summary.pdf' }] });
    for (const m of [photo, pdf]) await h.app.processor.receive(m);
    await h.app.processor.process(u.id, [photo, pdf]);
    const c = (await h.caseOf(u.id))!;
    expect(c.facts.paymentEvidenceId).toBeDefined();
    expect(c.facts.statementEvidenceId).toBeDefined();
    expect(h.exportedFiles).toHaveLength(0); // the video is still outstanding
    expect(await u.video()).toBe(CONFIRMED);
    expect(h.exportedFiles).toHaveLength(4);
  });

  it('a scanned (image-only) PDF is kept for the team as the statement', async () => {
    const u = h.user('scanned-pdf');
    await u.say('deposit nahi aaya 9810822372');
    await u.photo('pay500');
    await u.video();
    const scanned = buildPdf([]);
    h.transport.files.set('scan', scanned);
    const r = await u.send(u.build({ media: [{ kind: 'document', fileRef: 'scan', fileUniqueId: 'scan', mimeType: 'application/pdf', fileName: 'scan.pdf' }] }));
    expect(r).toBe(CONFIRMED);
    expect(h.exportedFiles).toHaveLength(4);
  });
});

describe('export failures', () => {
  it('a forward is rejected: no confirmation, case pending; the next message retries and succeeds', async () => {
    const u = h.user('fail-send');
    await u.say('deposit nahi aaya');
    h.transport.failExportForwards = 1;
    expect(await completeDeposit(u)).toBe('');
    const c = (await h.caseOf(u.id))!;
    expect(c.status).toBe('open');
    expect(c.facts.export).toMatchObject({ status: 'failed', attempts: 1 });
    expect(h.supportMessages).toHaveLength(0);

    expect(await u.say('abhi tak nahi aaya')).toBe(CONFIRMED);
    expect((await h.caseOf(u.id))?.facts.export).toMatchObject({ status: 'confirmed', attempts: 2 });
    expect(h.exportedFiles).toHaveLength(4); // each file forwarded exactly once
  });

  it('Telegram says a message never arrived: no confirmation; the retry resends only that message', async () => {
    const u = h.user('fail-verify');
    await u.say('deposit nahi aaya');
    h.transport.failExportVerify = 1; // the first forward is reported missing from the bot chat
    expect(await completeDeposit(u)).toBe('');
    const c = (await h.caseOf(u.id))!;
    expect(c.status).toBe('open');
    expect(c.facts.export).toMatchObject({ status: 'failed', attempts: 1 });
    expect(c.facts.export?.lastError).toMatch(/did not receive 1 of 4/);
    expect(Object.keys(c.facts.export!.forwarded)).toHaveLength(3); // the other three did arrive: remembered

    expect(await u.say('abhi tak nahi aaya')).toBe(CONFIRMED);
    expect(h.exportedFiles).toHaveLength(5); // only the lost one was forwarded again
  });

  it('a file fails half-way: the retry forwards only the ones that did not get through', async () => {
    const u = h.user('fail-half');
    await u.say('deposit nahi aaya');
    await completeDeposit(u, ['number', 'photo', 'pdf']);
    h.transport.failExportForwards = 1; // the first forward (the number's message) fails
    expect(await u.video()).toBe('');
    expect(h.exportedFiles).toHaveLength(0);
    expect(await u.say('abhi tak nahi aaya')).toBe(CONFIRMED);
    expect(h.exportedFiles).toHaveLength(4);
  });

  it('the background worker retries a failed export and only then confirms', async () => {
    const u = h.user('worker-retry');
    await u.say('deposit nahi aaya');
    h.transport.failExportForwards = 1;
    expect(await completeDeposit(u)).toBe('');
    await h.app.worker.tick(); // too soon: nothing
    expect(u.replies).toHaveLength(1);
    h.advance(3);
    await h.app.worker.tick();
    expect(u.last).toBe(CONFIRMED);
    expect(h.exportedFiles).toHaveLength(4);
    expect(h.supportMessages).toHaveLength(0);
    const c = (await h.caseOf(u.id))!;
    expect(c).toMatchObject({ status: 'escalated', facts: { handoffReason: 'verification_unavailable', export: { status: 'confirmed' } } });
    await h.app.worker.tick();
    expect(u.replies).toHaveLength(2); // nothing repeated
    for (const t of ['hi', 'ok']) expect(await u.say(t), t).toBe('');
  });

  it('the worker gives up after the attempt limit', async () => {
    const u = h.user('worker-limit');
    await u.say('deposit nahi aaya');
    h.transport.failExportForwards = 100;
    await completeDeposit(u);
    for (let i = 0; i < 25; i++) {
      h.advance(3);
      await h.app.worker.tick();
    }
    expect((await h.caseOf(u.id))?.facts.export?.attempts).toBe(20);
    expect(u.replies).toHaveLength(1);
  });

  it('a file cannot be forwarded: not shared, so not confirmed', async () => {
    const u = h.user('fail-forward');
    await u.say('deposit nahi aaya');
    h.transport.failExportForwards = 1;
    expect(await completeDeposit(u)).toBe('');
    expect((await h.caseOf(u.id))?.facts.export?.status).toBe('failed');
    expect(u.replies).toHaveLength(1); // only the request
  });

  it('without an export bot configured, handoffs work as before (silent ticket)', async () => {
    const d = new Harness({ adminGateway: new DisabledAdminGateway(), exportBot: null });
    d.vision.set('pay500', SCREENSHOTS.payment500);
    const u = d.user('no-bot');
    await u.say('deposit nahi aaya 9810822372');
    expect(await u.photo('pay500')).toBe('');
    expect(d.supportMessages).toHaveLength(1);
    expect(d.exports).toHaveLength(0);
  });
});

describe('withdrawal', () => {
  it('waits for the statement after the ID, then exports the ID and the PDF', async () => {
    const u = h.user('wd');
    expect(await u.say('withdrawal nahi aaya')).toMatch(/withdrawal check karne ke liye/);
    const idMessage = h.transport.nextId(u.id) + 1;
    expect(await u.say('WD-15436-64215')).toBe('');
    expect(h.exportedFiles).toHaveLength(0);
    expect(await u.pdf(buildPdf(HDFC_STATEMENT_WITH_CREDIT))).toBe(CONFIRMED);
    expect(h.exportedFiles.map((f) => f.messageId)).toEqual([idMessage, idMessage + 1]); // the message with the ID, then the PDF
    expect((await h.caseOf(u.id))?.status).toBe('escalated');
  });

  it('an ID in the first message still gets the statement requested once', async () => {
    const u = h.user('wd-first');
    expect(await u.say('WD-15436-64215 nahi aaya')).toMatch(/bank statement/i);
    expect(await u.say('ok')).toBe('');
    expect(await u.pdf(buildPdf(HDFC_STATEMENT_WITH_CREDIT))).toBe(CONFIRMED);
  });

  it('a history screenshot plus "upar wala" is the reference; the statement completes it', async () => {
    const u = h.user('wd-shot');
    await u.say('mera withdrawal pending hai');
    expect(await u.photo('wdhist')).toMatch(/3 withdrawals/);
    expect(await u.say('upar wala')).toMatch(/upar wala/);
    expect(h.exportedFiles).toHaveLength(0);
    expect(await u.pdf(buildPdf(HDFC_STATEMENT_WITH_CREDIT))).toBe(CONFIRMED);
    expect(h.exportedFiles).toHaveLength(2); // the history screenshot and the PDF
  });

  it('a history screenshot with several rows plus the statement is complete: no row to pick', async () => {
    const u = h.user('wd-rows');
    await u.say('mera withdrawal pending hai');
    const shot = h.transport.nextId(u.id) + 1;
    expect(await u.photo('wdhist')).toMatch(/3 withdrawals/);
    const pdf = h.transport.nextId(u.id) + 1;
    expect(await u.pdf(buildPdf(HDFC_STATEMENT_WITH_CREDIT))).toBe(CONFIRMED);
    expect(h.exportedFiles.map((f) => f.messageId)).toEqual([shot, pdf]);
    expect(h.supportMessages).toHaveLength(0);
  });

  it('a screenshot the classifier read as a payment screen still counts as the history screenshot', async () => {
    const u = h.user('wd-pay');
    expect(await u.say('withdrawal nahi aaya')).toMatch(/withdrawal check karne ke liye/);
    expect(await u.photo('pay500')).toBe(''); // one item in, waiting for the statement — like a typed ID
    const cases = await h.casesOf(u.id);
    expect(cases.map((c) => c.type)).toEqual(['withdrawal']); // no deposit case opened for it
    expect(cases[0]!.facts.withdrawalEvidenceId).toBeDefined();
    expect(h.exportedFiles).toHaveLength(0);
    expect(await u.pdf(buildPdf(HDFC_STATEMENT_WITH_CREDIT))).toBe(CONFIRMED);
    expect(h.exportedFiles).toHaveLength(2);
  });

  it('only the reference and the statement are forwarded: a number typed on the side is not', async () => {
    const u = h.user('wd-num');
    await u.say('withdrawal nahi aaya');
    await u.say('9810822372');
    const idMessage = h.transport.nextId(u.id) + 1;
    await u.say('WD-15436-64215');
    expect(await u.pdf(buildPdf(HDFC_STATEMENT_WITH_CREDIT))).toBe(CONFIRMED);
    expect(h.exportedFiles.map((f) => f.messageId)).toEqual([idMessage, idMessage + 1]);
  });

  it('"kya bhejna hai?" after the screenshot lists only the statement', async () => {
    const u = h.user('wd-ask');
    await u.say('mera withdrawal pending hai');
    await u.photo('wdhist');
    const r = await u.say('aur kya bhejna hai?');
    expect(r).toMatch(/bank statement/i);
    expect(r).not.toMatch(/Withdrawal ID/);
  });
});

describe('with the admin panel connected', () => {
  it('a verified deposit is resolved, never exported', async () => {
    const p = new Harness({ fixtures: ADMIN_FIXTURES });
    p.vision.set('pay500', SCREENSHOTS.payment500);
    const u = p.user('verified');
    await u.say('deposit nahi aaya 9810822372');
    expect(await u.photo('pay500')).toMatch(/Deposit Successful/);
    expect(p.exports).toHaveLength(0);
  });
});

describe('the export bot confirms the payment', () => {
  it('tells the right customer, in their language, and marks the deposit solved', async () => {
    const u = h.user('8939686943', { firstName: 'N K' });
    const other = h.user('7000000001');
    await u.say('deposit nahi aaya');
    await completeDeposit(u);
    await other.say('deposit nahi aaya');

    expect(await h.botSays(confirmation('8939686943'))).toBe('solved');
    expect(u.last).toBe('Sir, aapka deposit issue solve ho gaya hai. Inconvenience ke liye sorry. ✅');
    expect(other.replies).toHaveLength(1); // only their own request
    const c = (await h.casesOf(u.id))[0]!;
    expect(c).toMatchObject({ status: 'resolved', step: 'solved' });
    expect((await h.store.tickets.findOpenByCase(c.id))).toBeUndefined();
  });

  it('English customers get the English line', async () => {
    const u = h.user('8939686944');
    await u.say('Hi, I deposited 500 rupees but it is not showing in my wallet');
    await completeDeposit(u);
    await h.botSays(confirmation('8939686944'));
    expect(u.last).toBe('Your deposit issue has been solved. Sorry for the inconvenience, Sir. ✅');
  });

  it('the same confirmation twice sends nothing twice; afterwards a greeting is answered again', async () => {
    const u = h.user('8939686945');
    await u.say('deposit nahi aaya');
    await completeDeposit(u);
    await h.botSays(confirmation('8939686945'));
    const n = u.replies.length;
    expect(await h.botSays(confirmation('8939686945'))).toBe('duplicate');
    expect(u.replies).toHaveLength(n);
    expect(await u.say('thanks')).toMatch(/Welcome/);
    expect(await u.say('hi')).not.toBe('');
    expect(h.exportedFiles).toHaveLength(4); // nothing was exported again
  });

  it('without a User ID, the mobile number picks the customer', async () => {
    const u = h.user('8939686946');
    await u.say('deposit nahi aaya');
    await completeDeposit(u);
    expect(await h.botSays(confirmationByMobile('9810822372'))).toBe('solved');
    expect(u.last).toMatch(/solve ho gaya/);
    expect((await h.caseOf(u.id))?.status).toBe('resolved');
  });

  it('a confirmation that replies to one of the forwards picks that customer, whatever the text says', async () => {
    const u = h.user('8939686950');
    await u.say('deposit nahi aaya');
    await completeDeposit(u);
    const forwardedId = Object.values((await h.caseOf(u.id))!.facts.export!.forwarded)[0]!;
    expect(await h.botSays('✅ PAYMENT CONFIRMED\n🙏 Payment successfully confirmed.', forwardedId)).toBe('solved');
    expect(u.last).toMatch(/solve ho gaya/);
  });

  it('an unknown User ID, a mobile nobody pending has, two customers with the same mobile, or a different bot message: nothing is sent', async () => {
    const u = h.user('8939686947');
    const twin = h.user('8939686948');
    await u.say('deposit nahi aaya');
    await completeDeposit(u);
    await twin.say('deposit nahi aaya');
    await completeDeposit(twin);
    const n = h.transport.sent.length;
    expect(await h.botSays(confirmation('1234567890'))).toBe('ignored');
    expect(await h.botSays(confirmationByMobile('9999999999'))).toBe('ignored');
    expect(await h.botSays(confirmationByMobile('9810822372'))).toBe('ignored'); // both pending customers gave this number
    expect(await h.botSays('Files received 👍')).toBe('ignored');
    expect(h.transport.sent).toHaveLength(n);
    expect((await h.caseOf(u.id))?.status).toBe('escalated');
  });

  it('a confirmation for a customer whose case was never exported is not acted on', async () => {
    const u = h.user('8939686951');
    await u.say('hello');
    const n = h.transport.sent.length;
    expect(await h.botSays(confirmation('8939686951'))).toBe('ignored');
    expect(h.transport.sent).toHaveLength(n);
  });

  it('the confirmation reaches the customer even while a human has the chat', async () => {
    const u = h.user('8939686952');
    await u.say('deposit nahi aaya');
    await completeDeposit(u);
    await h.store.users.setHumanTakeover(u.id, new Date(h.clock().getTime() + 30 * 60_000));
    expect(await h.botSays(confirmation('8939686952'))).toBe('solved');
    expect(u.last).toMatch(/solve ho gaya/);
  });
});

describe('bookkeeping', () => {
  it('the export bot chat never gets a case or a folder', async () => {
    const u = h.user('8939686949');
    await u.say('deposit nahi aaya');
    await completeDeposit(u);
    expect(await h.store.users.get(EXPORT_BOT)).toBeUndefined();
    expect(h.folderOf(EXPORT_BOT)).toBe('none');
    expect(h.metrics.exports.get({ case: 'deposit', outcome: 'verified' })).toBe(1);
  });
});
