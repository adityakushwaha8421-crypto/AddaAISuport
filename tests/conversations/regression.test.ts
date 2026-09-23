import { beforeEach, describe, expect, it } from 'vitest';
import { buildPdf } from '../helpers/pdfFactory.js';
import { SCREENSHOTS } from '../helpers/fakeVision.js';
import {
  ADMIN_FIXTURES, HDFC_STATEMENT_WITH_CREDIT, HDFC_STATEMENT_WITHOUT_CREDIT, OTHER_ACCOUNT_STATEMENT,
} from '../helpers/fixtures.js';
import { Harness } from '../helpers/harness.js';

/**
 * Conversation regression suite. Runs the full pipeline (receiver → dedup → context → evidence →
 * interpretation → routing → workflow → admin → handoff → composer → outbox) with the
 * deterministic interpreter and templates, so every assertion is reproducible offline.
 */

let h: Harness;
beforeEach(() => {
  h = new Harness({ caseReplies: 'conversational', fixtures: ADMIN_FIXTURES });
  h.vision
    .set('pay500', SCREENSHOTS.payment500)
    .set('wdHistory', SCREENSHOTS.withdrawalHistory)
    .set('wdTwo', SCREENSHOTS.withdrawalTwoRows)
    .set('selfie', SCREENSHOTS.selfie);
});

const ASKS_REG = /registered (mobile )?number/i;

describe('1. Deposit issue', () => {
  it('batches the first request, confirms receipts, never re-asks, verifies automatically', async () => {
    const u = h.user('u1');
    const r1 = await u.say('deposit kiya tha wallet mein nahi aaya');
    // One request for everything, in one sentence.
    expect(r1).toBe(`Sir, deposit check karne ke liye ye details bhej dijiye 🙏

📱 Apna 10-digit registered number
🧾 Payment screenshot
📄 Bank statement PDF
🎥 Payment screen recording`);

    // Documents arriving afterwards are tracked silently (no "mil gaya / ab ye bhejo").
    expect(await u.photo('pay500')).toBe('');

    const r3 = await u.say('9810822372');
    expect(r3).not.toMatch(/mil gaya/i);
    expect(r3).toMatch(/successfully verify/i);
    expect(r3).toContain('ORD771001');
    expect(r3).toContain('₹500');
    expect(r3).not.toMatch(/statement/i);

    const c = await h.caseOf('u1');
    expect(c).toMatchObject({ type: 'deposit', status: 'resolved', orderId: 'ORD771001', registrationNumber: '9810822372' });
    expect(c?.facts.sources.orderId?.source).toBe('admin');
  });
});

describe('2. Withdrawal issue', () => {
  it('asks for ID or screenshot once, then reports the admin payout status', async () => {
    const u = h.user('u2');
    const r1 = await u.say('withdrawal abhi tak nahi aaya');
    expect(r1).toBe(`Sir, withdrawal check karne ke liye ye details bhej dijiye 🙏

🆔 Withdrawal ID ya withdrawal history ka screenshot
📄 Jis account me amount aana tha uska bank statement PDF`); // one request covering ID/screenshot and the destination account's statement

    const r2 = await u.say('WD-15436-64215');
    expect(r2).toMatch(/₹1,450 ka withdrawal successfully process/);
    expect(r2).toMatch(/HDFC Bank[\s\S]*XXXX6789/);
    expect(r2).not.toContain('50100123456789'); // account masked
    expect(r2).toMatch(/isi account ka recent bank statement PDF/); // user already said not received
    expect(h.admin.calls.filter((c) => c.op === 'findPayout')).toHaveLength(1);
  });
});

describe('3. Deposit → unrelated question → deposit resume', () => {
  it('pauses the deposit, answers the side topic cleanly, then resumes with state intact', async () => {
    const u = h.user('u3');
    await u.say('deposit ka issue hai');
    await u.say('mera number 9810822372 hai');

    const side = await u.say('Sir lineup de diya karo');
    expect(side).not.toMatch(/deposit|registered|screenshot|ORD/i);
    expect((await h.casesOf('u3'))[0]?.status).toBe('paused');

    const back = await u.say('mera deposit wala check karo');
    expect(back).not.toMatch(ASKS_REG); // registration number remembered
    expect(back).toMatch(/screenshot/i);
    const [c] = await h.casesOf('u3');
    expect(c?.status).toBe('open');
    expect(await h.casesOf('u3')).toHaveLength(1); // resumed, not duplicated
  });
});

describe('4. Withdrawal → unrelated question → withdrawal resume', () => {
  it('does not leak withdrawal status into the side answer and resumes afterwards', async () => {
    const u = h.user('u4');
    await u.say('withdrawal id WD-15436-61002 status?');
    const side = await u.say('contest kab start hoga aaj ka?');
    expect(side).not.toMatch(/withdrawal|processing|₹700/i);

    const back = await u.say('mera withdrawal wala kya hua');
    expect(back).toMatch(/processing/i);
    expect(back).toContain('₹700');
    expect(await h.casesOf('u4')).toHaveLength(1);
  });
});

describe('5. Screenshot → "upper wala"', () => {
  it('lists the rows in visual order and resolves "upper wala" to the top row', async () => {
    const u = h.user('u5');
    await u.say('withdrawal nahi aaya');
    const list = await u.photo('wdHistory');
    expect(list).toMatch(/3 withdrawals/);
    expect(list.indexOf('WD-15436-64215')).toBeLessThan(list.indexOf('WD-15436-61002'));
    expect(list.indexOf('WD-15436-61002')).toBeLessThan(list.indexOf('WD-15436-59990'));

    const r = await u.say('upper wala');
    expect(r).toMatch(/upar wala ₹1,450 \(WD-15436-64215\)/);
    expect(r).toMatch(/successfully process/);
    expect((await h.caseOf('u5'))?.withdrawalId).toBe('WD-15436-64215');
  });
});

describe('6. Screenshot → "neeche wala"', () => {
  it('resolves "neeche wala" to the bottom row when unambiguous (two rows)', async () => {
    const u = h.user('u6');
    await u.say('withdrawal issue hai');
    await u.photo('wdTwo');
    const r = await u.say('neeche wala');
    expect(r).toContain('WD-20001-22222');
    expect(r).toContain('₹400');
  });

  it('asks again instead of guessing when "neeche" is ambiguous (three rows)', async () => {
    const u = h.user('u6b');
    await u.say('withdrawal issue hai');
    await u.photo('wdHistory');
    const r = await u.say('neeche wala');
    expect(r).toMatch(/Kaunsa withdrawal/);
    expect((await h.caseOf('u6b'))?.withdrawalId).toBeUndefined();
  });
});

describe('7. Withdrawal ID embedded in text', () => {
  it('extracts the ID from a sentence and never asks for it', async () => {
    const u = h.user('u7');
    const r = await u.say('mera withdrawal id WD-15436-64215 hai sir');
    expect(r).toMatch(/successfully process/);
    expect(r).not.toMatch(/Withdrawal ID ya/);
  });
});

describe('8. Registration number embedded in text', () => {
  it('uses "number dusra hai 98…" directly, replacing the earlier number and re-checking', async () => {
    const u = h.user('u8');
    await u.say('deposit nahi aaya, mera number 9876543210 hai');
    const nomatch = await u.photo('pay500');
    expect(nomatch).toMatch(/match nahi ho rahe/); // no ₹500/UTR order on 9876543210
    expect(nomatch).not.toContain('ORD880001'); // never disclose another order on that number

    const r = await u.say('number dusra hai 9810822372');
    expect(r).not.toMatch(/10-digit/);
    expect(r).toContain('ORD771001');
    expect((await h.caseOf('u8'))?.registrationNumber).toBe('9810822372');
  });

  it('never discloses order details for a number without proof of payment', async () => {
    const u = h.user('u8b');
    const r = await u.say('deposit issue, number 9876543210');
    expect(r).not.toContain('ORD880001');
    expect(r).not.toContain('₹250');
    // Number already given → the one request lists only the remaining documents.
    expect(r).toBe(`Sir, deposit check karne ke liye ye details bhej dijiye 🙏

🧾 Payment screenshot
📄 Bank statement PDF
🎥 Payment screen recording`);
  });
});

describe('9. Successful withdrawal', () => {
  it('reports success with masked destination and does NOT ask for a statement unprompted', async () => {
    const u = h.user('u9');
    const r = await u.say('withdrawal WD-15436-64215 ka status batao');
    expect(r).toMatch(/successfully process/);
    expect(r).toMatch(/XXXX6789/);
    expect(r).not.toMatch(/statement/i);
    expect((await h.caseOf('u9'))?.status).toBe('resolved');

    // Only when the user says it did not arrive do we ask for the statement.
    const r2 = await u.say('credit nahi hua bhai');
    expect(r2).toMatch(/bank statement PDF/);
    expect(r2).not.toMatch(/successfully process/); // don't repeat the whole status
    expect((await h.caseOf('u9'))?.status).toBe('open');
  });
});

describe('10. Successful deposit', () => {
  it('tells the user it already succeeded and does not ask for a statement', async () => {
    const u = h.user('u10');
    const r = await u.photo('pay500', 'deposit nahi dikh raha 9810822372');
    expect(r).toMatch(/successfully verify/);
    expect(r).toContain('ORD771001');
    expect(r).not.toMatch(/statement/i);
  });
});

async function withdrawalAwaitingStatement(userId: string) {
  const u = h.user(userId);
  await u.say('WD-15436-64215 withdrawal ka paisa nahi aaya');
  return u;
}

describe('11. Bank statement with correct account', () => {
  it('finds the payout credit in the statement', async () => {
    const u = await withdrawalAwaitingStatement('u11');
    const r = await u.pdf(buildPdf(HDFC_STATEMENT_WITH_CREDIT));
    expect(r).toMatch(/₹1,450 ka credit 5 Sep/);
    expect((await h.caseOf('u11'))?.status).toBe('resolved');
    expect(h.supportMessages).toHaveLength(0);
  });

  it('escalates only when the statement is the payout account AND the credit is missing', async () => {
    const u = await withdrawalAwaitingStatement('u11b');
    const r = await u.pdf(buildPdf(HDFC_STATEMENT_WITHOUT_CREDIT));
    expect(r).toMatch(/shared with our team successfully/); // the requested statement is in: exported, and only that is said
    expect(r).not.toMatch(/check|wait|forward/i);
    expect(h.exportedFiles).toHaveLength(2); // the message with the ID, and the statement
    expect(h.supportMessages).toHaveLength(0);
  });
});

describe('12. Bank statement with wrong account', () => {
  it('explains the mismatch and asks for the right account, without escalating', async () => {
    const u = await withdrawalAwaitingStatement('u12');
    const r = await u.pdf(buildPdf(OTHER_ACCOUNT_STATEMENT));
    expect(r).toMatch(/us account ka nahi lag raha/);
    expect(r).toMatch(/HDFC Bank[\s\S]*XXXX6789/);
    expect(h.supportMessages).toHaveLength(0);
    expect((await h.caseOf('u12'))?.status).not.toBe('escalated');
  });
});

describe('13. Password-protected PDF', () => {
  it('asks for the password only because it is actually protected, then verifies', async () => {
    const u = await withdrawalAwaitingStatement('u13');
    const r1 = await u.pdf(buildPdf(HDFC_STATEMENT_WITH_CREDIT, { userPassword: 'YENU1304' }));
    expect(r1).toMatch(/password protected/);

    const wrong = await u.say('Password: WRONG99');
    expect(wrong).toMatch(/password sahi nahi/);

    const r2 = await u.say('Password:- YENU1304');
    expect(r2).toMatch(/₹1,450 ka credit/);
    // The password never reaches storage.
    const stored = JSON.stringify([...h.store.messages.rows, ...h.store.evidence.rows.values(), ...h.store.cases.rows.values()]);
    expect(stored).not.toContain('YENU1304');
    expect(stored).not.toContain('WRONG99');
  });
});

describe('14. Unprotected PDF', () => {
  it('never asks for a password', async () => {
    const u = await withdrawalAwaitingStatement('u14');
    const r = await u.pdf(buildPdf(HDFC_STATEMENT_WITH_CREDIT));
    expect(r).not.toMatch(/password/i);
  });
});

describe('15. Password embedded in normal text', () => {
  it.each(['ye lo password hai YENU1304 sir', 'YENU1304', 'The password is YENU1304'])('"%s"', async (text) => {
    const u = await withdrawalAwaitingStatement(`u15-${text.length}`);
    await u.pdf(buildPdf(HDFC_STATEMENT_WITH_CREDIT, { userPassword: 'YENU1304' }));
    const r = await u.say(text);
    // Reply language follows the user ("The password is …" is English); the fact is the same.
    expect(r).toMatch(/₹1,450.*credit|credit.*₹1,450/);
    expect(r).not.toMatch(/password/i);
  });
});

describe('16. User refuses additional documents', () => {
  it('stops asking and hands off with what is available', async () => {
    const u = await withdrawalAwaitingStatement('u16');
    const r = await u.say('statement nahi hai mere pass, jo hai usi se check karo');
    expect(r).toBe(''); // no "team will check" / "please wait" message
    expect(h.supportMessages).toHaveLength(1);
    expect(h.supportMessages[0]!.text).toMatch(/cannot provide more documents/);
  });
});

describe('17. Human handoff', () => {
  it('delivers a complete, masked summary and only then tells the customer', async () => {
    const u = h.user('u17', { firstName: 'Rahul', username: 'rahul_k' });
    await u.say('WD-15436-64215 ka paisa nahi aaya');
    const before = u.replies.length;
    await u.say('mujhe kisi insaan se baat karni hai');
    expect(u.replies).toHaveLength(before); // the customer is told nothing
    const support = h.supportMessages[0]!.text;
    expect(support).toMatch(/WITHDRAWAL/);
    expect(support).toMatch(/Customer asked for a human/);
    expect(support).toMatch(/WD-15436-64215/);
    expect(support).toMatch(/₹1,450/);
    expect(support).toMatch(/XXXXXXXXXX6789/); // masked for support too
    expect(support).not.toContain('50100123456789');
    expect(support).toMatch(/@rahul_k/);
    const c = await h.caseOf('u17');
    expect(c).toMatchObject({ status: 'escalated', escalation: 'delivered' });
  });

  it('does not claim forwarding when delivery fails; confirms after the retry succeeds', async () => {
    const u = h.user('u17b');
    h.transport.failSupportSends = 1;
    const r = await u.say('withdrawal WD-15436-64215 nahi aaya, agent se baat karao');
    expect(r).toBe(''); // a human request is a support-group ticket: nothing promised, even when delivery failed
    expect((await h.caseOf('u17b'))?.escalation).toBe('failed');

    await h.app.worker.tick();
    expect(h.supportMessages).toHaveLength(1); // the retry reaches the team
    expect(u.replies).toHaveLength(0); // and still nothing is sent to the customer
    expect((await h.caseOf('u17b'))?.status).toBe('escalated');
    const count = h.transport.sent.length;
    await h.app.worker.tick();
    expect(h.transport.sent).toHaveLength(count);
  });

  it('relays support replies to the customer and pauses the bot', async () => {
    const u = h.user('u17c');
    await u.say('mujhe customer care se baat karni hai, mera KYC reject ho gaya bina reason ke');
    const ticketMsg = h.supportMessages[0]!;
    await h.app.relay.onSupportMessage({ chatId: '-100999', messageId: 9001, fromUserId: 'agent1', text: 'Hi Rahul, KYC team is re-checking your documents.', replyToMessageId: ticketMsg.messageId });
    expect(u.last).toBe('Hi Rahul, KYC team is re-checking your documents.');
    const before = u.replies.length;
    await u.say('ok thanks');
    expect(u.replies).toHaveLength(before); // bot stays quiet while a human handles the chat
  });
});

describe('18. Telegram reply / swipe message', () => {
  it('resolves a swipe-reply on the bot\'s list against that list', async () => {
    const u = h.user('u18');
    await u.say('withdrawal status check karna hai');
    await u.photo('wdHistory');
    const listMsg = u.lastSent!.messageId;
    await u.say('Sir lineup de diya karo'); // topic switch in between
    const r = await u.replyTo(listMsg).say('second wala');
    expect(r).toContain('WD-15436-61002');
    expect(r).toMatch(/processing/i);
  });

  it('resolves "upar wala" swiped onto the user\'s own screenshot message', async () => {
    const u = h.user('u18b');
    await u.say('withdrawal nahi aaya');
    await u.photo('wdHistory');
    const shotId = h.transport.sent.length && [...h.store.messages.rows].reverse().find((m) => m.chatId === 'u18b' && m.direction === 'in' && m.media.length)!.telegramMessageId;
    const r = await u.replyTo(shotId).say('upar wala');
    expect(r).toContain('WD-15436-64215');
  });
});

describe('19. Duplicate message', () => {
  it('replies once to a redelivered update and never re-processes the same file', async () => {
    const u = h.user('u19');
    const msg = u.build({ text: 'withdrawal WD-15436-64215 check karo' });
    await u.send(msg);
    await u.send(msg);
    await u.send({ ...msg });
    expect(u.replies).toHaveLength(1);
    expect(h.admin.calls.filter((c) => c.op === 'findPayout')).toHaveLength(1);
    expect(h.metrics.duplicateMessages.get()).toBe(2);

    await u.photo('wdHistory', undefined, 'same-file');
    await u.photo('wdHistory', undefined, 'same-file');
    expect(h.vision.calls).toHaveLength(1);
  });

  it('processes a turn at most once even if the processor is invoked twice', async () => {
    const u = h.user('u19b');
    const msg = u.build({ text: 'hello' });
    await h.app.processor.receive(msg);
    await Promise.all([h.app.processor.process('u19b', [msg]), h.app.processor.process('u19b', [msg])]);
    // Two turns may run, but each has its own idempotency key; the store shows one inbound row.
    expect(h.store.messages.rows.filter((m) => m.chatId === 'u19b' && m.direction === 'in')).toHaveLength(1);
  });
});

describe('20. Multiple simultaneous users', () => {
  it('keeps conversations isolated under concurrency', async () => {
    const a = h.user('ua');
    const b = h.user('ub');
    const c = h.user('uc');
    await Promise.all([a.say('deposit nahi aaya'), b.say('withdrawal WD-15436-64215 nahi aaya'), c.say('hi')]);
    await Promise.all([a.say('9810822372'), b.pdf(buildPdf(HDFC_STATEMENT_WITH_CREDIT)), c.say('KYC verify nahi ho raha')]);

    expect(a.last).not.toMatch(/WD-|HDFC/);
    expect(b.last).toMatch(/₹1,450 ka credit/);
    expect(c.last).not.toMatch(/ORD|WD-/);
    expect((await h.caseOf('ua'))?.type).toBe('deposit');
    expect((await h.caseOf('ub'))?.type).toBe('withdrawal');
    expect((await h.caseOf('uc'))?.type).toBe('account');
  });
});
