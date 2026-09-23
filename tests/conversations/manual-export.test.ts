import { beforeEach, describe, expect, it } from 'vitest';
import { DisabledAdminGateway } from '../../src/admin/fixture.js';
import { SCREENSHOTS } from '../helpers/fakeVision.js';
import { HDFC_STATEMENT_WITH_CREDIT } from '../helpers/fixtures.js';
import { Harness, type UserSim } from '../helpers/harness.js';
import { buildPdf } from '../helpers/pdfFactory.js';

/**
 * Evidence forwarded to the export bot BY HAND.
 *
 * In production the staff share the account with the bot: a customer's messages are read or answered
 * by a person (so the bot's turn is skipped or its case closed), and the person then forwards the
 * number, screenshot, video and statement to the export bot themselves. The customer must still get
 * the agreed confirmation — after Telegram shows all four in the export bot's chat, and only once.
 */
const CONFIRMED = 'Your details and documents have been shared with our team successfully. They will review your issue and work on resolving it as soon as possible. ✅';

const NUMBER = { kind: 'text', text: '9810822372' } as const;
const SHOT = { kind: 'photo', mimeType: 'image/jpeg' } as const;
const VIDEO = { kind: 'video', mimeType: 'video/mp4' } as const;
const PDF = { kind: 'document', mimeType: 'application/pdf', fileName: 'statement.pdf' } as const;

let h: Harness;
beforeEach(() => {
  h = new Harness({ caseReplies: 'conversational', adminGateway: new DisabledAdminGateway() });
  h.vision.set('pay500', SCREENSHOTS.payment500);
});

const confirmationsTo = (u: UserSim) => u.replies.filter((r) => r.text === CONFIRMED);
const forwardAll = async (fromUserId: string) => {
  for (const item of [NUMBER, SHOT, VIDEO, PDF]) await h.humanForwards({ ...item, fromUserId });
};

describe('a human forwards the evidence to the export bot', () => {
  it('the customer is told once all four items are in the export bot chat — not before, and only once', async () => {
    const u = h.user('7001');
    await h.humanForwards({ ...NUMBER, fromUserId: u.id });
    await h.humanForwards({ ...SHOT, fromUserId: u.id });
    await h.humanForwards({ ...PDF, fromUserId: u.id });
    expect(confirmationsTo(u)).toHaveLength(0); // three of four: nothing yet
    const last = await h.humanForwards({ ...VIDEO, fromUserId: u.id });
    expect(confirmationsTo(u)).toHaveLength(1);
    // the very same update delivered again (Telegram redelivery / a restart) changes nothing
    await h.app.onExportForward({ ...VIDEO, fromUserId: u.id, messageId: last });
    await h.drain();
    expect(confirmationsTo(u)).toHaveLength(1);
  });

  it('works while the bot is paused in that chat: the human answered, the case was closed', async () => {
    const u = h.user('7002');
    await u.say('deposit nahi aaya');
    await h.app.relay.onOwnOutgoing({ chatId: u.id, messageId: 9001, text: 'ji sir dekhta hu' }); // staff replies from the account
    expect(await u.say('9810822372')).toBe(''); // the bot stays out of it
    expect(await u.photo('pay500')).toBe('');
    await forwardAll(u.id);
    expect(confirmationsTo(u)).toHaveLength(1);
    expect(h.exportedFiles).toHaveLength(0); // the bot itself exported nothing: this was the human's doing
  });

  it('works when the staff merely READ the chat (turns skipped as seen_by_human)', async () => {
    const u = h.user('7003');
    expect(await u.readByHuman().say('deposit nahi aaya')).toBe('');
    await forwardAll(u.id);
    expect(confirmationsTo(u)).toHaveLength(1);
  });

  it('a forward Telegram does not show in the export bot chat earns nothing until it is sent again', async () => {
    const u = h.user('7004');
    await h.humanForwards({ ...NUMBER, fromUserId: u.id });
    await h.humanForwards({ ...SHOT, fromUserId: u.id });
    await h.humanForwards({ ...VIDEO, fromUserId: u.id }, { arrives: false }); // deleted / never delivered
    await h.humanForwards({ ...PDF, fromUserId: u.id });
    expect(confirmationsTo(u)).toHaveLength(0);
    await h.humanForwards({ ...VIDEO, fromUserId: u.id }); // forwarded again
    expect(confirmationsTo(u)).toHaveLength(1);
  });

  it('only the four required items count: chatter, a sticker or a zip change nothing', async () => {
    const u = h.user('7005');
    await h.humanForwards({ kind: 'text', text: 'sir please check', fromUserId: u.id });
    await h.humanForwards({ kind: 'other', fromUserId: u.id });
    await h.humanForwards({ kind: 'document', mimeType: 'application/zip', fileName: 'x.zip', fromUserId: u.id });
    await h.humanForwards({ ...SHOT, fromUserId: u.id });
    await h.humanForwards({ ...VIDEO, fromUserId: u.id });
    await h.humanForwards({ ...PDF, fromUserId: u.id });
    expect(confirmationsTo(u)).toHaveLength(0); // the number is still missing
    await h.humanForwards({ ...NUMBER, fromUserId: u.id });
    expect(confirmationsTo(u)).toHaveLength(1);
  });

  it('items of different customers are never mixed', async () => {
    const a = h.user('7006');
    const b = h.user('7007');
    await h.humanForwards({ ...NUMBER, fromUserId: a.id });
    await h.humanForwards({ ...SHOT, fromUserId: a.id });
    await h.humanForwards({ ...VIDEO, fromUserId: b.id });
    await h.humanForwards({ ...PDF, fromUserId: b.id });
    expect(confirmationsTo(a)).toHaveLength(0);
    expect(confirmationsTo(b)).toHaveLength(0);
  });

  it('a customer who hides their account on forwards is found by the file / the number they sent', async () => {
    const u = h.user('7008');
    const shot = u.build({ media: [{ kind: 'photo', fileRef: 'p1', fileUniqueId: 'photo:111', mimeType: 'image/jpeg' }] });
    const video = u.build({ media: [{ kind: 'video', fileRef: 'v1', fileUniqueId: 'doc:222', mimeType: 'video/mp4' }] });
    const pdf = u.build({ media: [{ kind: 'document', fileRef: 'd1', fileUniqueId: 'doc:333', mimeType: 'application/pdf', fileName: 's.pdf' }] });
    const number = u.build({ text: '9810822372' });
    h.transport.files.set('p1', Buffer.from('pay500'));
    h.transport.files.set('v1', Buffer.from('mp4'));
    h.transport.files.set('d1', buildPdf(HDFC_STATEMENT_WITH_CREDIT));
    for (const m of [number, shot, video, pdf]) await u.readByHuman().deliver(m); // read by staff: the bot stays silent
    await h.drain();
    const hidden = { fromName: 'Hidden User' };
    await h.humanForwards({ ...NUMBER, ...hidden });
    await h.humanForwards({ ...SHOT, ...hidden, fileUniqueId: 'photo:111' });
    await h.humanForwards({ ...VIDEO, ...hidden, fileUniqueId: 'doc:222' });
    await h.humanForwards({ ...PDF, ...hidden, fileUniqueId: 'doc:333' });
    expect(confirmationsTo(u)).toHaveLength(1);
  });

  it('a hidden-sender forward of something we never saw is left alone', async () => {
    const u = h.user('7009');
    for (const item of [NUMBER, SHOT, VIDEO, PDF]) await h.humanForwards({ ...item, fromName: 'Hidden User', fileUniqueId: 'doc:never-seen' });
    expect(confirmationsTo(u)).toHaveLength(0);
    expect(h.transport.sent.filter((s) => s.text === CONFIRMED)).toHaveLength(0);
  });

  it('never a second confirmation for a case the bot exported and confirmed itself', async () => {
    const u = h.user('7010', { firstName: 'N K' });
    await u.say('deposit nahi aaya');
    await u.say('9810822372');
    await u.photo('pay500');
    await u.pdf(buildPdf(HDFC_STATEMENT_WITH_CREDIT));
    expect(await u.video()).toBe(CONFIRMED); // the bot's own verified export
    await forwardAll(u.id); // a colleague forwards the same things by hand as well
    expect(confirmationsTo(u)).toHaveLength(1);
  });

  it('a later, separate submission earns its own confirmation', async () => {
    const u = h.user('7011');
    await forwardAll(u.id);
    h.advance(180);
    await forwardAll(u.id);
    expect(confirmationsTo(u)).toHaveLength(2);
  });
});
