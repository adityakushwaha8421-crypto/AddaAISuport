import { beforeEach, describe, expect, it } from 'vitest';
import { DisabledAdminGateway } from '../../src/admin/fixture.js';
import { Harness } from '../helpers/harness.js';

/**
 * Natural-language openers, end to end: the right workflow starts from how customers actually
 * write, the request for evidence goes out once, and small talk while waiting gets no reply.
 */
// The one-time requests, in whichever of the three languages the customer wrote.
const DEPOSIT_REQUEST = /(deposit check karne ke liye|to check the deposit|डिपॉज़िट चेक करने के लिए)[\s\S]*(registered number|रजिस्टर्ड नंबर)[\s\S]*(statement|स्टेटमेंट)[\s\S]*(recording|रिकॉर्डिंग)/i;
const WITHDRAWAL_REQUEST = /(withdrawal check karne ke liye|to check the withdrawal|विड्रॉल चेक करने के लिए)[\s\S]*(Withdrawal ID|विड्रॉल ID)[\s\S]*(bank statement PDF|बैंक स्टेटमेंट PDF)/i;
const CLARIFY = /Deposit ka issue hai ya withdrawal ka/;

const DEPOSIT = [
  'Paise add nahi hue', 'Maine payment kar diya but balance nahi aaya', 'Wallet me amount show nahi ho raha', 'Mera deposit nahi hua',
  'Paise account me add nahi hue', 'Money deducted but balance nahi aaya', 'Payment successful hai but wallet empty hai',
  'Sir paise daale the, abhi tak nahi aaye', 'deposite nhi hua sir', 'upi se 500 bheje wallet me nahi aaye',
  'I added money but my balance did not update', 'पैसे जमा किए पर बैलेंस नहीं बढ़ा',
];
const WITHDRAWAL = [
  'Mere paise nahi aaye', 'Mere paise kaha gaye?', 'Withdraw kiya tha but amount receive nahi hua',
  'Wallet se paise chale gaye but account me nahi aaye', 'Withdrawal ka paisa nahi mila', 'Money abhi tak receive nahi hua',
  'Bank me payment nahi aayi', 'Mera withdrawal pending hai', 'Paise account me transfer nahi hue', 'withdrawl nhi aya',
  'I withdrew money but it has not reached my bank', 'पैसे निकाले थे बैंक में नहीं आए',
];
const AMBIGUOUS = ['Amount credit nahi hua', 'payment problem hai', 'paise ka issue hai sir'];

let h: Harness;
beforeEach(() => {
  h = new Harness({ adminGateway: new DisabledAdminGateway() });
});

describe('deposit openers start the deposit workflow with its one-time request', () => {
  it.each(DEPOSIT)('%s', async (text) => {
    const u = h.user(`d-${text.length}-${text.charCodeAt(0)}-${text.charCodeAt(5) || 0}`);
    const r = await u.say(text);
    expect(r).toMatch(DEPOSIT_REQUEST);
    expect(r).not.toMatch(/Withdrawal ID|विड्रॉल ID/);
    const cases = await h.casesOf(u.id);
    expect(cases.map((c) => c.type)).toEqual(['deposit']);
    // Waiting: greetings and acks get nothing, and the request is not repeated.
    expect(await u.say('hello')).toBe('');
    expect(await u.say('ok')).toBe('');
    expect((await h.caseOf(u.id))?.facts.asks.registration_number).toBe(1);
  });
});

describe('withdrawal openers start the withdrawal workflow with its two-item request', () => {
  it.each(WITHDRAWAL)('%s', async (text) => {
    const u = h.user(`w-${text.length}-${text.charCodeAt(0)}-${text.charCodeAt(5) || 0}`);
    const r = await u.say(text);
    expect(r).toMatch(WITHDRAWAL_REQUEST);
    expect(r).not.toMatch(/registered number|payment screenshot|recording|रजिस्टर्ड|रिकॉर्डिंग/i); // never unnecessary evidence
    const cases = await h.casesOf(u.id);
    expect(cases.map((c) => c.type)).toEqual(['withdrawal']);
    expect(await u.say('hi')).toBe('');
    expect(await u.say('theek hai')).toBe('');
    expect((await h.caseOf(u.id))?.facts.asks.withdrawal_ref).toBe(1);
  });
});

describe('a money problem with no readable direction gets one short question', () => {
  it.each(AMBIGUOUS)('%s', async (text) => {
    const u = h.user(`a-${text.length}`);
    expect(await u.say(text)).toMatch(CLARIFY);
    expect(await u.say('withdrawal ka')).toMatch(WITHDRAWAL_REQUEST);
    const cases = await h.casesOf(u.id);
    expect(cases.map((c) => c.type)).toEqual(['withdrawal']);
  });

  it('answering "deposit" starts the deposit request', async () => {
    const u = h.user('a-dep');
    expect(await u.say('amount credit nahi hua')).toMatch(CLARIFY);
    expect(await u.say('deposit wala')).toMatch(DEPOSIT_REQUEST);
  });
});
