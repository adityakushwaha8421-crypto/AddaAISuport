import type { IssueType } from '../nlu/issueType.js';

export type Language = 'hinglish' | 'english' | 'hindi';

const pick = (lang: Language, hinglish: string, english: string, hindi: string) => (lang === 'english' ? english : lang === 'hindi' ? hindi : hinglish);

/** The one evidence request per case: everything the team needs, asked once, one item per line. */
export function requestText(type: IssueType, lang: Language): string {
  if (type === 'deposit') {
    return [
      pick(lang, 'Sir, deposit check karne ke liye please ye details bhej dijiye 🙏', 'Sir, to check the deposit please send these details 🙏', 'सर, डिपॉज़िट चेक करने के लिए कृपया ये डिटेल्स भेज दीजिए 🙏'),
      '',
      '📱 ' + pick(lang, 'Registered Number', 'Registered Number', 'रजिस्टर्ड नंबर'),
      pick(lang, 'Apna 10-digit registered number bhej dijiye.', 'Please send your 10-digit registered number.', 'अपना 10 अंकों का रजिस्टर्ड नंबर भेज दीजिए।'),
      '',
      '🖼️ ' + pick(lang, 'Payment Screenshot', 'Payment Screenshot', 'पेमेंट स्क्रीनशॉट'),
      pick(lang, 'Payment ka clear screenshot bhej dijiye.', 'Please send a clear screenshot of the payment.', 'पेमेंट का साफ़ स्क्रीनशॉट भेज दीजिए।'),
      '',
      '📄 ' + pick(lang, 'Bank Statement', 'Bank Statement', 'बैंक स्टेटमेंट'),
      pick(lang, 'Jis bank account se payment kiya hai, uska Bank Statement PDF bhej dijiye.', 'Please send the bank statement PDF of the account you paid from.', 'जिस बैंक अकाउंट से पेमेंट किया है, उसका बैंक स्टेटमेंट PDF भेज दीजिए।'),
      '',
      '🎥 ' + pick(lang, 'Payment Screen Recording', 'Payment Screen Recording', 'पेमेंट स्क्रीन रिकॉर्डिंग'),
      pick(lang, 'Payment karte waqt ki screen recording/video bhej dijiye.', 'Please send the screen recording/video taken while making the payment.', 'पेमेंट करते समय की स्क्रीन रिकॉर्डिंग/वीडियो भेज दीजिए।'),
    ].join('\n');
  }
  // A withdrawal is checked in steps: first which withdrawal, and what it shows (see the workflow).
  return [
    pick(lang, 'Sir, withdrawal check karne ke liye please ye detail bhej dijiye 🙏', 'Sir, to check the withdrawal please send this 🙏', 'सर, विड्रॉल चेक करने के लिए कृपया ये डिटेल भेज दीजिए 🙏'),
    '',
    '🧾 ' + pick(lang, 'Withdrawal ID', 'Withdrawal ID', 'विड्रॉल ID'),
    pick(lang, 'Apni Withdrawal ID ya withdrawal history ka screenshot bhej dijiye.', 'Please send your Withdrawal ID or a screenshot of your withdrawal history.', 'अपनी विड्रॉल ID या विड्रॉल हिस्ट्री का स्क्रीनशॉट भेज दीजिए।'),
  ].join('\n');
}

/** The withdrawal shows as Pending: it is on its way; nothing more is needed from the customer. */
export function withdrawalPendingText(lang: Language): string {
  return [
    pick(lang, 'Hello 👋', 'Hello 👋', 'नमस्ते 👋'),
    '',
    pick(
      lang,
      'Withdrawal request lagane ke baad amount usually 12–24 hours ke andar aapke bank account me credit ho jata hai.',
      'After placing a withdrawal request, the amount is usually credited to your bank account within 12–24 hours.',
      'विड्रॉल रिक्वेस्ट लगाने के बाद अमाउंट आमतौर पर 12–24 घंटे के अंदर आपके बैंक अकाउंट में क्रेडिट हो जाता है।',
    ),
    '',
    pick(lang, 'Hamare saath khelne aur aapke patience ke liye thank you.', 'Thank you for playing with us and for your patience.', 'हमारे साथ खेलने और आपके धैर्य के लिए धन्यवाद।'),
  ].join('\n');
}

/** The withdrawal shows as Success but the customer has not received it: now the bank statement is needed. */
export function statementRequestText(lang: Language): string {
  return [
    pick(lang, 'Sir, aapka withdrawal successful dikh raha hai. Check karne ke liye please ye bhej dijiye 🙏', 'Sir, your withdrawal shows as successful. To check it please send this 🙏', 'सर, आपका विड्रॉल सक्सेसफुल दिख रहा है। चेक करने के लिए कृपया ये भेज दीजिए 🙏'),
    '',
    '📄 ' + pick(lang, 'Bank Statement', 'Bank Statement', 'बैंक स्टेटमेंट'),
    pick(lang, 'Jis bank account me amount aana tha, uska Bank Statement PDF bhej dijiye.', 'Please send the bank statement PDF of the account the amount should have reached.', 'जिस बैंक अकाउंट में अमाउंट आना था, उसका बैंक स्टेटमेंट PDF भेज दीजिए।'),
  ].join('\n');
}

/** Answered ONLY to a greeting that opens a fresh conversation with no case in it (see the workflow). */
export function greetingText(lang: Language): string {
  return pick(
    lang,
    'Namaste sir 🙏 Fantasy Adda support me aapka swagat hai. Apni problem detail me bataiye, hum check karte hain.',
    'Hello sir 🙏 Welcome to Fantasy Adda support. Please describe your problem in detail and we will check it.',
    'नमस्ते सर 🙏 फैंटेसी अड्डा सपोर्ट में आपका स्वागत है। अपनी समस्या विस्तार से बताइए, हम चेक करते हैं।',
  );
}

export interface SolvedDetails {
  /** The customer's Telegram display name; "Sir" when unknown. */
  name?: string;
  /** The confirmed amount as the export bot printed it, e.g. "₹2,999.01". */
  amount?: string;
}

/**
 * After the export bot's PAYMENT CONFIRMED: the solved note, with the customer's name and the
 * confirmed amount. A confirmed payment is money the customer paid in — always a deposit note.
 */
export function solvedText(lang: Language, d: SolvedDetails): string {
  const name = d.name?.trim() || pick(lang, 'Sir', 'Sir', 'सर');
  const body = d.amount
    ? pick(
        lang,
        `Aapka deposit issue successfully resolve ho gaya hai. Aapka amount ${d.amount} successfully credit/confirm ho gaya hai. 💰✅`,
        `Your deposit issue has been successfully resolved. Your amount of ${d.amount} has been credited/confirmed successfully. 💰✅`,
        `आपका डिपॉज़िट इश्यू सफलतापूर्वक सॉल्व हो गया है। आपका अमाउंट ${d.amount} सफलतापूर्वक क्रेडिट/कन्फर्म हो गया है। 💰✅`,
      )
    : pick(
        lang,
        'Aapka deposit issue successfully resolve ho gaya hai aur payment confirm ho gaya hai. 💰✅',
        'Your deposit issue has been successfully resolved and the payment has been confirmed. 💰✅',
        'आपका डिपॉज़िट इश्यू सफलतापूर्वक सॉल्व हो गया है और पेमेंट कन्फर्म हो गया है। 💰✅',
      );
  return [
    `🎉 ${pick(lang, 'Deposit Issue Resolved!', 'Deposit Issue Resolved!', 'डिपॉज़िट इश्यू सॉल्व हो गया!')}`,
    '',
    pick(lang, `Hello ${name} 👋`, `Hello ${name} 👋`, `नमस्ते ${name} 👋`),
    '',
    body,
    '',
    pick(lang, 'Aapke patience ke liye thank you, Sir. 🙏', 'Thank you for your patience, Sir. 🙏', 'आपके धैर्य के लिए धन्यवाद, सर। 🙏'),
    pick(lang, 'Sorry for the inconvenience. 💙', 'Sorry for the inconvenience. 💙', 'असुविधा के लिए माफ़ी। 💙'),
  ].join('\n');
}

/**
 * After the export bot's WITHDRAWAL REVERSED: the withdrawal case is solved and the amount is back
 * in the customer's wallet.
 */
export function refundedText(lang: Language, d: SolvedDetails): string {
  const name = d.name?.trim() || pick(lang, 'Sir', 'Sir', 'सर');
  const body = d.amount
    ? pick(
        lang,
        `Aapka withdrawal issue successfully resolve ho gaya hai. Aapka amount ${d.amount} successfully aapke wallet me refund ho gaya hai. 💰✅`,
        `Your withdrawal issue has been successfully resolved. Your amount of ${d.amount} has been refunded to your wallet successfully. 💰✅`,
        `आपका विड्रॉल इश्यू सफलतापूर्वक सॉल्व हो गया है। आपका अमाउंट ${d.amount} सफलतापूर्वक आपके वॉलेट में रिफंड हो गया है। 💰✅`,
      )
    : pick(
        lang,
        'Aapka withdrawal issue successfully resolve ho gaya hai aur amount aapke wallet me refund ho gaya hai. 💰✅',
        'Your withdrawal issue has been successfully resolved and the amount has been refunded to your wallet. 💰✅',
        'आपका विड्रॉल इश्यू सफलतापूर्वक सॉल्व हो गया है और अमाउंट आपके वॉलेट में रिफंड हो गया है। 💰✅',
      );
  return [
    `🎉 ${pick(lang, 'Withdrawal Issue Resolved!', 'Withdrawal Issue Resolved!', 'विड्रॉल इश्यू सॉल्व हो गया!')}`,
    '',
    pick(lang, `Hello ${name} 👋`, `Hello ${name} 👋`, `नमस्ते ${name} 👋`),
    '',
    body,
    '',
    pick(lang, 'Aapke patience ke liye thank you, Sir. 🙏', 'Thank you for your patience, Sir. 🙏', 'आपके धैर्य के लिए धन्यवाद, सर। 🙏'),
    pick(lang, 'Sorry for the inconvenience. 💙', 'Sorry for the inconvenience. 💙', 'असुविधा के लिए माफ़ी। 💙'),
  ].join('\n');
}
