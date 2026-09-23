import { beforeEach, describe, expect, it } from 'vitest';
import { DisabledAdminGateway } from '../../src/admin/fixture.js';
import { REPLIES } from '../../src/control/adminCommands.js';
import { lexicalInterpret } from '../../src/nlu/lexical.js';
import type { Interpreter } from '../../src/nlu/interpreter.js';
import { SCREENSHOTS } from '../helpers/fakeVision.js';
import { Harness } from '../helpers/harness.js';

/**
 * /botoff means ZERO automatic messages, from every process, whatever is in flight: greetings,
 * evidence requests, forwards, confirmations, queued work, and replies prepared before the command.
 * The state lives in the shared store; the final send re-reads it, so a reply being composed when
 * /botoff lands is cancelled — and never sent later.
 */
const ADMIN = '500000001';
let h: Harness;
beforeEach(() => {
  h = new Harness({ adminGateway: new DisabledAdminGateway(), adminIds: [ADMIN] });
  h.vision.set('pay500', SCREENSHOTS.payment500);
});

const snapshot = () => ({ sent: h.transport.sent.length, forwards: h.transport.forwards.length });

describe('/botoff: zero AI replies', () => {
  it('hi, deposit, withdrawal, match, random, a screenshot: nothing is sent, nothing is started, nothing is filed', async () => {
    expect(await h.user(ADMIN).say('/botoff')).toBe(REPLIES.off);
    const before = snapshot();
    const c = h.user('off1');
    for (const t of ['Hi', 'Deposit issue', 'Withdrawal issue', 'Match issue', 'Any random message', 'mera withdrawal nahi aaya, jaldi karo']) {
      expect(await c.say(t), t).toBe('');
    }
    expect(await c.photo('pay500')).toBe('');
    expect(snapshot()).toEqual(before);
    expect(await h.casesOf(c.id)).toHaveLength(0);
    expect(h.folderOf(c.id)).toBe('none');
    // The same through the real path: persisted, queued, and never claimed while OFF.
    await c.deliver(c.build({ text: 'deposit nahi hua' }));
    expect(await h.drain()).toBe(0);
    expect(snapshot()).toEqual(before);
  });

  it('only /boton brings replies back', async () => {
    const admin = h.user(ADMIN);
    const c = h.user('off2');
    await admin.say('/botoff');
    expect(await c.say('deposit nahi hua')).toBe('');
    expect(await c.say('/boton')).toBe(''); // a customer cannot switch it on
    expect(await h.app.botSwitch.isOnNow()).toBe(false);
    expect(await c.say('hello?')).toBe('');
    expect(await admin.say('/boton')).toBe(REPLIES.on);
    expect(await c.say('deposit nahi hua')).toMatch(/deposit check karne ke liye/);
  });

  it('a second process over the same store sees OFF at once, even with a stale cache', async () => {
    const other = new Harness({ store: h.store, adminGateway: new DisabledAdminGateway(), adminIds: [ADMIN] });
    expect(await other.app.botSwitch.isOn()).toBe(true); // cached ON in the other process
    await h.user(ADMIN).say('/botoff');
    const c = other.user('off3');
    expect(await c.say('withdrawal nahi aaya')).toBe('');
    expect(other.transport.sent).toHaveLength(0);
    expect(await other.casesOf(c.id)).toHaveLength(0);
  });

  it('race: /botoff while a message is being handled cancels the reply, and it is never sent later', async () => {
    // The switch flips while the message is being understood — after the turn passed the entry check.
    let flip = false;
    const interpreter: Interpreter = {
      async interpret(input) {
        if (flip) {
          flip = false;
          await h.app.botSwitch.set(false);
        }
        return lexicalInterpret(input);
      },
    };
    h = new Harness({ adminGateway: new DisabledAdminGateway(), adminIds: [ADMIN], interpreter });
    const c = h.user('race1');
    flip = true;
    expect(await c.say('deposit nahi hua')).toBe('');
    expect(h.transport.sent).toHaveLength(0);
    // The case exists (the message was read), but its one evidence request is still owed: it was never sent.
    const [k] = await h.casesOf(c.id);
    expect(k?.type).toBe('deposit');
    expect(k?.facts.requestSentAt).toBeUndefined();
    expect((await h.store.outbox.listPending(5)).length).toBe(0); // nothing waiting to be flushed
    expect(await h.app.outbox.flushPending()).toBe(0);
    // Back ON: nothing from before is sent on its own; the customer's next message gets the request.
    await h.user(ADMIN).say('/boton');
    expect(await h.app.outbox.flushPending()).toBe(0);
    expect(h.transport.sent.filter((s) => s.chatId === c.id)).toHaveLength(0);
    expect(await c.say('deposit nahi hua, check karo')).toMatch(/deposit check karne ke liye/);
  });

  it('race at the very last moment: the transport itself refuses the send when OFF', async () => {
    const c = h.user('race2');
    await h.app.botSwitch.set(false);
    const r = await h.app.outbox.send({ key: 'turn:race2:1', chatId: c.id, userId: c.id, text: 'Sir, ...', meta: { kind: 'reply' } });
    expect(r).toMatchObject({ sent: false, cancelled: true });
    expect(h.transport.sent).toHaveLength(0);
    expect((await h.store.outbox.getByKey('turn:race2:1'))?.status).toBe('cancelled');
    await h.app.botSwitch.set(true);
    // Same key again (a re-run of the turn), and the flush loop: still nothing.
    expect(await h.app.outbox.send({ key: 'turn:race2:1', chatId: c.id, userId: c.id, text: 'Sir, ...', meta: { kind: 'reply' } })).toMatchObject({ sent: false, cancelled: true, duplicate: true });
    expect(await h.app.outbox.flushPending()).toBe(0);
    expect(h.transport.sent).toHaveLength(0);
  });

  it('a reply that failed to send before /botoff is withdrawn, not sent after /boton', async () => {
    const c = h.user('stale1');
    h.transport.failCustomerSends = 1; // Telegram hiccup: the reply stays in the outbox for a retry
    expect(await c.say('hi')).toBe('');
    expect(await h.store.outbox.listPending(5)).toHaveLength(1);
    await h.user(ADMIN).say('/botoff');
    expect(await h.store.outbox.listPending(5)).toHaveLength(0);
    await h.user(ADMIN).say('/boton');
    expect(await h.app.outbox.flushPending()).toBe(0);
    await h.app.worker.tick();
    expect(h.transport.sent.filter((s) => s.chatId === c.id)).toHaveLength(0);
  });

  it('while OFF, no forward reaches the export bot and no background duty runs', async () => {
    const u = h.user('exp1');
    expect(await u.say('withdrawal nahi aaya')).toMatch(/withdrawal check karne ke liye/);
    await h.user(ADMIN).say('/botoff');
    const before = snapshot();
    h.vision.set('wdhist', SCREENSHOTS.withdrawalHistory);
    expect(await u.photo('wdhist')).toBe('');
    await h.app.worker.tick();
    expect(snapshot()).toEqual(before);
    expect(h.exportedFiles).toHaveLength(0);
  });
});
