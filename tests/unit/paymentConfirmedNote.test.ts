import { describe, expect, it } from 'vitest';
import { assemble, type App } from '../../src/app.js';
import { silentLogger } from '../../src/observability/logger.js';
import { solvedText } from '../../src/response/requests.js';
import { MemoryStore } from '../../src/storage/memory.js';
import { extractMobileNumbers } from '../../src/nlu/mobile.js';
import { identityMatches, parseConfirmation, parseCustomer } from '../../src/workflows/paymentConfirmed.js';
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
      userId: '6135570708', orderId: 'ILLUN-178923603882201', customerName: 'P Kumar', customerUsername: 'pkumar_9', amount: '₹2,999.01', mobile: '9810822372', issue: 'deposit',
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

  it('PAYMENT CONFIRMED is a deposit, whatever case the customer has open; withdrawal wording only when the confirmation says withdrawal', async () => {
    build();
    // The customer's open case was recorded as a withdrawal; the export bot confirms a PAYMENT: the note says deposit.
    await app.onMessage(t.inbound('7000000001', 'mera withdrawal bank me nahi aaya', [], NOW));
    await confirm(confirmation('7000000001', { amount: '₹3,844.94' }));
    expect(t.sent.at(-1)!.text).toBe('🎉 Deposit Issue Resolved!\n\nHello P Kumar 👋\n\nAapka deposit issue successfully resolve ho gaya hai. Aapka amount ₹3,844.94 successfully credit/confirm ho gaya hai. 💰✅\n\nAapke patience ke liye thank you, Sir. 🙏\nSorry for the inconvenience. 💙');
    expect(t.sent.at(-1)!.text).not.toMatch(/withdrawal/i);
    // A confirmation that itself speaks of a withdrawal gets the withdrawal wording.
    await app.onMessage(t.inbound('7000000011', 'withdrawal nahi aaya', [], NOW));
    await confirm('✅ WITHDRAWAL PAYMENT CONFIRMED\n👤 Customer: P Kumar (User ID: 7000000011)\n💰 Amount: ₹1,500', 3);
    expect(t.sent.at(-1)!.text).toBe('🎉 Withdrawal Issue Resolved!\n\nHello P Kumar 👋\n\nAapka withdrawal issue successfully resolve ho gaya hai. Aapka amount ₹1,500 successfully transfer/confirm ho gaya hai. 💰✅\n\nAapke patience ke liye thank you, Sir. 🙏\nSorry for the inconvenience. 💙');
    expect(parseConfirmation('✅ PAYMENT CONFIRMED\nUser ID: 6135570708\n🤖 @withdraw_pay_bot')?.issue).toBe('deposit'); // a bot handle is not the topic
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

// ── No User ID: the Mobile line as the fallback ─────────────────────────────

const noId = (o: { name?: string; username?: string; mobile?: string; amount?: string; order?: string } = {}) =>
  [
    '✅ PAYMENT CONFIRMED',
    '',
    `👤 Customer: ${o.name ?? 'Fantasy Expert News'} (${o.username ? `@${o.username}` : 'no username'}, no user id)`,
    `📱 Mobile: ${o.mobile ?? '9330949495'}`,
    `💰 Amount: ${o.amount ?? '₹200.00'}`,
    `🧾 Order: ${o.order ?? 'ILLUN-179030843478237'}`,
  ].join('\n');

describe('mobile numbers a customer typed are remembered', () => {
  it('reads Indian mobiles in every common shape, and nothing else', () => {
    expect(extractMobileNumbers('mera number 9330949495 hai')).toEqual(['9330949495']);
    expect(extractMobileNumbers('+91 93309 49495 / 91-9810822372 / 09810822372')).toEqual(['9330949495', '9810822372']);
    expect(extractMobileNumbers('९३३०९४९४९५')).toEqual(['9330949495']);
    expect(extractMobileNumbers('order ILLUN-179030843478237 amount 2999 utr 123456789012 date 25092026')).toEqual([]);
    expect(extractMobileNumbers('5330949495 is not a mobile; 93309494951 is too long')).toEqual([]);
    expect(extractMobileNumbers(undefined)).toEqual([]);
  });

  it('a number typed in a chat is stored on that customer and found again', async () => {
    build();
    await app.onMessage(t.inbound('7000000101', 'deposit nahi hua', [], NOW));
    await app.onMessage(t.inbound('7000000101', 'number: +91 93309 49495', [], NOW));
    await app.onMessage(t.inbound('7000000101', '9330949495 ye hai', [], NOW)); // again: once
    expect((await store.users.get('7000000101'))?.mobileNumbers).toEqual(['9330949495']);
    expect((await store.users.findByMobileNumber('9330949495')).map((u) => u.id)).toEqual(['7000000101']);
    expect(await store.users.findByMobileNumber('9810822372')).toEqual([]);
  });
});

describe('a confirmation without a User ID is delivered by mobile number, only when the customer is certain', () => {
  it('the example: one customer typed 9330949495 and is "Fantasy Expert News" on Telegram → told once, by that name, with ₹200.00', async () => {
    build();
    t.profiles.set('7000000201', { id: '7000000201', firstName: 'Fantasy Expert', lastName: 'News' });
    await app.onMessage(t.inbound('7000000201', 'deposit nahi hua 200 ka', [], NOW));
    await app.onMessage(t.inbound('7000000201', '9330949495', [], NOW));
    expect(await confirm(noId())).toBe('solved');
    expect(t.sent.at(-1)).toMatchObject({ chatId: '7000000201', kind: 'payment_confirmed' });
    expect(t.sent.at(-1)!.text).toBe(solvedText('hinglish', { name: 'Fantasy Expert News', amount: '₹200.00', issue: 'deposit' }));
    expect(await store.requests.listOpen('7000000201')).toHaveLength(0);
    expect(await confirm(noId(), 2)).toBe('duplicate');
    expect(customerSends(t).filter((s) => s.kind === 'payment_confirmed')).toHaveLength(1);
  });

  it('nobody typed that number → nobody is messaged', async () => {
    build();
    await app.onMessage(t.inbound('7000000202', 'deposit nahi hua', [], NOW));
    await app.onMessage(t.inbound('7000000202', '9810822372', [], NOW));
    expect(await confirm(noId({ mobile: '9330949495' }))).toBe('user_unverified');
    expect(customerSends(t).filter((s) => s.kind === 'payment_confirmed')).toHaveLength(0);
  });

  it('the customer who typed the number is someone else on Telegram → nobody is messaged', async () => {
    build();
    t.profiles.set('7000000203', { id: '7000000203', firstName: 'Rahul', lastName: 'Sharma' });
    await app.onMessage(t.inbound('7000000203', 'deposit nahi hua', [], NOW));
    await app.onMessage(t.inbound('7000000203', 'mera number 9330949495', [], NOW));
    expect(await confirm(noId({ name: 'Fantasy Expert News' }))).toBe('user_unverified');
    expect(customerSends(t).filter((s) => s.kind === 'payment_confirmed')).toHaveLength(0);
    expect(await store.requests.listOpen('7000000203')).toHaveLength(1);
  });

  it('a confirmation with a name Telegram cannot confirm (or no name at all) is not enough by mobile alone', async () => {
    build();
    t.profiles.set('7000000204', { id: '7000000204' }); // Telegram shows no name
    await app.onMessage(t.inbound('7000000204', '9330949495', [], NOW));
    expect(await confirm(noId({ name: 'Fantasy Expert News' }))).toBe('user_unverified');
    expect(await confirm('✅ PAYMENT CONFIRMED\n📱 Mobile: 9330949495\n💰 Amount: ₹200', 2)).toBe('user_unverified');
    // A matching @username is a positive match too.
    t.profiles.set('7000000204', { id: '7000000204', username: 'fantasy_news' });
    expect(await confirm(noId({ username: 'fantasy_news' }), 3)).toBe('solved');
  });

  it('two customers typed the same number: only the one the confirmation names is told; both matching → nobody', async () => {
    build();
    t.profiles.set('7000000205', { id: '7000000205', firstName: 'Fantasy Expert', lastName: 'News' });
    t.profiles.set('7000000206', { id: '7000000206', firstName: 'Amit', lastName: 'Verma' });
    await app.onMessage(t.inbound('7000000205', '9330949495', [], NOW));
    await app.onMessage(t.inbound('7000000206', '9330949495', [], NOW));
    expect(await confirm(noId())).toBe('solved');
    expect(t.sent.at(-1)!.chatId).toBe('7000000205');
    t.profiles.set('7000000206', { id: '7000000206', firstName: 'Fantasy', lastName: 'News' });
    expect(await confirm(noId({ order: 'ILLUN-2' }), 2)).toBe('user_unverified');
    expect(customerSends(t).filter((s) => s.kind === 'payment_confirmed')).toHaveLength(1);
  });

  it('a User ID always wins over the Mobile line, even when the number points at somebody else', async () => {
    build();
    await app.onMessage(t.inbound('7000000207', 'deposit nahi hua', [], NOW));
    await app.onMessage(t.inbound('7000000208', '9330949495', [], NOW));
    expect(await confirm(confirmation('7000000207', { name: 'P Kumar' }) + '\n📱 Mobile: 9330949495')).toBe('solved');
    expect(t.sent.at(-1)!.chatId).toBe('7000000207');
  });
});

// ── "Customer: @handle (Name)": the @username as the address ────────────────

const betix = (o: { customer?: string; mobile?: string; order?: string } = {}) =>
  `✅ PAYMENT CONFIRMED\n\n👤 Customer: ${o.customer ?? '@Sureshreddy45 (Suresh)'}\n📱 Mobile: ${o.mobile ?? '6363446223'}\n💰 Amount: ₹1,499.06\n🧾 Order: ${o.order ?? 'ILLUN-17907641975708'}\n\n✅ Confirmed by: Betix System\n🤖 @betixpay_cs_bot\n🕒 Time: 18:44\n\n🙏 Payment successfully confirmed.`;

describe('the Customer line in every shape the export bot prints', () => {
  it('the @handle is the username wherever it stands; the name is never the handle', () => {
    expect(parseCustomer('👤 Customer: @Sureshreddy45 (Suresh)')).toEqual({ customerName: 'Suresh', customerUsername: 'Sureshreddy45' });
    expect(parseCustomer('👤 Customer: Suresh Reddy @Sureshreddy45')).toEqual({ customerName: 'Suresh Reddy', customerUsername: 'Sureshreddy45' });
    expect(parseCustomer('👤 Customer: P Kumar (User ID: 6135570708, no username)')).toEqual({ customerName: 'P Kumar', customerUsername: undefined });
    expect(parseCustomer('👤 Customer: P Kumar (User ID: 6135570708, @pkumar_9)')).toEqual({ customerName: 'P Kumar', customerUsername: 'pkumar_9' });
    expect(parseCustomer('👤 Customer: Fantasy Expert News (no username, no user id)')).toEqual({ customerName: 'Fantasy Expert News', customerUsername: undefined });
    expect(parseCustomer('👤 Customer: @Sureshreddy45')).toEqual({ customerName: undefined, customerUsername: 'Sureshreddy45' });
    expect(parseCustomer(undefined)).toEqual({});
  });

  it('the pasted confirmation: no User ID, @Sureshreddy45, Suresh, 6363446223, ₹1,499.06 — and the bot\'s own @handle further down is not the customer', () => {
    expect(parseConfirmation(betix())).toEqual({ userId: undefined, orderId: 'ILLUN-17907641975708', customerName: 'Suresh', customerUsername: 'Sureshreddy45', amount: '₹1,499.06', mobile: '6363446223', issue: 'deposit' });
  });

  it('the same @username is the same account, whatever the names look like', () => {
    expect(identityMatches({ customerName: 'Suresh', customerUsername: 'Sureshreddy45' }, { firstName: 'S.R.', username: 'sureshreddy45' }, true).ok).toBe(true);
    expect(identityMatches({ customerUsername: 'Sureshreddy45' }, { username: 'SURESHREDDY45' }, true).ok).toBe(true);
    expect(identityMatches({ customerName: 'Suresh', customerUsername: 'Sureshreddy45' }, { firstName: 'Suresh', username: 'someone_else' }, true).ok).toBe(false);
  });
});

describe('a confirmation without a User ID but with an @username', () => {
  it('the pasted case: @Sureshreddy45 wrote to the account → told once, by Telegram name, with ₹1,499.06 (no mobile number needed)', async () => {
    build();
    t.profiles.set('7000000301', { id: '7000000301', firstName: 'Suresh', lastName: 'Reddy', username: 'Sureshreddy45' });
    await app.onMessage(t.inbound('7000000301', 'deposit nahi hua 1499 ka', [], NOW));
    expect(await confirm(betix())).toBe('solved');
    expect(t.sent.at(-1)).toMatchObject({ chatId: '7000000301', kind: 'payment_confirmed' });
    expect(t.sent.at(-1)!.text).toBe(solvedText('hinglish', { name: 'Suresh Reddy', amount: '₹1,499.06', issue: 'deposit' }));
    expect(await store.requests.listOpen('7000000301')).toHaveLength(0);
    expect(await confirm(betix(), 2)).toBe('duplicate');
  });

  it('an @username that never wrote to the account is taken only when the confirmation\'s name matches its Telegram name', async () => {
    build();
    t.profiles.set('7000000302', { id: '7000000302', firstName: 'Suresh', username: 'Sureshreddy45' });
    expect(await confirm(betix())).toBe('solved'); // "Suresh" confirms it
    expect(t.sent.at(-1)!.chatId).toBe('7000000302');
    build();
    t.profiles.set('7000000303', { id: '7000000303', firstName: 'Somebody', lastName: 'Else', username: 'Sureshreddy45' });
    expect(await confirm(betix())).toBe('user_unverified'); // a stranger holding the handle: nobody is messaged
    expect(customerSends(t)).toHaveLength(0);
  });

  it('Telegram has no such @username → the mobile number is the fallback, verified as before', async () => {
    build();
    t.profiles.set('7000000304', { id: '7000000304', firstName: 'Suresh', lastName: 'R' }); // no username on Telegram
    await app.onMessage(t.inbound('7000000304', 'mera number 6363446223', [], NOW));
    expect(await confirm(betix())).toBe('solved');
    expect(t.sent.at(-1)!.chatId).toBe('7000000304');
    build();
    expect(await confirm(betix())).toBe('user_unverified'); // no such handle, nobody typed the number
  });

  it('a User ID still wins over the @username', async () => {
    build();
    t.profiles.set('7000000305', { id: '7000000305', firstName: 'Suresh', username: 'Sureshreddy45' });
    await app.onMessage(t.inbound('7000000306', 'deposit nahi hua', [], NOW)); // P Kumar
    expect(await confirm('✅ PAYMENT CONFIRMED\n👤 Customer: P Kumar (User ID: 7000000306)\n💰 Amount: ₹500')).toBe('solved');
    expect(t.sent.at(-1)!.chatId).toBe('7000000306');
  });
});
