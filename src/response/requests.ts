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
  return [
    pick(lang, 'Sir, withdrawal check karne ke liye please ye details bhej dijiye 🙏', 'Sir, to check the withdrawal please send these details 🙏', 'सर, विड्रॉल चेक करने के लिए कृपया ये डिटेल्स भेज दीजिए 🙏'),
    '',
    '🧾 ' + pick(lang, 'Withdrawal ID', 'Withdrawal ID', 'विड्रॉल ID'),
    pick(lang, 'Apni Withdrawal ID ya withdrawal history ka screenshot bhej dijiye.', 'Please send your Withdrawal ID or a screenshot of your withdrawal history.', 'अपनी विड्रॉल ID या विड्रॉल हिस्ट्री का स्क्रीनशॉट भेज दीजिए।'),
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
  issue: IssueType;
}

/** After the export bot's PAYMENT CONFIRMED: the solved note, with the customer's name and the confirmed amount. */
export function solvedText(lang: Language, d: SolvedDetails): string {
  const name = d.name?.trim() || pick(lang, 'Sir', 'Sir', 'सर');
  const issue = d.issue === 'withdrawal' ? pick(lang, 'withdrawal', 'withdrawal', 'विड्रॉल') : pick(lang, 'deposit', 'deposit', 'डिपॉज़िट');
  const settled = d.issue === 'withdrawal' ? pick(lang, 'transfer/confirm', 'transferred/confirmed', 'ट्रांसफर/कन्फर्म') : pick(lang, 'credit/confirm', 'credited/confirmed', 'क्रेडिट/कन्फर्म');
  const title = d.issue === 'withdrawal' ? pick(lang, 'Withdrawal Issue Resolved!', 'Withdrawal Issue Resolved!', 'विड्रॉल इश्यू सॉल्व हो गया!') : pick(lang, 'Deposit Issue Resolved!', 'Deposit Issue Resolved!', 'डिपॉज़िट इश्यू सॉल्व हो गया!');
  const body = d.amount
    ? pick(
        lang,
        `Aapka ${issue} issue successfully resolve ho gaya hai. Aapka amount ${d.amount} successfully ${settled} ho gaya hai. 💰✅`,
        `Your ${issue} issue has been successfully resolved. Your amount of ${d.amount} has been ${settled} successfully. 💰✅`,
        `आपका ${issue} इश्यू सफलतापूर्वक सॉल्व हो गया है। आपका अमाउंट ${d.amount} सफलतापूर्वक ${settled} हो गया है। 💰✅`,
      )
    : pick(
        lang,
        `Aapka ${issue} issue successfully resolve ho gaya hai aur payment confirm ho gaya hai. 💰✅`,
        `Your ${issue} issue has been successfully resolved and the payment has been confirmed. 💰✅`,
        `आपका ${issue} इश्यू सफलतापूर्वक सॉल्व हो गया है और पेमेंट कन्फर्म हो गया है। 💰✅`,
      );
  return [
    `🎉 ${title}`,
    '',
    pick(lang, `Hello ${name} 👋`, `Hello ${name} 👋`, `नमस्ते ${name} 👋`),
    '',
    body,
    '',
    pick(lang, 'Aapke patience ke liye thank you, Sir. 🙏', 'Thank you for your patience, Sir. 🙏', 'आपके धैर्य के लिए धन्यवाद, सर। 🙏'),
    pick(lang, 'Sorry for the inconvenience. 💙', 'Sorry for the inconvenience. 💙', 'असुविधा के लिए माफ़ी। 💙'),
  ].join('\n');
}
