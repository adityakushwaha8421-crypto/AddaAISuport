import { describe, expect, it } from 'vitest';
import { assemble, type App } from '../../src/app.js';
import { silentLogger } from '../../src/observability/logger.js';
import { solvedText } from '../../src/response/requests.js';
import { MemoryStore } from '../../src/storage/memory.js';
import { identityMatches, parseConfirmation } from '../../src/workflows/paymentConfirmed.js';
import { ADMIN, EXPORT_BOT, FakeTransport, NOW, SUPPORT, customerSends } from '../helpers/fakeTransport.js';

/**
 * The solved note after PAYMENT CONFIRMED: to exactly the User ID the export bot names, once per
 * payment, by the customer's Telegram name, with the confirmed amount — and only after the customer
 * the confirmation names has been checked against the Telegram user behind that User ID.
 */
const confirmation = (userId: string, o: { name?: string; username?: string; amount?: string; order?: string } = {}) =>
  [
    '✅ PAYMENT CONFIRMED',
    `👤 Customer: ${o.name ?? 'P Kumar'} (User ID: ${userId}, ${o.username ? `@${o.username}` : 'no username'})`,
    '📱 Mobile: 9810822372',
    ...(o.amount === '' ? [] : [`💰 Amount: ${o.amount ?? '₹2,999.01'}`]),
    ...(o.order ? [`🧾 Order: ${o.order}`] : []),
  ].join('\n\n');

let store: MemoryStore;
let t: FakeTransport;
let app: App;
const build = () => {
  store = new MemoryStore();
  t = new FakeTransport();
  app = assemble({ store, transport: t, log: silentLogger, clock: () => NOW }, { adminIds: [ADMIN], supportChatId: SUPPORT, exportChatId: EXPORT_BOT });
};
const confirm = (text: string, id = 1) => app.confirmations.onExportMessage({ messageId: id, text });

describe('reading the confirmation', () => {
  it('takes the User ID, the customer name and username, the amount and the order reference', () => {
    expect(parseConfirmation(confirmation('6135570708', { username: 'pkumar_9', order: 'ILLUN-178923603882201' }))).toEqual({
      userId: '6135570708', orderId: 'ILLUN-178923603882201', customerName: 'P Kumar', customerUsername: 'pkumar_9', amount: '₹2,999.01',
    });
    expect(parseConfirmation(confirmation('6135570708'))).toMatchObject({ customerName: 'P Kumar', customerUsername: undefined, amount: '₹2,999.01' });
    expect(parseConfirmation('PAYMENT CONFIRMED\nUser ID: 6135570708\nAmount: Rs. 500')).toMatchObject({ amount: '₹500', customerName: undefined });
    expect(parseConfirmation('PAYMENT CONFIRMED\nUser ID: 6135570708\nAmount: INR 12500.50')).toMatchObject({ amount: '₹12500.50' });
    expect(parseConfirmation(confirmation('6135570708', { amount: '' }))).toMatchObject({ amount: undefined });
    expect(parseConfirmation('⚠️ MANUAL REVIEW NEEDED\nUser ID: 6135570708')).toBeUndefined();
  });

  it('checks the named customer against the Telegram user: username must be theirs, name must share a word or an initial', () => {
    expect(identityMatches({ customerName: 'P Kumar' }, { firstName: 'Pankaj', lastName: 'Kumar' }).ok).toBe(true);
    expect(identityMatches({ customerName: 'P Kumar' }, { firstName: 'P' }).ok).toBe(true);
    expect(identityMatches({ customerName: 'Pankaj' }, { firstName: 'P', lastName: 'K' }).ok).toBe(true);
    expect(identityMatches({ customerName: 'P Kumar', customerUsername: 'pkumar' }, { firstName: 'Pankaj', username: 'PKumar' }).ok).toBe(true);
    expect(identityMatches({}, { firstName: 'Anyone' }).ok).toBe(true); // nothing claimed: the User ID alone
    expect(identityMatches({ customerName: 'P Kumar' }, {}).ok).toBe(true); // Telegram shows no name: nothing to compare
    expect(identityMatches({ customerName: 'P Kumar', customerUsername: 'pkumar' }, { firstName: 'P Kumar', username: 'someone_else' })).toMatchObject({ ok: false });
    expect(identityMatches({ customerName: 'Rahul Sharma' }, { firstName: 'Pankaj', lastName: 'Kumar' })).toMatchObject({ ok: false });
  });
});

describe('the solved note', () => {
  it('goes to that exact user, by their Telegram name, with the confirmed amount, once per payment', async () => {
    build();
    t.profiles.set('6135570708', { id: '6135570708', firstName: 'Pankaj', lastName: 'Kumar' });
    await app.onMessage(t.inbound('6135570708', 'I deposited money but my wallet does not show it', [], NOW));
    expect(await confirm(confirmation('6135570708', { order: 'ILLUN-1' }))).toBe('solved');
    const note = t.sent.at(-1)!;
    expect(note.chatId).toBe('6135570708');
    expect(note.text).toBe(solvedText('english', { name: 'Pankaj Kumar', amount: '₹2,999.01', issue: 'deposit' }));
    expect(note.text).toBe('🎉 Deposit Issue Resolved!\n\nHello Pankaj Kumar 👋\n\nYour deposit issue has been successfully resolved. Your amount of ₹2,999.01 has been credited/confirmed successfully. 💰✅\n\nThank you for your patience, Sir. 🙏\nSorry for the inconvenience. 💙');
    expect(await confirm(confirmation('6135570708', { order: 'ILLUN-1' }), 2)).toBe('duplicate');
    expect(await store.requests.listOpen('6135570708')).toHaveLength(0);
    expect(customerSends(t).filter((s) => s.kind === 'payment_confirmed')).toHaveLength(1);
  });

  it('a withdrawal case gets the withdrawal wording; Hinglish and Hindi customers get theirs', async () => {
    build();
    await app.onMessage(t.inbound('7000000001', 'mera withdrawal bank me nahi aaya', [], NOW));
    await confirm(confirmation('7000000001', { amount: '₹1,500' }));
    expect(t.sent.at(-1)!.text).toBe('🎉 Withdrawal Issue Resolved!\n\nHello P Kumar 👋\n\nAapka withdrawal issue successfully resolve ho gaya hai. Aapka amount ₹1,500 successfully transfer/confirm ho gaya hai. 💰✅\n\nAapke patience ke liye thank you, Sir. 🙏\nSorry for the inconvenience. 💙');
    await app.onMessage(t.inbound('7000000002', 'मैंने पैसे डाले लेकिन वॉलेट में नहीं आए', [], NOW));
    await confirm(confirmation('7000000002', { amount: '₹300' }), 2);
    expect(t.sent.at(-1)!.text).toBe(solvedText('hindi', { name: 'P Kumar', amount: '₹300', issue: 'deposit' }));
    expect(t.sent.at(-1)!.text).toMatch(/^🎉 डिपॉज़िट इश्यू सॉल्व हो गया!\n\nनमस्ते P Kumar 👋\n\nआपका डिपॉज़िट इश्यू सफलतापूर्वक सॉल्व हो गया है। आपका अमाउंट ₹300 /);
  });

  it('no amount in the confirmation: the note says the payment is confirmed, without inventing a figure', async () => {
    build();
    await app.onMessage(t.inbound('7000000003', 'I deposited money but my wallet is still empty', [], NOW));
    expect(await confirm(confirmation('7000000003', { amount: '' }))).toBe('solved');
    expect(t.sent.at(-1)!.text).toContain('Your deposit issue has been successfully resolved and the payment has been confirmed. 💰✅');
    expect(t.sent.at(-1)!.text).not.toMatch(/₹|amount of/);
  });

  it('the customer named in the confirmation must match the Telegram user behind the User ID', async () => {
    build();
    t.profiles.set('6135570708', { id: '6135570708', firstName: 'Pankaj', lastName: 'Kumar', username: 'pankaj_k' });
    await app.onMessage(t.inbound('6135570708', 'deposit nahi hua', [], NOW));
    expect(await confirm(confirmation('6135570708', { name: 'Rahul Sharma' }))).toBe('user_mismatch');
    expect(await confirm(confirmation('6135570708', { name: 'Pankaj Kumar', username: 'rahul_s' }), 2)).toBe('user_mismatch');
    expect(customerSends(t).filter((s) => s.kind === 'payment_confirmed')).toHaveLength(0);
    expect(await store.requests.listOpen('6135570708')).toHaveLength(1); // the case stays open
    // The right customer, mistyped case in the username: sent.
    expect(await confirm(confirmation('6135570708', { name: 'P Kumar', username: 'Pankaj_K' }), 3)).toBe('solved');
  });

  it('a User ID Telegram does not know to this account, with nothing stored about it: nobody is messaged', async () => {
    build();
    expect(await confirm(confirmation('8888888888'))).toBe('user_unverified');
    expect(customerSends(t)).toHaveLength(0);
    // Once the customer has written (so Telegram knows them), the confirmation goes through.
    await app.onMessage(t.inbound('8888888888', 'deposit nahi hua', [], NOW));
    expect(await confirm(confirmation('8888888888'), 2)).toBe('solved');
  });

  it('the Telegram name wins over the stored one and over the confirmation', async () => {
    build();
    await app.onMessage(t.inbound('7000000009', 'deposit nahi hua', [], NOW));
    t.profiles.set('7000000009', { id: '7000000009', firstName: 'Pankaj', lastName: 'K' }); // renamed on Telegram since
    await confirm(confirmation('7000000009', { name: 'P Kumar' }));
    expect(t.sent.at(-1)!.text).toContain('Hello Pankaj K 👋');
  });
});
