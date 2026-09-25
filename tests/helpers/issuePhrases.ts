/** Phrase tables for deposit-vs-withdrawal detection: Hinglish, Hindi, English, misspellings, fragments. */
export const DEPOSIT = [
  // the examples given
  'Paise add nahi hue', 'Deposit nahi hua', 'Payment kiya but balance nahi aaya', 'Wallet me amount nahi dikh raha',
  // Hinglish variants
  'maine 500 add kiye the abhi tak nahi aaye', 'paisa kat gaya par wallet me nahi aaya', 'payment successful dikha raha hai lekin balance same hai',
  'add money kiya tha 200 ka nahi hua', 'upi se paise bheje the app me nahi aaye', 'recharge nahi hua', 'deposit pending dikha raha hai',
  'mere account se 300 cut gaye wallet me nahi add hue', 'phonepe se pay kiya balance update nahi hua', 'paise dale the wallet me show nahi ho rahe',
  'gpay se 500 bheja tha balance nahi bada', 'payment kar diya hai add nahi hua', 'depsit nhi hua bhai', 'paisa add krne pr b nhi aaya',
  'wallet me paisa nahi aya payment ho gya', 'add cash nahi hua', 'transaction successful but wallet 0', 'amount add karne ke baad bhi balance nahi aaya',
  'balance me add nahi hua paisa', 'dipojit kiya tha nahi hua', 'paytm se payment kiya hai wallet me nahi dikh raha', 'add kiya 1000 abhi tak pending',
  'paise jama kiye the app me nahi aaye', 'qr scan karke pay kiya balance nahi badha', 'payment cut gaya add nahi hua', 'wallet balance zero dikha raha hai paise dale the',
  'wallet me paise add kiye nahi aaye', 'add money nahi ho raha', 'amount add nahi hua', 'app me 500 daale the nahi aaye', 'add kiye the 300 rupees abhi tak nahi aaye',
  // English, as customers actually type it
  'Payment cut my account 300 not available my wallet', 'Payment deducted but wallet not credited', 'Money cut from account but not added to wallet',
  'Amount deducted, balance not updated', 'Payment successful but wallet not showing money', 'payment gone from account but not in game',
  '300 debited from my account, wallet still same', 'my money is deducted but not added in my id', 'deducted 200 not credit in wallet', 'paid 500, wallet not updated',
  'I added 1000 but my wallet is still empty', 'money deducted from bank, not showing in app', 'deposit failed but money gone', 'amount debit ho gaya but not credited in wallet',
  'I paid through UPI but the balance did not update', 'my deposit is not reflecting', 'added money, wallet not updated',
  // Hindi
  'जमा किया पैसा नहीं आया', 'मैंने पैसे डाले वॉलेट में नहीं दिखे', 'पेमेंट हो गया बैलेंस नहीं बढ़ा', 'डिपॉज़िट नहीं हुआ', 'पैसे ऐड नहीं हुए',
];

export const WITHDRAWAL = [
  // the examples given
  'Withdrawal ka paisa nahi aaya', 'Mere paise account me nahi aaye', 'Withdraw kiya tha but receive nahi hua', 'Mere paise kaha gaye', 'Amount bank me credit nahi hua',
  // Hinglish variants
  'withdrawal pending hai 3 din se', 'winning amount bank me nahi aaya', 'paise nikale the abhi tak nahi mile', 'bank account me transfer nahi hua',
  'mera withdrawal reject ho gaya paise wapas nahi aaye', 'withdraw request kiya tha status success hai par bank me kuch nahi', 'kal withdraw kiya aaj tak nahi aaya',
  '2000 withdraw kiye account me nahi pahunche', 'mere jeete hue paise nahi mile', 'payout nahi aaya', 'paise kab aayenge withdrawal ke', 'widrawal nhi aaya',
  'vidraw kiya tha paisa nhi mila', 'mere paise abhi tak nahi aaye', 'amount received nahi hua bank me', 'paisa bank me nahi pahucha', 'withdrawl ho gaya but account me nahi',
  'redeem kiya tha nahi mila', 'cashout pending', 'paisa account me kab aayega', 'mere 700 rupay nahi aaye', 'withdrawal successful dikha raha hai bank me nahi aaya',
  'nikala tha paisa abhi tak nahi aaya', 'mere paise nahi aaye', 'jeeta hua paisa account me nahi aaya', 'withdrawal 2 din se processing me hai', 'paisa pending hai',
  // English
  'I withdrew 1500 yesterday, nothing in my bank yet', 'withdrawal successful but not received in bank', 'my winnings have not been credited to my account',
  'money not received in my bank account', 'payout is still pending', 'I have not got my withdrawal',
  // Hindi
  'विड्रॉल का पैसा नहीं आया', 'मेरे पैसे बैंक में नहीं आए', 'निकासी की थी अभी तक नहीं मिली', 'पैसे निकाले थे खाते में नहीं आए', 'विथड्रॉ किया था नहीं मिला',
];

export const MATCH = [
  'match cancel ho gaya points nahi mile', 'lineup galat hai', 'points kam mile', 'match under review hai', 'mere points update nahi hue',
  'player missing hai team se', 'result galat aaya', 'match abandon ho gaya paise wapas nahi aaye', 'contest ka winner galat declare hua',
  'rank galat dikha raha hai', 'match extend ho gaya kyu', 'points late aa rahe hain', 'मैच का रिजल्ट गलत है', 'पॉइंट कम मिले',
];

export const OTHER = [
  'hi', 'hello sir', 'good morning', 'thanks', 'ok', 'kya bhejna hai', 'otp nahi aaya', 'login nahi ho raha', 'app crash ho raha hai',
  'team edit nahi ho rahi', 'contest join nahi ho raha', 'kyc pending hai', 'mera account ban ho gaya', 'refund nahi aaya', 'bonus nahi mila',
  'referral bonus kab milega', 'password bhool gaya', 'app update nahi ho raha', 'human se baat karao', 'kuch bhi random 12345',
  // "add" with no money behind it is a request, not a payment (a customer asked for Kabaddi and got a deposit request)
  'Sir app mein Kabaddi to add karo', 'kabaddi add karo', 'app me cricket add karo', 'sir ye player add karo', 'contest add karo', 'add me in group', 'app me kabaddi kab aayega',
  // names a direction, reports no problem: a question or a request (a customer asking for a higher withdrawal limit got the withdrawal request)
  'Increase my withdrawal amount in app', 'withdrawal limit badhao', 'minimum withdrawal kitna hai', 'deposit kaise kare', 'how to withdraw money', 'maine withdrawal kiya',
  'withdrawal time kya hai', 'deposit bonus milega kya', 'deposit offer kya hai', 'withdrawal', 'deposit',
  // bank ACCOUNT problems, no money in the sentence (a customer who could not verify their bank account got the withdrawal request)
  'Unable to do bank account verification as it is showing bank account is already exist, but have not added my bank account',
  'bank account verification nahi ho raha', 'bank account add nahi ho raha', 'my bank account is not verified', 'bank details galat hai', 'kyc me bank account reject ho gaya',
];

/** Money is the topic, but neither side is named: with no context the agent must not guess. */
export const AMBIGUOUS = ['amount credit nahi hua', 'credit nahi hua', 'transaction failed'];
