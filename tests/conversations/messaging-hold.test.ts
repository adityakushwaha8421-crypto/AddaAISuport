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

  it('the same in conversational mode; the only message through the hold is the payment confirmation, once, to that User ID', async () => {
    h = new Harness({ customerMessaging: false, caseReplies: 'conversational', adminGateway: new DisabledAdminGateway() });
    h.vision.set('wdhist', SCREENSHOTS.withdrawalHistory);
    const u = h.user('6135570708');
    const other = h.user('6135570709');
    expect(await u.say('withdrawal nahi aaya')).toBe('');
    expect(await other.say('deposit nahi hua')).toBe('');
    expect(await u.photo('wdhist')).toBe('');
    expect(await u.pdf(buildPdf(HDFC_STATEMENT_WITH_CREDIT))).toBe('');
    expect(h.exportedFiles.length).toBeGreaterThan(0); // internal work still happens
    const confirmation = '✅ PAYMENT CONFIRMED\n\n👤 Customer: P Kumar (User ID: 6135570708, no username)\n\n📱 Mobile: 9810822372\n\n💰 Amount: ₹500\n\n🧾 Order: ILLUN-178923603882201';
    expect(await h.botSays(confirmation)).toBe('solved');
    expect(u.replies.map((r) => r.text)).toEqual(['Sir, aapka issue solved ho gaya hai. Sorry for the inconvenience. 🙏']);
    expect(other.replies).toHaveLength(0);
    // The same confirmation again (re-sent by the bot): no second message.
    await h.botSays(confirmation);
    await h.botSays(confirmation.replace('P Kumar', 'P. Kumar'));
    expect(u.replies).toHaveLength(1);
    await h.app.worker.tick();
    expect(customerSends().filter((s) => s.chatId !== u.id)).toHaveLength(0);
  });

  it('a confirmation for a customer with no case in the store still reaches exactly that User ID, once', async () => {
    const text = '✅ PAYMENT CONFIRMED\n\n👤 Customer: Unknown (User ID: 7777777001, no username)\n\n💰 Amount: ₹200';
    expect(await h.botSays(text)).toBe('solved');
    expect(h.transport.sent.map((s) => [s.chatId, s.text])).toEqual([['7777777001', 'Sir, aapka issue solved ho gaya hai. Sorry for the inconvenience. 🙏']]);
    expect(await h.botSays(text)).toBe('duplicate'); // the very same confirmation re-sent: nothing more
    expect(h.transport.sent).toHaveLength(1);
    expect(await h.botSays(text.replace('₹200', '₹350'))).toBe('solved'); // a different payment for the same customer
    expect(h.transport.sent).toHaveLength(2);
  });

  it('a confirmation without a User ID tells nobody', async () => {
    expect(await h.botSays('✅ PAYMENT CONFIRMED\n\n📱 Mobile: 9810822372\n\n💰 Amount: ₹500')).toBe('ignored');
    expect(await h.botSays('Payment pending, please wait')).toBe('ignored');
    expect(h.transport.sent).toHaveLength(0);
  });

  it('admin commands still answer the admin', async () => {
    expect(await h.user(ADMIN).say('/botoff')).toBe(REPLIES.off);
    expect(await h.user(ADMIN).say('/boton')).toBe(REPLIES.on);
  });
});
