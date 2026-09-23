import { describe, expect, it } from 'vitest';
import { DisabledAdminGateway } from '../../src/admin/fixture.js';
import { SCREENSHOTS } from '../helpers/fakeVision.js';
import { ADMIN_FIXTURES, HDFC_STATEMENT_WITH_CREDIT } from '../helpers/fixtures.js';
import { EXPORT_BOT, Harness, SUPPORT_CHAT } from '../helpers/harness.js';
import { buildPdf } from '../helpers/pdfFactory.js';

/**
 * Many customers at once through the real entry point (persist → queue → worker), with
 * duplicates, worker deaths, Telegram failures and a human in the middle. What must hold:
 * every message answered exactly once, every reply in its own customer's chat, order kept.
 */
const USERS = 120;
const number = (i: number) => (i === 0 ? '9810822372' : `98${String(10000000 + i).slice(-8)}`);

describe('concurrent customers through the queue', () => {
  it('replies once per turn, keeps customers apart, keeps each customer in order', async () => {
    const h = new Harness({ caseReplies: 'conversational', fixtures: ADMIN_FIXTURES, concurrency: 8 });
    h.vision.set('pay500', SCREENSHOTS.payment500);
    const users = Array.from({ length: USERS }, (_, i) => h.user(`u${i}`, { firstName: `Customer ${i}` }));

    // Round 1: everyone opens a deposit case at the same time.
    await Promise.all(users.map((u) => u.deliver(u.build({ text: 'deposit nahi aaya' }))));
    expect((await h.queue.stats()).pending).toBe(USERS);
    const ran = await h.drain();
    expect(ran).toBe(USERS);
    for (const u of users) {
      expect(u.replies).toHaveLength(1);
      expect(u.last).toMatch(/deposit check karne ke liye/);
    }

    // Round 2: each sends their own registered number (silently collected). Only customer 0's
    // number has orders in the admin panel.
    await Promise.all(users.map((u, i) => u.deliver(u.build({ text: number(i) }))));
    await h.drain();
    for (const [i, u] of users.entries()) {
      const c = (await h.caseOf(u.id))!;
      expect(c.userId).toBe(u.id);
      expect(c.registrationNumber).toBe(number(i)); // never another customer's number
      expect(u.replies).toHaveLength(1);
    }

    // Round 3: the screenshot verifies against the admin panel for everyone.
    await Promise.all(users.map((u) => u.deliver(u.build({ media: [{ kind: 'photo', fileRef: 'pay500', fileUniqueId: `pay-${u.id}`, mimeType: 'image/jpeg' }] }))));
    h.transport.files.set('pay500', Buffer.from('pay500'));
    await h.drain();
    for (const [i, u] of users.entries()) {
      expect(u.replies).toHaveLength(2);
      // The one customer whose number the panel knows is verified; nobody else inherits that.
      expect(u.last).toMatch(i === 0 ? /Deposit Successful/ : /Match Nahi Hui/);
    }

    // Isolation: every outbound message sits in the chat of the user it was composed for.
    const out = (h.store as unknown as { messages: { rows: Array<{ direction: string; chatId: string; userId: string }> } }).messages.rows.filter((m) => m.direction === 'out' && m.chatId !== SUPPORT_CHAT && m.chatId !== EXPORT_BOT);
    expect(out).toHaveLength(USERS * 2);
    for (const m of out) expect(m.userId).toBe(m.chatId);
    expect((await h.queue.stats())).toEqual({ pending: 0, running: 0, dead: 0, failed: 0 });
  });

  it('a burst from one customer is one turn; messages across turns stay in order', async () => {
    const h = new Harness({ caseReplies: 'conversational', fixtures: ADMIN_FIXTURES, debounceMs: 1000, maxWaitMs: 3000 });
    const u = h.user('burst');
    await u.deliver(u.build({ text: 'withdrawal ka status batao' }));
    await u.deliver(u.build({ text: 'WD-15436-64215' }));
    expect((await h.queue.stats()).pending).toBe(1); // merged
    h.advance(1); // debounce over
    await h.drain();
    expect(u.replies).toHaveLength(1);
    expect(u.last).toMatch(/Withdrawal Successful/);
    await u.deliver(u.build({ text: 'thanks' }));
    h.advance(1);
    await h.drain();
    expect(u.replies).toHaveLength(2);
    expect(u.last).toMatch(/Welcome/);
  });
});

describe('duplicates, crashes and failures', () => {
  it('the same Telegram message delivered twice is answered once', async () => {
    const h = new Harness({ caseReplies: 'conversational', fixtures: ADMIN_FIXTURES });
    const u = h.user('dup');
    const m = u.build({ text: 'WD-15436-64215 status' });
    await u.deliver(m);
    await u.deliver(m); // Telegram redelivery
    await u.deliver({ ...m }); // and once more from a gateway retry
    await h.drain();
    expect(u.replies).toHaveLength(1);
    expect(h.metrics.duplicateMessages.get()).toBe(2);
  });

  it('a worker dies holding the job: another worker picks it up after the lease, one reply', async () => {
    const h = new Harness({ caseReplies: 'conversational', fixtures: ADMIN_FIXTURES, jobLeaseMs: 10_000 });
    const u = h.user('crash-before');
    await u.deliver(u.build({ text: 'WD-15436-64215 status' }));
    const job = (await h.queue.claim('dead-worker', 10_000))!; // claimed, then the process is gone
    expect(job).toBeDefined();
    expect(await h.drain()).toBe(0); // still leased: nobody else can take it
    h.advance(1);
    expect(await h.drain()).toBe(1);
    expect(u.replies).toHaveLength(1);
  });

  it('a worker dies after replying but before finishing the job: the re-run sends nothing', async () => {
    const h = new Harness({ caseReplies: 'conversational', fixtures: ADMIN_FIXTURES, jobLeaseMs: 10_000 });
    const u = h.user('crash-after');
    const m = u.build({ text: 'WD-15436-64215 status' });
    await u.deliver(m);
    const job = (await h.queue.claim('dead-worker', 10_000))!;
    await h.app.processor.process(u.id, [m], { jobId: job.id }); // the work happened…
    expect(u.replies).toHaveLength(1);
    h.advance(1); // …then the lease expired without complete()
    expect(await h.drain()).toBe(1);
    expect(u.replies).toHaveLength(1);
  });

  it('a reply key is tied to the messages, so a re-run of the same turn can never send twice', async () => {
    const h = new Harness({ caseReplies: 'conversational', fixtures: ADMIN_FIXTURES });
    const u = h.user('rerun');
    const m = u.build({ text: 'WD-15436-64215 status' });
    await h.app.processor.receive(m);
    await h.app.processor.process(u.id, [m]);
    // The same turn run again (say the processed flag was lost): the outbox key stops the second send.
    await h.app.processor.process(u.id, [m]);
    expect(u.replies).toHaveLength(1);
  });

  it('Telegram fails twice while sending: the outbox retries and the customer gets exactly one message', async () => {
    const h = new Harness({ caseReplies: 'conversational', fixtures: ADMIN_FIXTURES });
    const u = h.user('tg-fail');
    h.transport.failCustomerSends = 2;
    await u.deliver(u.build({ text: 'WD-15436-64215 status' }));
    await h.drain();
    expect(u.replies).toHaveLength(0);
    await h.app.outbox.flushPending();
    expect(u.replies).toHaveLength(0);
    await h.app.outbox.flushPending();
    expect(u.replies).toHaveLength(1);
    await h.app.outbox.flushPending();
    expect(u.replies).toHaveLength(1);
  });

  it('an export whose forward fails is retried by the worker and confirmed once; nothing is forwarded twice', async () => {
    const h = new Harness({ caseReplies: 'conversational', adminGateway: new DisabledAdminGateway() });
    h.vision.set('pay500', SCREENSHOTS.payment500);
    const u = h.user('export-retry');
    await u.say('deposit nahi aaya 9810822372');
    await u.photo('pay500');
    await u.video();
    h.transport.failExportForwards = 2;
    expect(await u.pdf(buildPdf(HDFC_STATEMENT_WITH_CREDIT))).toBe('');
    expect((await h.caseOf(u.id))?.facts.export?.status).toBe('failed');
    h.advance(3);
    await h.app.worker.tick(); // the second forward failure
    expect(u.replies.filter((r) => /shared with our team/.test(r.text))).toHaveLength(0);
    h.advance(3);
    await h.app.worker.tick(); // third attempt: only what is missing is forwarded, then verified
    expect(u.last).toMatch(/shared with our team/);
    expect(h.exportedFiles).toHaveLength(4);
    expect((await h.caseOf(u.id))?.facts.export?.status).toBe('confirmed');
    await h.app.worker.tick();
    expect(u.replies.filter((r) => /shared with our team/.test(r.text))).toHaveLength(1);
  });

  it('a human and the AI never race: their actions on one chat run in order', async () => {
    const h = new Harness({ caseReplies: 'conversational', fixtures: ADMIN_FIXTURES });
    const u = h.user('race');
    await u.deliver(u.build({ text: 'deposit nahi aaya' }));
    await h.app.onOwnOutgoing({ chatId: u.id, messageId: 999 }); // a human typed right after
    await h.drain();
    // The turn ran first (queued first), then the human's message closed the case and paused the bot.
    expect(u.replies).toHaveLength(1);
    expect((await h.casesOf(u.id))[0]?.status).toBe('closed');
    await u.deliver(u.build({ text: 'hi' }));
    await h.drain();
    expect(u.replies).toHaveLength(1);
  });

  it('the export bot confirmation delivered twice solves the case once', async () => {
    const h = new Harness({ caseReplies: 'conversational', adminGateway: new DisabledAdminGateway() });
    h.vision.set('pay500', SCREENSHOTS.payment500);
    const u = h.user('8939686943');
    await u.say('deposit nahi aaya 9810822372');
    await u.photo('pay500');
    await u.video();
    await u.pdf(buildPdf(HDFC_STATEMENT_WITH_CREDIT));
    const text = '✅ PAYMENT CONFIRMED\n👤 Customer: N K (User ID: 8939686943)\n📱 Mobile: 9810822372';
    await h.app.onExportMessage({ messageId: 500, text });
    await h.app.onExportMessage({ messageId: 500, text }); // redelivered
    await h.drain();
    expect(u.replies.filter((r) => /solved ho gaya/.test(r.text))).toHaveLength(1);
    expect((await h.caseOf(u.id))?.status).toBe('resolved');
  });
});
