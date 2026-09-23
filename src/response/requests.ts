import type { IssueType } from '../nlu/issueType.js';

export type Language = 'hinglish' | 'english' | 'hindi';

const pick = (lang: Language, hinglish: string, english: string, hindi: string) => (lang === 'english' ? english : lang === 'hindi' ? hindi : hinglish);

/** The one evidence request per case: everything the team needs, asked once, one item per line. */
export function requestText(type: IssueType, lang: Language): string {
  if (type === 'deposit') {
    return [
      pick(lang, 'Sir, deposit check karne ke liye ye details bhej dijiye 🙏', 'Sir, to check the deposit please send these 🙏', 'सर, डिपॉज़िट चेक करने के लिए ये डिटेल्स भेज दीजिए 🙏'),
      '',
      '📱 ' + pick(lang, 'Apna 10-digit registered number', 'Your 10-digit registered number', 'अपना 10 अंकों का रजिस्टर्ड नंबर'),
      '🖼 ' + pick(lang, 'Payment screenshot', 'Payment screenshot', 'पेमेंट स्क्रीनशॉट'),
      '📄 ' + pick(lang, 'Jis account se payment kiya uska bank statement PDF', 'Bank statement PDF of the account you paid from', 'जिस अकाउंट से पेमेंट किया उसका बैंक स्टेटमेंट PDF'),
      '🎥 ' + pick(lang, 'Payment ki screen recording (video)', 'A screen recording (video) of the payment', 'पेमेंट की स्क्रीन रिकॉर्डिंग (वीडियो)'),
    ].join('\n');
  }
  return [
    pick(lang, 'Sir, withdrawal check karne ke liye ye details bhej dijiye 🙏', 'Sir, to check the withdrawal please send these 🙏', 'सर, विड्रॉल चेक करने के लिए ये डिटेल्स भेज दीजिए 🙏'),
    '',
    '🧾 ' + pick(lang, 'Withdrawal ID ya withdrawal history ka screenshot', 'Withdrawal ID or a screenshot of your withdrawal history', 'विड्रॉल ID या विड्रॉल हिस्ट्री का स्क्रीनशॉट'),
    '📄 ' + pick(lang, 'Jis account me amount aana tha uska bank statement PDF', 'Bank statement PDF of the account the amount should have reached', 'जिस अकाउंट में अमाउंट आना था उसका बैंक स्टेटमेंट PDF'),
  ].join('\n');
}

/** After the export bot's PAYMENT CONFIRMED: the agreed note, never paraphrased. */
export function solvedText(lang: Language): string {
  return pick(lang, 'Sir, aapka issue solved ho gaya hai. Sorry for the inconvenience. 🙏', 'Sir, your issue has been solved. Sorry for the inconvenience. 🙏', 'सर, आपका इश्यू सॉल्व हो गया है। असुविधा के लिए माफ़ी। 🙏');
}
