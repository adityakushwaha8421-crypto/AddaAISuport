import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DisabledAdminGateway } from '../../src/admin/fixture.js';
import { REPLIES } from '../../src/control/adminCommands.js';
import { Harness } from '../helpers/harness.js';

/**
 * /boton, /botoff, /restart end to end: authorised admins only, the OFF state silences everything
 * and is kept across a restart, and customers typing the same words change nothing.
 */
const ADMIN = '500000001';
let h: Harness;
let restart: ReturnType<typeof vi.fn>;
beforeEach(() => {
  restart = vi.fn();
  h = new Harness({ caseReplies: 'conversational', adminGateway: new DisabledAdminGateway(), adminIds: [ADMIN], onRestart: restart });
});

describe('admin commands', () => {
  it('/botoff silences the agent for every customer; /boton brings it back; both reply to the admin', async () => {
    const admin = h.user(ADMIN);
    const c1 = h.user('c1');
    expect(await c1.say('hi')).toMatch(/Hello sir/);

    expect(await admin.say('/botoff')).toBe(REPLIES.off);
    expect(await h.app.botSwitch.isOn()).toBe(false);
    const sent = h.transport.sent.length;
    expect(await c1.say('deposit nahi aaya')).toBe('');
    expect(await h.user('c2').say('withdrawal nahi aaya')).toBe('');
    expect(await c1.say('hello')).toBe('');
    expect(h.transport.sent).toHaveLength(sent); // nothing automatic went anywhere
    expect(await h.casesOf('c1')).toHaveLength(0); // no workflow was started while OFF
    expect(h.folderOf('c1')).toBe('none'); // and no filing either: the messages are just kept

    expect(await admin.say('/boton')).toBe(REPLIES.on);
    expect(await c1.say('deposit nahi aaya')).toMatch(/deposit check karne ke liye/);
  });

  it('the OFF state is permanent: it survives a restart of the process', async () => {
    await h.user(ADMIN).say('/botoff');
    h.restart();
    expect(await h.app.botSwitch.isOn()).toBe(false);
    expect(await h.user('c3').say('deposit nahi aaya')).toBe('');
    await h.user(ADMIN).say('/boton');
    h.restart();
    expect(await h.user('c3').say('deposit nahi aaya')).toMatch(/deposit check karne ke liye/);
  });

  it('a customer typing the commands gets nowhere, and the bot stays as it was', async () => {
    const c = h.user('c4');
    expect(await c.say('/botoff')).toBe('');
    expect(await h.app.botSwitch.isOn()).toBe(true);
    expect(await h.user('c5').say('deposit nahi aaya')).toMatch(/deposit check karne ke liye/);
    expect(await c.say('/restart')).toBe('');
    expect(restart).not.toHaveBeenCalled();
  });

  it('/restart from an admin asks the supervisor for a safe restart; the confirmation comes after', async () => {
    const admin = h.user(ADMIN);
    expect(await admin.say('/restart')).toBe('');
    expect(restart).toHaveBeenCalledWith({ chatId: ADMIN });
  });

  it('the account owner can run the commands from Saved Messages without being listed', async () => {
    const own = new Harness({ caseReplies: 'conversational', adminGateway: new DisabledAdminGateway() }); // no ADMIN_TELEGRAM_IDS at all
    await own.app.onAdminCommand({ chatId: 'self', messageId: 1, fromUserId: 'self', text: '/botoff' });
    expect(await own.app.botSwitch.isOn()).toBe(false);
    expect(own.transport.sent.at(-1)).toMatchObject({ chatId: 'self', text: REPLIES.off });
    await own.app.onAdminCommand({ chatId: 'self', messageId: 2, fromUserId: 'self', text: 'note to self' });
    expect(own.transport.sent).toHaveLength(1);
  });

  it('a message that arrives while OFF is kept in the transcript and never answered — not even after /boton', async () => {
    const admin = h.user(ADMIN);
    const c = h.user('c6');
    await admin.say('/botoff');
    await c.deliver(c.build({ text: 'deposit nahi aaya' }));
    expect(h.queue.all().filter((j) => j.type === 'turn')).toHaveLength(0); // never queued
    expect(await h.drain()).toBe(0);
    expect(c.replies).toHaveLength(0);
    expect(await h.casesOf(c.id)).toHaveLength(0);
    const stored = await h.store.messages.recent(c.id, 5);
    expect(stored).toHaveLength(1);
    expect(stored[0]?.processedAt).toBeDefined(); // in the transcript, marked handled
    await admin.say('/boton');
    expect(await h.drain()).toBe(0);
    expect(c.replies).toHaveLength(0); // switching on answers nothing from before
    h.advance(1);
    expect(await c.say('deposit nahi aaya')).toMatch(/deposit check karne ke liye/); // a new message is answered
  });

  it('a turn queued just before /botoff is not answered after /boton either', async () => {
    const c = h.user('c7');
    await c.deliver(c.build({ text: 'withdrawal nahi aaya' })); // queued while ON, not yet run
    await h.app.botSwitch.set(false);
    expect(await h.drain()).toBe(0); // gated while OFF
    h.advance(1);
    await h.app.botSwitch.set(true);
    expect(await h.drain()).toBe(1); // the job runs…
    expect(c.replies).toHaveLength(0); // …and ignores the message: it is from before the switch-on
    expect(await h.casesOf(c.id)).toHaveLength(0);
  });

  it('while OFF, a PAYMENT CONFIRMED from the export bot waits too; the customer is told after /boton', async () => {
    const u = h.user('8939686943');
    await u.say('deposit nahi aaya');
    for (const step of ['9810822372', 'photo', 'pdf', 'video']) {
      if (step === 'photo') { h.vision.set('pay500', (await import('../helpers/fakeVision.js')).SCREENSHOTS.payment500); await u.photo('pay500'); }
      else if (step === 'pdf') await u.pdf((await import('../helpers/pdfFactory.js')).buildPdf((await import('../helpers/fixtures.js')).HDFC_STATEMENT_WITH_CREDIT));
      else if (step === 'video') await u.video();
      else await u.say(step);
    }
    expect(u.last).toMatch(/shared with our team/);
    await h.user(ADMIN).say('/botoff');
    const sent = h.transport.sent.length;
    await h.app.onExportMessage({ messageId: h.transport.nextId('export'), text: '✅ PAYMENT CONFIRMED\n\n👤 Customer: N K (User ID: 8939686943)\n📱 Mobile: 9810822372' });
    expect(await h.drain()).toBe(0);
    expect(h.transport.sent).toHaveLength(sent);
    expect((await h.casesOf(u.id))[0]?.status).not.toBe('resolved');
    await h.user(ADMIN).say('/boton');
    await h.drain();
    expect(u.last).toMatch(/solved ho gaya/);
    expect((await h.casesOf(u.id))[0]?.status).toBe('resolved');
  });
});
