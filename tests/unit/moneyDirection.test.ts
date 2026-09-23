import { describe, expect, it } from 'vitest';
import { moneyDirection } from '../../src/nlu/moneyDirection.js';
import { lexicalForm } from '../../src/nlu/normalize.js';

/**
 * Deposit vs withdrawal from natural phrasing: Hinglish, Hindi, English, misspellings, fragments.
 * The scorer reads which way the money was meant to move; it never needs the words
 * "deposit"/"withdrawal".
 */
const DEPOSIT = [
  'Paise add nahi hue', 'Maine payment kar diya but balance nahi aaya', 'Wallet me amount show nahi ho raha', 'Mera deposit nahi hua',
  'Paise account me add nahi hue', 'Money deducted but balance nahi aaya', 'Amount add kiya balance nahi badha',
  'Payment successful hai but wallet empty hai', 'Sir paise daale the, abhi tak nahi aaye', '500 ka recharge kiya tha add nahi hua',
  'upi se payment kiya wallet me nahi dikha', 'bank se paise kat gaye app me nahi aaye', 'gpay se bheja wallet update nahi hua',
  'phonepe se 200 daale the balance same hai', 'payment ho gaya balance same hai', 'app me 200 transfer kiye abhi tak nahi aaye',
  'amount add karne ke baad bhi balance nahi badha', 'deposite nhi hua', 'pese add ni hue', 'jama kiya paisa nahi dikha',
  'paymnt kiya tha wallet m nhi aya', 'add money kiya tha 1000 ka, wallet me 0 dikha raha hai',
  // English
  'I added money but my balance did not update', 'my payment went through but nothing in wallet',
  'money debited from my bank but not credited to wallet', 'paid 1000, wallet still empty', 'deposit of 500 not showing',
  // Hindi
  'पैसे जमा किए पर बैलेंस नहीं बढ़ा', 'वॉलेट में पैसे नहीं आए', 'पेमेंट कर दिया पर बैलेंस नहीं आया', 'पैसे डाले थे अभी तक नहीं आए',
];

const WITHDRAWAL = [
  'Mere paise nahi aaye', 'Mere paise kaha gaye?', 'Withdraw kiya tha but amount receive nahi hua',
  'Wallet se paise chale gaye but account me nahi aaye', 'Withdrawal ka paisa nahi mila', 'Money abhi tak receive nahi hua',
  'Bank me payment nahi aayi', 'Mera withdrawal pending hai', 'Paise account me transfer nahi hue', 'withdrawl nhi aya',
  'widrawal pending h', 'paise nikale the bank mein nahi aaye', 'winning amount nahi mila', 'payout abhi tak nahi aaya',
  'bank account me paise nahi aaye', 'redeem kiya tha paisa nahi aaya', 'amount bank me transfer nahi hua',
  'mera paisa kab aayega, pending dikha raha hai', '2000 nikala tha abhi tak account me nahi aaya', 'paisa nahi aaya',
  'withdrow kiya 3 din ho gaye', 'vidrawal ka amount abhi tak nahi mila',
  // English
  'I withdrew money but it has not reached my bank', "haven't received my winnings yet", 'cash out not received',
  'my withdrawal is stuck in processing', 'money not credited to my bank account',
  // Hindi
  'पैसे निकाले थे बैंक में नहीं आए', 'मेरी निकासी नहीं आई', 'विड्रॉल पेंडिंग है', 'खाते में पैसे नहीं आए',
];

/** Fits both sides: the caller asks one question instead of guessing. */
const AMBIGUOUS = ['Amount credit nahi hua', 'paise ka issue hai', 'payment problem', 'credit nahi hua abhi tak', 'amount reflect nahi hua'];

/** No money in it at all: both sides must stay at zero, whatever the negations. */
const UNRELATED = ['KYC verify nahi ho raha', 'app crash ho raha hai', 'app open nahi ho raha', 'login nahi ho raha', 'otp nahi aaya',
  'contest join nahi ho raha', 'hi', 'ok', 'thank you', 'kya bhejna hai', 'lineup de do', 'password reset karna hai'];

describe('moneyDirection', () => {
  it.each(DEPOSIT)('deposit: %s', (text) => {
    const r = moneyDirection(lexicalForm(text));
    expect(r.type, `d=${r.deposit} w=${r.withdrawal}`).toBe('deposit');
  });

  it.each(WITHDRAWAL)('withdrawal: %s', (text) => {
    const r = moneyDirection(lexicalForm(text));
    expect(r.type, `d=${r.deposit} w=${r.withdrawal}`).toBe('withdrawal');
  });

  it.each(AMBIGUOUS)('ambiguous, money topic: %s', (text) => {
    const r = moneyDirection(lexicalForm(text));
    expect(r.type, `d=${r.deposit} w=${r.withdrawal}`).toBeUndefined();
    expect(r.moneyTopic).toBe(true);
  });

  it.each(UNRELATED)('not about money: %s', (text) => {
    const r = moneyDirection(lexicalForm(text));
    expect([r.deposit, r.withdrawal]).toEqual([0, 0]);
  });

  it('a named direction is told apart from a generic "money did not come"', () => {
    expect(moneyDirection(lexicalForm('withdrawal nahi aaya')).named).toBe(true);
    expect(moneyDirection(lexicalForm('mere paise nahi aaye')).named).toBe(false);
  });
});
