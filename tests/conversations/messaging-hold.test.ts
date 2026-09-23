import { beforeEach, describe, expect, it } from 'vitest';
import { DisabledAdminGateway } from '../../src/admin/fixture.js';
import { REPLIES } from '../../src/control/adminCommands.js';
import { CUSTOMER_MESSAGING_ENABLED } from '../../src/control/customerMessaging.js';
import { SCREENSHOTS } from '../helpers/fakeVision.js';
import { HDFC_STATEMENT_WITH_CREDIT } from '../helpers/fixtures.js';
import { EXPORT_BOT, Harness, SUPPORT_CHAT } from '../helpers/harness.js';
import { buildPdf } from '../helpers/pdfFactory.js';

/**
 * The temporary hold (control/customerMessaging.ts): with customer messaging disabled, no
 * automatic message reaches any customer — in either reply mode — while everything internal
 * (cases, evidence, export forwards, tickets, folders, admin replies) keeps working.
 */
const ADMIN = '500000001';
let h: Harness;
beforeEach(() => {
  h = new Harness({ customerMessaging: false, adminGateway: new DisabledAdminGateway(), adminIds: [ADMIN] });
  h.vision.set('wdhist', SCREENSHOTS.withdrawalHistory);
});

const customerSends = () => h.transport.sent.filter((s) => s.chatId !== SUPPORT_CHAT && s.chatId !== EXPORT_BOT && s.chatId !== ADMIN);

describe('customer messaging hold', () => {
  it('is switched off in the shipped code', () => {
    expect(CUSTOMER_MESSAGING_ENABLED).toBe(false);
  });

  it('greetings, deposit, withdrawal, match, random, evidence: no customer receives anything', async () => {
    const c = h.user('hold1');
    for (const t of ['Hi', 'deposit nahi hua', 'withdrawal nahi aaya', 'match cancel ho gaya points nahi mile', 'kuch bhi', 'kya bhejna hai?']) {
      expect(await c.say(t), t).toBe('');
    }
    expect(await c.photo('wdhist')).toBe('');
    expect(customerSends()).toHaveLength(0);
    // Read and understood underneath: a case exists, the request is still owed (never sent), and the outbox holds no retry.
    const cases = await h.casesOf(c.id);
    expect(cases.length).toBeGreaterThan(0);
    expect(cases.every((k) => !k.facts.requestSentAt)).toBe(true);
    expect(await h.store.outbox.listPending(5)).toHaveLength(0);
    expect(await h.app.outbox.flushPending()).toBe(0);
    expect(customerSends()).toHaveLength(0);
  });

  it('the same in conversational mode, and no export confirmation either', async () => {
    h = new Harness({ customerMessaging: false, caseReplies: 'conversational', adminGateway: new DisabledAdminGateway() });
    h.vision.set('wdhist', SCREENSHOTS.withdrawalHistory);
    const u = h.user('hold2');
    expect(await u.say('withdrawal nahi aaya')).toBe('');
    expect(await u.photo('wdhist')).toBe('');
    expect(await u.pdf(buildPdf(HDFC_STATEMENT_WITH_CREDIT))).toBe('');
    // Internal work still happens: the evidence went to the export bot.
    expect(h.exportedFiles.length).toBeGreaterThan(0);
    await h.botSays('✅ PAYMENT CONFIRMED\n\n👤 Customer: N K (User ID: hold2, no username)\n\n💰 Amount: ₹500');
    await h.app.worker.tick();
    expect(h.transport.sent.filter((s) => s.chatId === u.id)).toHaveLength(0);
  });

  it('admin commands still answer the admin', async () => {
    expect(await h.user(ADMIN).say('/botoff')).toBe(REPLIES.off);
    expect(await h.user(ADMIN).say('/boton')).toBe(REPLIES.on);
  });
});
