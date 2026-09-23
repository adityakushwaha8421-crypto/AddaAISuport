import { beforeEach, describe, expect, it } from 'vitest';
import { ScriptedLlm } from '../../src/llm/fake.js';
import { NO_CLAIMS } from '../../src/nlu/types.js';
import { buildPdf } from '../helpers/pdfFactory.js';
import { SCREENSHOTS } from '../helpers/fakeVision.js';
import { ADMIN_FIXTURES, HDFC_STATEMENT_WITH_CREDIT } from '../helpers/fixtures.js';
import { emptyMemory } from '../../src/domain/memory.js';
import { Harness, type UserSim } from '../helpers/harness.js';

/** Low-friction conversation behaviour: greet normally, ask once, track silently, speak only when needed. */
const ONE_REQUEST = `Sir, deposit check karne ke liye ye details bhej dijiye 🙏

📱 Apna 10-digit registered number
🧾 Payment screenshot
📄 Bank statement PDF
🎥 Payment screen recording`;
const DOC_REQUEST = /bhej dijiye|bhejo|send/i;

let h: Harness;
beforeEach(() => {
  h = new Harness({ caseReplies: 'conversational', fixtures: ADMIN_FIXTURES });
  h.vision.set('pay500', SCREENSHOTS.payment500);
});

const video = (u: UserSim, key: string) => {
  h.transport.files.set(key, Buffer.from('mp4'));
  return u.send(u.build({ media: [{ kind: 'video', fileRef: key, fileUniqueId: key, mimeType: 'video/mp4', durationSec: 9 }] }));
};

describe('simple, natural conversation', () => {
  it.each(['hi', 'hello', 'hey', 'hii', 'kya haal hai', 'good morning'])('A. "%s" → short greeting, no documents', async (text) => {
    const r = await h.user(`a-${text}`).say(text);
    expect(r).toBe('Hello sir 👋 Kaise help karun?');
  });

  it.each(['deposit nahi aaya', 'payment add nahi hua', 'deposit issue hai', 'payment successful but balance nahi aaya', 'paisa wallet me nahi aaya'])(
    'B. "%s" → one combined request',
    async (text) => {
      expect(await h.user(`b-${text.length}`).say(text)).toBe(ONE_REQUEST);
    },
  );

  it('C. documents one by one → no repetitive requests, then the result', async () => {
    const u = h.user('c');
    await u.say('deposit nahi aaya');
    expect(await u.photo('pay500')).toBe('');
    expect(await u.pdf(buildPdf(HDFC_STATEMENT_WITH_CREDIT))).toBe('');
    expect(await video(u, 'v-c')).toBe('');
    const result = await u.say('9810822372');
    expect(result).toMatch(/successfully verify/);
    expect(result).not.toMatch(DOC_REQUEST);
    expect(u.replies).toHaveLength(2); // the one request + the result
  });

  it('D. everything at once → straight to the result, no document requests', async () => {
    const u = h.user('d');
    h.transport.files.set('p-d', Buffer.from('pay500'));
    h.transport.files.set('s-d', buildPdf(HDFC_STATEMENT_WITH_CREDIT));
    h.transport.files.set('v-d', Buffer.from('mp4'));
    const msgs = [
      u.build({ text: 'deposit nahi aaya, number 9810822372' }),
      u.build({ media: [{ kind: 'photo', fileRef: 'p-d', fileUniqueId: 'p-d', mimeType: 'image/jpeg' }] }),
      u.build({ media: [{ kind: 'document', fileRef: 's-d', fileUniqueId: 's-d', mimeType: 'application/pdf', fileName: 'stmt.pdf' }] }),
      u.build({ media: [{ kind: 'video', fileRef: 'v-d', fileUniqueId: 'v-d', mimeType: 'video/mp4' }] }),
    ];
    for (const m of msgs) await h.app.processor.receive(m);
    await h.app.processor.process('d', msgs);
    expect(u.replies).toHaveLength(1);
    expect(u.last).toMatch(/successfully verify/);
    expect(u.last).not.toMatch(DOC_REQUEST);
  });

  it('E. a genuinely required item is missing → ask only for that one', async () => {
    const u = h.user('e');
    await u.say('deposit nahi aaya');
    await u.photo('pay500');
    const r = await u.say('check karo');
    expect(r).toMatch(/registered number/);
    expect(r).not.toMatch(/statement|video|screenshot/i);
  });

  it('F. topic change → answer the new topic, no document request', async () => {
    const u = h.user('f');
    await u.say('deposit nahi aaya');
    const r = await u.say('Sir lineup kab milega?');
    expect(r).not.toMatch(/statement|screenshot|registered|video/i);
  });

  it.each(['okay', 'haan', 'theek hai', 'good'])('G. "%s" → brief reply, no checklist', async (text) => {
    const u = h.user(`g-${text}`);
    await u.say('deposit nahi aaya');
    const r = await u.say(text);
    expect(r).not.toMatch(/statement|screenshot|registered|video/i);
    expect(r.length).toBeLessThan(20);
  });

  it('H. data already available is never asked again', async () => {
    const u = h.user('h');
    await u.say('deposit nahi aaya, mera number 9810822372');
    await u.pdf(buildPdf(HDFC_STATEMENT_WITH_CREDIT));
    const r = await u.say('abhi tak nahi aaya, check karo');
    expect(r).not.toMatch(/registered number|statement/i);
    expect(r).toMatch(/payment screenshot/i);
  });
});

/** One request, then silent collection: the bot must never run a checklist loop. */
describe('document collection: ask once, then collect silently', () => {
  const REQUESTS_AGAIN = /bhej dijiye|bhejo|please send/i;

  it('1+5. only the registration number arrives, then nothing → no reminders', async () => {
    const u = h.user('d1');
    expect(await u.say('deposit nahi aaya')).toBe(ONE_REQUEST);
    expect(await u.say('9810822372')).toBe('');
    expect(await u.say('haan')).toBe('');
    expect(await u.say('ok')).toBe('');
    expect(u.replies).toHaveLength(1); // the one request; no acks, no document reminders
  });

  it('2+3. screenshot and statement arrive later, in any order → silent until it can verify', async () => {
    const u = h.user('d2');
    await u.say('deposit nahi aaya');
    expect(await u.pdf(buildPdf(HDFC_STATEMENT_WITH_CREDIT))).toBe('');
    expect(await video(u, 'v-d2')).toBe('');
    expect(await u.photo('pay500')).toBe(''); // still no registered number → cannot verify yet
    const result = await u.say('9810822372');
    expect(result).toMatch(/successfully verify/);
    expect(u.replies.filter((r) => REQUESTS_AGAIN.test(r.text))).toHaveLength(1); // only the first request
  });

  it('6. "kya bhejna hai?" → lists exactly what is still outstanding, and does not count as a new ask', async () => {
    const u = h.user('d3');
    await u.say('deposit nahi aaya');
    await u.say('9810822372');
    await u.photo('pay500'); // verification runs here (number + screenshot are enough)
    const asksAgain = h.user('d4');
    await asksAgain.say('deposit nahi aaya');
    await asksAgain.photo('pay500');
    const r = await asksAgain.say('kya bhejna hai?');
    expect(r).toContain('registered number');
    expect(r).not.toContain('payment screenshot'); // already received
    const c = await h.caseOf('d4');
    expect(c?.facts.asks.registration_number).toBe(1); // the one-time request only
  });

  it('7. a wrong image gets a correction, not another checklist; any PDF is taken as the statement', async () => {
    const u = h.user('d5');
    await u.say('deposit nahi aaya');
    expect(await u.pdf(buildPdf(['Rent agreement between parties', 'Signed on the 1st day', 'Witness: someone']), 'agreement.pdf')).toBe('');
    expect((await h.caseOf(u.id))?.facts.statementEvidenceId).toBeDefined();
    const r = await u.photo('selfie');
    expect(r).toMatch(/related nahi|clear read nahi/);
    expect(r).not.toMatch(/registered number|screen recording/);
  });

  it('8. verification wins over the checklist: never asks for statement/video once it can verify', async () => {
    const u = h.user('d6');
    await u.say('deposit nahi aaya');
    await u.photo('pay500');
    const r = await u.say('9810822372');
    expect(r).toMatch(/successfully verify/);
    expect(r).not.toMatch(/statement|recording|video/i);
    expect(u.replies).toHaveLength(2);
  });

  it('withdrawal: one request, then silent until it can act', async () => {
    const u = h.user('d7');
    expect(await u.say('withdrawal nahi aaya')).toBe(`Sir, withdrawal check karne ke liye ye details bhej dijiye 🙏

🆔 Withdrawal ID ya withdrawal history ka screenshot
📄 Jis account me amount aana tha uska bank statement PDF`);
    expect(await u.say('dekh rahe ho?')).not.toMatch(/Withdrawal ID ya withdrawal history screenshot/); // no verbatim repeat
    const r = await u.say('WD-15436-64215');
    expect(r).toMatch(/successfully process/);
  });
});

/** Personalised memory: what a customer proved once is not asked again next time. */
describe('returning customer memory', () => {
  it('reuses the registration number from an earlier case, so the next request is shorter', async () => {
    const u = h.user('m1');
    await u.say('deposit nahi aaya');
    await u.photo('pay500');
    expect(await u.say('9810822372')).toMatch(/successfully verify/); // case 1 resolves, number proved

    const mem = (await h.store.users.get('m1'))!.memory;
    expect(mem.registrationNumbers[0]).toMatchObject({ value: '9810822372', verified: true });

    h.advance(60 * 24);
    const second = await u.say('ek aur deposit nahi aaya, ORD771002 wala');
    expect(second).not.toMatch(/registered number/); // remembered, not asked again
    expect(second).toMatch(/payment screenshot/i);
    expect((await h.caseOf('m1'))?.registrationNumber).toBe('9810822372');
    expect((await h.caseOf('m1'))?.facts.sources.registrationNumber?.source).toBe('memory');
  });

  it('a number the customer types this time wins over the remembered one', async () => {
    const u = h.user('m2');
    await u.say('deposit nahi aaya');
    await u.photo('pay500');
    await u.say('9810822372');
    h.advance(60);
    await u.say('deposit issue phir se, number dusra hai 9876543210');
    expect((await h.caseOf('m2'))?.registrationNumber).toBe('9876543210');
  });

  it('gives the support team the customer history, and /forget erases it', async () => {
    const u = h.user('m3');
    await u.say('deposit nahi aaya');
    await u.photo('pay500');
    await u.say('9810822372');
    h.advance(60);
    await u.say('WD-15436-64215 ka paisa nahi aaya, agent se baat karao');
    const ticketMsg = h.supportMessages[h.supportMessages.length - 1]!;
    expect(ticketMsg.text).toMatch(/Customer history: .*earlier case/);
    expect(ticketMsg.text).toMatch(/known registration number \(verified\)/);

    await h.app.relay.onSupportMessage({ chatId: '-100999', messageId: 9100, fromUserId: 'agent', text: '/forget', replyToMessageId: ticketMsg.messageId });
    expect((await h.store.users.get('m3'))!.memory).toEqual(emptyMemory());
    expect(u.last).not.toContain('/forget'); // internal command, never relayed to the customer
  });
});

/** Two issues from one customer stay separate; only personal preferences are shared. */
describe('per-user memory, per-case data', () => {
  it('keeps deposit and withdrawal data apart while sharing the customer\'s number and style', async () => {
    const u = h.user('s1');
    await u.say('bhai deposit nahi aaya');
    await u.photo('pay500');
    await u.say('bhai 9810822372'); // second "bhai" → they prefer it
    const deposit = (await h.casesOf('s1')).find((c) => c.type === 'deposit')!;
    expect(deposit.orderId).toBe('ORD771001');

    const wd = await u.say('bhai withdrawal WD-15436-64215 ka paisa bhi nahi aaya');
    expect(wd).toMatch(/bhai/i); // mirrors their form of address
    expect(wd).not.toMatch(/\bsir\b/i);

    const cases = await h.casesOf('s1');
    const withdrawal = cases.find((c) => c.type === 'withdrawal')!;
    expect(cases).toHaveLength(2);
    // No cross-contamination between the two cases.
    expect(withdrawal.orderId).toBeUndefined();
    expect(withdrawal.facts.deposit).toBeUndefined();
    expect(withdrawal.facts.paymentEvidenceId).toBeUndefined();
    expect(deposit.withdrawalId).toBeUndefined();
    expect(deposit.facts.payout).toBeUndefined();
    // Customer-level facts are shared: the number carries over without being asked again.
    expect(withdrawal.registrationNumber).toBe('9810822372');
    expect(withdrawal.facts.payout?.withdrawalId).toBe('WD-15436-64215');
    const mem = (await h.store.users.get('s1'))!.memory;
    expect(mem.recentCases.map((x) => x.type).sort()).toEqual(['deposit', 'withdrawal']);
    expect(mem.style.bhaiCount).toBeGreaterThanOrEqual(2);
  });
});

/** When the AI is not sure, it says nothing — the team picks the case up from the support group. */
describe('silence instead of guessing', () => {
  it('says nothing about escalation, forwarding or waiting when a case goes to humans', async () => {
    const u = h.user('q1');
    await u.say('WD-15436-64215 ka paisa nahi aaya');
    const before = u.replies.length;
    await u.say('mujhe kisi insaan se baat karni hai');
    expect(u.replies).toHaveLength(before);
    expect(h.supportMessages).toHaveLength(1); // the team still receives the full case
    expect(h.supportMessages[0]!.text).toMatch(/Customer asked for a human/);
  });

  it('stays silent on an unrelated question it has no approved answer for', async () => {
    const u = h.user('q2');
    expect(await u.say('sir aaj ka best captain kaun rahega?')).toBe('');
  });

  it('answers an unrelated question when the knowledge base covers it', async () => {
    const hk = new Harness({ caseReplies: 'conversational', fixtures: ADMIN_FIXTURES, knowledge: [{ id: 'l', keywords: ['lineup'], answer: 'Sir, lineup match se pehle app ke contest page par dikhta hai 👍' }] });
    expect(await hk.user('q3').say('sir lineup kab aayega?')).toMatch(/contest page/);
  });

  it('never answers with a "please wait" line after an admin outage', async () => {
    h.admin.failNext(5);
    const u = h.user('q4');
    const r = await u.say('withdrawal WD-15436-64215 status');
    expect(r).toMatch(/bank statement/i); // the one thing still needed, nothing about the outage
    expect(r).not.toMatch(/wait|team|manual/i);
    expect(h.supportMessages).toHaveLength(0);
  });
});

/**
 * When the interpreter cannot read a message, the agent says nothing at all — no guess, no nudge,
 * no "team will check". The open case is untouched and humans pick it up from the transcript.
 */
describe('silence when the message is not understood', () => {
  it.each(['asdkjh qwe', '????', 'aur bhi', 'zxcv', '...'])('"%s" → no reply', async (text) => {
    const u = h.user(`silent-${text}`);
    expect(await u.say('deposit nahi aaya')).toBe(ONE_REQUEST);
    const before = h.transport.sent.length;
    await u.say(text);
    expect(h.transport.sent).toHaveLength(before); // nothing sent, not even a reminder
  });

  it('still answers once the same customer says something readable', async () => {
    const u = h.user('silent-recovers');
    await u.say('deposit nahi aaya');
    await u.say('??????');
    expect(await u.say('kya bhejna hai?')).toMatch(/registered number/);
  });
});

/** Found by the live self-test against the real model (npm run test:live). */
describe('live self-test findings', () => {
  it('never repeats the statement request when the customer says the money did not arrive', async () => {
    const u = h.user('live-repeat');
    await u.say('withdrawal nahi aaya');
    expect(await u.say('WD-15436-64215')).toMatch(/bank statement PDF bhej dijiye/);
    expect(await u.say('bank me nahi aaya sir')).toBe('');
  });

  it('a frustrated first message is not told its details were already received', async () => {
    const r = await h.user('live-frustrated').say('kitni baar bolu withdrawal ka paisa nahi aaya');
    expect(r).toMatch(/Samajh sakta hoon/);
    expect(r).not.toMatch(/dobara bhejne|bhej chuke/);
  });
});

describe('live self-test findings (second run)', () => {
  it('a second "kaise ho" is answered, not met with the same greeting again', async () => {
    const u = h.user('greet-twice');
    expect(await u.say('hi')).toBe('Hello sir 👋 Kaise help karun?');
    expect(await u.say('kaise ho aap')).toBe('Main theek hoon sir, shukriya 😊 Bataiye, kya help chahiye?');
  });

  it('"ok thanks" does not switch a Hinglish chat to English, even when the model calls it English', async () => {
    const reading = (intent: string, language: string) => ({
      intent, case_type: null, relation: 'none', target_case_id: null, claims: { ...NO_CLAIMS }, reference: { kind: 'none', index: null },
      affirmation: 'none', language, gist: '', proposed: { registration_number: null, withdrawal_id: null, order_id: null, utr: null, amount: null },
      match_issue: { detected: false, category: null }, confidence: 0.9,
    });
    let next = reading('greeting', 'hinglish');
    const hl = new Harness({ caseReplies: 'conversational', fixtures: ADMIN_FIXTURES, llm: new ScriptedLlm().on('interpret', () => next) });
    const u = hl.user('lang-keep');
    expect(await u.say('hello ji kya haal hai')).toMatch(/Kaise help karun/);
    next = reading('thanks', 'english');
    expect(await u.say('ok thanks')).toBe('Welcome sir 😊');
  });

  it('"kya bhejna hai?" in a withdrawal lists everything still outstanding, statement included', async () => {
    const u = h.user('wd-what');
    await u.say('withdrawal ka issue hai');
    const r = await u.say('kya bhejna hai?');
    expect(r).toMatch(/Withdrawal ID/);
    expect(r).toMatch(/bank statement PDF/);
  });
});
