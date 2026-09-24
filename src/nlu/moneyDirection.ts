/**
 * Deposit or withdrawal, read from the DIRECTION the money was meant to move rather than from the
 * words "deposit"/"withdrawal":
 *
 *   deposit    — the customer pushed money INTO the app wallet (paid, added, recharged, "daale")
 *                and the wallet/balance does not show it;
 *   withdrawal — money LEFT the wallet (withdrew, "nikale", payout, winnings) and never REACHED
 *                the bank account.
 *
 * Cues cover Hinglish, Hindi (Devanagari) and English with their common misspellings, and are
 * weighted: a named direction (2) outweighs a generic "money didn't come" (1), which on its own
 * describes money the customer was waiting to receive, i.e. a payout. Cues that fit both sides
 * ("credit nahi hua", "amount reflect nahi hua") score nothing, so the caller asks instead of
 * guessing. Input is the lexical form (lower-case, punctuation stripped).
 */

export interface MoneyDirection {
  deposit: number;
  withdrawal: number;
  /** Which side wins by a clear margin, if any. */
  type?: 'deposit' | 'withdrawal';
  /** A cue that names the direction outright (not just "money didn't come"). */
  named: boolean;
  /** Money is the topic, even when no direction can be read. */
  moneyTopic: boolean;
}

// `\b` only knows ASCII letters; Hindi needs a boundary that understands any script.
const UB = String.raw`(?:(?<![\p{L}\p{M}\p{N}_])(?=[\p{L}\p{M}\p{N}_])|(?<=[\p{L}\p{M}\p{N}_])(?![\p{L}\p{M}\p{N}_]))`;
const rx = (src: string) => new RegExp(src.replaceAll(String.raw`\b`, UB), 'u');
/** Up to n words in between, then the space before the next token. */
const W = (n: number) => String.raw`(?:\s+\S+){0,${n}}?\s+`;

// ── Building blocks (alternations, no capture) ─────────────────────────────
const NOT = String.raw`(?:nahi+|nhi+|nahin|nai|ni|na|nt|not|never|nothing|didn'?t|didnt|hasn'?t|hasnt|haven'?t|havent|isn'?t|isnt|नहीं|नही|ना)`;
const MONEY = String.raw`(?:paisa|paise|paisey|paiso|pesa|pese|pesey|paysa|payse|rupay|rupaye|rupee|rupees|rs|money|amount|amt|cash|rakam|rakkam|राशि|रुपए|रुपये|पैसे|पैसा)`;
/** Money reaching the customer. "credit"/"reflect" are deliberately absent: they fit both sides. */
const ARRIVE = String.raw`(?:aaya|aya|aayaa|aaye|aye|aayi|ayi|aai|ayee|aa\s*rha|aa\s*raha|pahuncha|pohcha|pahunche|pohche|pahucha|mila|mile|mili|milaa|receive|received|recieve|recieved|recived|reached|got|आया|आये|आए|आई|मिला|मिले|मिली|पहुंचा|पहुँचा)`;
const WALLET = String.raw`(?:wallet|walet|vallet|wallat|balance|balence|balanc|वॉलेट|वालेट|बैलेंस)`;
const APP = String.raw`(?:app|application|game|id|adda|fantasy|wallet|walet|ऐप|एप|वॉलेट)`;
const BANK = String.raw`(?:bank|bnk|baink|khata|khate|khaate|khatey|a\/c|acc|acct|बैंक|खाते|खाता)`;
/** "bank se" / "from my bank": the bank is where the money LEFT, not where it should arrive. */
const BANK_AS_DESTINATION = String.raw`(?<!from\s)(?<!from\s(?:my|the|our)\s)${BANK}(?!\s+(?:se|से)\b)`;

const DEPOSIT_WORD = rx(String.raw`\b(?:deposit\w*|deposite|dipojit|dipozit|depost|depsit|dposit|depozit|jama|जमा|डिपॉजिट|डिपॉज़िट|डिपोजिट)\b`);
const WITHDRAW_WORD = rx(String.raw`\b(?:withdr\w*|widraw\w*|vidraw\w*|vithdraw\w*|withdrow\w*|withdrwal|wthdraw\w*|witdraw\w*|wihdraw\w*|nikaas\w*|nikas\w*|nikal\w*|nikaal\w*|payout\w*|redeem\w*|cash\s*out|cashout|निकासी|निकाल\S*|निकले|निकाले|विड्रॉ\S*|विथड्रॉ\S*|पेआउट)`);

// ── Deposit: money went towards the app and the wallet does not show it ───
const DEPOSIT_CUES: Array<[RegExp, number]> = [
  [DEPOSIT_WORD, 2],
  // add money / add nahi hua / add kiya / नहीं जुड़ा
  [rx(String.raw`\b(?:add|ad|aad|added|adding)\s+(?:money|cash|amount|balance|fund\w*|kiya|kia|kiye|kari|kar\w*|kr\w*|krne|hua|hue|ho|hi|diya|diye|${NOT})\b`), 2],
  [rx(String.raw`\b${NOT}\s+(?:add|ad|aad|added|jud\w*|जुड़\S*)\b|\bजुड़े\s+नहीं|\bनहीं\s+जुड़|\b(?:ऐड|एड|ऐडेड)\s+(?:नहीं|नही|ना)|\b(?:ऐड|एड)\s+(?:किया|किए|कर)`), 2],
  // paise daale (money put in — "details daal diye" is typing, not paying), recharge
  [rx(String.raw`\b(?:${MONEY}|\d+(?:\s*(?:ka|ke|rs|rupay|rupaye))?)${W(2)}(?:dala|daala|dale|daale|dali|daali|daal|dal|dalay|डाला|डाले|डाली)\b|\b(?:dala|daala|dale|daale|dali|daali|daal|dal|dalay|डाला|डाले|डाली)${W(2)}(?:${MONEY}|\d+)\b`), 2],
  [rx(String.raw`\brecharge\w*|\bरिचार्ज`), 2],
  // payment made / went through / deducted — money left the customer's side towards the app
  [rx(String.raw`\b(?:payment|paymnt|paymet|pymt|pement|paymen|paymnet|pay)\s+(?:kiya|kia|kar\s+(?:diya|dia|di|liya)|ho\s+(?:gaya|gya|gyi|gayi|gai)|hua|huwa|hui|done|complete\w*|success\w*|sucess\w*|succesful|(?:went\s+)?through|cut|deduct\w*|kat\w*|gaya|gya)\b`), 2],
  [rx(String.raw`\b(?:paid|payed|pay\s+kar\s+diya)\b|\bपेमेंट\s+(?:किया|कर|हो)`), 2],
  [rx(String.raw`\b(?:upi|gpay|g\s*pay|google\s*pay|phonepe|phone\s*pe|paytm|bhim|net\s*banking|netbanking|qr|scan\s+(?:kar|kiya|karke))\b|\bयूपीआई|\bफोनपे|\bपेटीएम`), 1],
  // wallet / balance not showing, empty (but not "wallet se …" — money leaving the wallet)
  [rx(String.raw`\b${WALLET}(?!\s+(?:se|से)\b)${W(4)}(?:${NOT}|empty|khali|khaali|zero|0|same)\b`), 2],
  [rx(String.raw`\b${NOT}(?:\s+(?:show|dikh\w*|update\w*|badh\w*|reflect\w*|credit\w*|added?))?${W(2)}${WALLET}\b`), 1.5],
  [rx(String.raw`\b${WALLET}(?:\s+(?:me|mein|m|par|pe|mai|में))?\s+(?:show|dikh\w*|update\w*|badh\w*|add|reflect\w*)\s+${NOT}\b`), 2],
  // debited/deducted from the customer's bank (money moved towards the app)
  [rx(String.raw`\b(?:deduct\w*|debit\w*|kat\s+(?:gaya|gya|gaye|gye|liya|liye|gayi|gyi)|kata|kate|kati|cut\s+(?:ho|hua|gaya|ho\s+gaya|hogaya))\b|\bकट\s+(?:गया|गए|गये)|\bकाट\s+लिया`), 1],
  [rx(String.raw`\b${BANK}\s+(?:se|से)${W(4)}(?:kat\w*|cut|deduct\w*|debit\w*|gaya|gaye|gye|chale|nikal\w*|कट|गए|गये)`), 2],
  // money sent/transferred to the app
  [rx(String.raw`\b(?:transfer\w*|bheja|bheje|bhej\s+diya|send|sent|ट्रांसफर|भेजा|भेजे)${W(4)}${APP}\b`), 2],
  [rx(String.raw`\b${APP}\s+(?:me|mein|m|par|pe|ko|mai|में)${W(2)}(?:transfer\w*|bheja|bheje|daal\w*|dal\w*|add|dala|ट्रांसफर|डाल\S*|भेज\S*)`), 2],
];

// ── Withdrawal: money left the wallet and has not reached the bank ────────
const WITHDRAWAL_CUES: Array<[RegExp, number]> = [
  [WITHDRAW_WORD, 2],
  [rx(String.raw`\b(?:winning|winnings|wining|jeeta|jeete|jeeti|jeet\s+(?:ka|ki|ke|hua)|prize\s+money|जीत\S*|विनिंग)\b`), 1.5],
  // bank / account: nothing arrived, no transfer (but not "bank se …" — money leaving the bank)
  [rx(String.raw`\b${BANK_AS_DESTINATION}${W(5)}${NOT}\b`), 2],
  [rx(String.raw`\b${NOT}${W(3)}${BANK_AS_DESTINATION}\b`), 2],
  [rx(String.raw`\b(?:account|acount|acc|khate|khata|खाते)\s+(?:me|mein|m|par|pe|mai|में)(?:\s+(?!add\b|ad\b|jama\b)\S+){0,2}?\s+${NOT}\s+(?:${ARRIVE}|transfer\w*|hue|hua|huye|pahuch\w*|ट्रांसफर|हुए|हुआ)`), 1.5],
  [rx(String.raw`\b(?:transfer\w*|ट्रांसफर)\s+(?:hi\s+)?${NOT}\b|\b${NOT}\s+(?:transfer\w*|ट्रांसफर)`), 2],
  // money left the wallet
  [rx(String.raw`\b${WALLET}\s+(?:se|से)${W(5)}(?:gaye|gaya|gye|chale|chala|kat\w*|cut|deduct\w*|minus|kam|nikal\w*|gayi|gai|गए|गये|कट)`), 2],
];

/** Generic "money I was waiting for has not come": one fact however it is phrased, so the strongest cue counts once. */
const WITHDRAWAL_GENERIC: Array<[RegExp, number]> = [
  [rx(String.raw`\b${MONEY}${W(4)}${NOT}(?:\s+\S+)?\s+${ARRIVE}\b`), 1],
  [rx(String.raw`\b${MONEY}${W(4)}${ARRIVE}\s+(?:hi\s+)?${NOT}\b`), 1],
  [rx(String.raw`\b${NOT}(?:\s+(?:yet|abhi\s+tak|तक))?\s+${ARRIVE}\b(?!\s+${WALLET})`), 0.5],
  [rx(String.raw`\b(?:not\s+(?:yet\s+)?(?:received|recieved|reached|got)|(?:haven'?t|havent|didn'?t|didnt|did\s+not|have\s+not|still\s+not)\s+(?:got|received|recieved|reached))\b`), 1],
  [rx(String.raw`\b${MONEY}${W(3)}(?:kaha|kahan|kahaan|kidhar|कहाँ|कहां)\s+(?:gaye|gaya|gya|gye|gayi|hai|h|गए|गया|है)\b|\b(?:kaha|kahan|kahaan|kidhar)\s+(?:gaye|gaya|gya|gye)${W(3)}${MONEY}\b`), 1],
  [rx(String.raw`\b${MONEY}${W(3)}(?:pending|pendng|processing|atka|atke|ruka|ruke|stuck|hold|पेंडिंग|अटका|रुका)\b`), 1],
  [rx(String.raw`\b(?:kab|kabtak|कब)(?:\s+tak)?\s+(?:aayega|ayega|aega|aaega|milega|aayenge|milenge|आएगा|मिलेगा|आएंगे)\b`), 1],
];

/** Money is what the message is about, even when no direction can be read. */
const MONEY_TOPIC = rx(String.raw`\b(?:${MONEY}|payment|paymnt|balance|balence|credit\w*|refund\w*|bonus|cashback|transaction|txn|wallet|walet|पेमेंट|बैलेंस|क्रेडिट|रिफंड|बोनस)\b`);
/** Money that moves through the wallet — a refund, bonus or cashback "not received" points nowhere in particular. */
const MOVING_MONEY = rx(String.raw`\b(?:${MONEY}|payment|paymnt|balance|balence|wallet|walet|winning\w*|पेमेंट|बैलेंस|वॉलेट)\b`);

const sum = (cues: Array<[RegExp, number]>, t: string) => cues.reduce((n, [r, w]) => n + (r.test(t) ? w : 0), 0);
const max = (cues: Array<[RegExp, number]>, t: string) => cues.reduce((n, [r, w]) => (r.test(t) ? Math.max(n, w) : n), 0);
const hasNamed = (cues: Array<[RegExp, number]>, t: string) => cues.some(([r, w]) => w >= 1.5 && r.test(t));

/** Score both directions on the lexical form of the message and pick a side when one clearly wins. */
export function moneyDirection(t: string): MoneyDirection {
  const deposit = sum(DEPOSIT_CUES, t);
  // "nahi aaya" / "kab aayega" only speak of money when money is what the message is about
  // (not an OTP, not a lineup).
  const withdrawal = sum(WITHDRAWAL_CUES, t) + (MOVING_MONEY.test(t) ? max(WITHDRAWAL_GENERIC, t) : 0);
  const best = Math.max(deposit, withdrawal);
  const margin = Math.abs(deposit - withdrawal);
  const type = best > 0 && margin >= 1 ? (deposit > withdrawal ? 'deposit' : 'withdrawal') : undefined;
  const named = type === 'deposit' ? hasNamed(DEPOSIT_CUES, t) : type === 'withdrawal' ? hasNamed(WITHDRAWAL_CUES, t) : false;
  return { deposit, withdrawal, type, named, moneyTopic: best > 0 || MONEY_TOPIC.test(t) };
}
