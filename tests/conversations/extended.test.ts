import { beforeEach, describe, expect, it } from 'vitest';
import { ScriptedLlm } from '../../src/llm/fake.js';
import { NO_CLAIMS } from '../../src/nlu/types.js';
import { buildPdf } from '../helpers/pdfFactory.js';
import { analysisOf, SCREENSHOTS } from '../helpers/fakeVision.js';
import { ADMIN_FIXTURES, HDFC_STATEMENT_WITH_CREDIT } from '../helpers/fixtures.js';
import { Harness } from '../helpers/harness.js';

const WITHDRAWAL_REQUEST = `Sir, withdrawal check karne ke liye ye details bhej dijiye 🙏

🆔 Withdrawal ID ya withdrawal history ka screenshot
📄 Jis account me amount aana tha uska bank statement PDF`;

let h: Harness;
beforeEach(() => {
  h = new Harness({ fixtures: ADMIN_FIXTURES });
  h.vision.set('pay500', SCREENSHOTS.payment500).set('wdHistory', SCREENSHOTS.withdrawalHistory).set('selfie', SCREENSHOTS.selfie);
});

describe('clarification & retyping', () => {
  it('"amount credit nahi hua" → asks deposit or withdrawal once → continues with the claim remembered', async () => {
    const u = h.user('x1');
    expect(await u.say('amount credit nahi hua')).toMatch(/Deposit ka issue hai ya withdrawal ka/);
    const r = await u.say('withdrawal ka');
    expect(r).toBe(WITHDRAWAL_REQUEST); // the one-time request, not a follow-up
    const cases = await h.casesOf('x1');
    expect(cases).toHaveLength(1);
    expect(cases[0]).toMatchObject({ type: 'withdrawal' });
  });

  it('a screenshot settles the type without asking', async () => {
    const u = h.user('x1b');
    await u.say('amount credit nahi hua');
    const r = await u.photo('wdHistory');
    expect(r).toMatch(/3 withdrawals/);
    expect((await h.caseOf('x1b'))?.type).toBe('withdrawal');
  });
});

describe('tone & friction', () => {
  it('acknowledges frustration and hands off instead of repeating a request', async () => {
    const u = h.user('x2');
    await u.say('deposit nahi aaya');
    const r = await u.say('kitni baar bheju bhai, kab tak wait karu');
    expect(r).toMatch(/Samajh sakta hoon/);
    expect(r).not.toMatch(/registered number aur payment screenshot bhej/); // no full restart
  });

  it('"ok" to a request gets no reply and does not count as a repeat ask', async () => {
    const u = h.user('x2c');
    await u.say('withdrawal nahi aaya');
    expect(await u.say('ok')).toBe('');
    expect(await u.say('ok')).toBe('');
    expect(h.supportMessages).toHaveLength(0);
    expect((await h.caseOf('x2c'))?.facts.asks.withdrawal_ref).toBe(1);
    expect(await u.say('WD-15436-64215')).toMatch(/successfully process/);
  });

  it('does not repeat the ticket status to "ok" on an escalated case', async () => {
    const u = h.user('x2d');
    await u.say('WD-15436-64215 nahi aaya, agent se baat karao');
    const before = u.replies.length;
    await u.say('ok');
    expect(await u.say('thank you')).toBe('');
    expect(u.replies).toHaveLength(before);
  });

  it('treats "baad mein bhejta hoon" as a promise, not a delivery', async () => {
    const u = h.user('x2b');
    await u.say('WD-15436-64215 ka paisa nahi aaya');
    const r = await u.say('statement baad mein bhejta hoon');
    expect(r).toMatch(/Jab ready ho bhej dijiye/);
    expect(r).not.toMatch(/mil gaya/i);
  });
});

describe('media edge cases', () => {
  it('accepts a payment video even when it cannot be analysed, and forwards it to the team', async () => {
    const u = h.user('x3v');
    await u.say('deposit kiya tha wallet mein nahi aaya');
    h.transport.files.set('vid-1', Buffer.from('mp4-bytes'));
    const r = await u.send(u.build({ media: [{ kind: 'video', fileRef: 'vid-1', fileUniqueId: 'vid-1', mimeType: 'video/mp4', durationSec: 12 }] }));
    expect(r).toBe(''); // accepted silently — no "video check nahi ho pa raha", no new request
    const videoMsg = [...h.store.messages.rows].find((m) => m.chatId === 'x3v' && m.media.some((x) => x.kind === 'video'))!;
    await u.say('number nahi pata, agent se baat karao');
    expect(h.transport.forwards).toContainEqual({ from: 'x3v', messageId: videoMsg.telegramMessageId, to: '-100999' });
  });

  it('voice notes: honest "can\'t listen" reply', async () => {
    const u = h.user('x3');
    await u.say('withdrawal issue');
    const r = await u.send(u.build({ media: [{ kind: 'voice', fileRef: 'v', fileUniqueId: 'v1', durationSec: 5 }] }));
    expect(r).toMatch(/voice note/);
  });

  it('an unrelated image is not treated as evidence', async () => {
    const u = h.user('x3b');
    await u.say('withdrawal nahi aaya');
    const r = await u.photo('selfie');
    expect(r).toMatch(/related nahi lag rahi/);
    expect((await h.caseOf('x3b'))?.facts.withdrawalEvidenceId).toBeUndefined();
  });

  it('an unreadable (scanned) statement gets one clear request, not a password prompt', async () => {
    const u = h.user('x3c');
    await u.say('WD-15436-64215 ka paisa nahi aaya');
    const blank = buildPdf([' ']);
    const r = await u.pdf(blank);
    expect(r).not.toMatch(/password/i);
  });

  it('screenshot + caption in one album-like burst → one reply', async () => {
    const u = h.user('x3d');
    h.transport.files.set('wd-album', Buffer.from('wdHistory'));
    const m1 = u.build({ text: 'withdrawal nahi aaya' });
    const m2 = u.build({ media: [{ kind: 'photo', fileRef: 'wd-album', fileUniqueId: 'wd-album', mimeType: 'image/jpeg' }] });
    for (const m of [m1, m2]) await h.app.processor.receive(m);
    await h.app.processor.process('x3d', [m1, m2]);
    expect(u.replies).toHaveLength(1);
    expect(u.last).toMatch(/3 withdrawals/);
  });
});

describe('escalated cases', () => {
  it('forwards new evidence to the existing ticket instead of opening another', async () => {
    const u = h.user('x4');
    await u.say('WD-15436-64215 ka paisa nahi aaya, agent se baat karao');
    expect(h.supportMessages).toHaveLength(1);
    const r = await u.pdf(buildPdf(HDFC_STATEMENT_WITH_CREDIT));
    expect(r).toBe(''); // silent for the customer…
    expect(h.supportMessages).toHaveLength(2); // …but the team gets the new document
    expect(h.supportMessages[1]!.replyTo).toBe(h.supportMessages[0]!.messageId);
    expect([...h.store.tickets.rows.values()]).toHaveLength(1);
  });

  it('passes on substantive text; stays quiet about pings', async () => {
    const u = h.user('x4b');
    await u.say('WD-15436-64215 nahi aaya, human se baat karni hai');
    expect(await u.say('abhi bhi paisa nahi aaya')).toBe('');
    expect(await u.say('?')).toBe('');
    expect(h.supportMessages).toHaveLength(2); // only the substantive message reached the team
  });
});

describe('admin outcomes', () => {
  it('admin outage → statement requested once, then an honest handoff, never a false "not found"', async () => {
    h.admin.failNext(5);
    const u = h.user('x5');
    const r = await u.say('withdrawal WD-15436-64215 status');
    expect(r).toMatch(/bank statement/i); // never a false "not found", and never a "team will check" line
    expect(r).not.toMatch(/nahi mil|team|wait/i);
    expect(h.supportMessages).toHaveLength(0);
    expect(await u.pdf(buildPdf(HDFC_STATEMENT_WITH_CREDIT))).toMatch(/shared with our team successfully/);
    expect(h.exportedFiles).toHaveLength(2); // the message with the ID, and the PDF
    expect(h.supportMessages).toHaveLength(0);
  });

  it('failed withdrawal: reports status + reason; dispute afterwards goes to humans', async () => {
    const u = h.user('x5b');
    const r = await u.say('WD-15436-59990 ka status?');
    expect(r).toMatch(/failed dikh raha hai[\s\S]*Reason: Invalid IFSC/);
    const r2 = await u.say('paisa kat gaya tha, wapas nahi aaya');
    expect(r2).toMatch(/shared with our team successfully/); // nothing more was ever asked for: exported at once
    expect(h.exportedFiles).toHaveLength(1); // the message with the ID
    expect(h.supportMessages).toHaveLength(0);
  });

  it('processing within SLA: status only; beyond SLA: escalates', async () => {
    const u = h.user('x5c');
    expect(await u.say('WD-15436-61002 kab aayega?')).toMatch(/processing/);
    expect(h.supportMessages).toHaveLength(0);
    h.admin.upsertPayout({ ...ADMIN_FIXTURES.payouts[1]!, requestedAt: '2026-09-09T10:00:00+05:30' });
    const v = h.user('x5d');
    const r = await v.say('WD-15436-61002 kab aayega?');
    expect(r).toMatch(/processing/); // the status is still a fact
    expect(r).toMatch(/shared with our team successfully/); // beyond the SLA: exported to the team
    expect(h.exportedFiles).toHaveLength(1);
  });

  it('unknown ID: one re-check request, then handoff', async () => {
    const u = h.user('x5e');
    expect(await u.say('withdrawal id WD-11111-00000 check karo')).toMatch(/nahi mil rahi/);
    expect(await u.say('WD-11111-00001')).toMatch(/nahi mil rahi/);
    expect(await u.say('WD-11111-00002')).toMatch(/shared with our team successfully/);
  });

  it('pending deposit with a verified receipt goes straight to the team (no statement demand)', async () => {
    h.vision.set('pay1000', analysisOf({
      category: 'payment_screenshot',
      transcript: 'Paytm\nPayment Successful\n₹1,000\n10 Sep 2026, 06:02 PM\nUPI Ref No: 698765432109',
      payment: { amount: 1000, amount_confidence: 0.95, date: '2026-09-10', time: '18:02', utr: '698765432109', utr_confidence: 0.95, status: 'success' } as never,
    }));
    const u = h.user('x5f');
    await u.say('deposit nahi aaya 9810822372');
    const r = await u.photo('pay1000');
    expect(r).toMatch(/pending[\s\S]*ORD771002/); // the verified status is still shared
    expect(r).not.toMatch(/team|forward|wait/i);
    expect(r).not.toMatch(/statement/i);
    expect(h.supportMessages).toHaveLength(0); // statement and video from the one request still outstanding
    expect(await u.pdf(buildPdf(HDFC_STATEMENT_WITH_CREDIT))).toBe('');
    expect(await u.video()).toMatch(/shared with our team successfully/);
    expect(h.exportedFiles).toHaveLength(4);
    expect(h.supportMessages).toHaveLength(0);
  });
});

describe('statement edge cases', () => {
  it('asks for a newer statement once when it ends before the payout date', async () => {
    const u = h.user('x6');
    await u.say('WD-15436-64215 ka paisa nahi aaya');
    const old = HDFC_STATEMENT_WITH_CREDIT.filter((l) => !/0[5-9]\/09\/2026|From/.test(l)).concat(['Statement From : 01/08/2026 To : 31/08/2026', '20/08/2026 NEFT CR 100.00 1,000.00', '25/08/2026 UPI DR 50.00 950.00', '28/08/2026 ATM 100.00 850.00']);
    const r = await u.pdf(buildPdf(old));
    expect(r).toMatch(/5 Sept? se pehle ka hai/);
    expect(h.supportMessages).toHaveLength(0);
  });

  it('three wrong PDF passwords → handoff rather than a loop', async () => {
    const u = h.user('x6b');
    await u.say('WD-15436-64215 ka paisa nahi aaya');
    await u.pdf(buildPdf(HDFC_STATEMENT_WITH_CREDIT, { userPassword: 'RIGHT123' }));
    await u.say('password: WRONG1');
    await u.say('password: WRONG2');
    const r = await u.say('password: WRONG3');
    expect(r).toBe(''); // an unreadable PDF is a support-group ticket, not an export
    expect(h.supportMessages).toHaveLength(1);
    expect(h.exportedFiles).toHaveLength(0);
  });

  it('"Skip" on a protected PDF hands off with what is available', async () => {
    const u = h.user('x6c');
    await u.say('WD-15436-64215 ka paisa nahi aaya');
    await u.pdf(buildPdf(HDFC_STATEMENT_WITH_CREDIT, { userPassword: 'RIGHT123' }));
    expect(await u.say('skip')).toBe(''); // the customer stopped: a support-group ticket, silently
    expect(h.supportMessages).toHaveLength(1);
    expect(h.exportedFiles).toHaveLength(0);
  });
});

describe('general questions', () => {
  it('answers from the knowledge base without touching cases', async () => {
    const hk = new Harness({ fixtures: ADMIN_FIXTURES, knowledge: [{ id: 'l', keywords: ['lineup'], answer: 'Sir, lineup match se pehle app ke contest page par dikhta hai 👍' }] });
    const u = hk.user('x7');
    expect(await u.say('Sir lineup kab aayega')).toMatch(/contest page/);
    expect(await hk.casesOf('x7')).toHaveLength(0);
  });
});

describe('resilience', () => {
  it('recovers messages a crash left unprocessed, and replies exactly once', async () => {
    const u = h.user('x8');
    const m = u.build({ text: 'WD-15436-64215 status' });
    await h.app.processor.receive(m); // stored, then "crash" before processing
    expect(await h.app.recover(15)).toBe(1);
    await h.drain();
    expect(u.replies).toHaveLength(1);
    expect(await h.app.recover(15)).toBe(0);
  });

  it('retries a failed customer send without duplicating it', async () => {
    const u = h.user('x8b');
    h.transport.failCustomerSends = 1;
    await u.say('WD-15436-64215 status');
    expect(u.replies).toHaveLength(0);
    await h.app.outbox.flushPending();
    await h.app.outbox.flushPending();
    expect(u.replies).toHaveLength(1);
  });

  it('closes idle cases but never touches escalated ones', async () => {
    const a = h.user('x8c');
    const b = h.user('x8d');
    await a.say('withdrawal nahi aaya');
    await b.say('WD-15436-64215 nahi aaya, agent se baat karao');
    h.advance(60 * 50);
    await h.app.worker.tick();
    expect((await h.casesOf('x8c'))[0]?.status).toBe('closed');
    expect((await h.casesOf('x8d'))[0]?.status).toBe('escalated');
  });

  it('stays silent while a human operates the account, for as long as they keep it', async () => {
    const u = h.user('x8e');
    await h.app.relay.onOwnOutgoing({ chatId: 'x8e', messageId: 1, text: 'Ji sir?' });
    await u.say('hello?');
    expect(u.replies).toHaveLength(0);
    h.advance(61); // no timer: nothing changes
    expect(await u.say('hello?')).toBe('');
    await h.app.relay.onOwnOutgoing({ chatId: 'x8e', messageId: 2, text: '/ai' });
    expect(await u.say('hello?')).not.toBe('');
  });
});

describe('LLM interpreter path', () => {
  it('uses the model for interpretation but only accepts identifiers present in the text', async () => {
    const llm = new ScriptedLlm().on('interpret', () => ({
      intent: 'withdrawal_issue', case_type: 'withdrawal', relation: 'new_issue', target_case_id: null,
      claims: { ...NO_CLAIMS, notReceived: true }, reference: { kind: 'none', index: null }, affirmation: 'none', language: 'hinglish',
      gist: 'Withdrawal from yesterday not received', confidence: 0.92,
      proposed: { registration_number: null, withdrawal_id: 'WD-15436-64215', order_id: null, utr: null, amount: null }, // hallucinated
    }));
    const hl = new Harness({ fixtures: ADMIN_FIXTURES, llm });
    const u = hl.user('x9');
    const r = await u.say('kal wala paisa bank me nahi pahuncha');
    expect(r).toMatch(/Withdrawal ID ya withdrawal history/); // did not use the invented ID
    expect(hl.admin.calls).toHaveLength(0);
    expect((await hl.caseOf('x9'))?.facts.claims.notReceived).toBe(true);
  });
});
