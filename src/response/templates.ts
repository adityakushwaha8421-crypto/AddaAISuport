import type { CaseType, Slot } from '../domain/cases.js';
import type { WithdrawalCandidate } from '../domain/evidence.js';
import type { Language } from '../nlu/types.js';
import type { Act, ReceivedItem } from './acts.js';

/**
 * Deterministic phrasing for every act, in Hinglish / English / Hindi. This is both the
 * RESPONSE_MODE=template renderer and the safe fallback when LLM phrasing fails the guard.
 */

export const inr = (n: number | undefined) =>
  n === undefined ? '' : `₹${n.toLocaleString('en-IN', { maximumFractionDigits: 2 })}`;

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** "2026-09-05" or "2026-09-05T10:00:00+05:30" → "5 Sep". Anything else is shown as given. */
const shortDate = (iso: string | undefined) => {
  const m = iso ? /^(\d{4})-(\d{2})-(\d{2})/.exec(iso) : null;
  return m ? `${Number(m[3])} ${MONTHS[Number(m[2]) - 1]}` : (iso ?? '');
};

type L = Language;
const pick = (lang: L, h: string, e: string, hi: string) => (lang === 'english' ? e : lang === 'hindi' ? hi : h);
const pickList = (lang: L, h: string[], e: string[], hi: string[]) => (lang === 'english' ? e : lang === 'hindi' ? hi : h);

const SLOT_NAME: Record<Slot, [string, string, string]> = {
  registration_number: ['10-digit registered number', '10-digit registered mobile number', '10 अंकों का रजिस्टर्ड नंबर'],
  payment_proof: ['payment screenshot', 'payment screenshot', 'पेमेंट का स्क्रीनशॉट'],
  payment_video: ['payment ki screen recording (video)', 'a screen recording (video) of the payment', 'पेमेंट की स्क्रीन रिकॉर्डिंग (वीडियो)'],
  utr: ['UTR/reference number', 'UTR/reference number', 'UTR/रेफरेंस नंबर'],
  withdrawal_ref: ['Withdrawal ID ya withdrawal history ka screenshot', 'the Withdrawal ID or a screenshot of your withdrawal history', 'विड्रॉल ID या विड्रॉल हिस्ट्री का स्क्रीनशॉट'],
  withdrawal_choice: ['kaunsa withdrawal', 'which withdrawal', 'कौन सा विड्रॉल'],
  bank_statement: ['same account ka recent bank statement PDF', 'a recent bank statement PDF of the same account', 'उसी अकाउंट का हाल का बैंक स्टेटमेंट PDF'],
  pdf_password: ['PDF password', 'the PDF password', 'PDF पासवर्ड'],
  issue_description: ['issue thoda detail mein', 'a few details about the issue', 'समस्या थोड़ा विस्तार से'],
  screenshot: ['screenshot', 'a screenshot', 'स्क्रीनशॉट'],
};

const RECEIVED_NAME: Record<ReceivedItem, [string, string, string]> = {
  registration_number: ['Registration number', 'Registration number', 'रजिस्टर्ड नंबर'],
  payment_screenshot: ['payment screenshot', 'payment screenshot', 'पेमेंट स्क्रीनशॉट'],
  withdrawal_id: ['Withdrawal ID', 'Withdrawal ID', 'विड्रॉल ID'],
  withdrawal_screenshot: ['withdrawal screenshot', 'withdrawal screenshot', 'विड्रॉल स्क्रीनशॉट'],
  bank_statement: ['bank statement', 'bank statement', 'बैंक स्टेटमेंट'],
  utr: ['UTR', 'UTR', 'UTR'],
  screenshot: ['screenshot', 'screenshot', 'स्क्रीनशॉट'],
  details: ['details', 'details', 'डिटेल्स'],
  pdf: ['PDF', 'PDF', 'PDF'],
  payment_video: ['payment video', 'payment video', 'पेमेंट वीडियो'],
  video: ['video', 'video', 'वीडियो'],
};

/** Deposit wording differs: the statement is of the account the customer paid FROM. */
const DEPOSIT_SLOT_NAME: Partial<Record<Slot, [string, string, string]>> = {
  bank_statement: ['jis account se payment kiya uska bank statement PDF', 'a bank statement PDF of the account you paid from', 'जिस अकाउंट से पेमेंट किया उसका बैंक स्टेटमेंट PDF'],
};

/** Item names for the single first deposit request (one natural sentence). */
const FIRST_ASK_NAME: Partial<Record<Slot, [string, string, string]>> = {
  registration_number: ['apna 10-digit registered number', 'your 10-digit registered number', 'अपना 10 अंकों का रजिस्टर्ड नंबर'],
  bank_statement: ['bank statement PDF', 'bank statement PDF', 'बैंक स्टेटमेंट PDF'],
  payment_proof: ['payment screenshot', 'payment screenshot', 'पेमेंट स्क्रीनशॉट'],
  payment_video: ['payment screen recording', 'a screen recording of the payment', 'पेमेंट स्क्रीन रिकॉर्डिंग'],
};

const nameOf = <K extends string>(table: Record<K, [string, string, string]>, k: K, lang: L) =>
  table[k][lang === 'english' ? 1 : lang === 'hindi' ? 2 : 0];

function joinList(items: string[], lang: L): string {
  if (items.length <= 1) return items[0] ?? '';
  const and = pick(lang, 'aur', 'and', 'और');
  return `${items.slice(0, -1).join(', ')} ${and} ${items[items.length - 1]}`;
}

const cap = (s: string) => (s ? s[0]!.toUpperCase() + s.slice(1) : s);

/** Field labels on result cards. */
const LABEL = {
  orderId: ['Order ID', 'Order ID', 'ऑर्डर ID'],
  amount: ['Amount', 'Amount', 'राशि'],
  bank: ['Bank', 'Bank', 'बैंक'],
  account: ['Account', 'Account', 'अकाउंट'],
  utr: ['UTR', 'UTR', 'UTR'],
  reason: ['Reason', 'Reason', 'कारण'],
} as const;
const label = (k: keyof typeof LABEL, lang: L) => LABEL[k][lang === 'english' ? 1 : lang === 'hindi' ? 2 : 0];

/** How each requested item is shown in a request list. */
const SLOT_EMOJI: Partial<Record<Slot, string>> = {
  registration_number: '📱', payment_proof: '🧾', payment_video: '🎥', bank_statement: '📄', withdrawal_ref: '🆔', utr: '🔢', pdf_password: '🔐', screenshot: '🖼️',
};

/**
 * The shape every outcome message shares:
 *   ✅ **Title**
 *   what happened, in one sentence
 *   🏦 Label: value        (one fact per line)
 *   👉 what to do next
 * `**…**` becomes Telegram bold in response/format.ts, which also puts IDs and UTRs in monospace.
 */
function card(c: { icon: string; title: string; body: string; facts?: Array<[string, string, string | undefined]>; next?: string }): string {
  const facts = (c.facts ?? []).filter(([, , v]) => v).map(([icon, name, v]) => `${icon} ${name}: ${v}`);
  return [`${c.icon} **${c.title}**`, c.body, facts.join('\n'), c.next ? `👉 ${c.next}` : ''].filter(Boolean).join('\n\n');
}

/** A short message with its next step on a line of its own. */
const withNext = (text: string, next: string) => `${text}\n\n👉 ${next}`;

const ORDINAL: Record<L, string[]> = {
  hinglish: ['upar wala', 'dusra', 'teesra', 'chautha', 'paanchva'],
  english: ['the top one', 'the second one', 'the third one', 'the fourth one', 'the fifth one'],
  hindi: ['ऊपर वाला', 'दूसरा', 'तीसरा', 'चौथा', 'पाँचवाँ'],
};

const KEYCAP = ['1️⃣', '2️⃣', '3️⃣', '4️⃣', '5️⃣', '6️⃣'];

const statusMark = (s?: string) =>
  !s ? '' : /success|paid|complet/i.test(s) ? `✅ ${s}` : /process|pending|initiat|queue/i.test(s) ? `⏳ ${s}` : /fail|reject|revers|cancel/i.test(s) ? `❌ ${s}` : s;

function candidateLine(c: WithdrawalCandidate): string {
  const n = KEYCAP[c.position - 1] ?? `${c.position}.`;
  return `${n} ${[inr(c.amount), c.withdrawalId, statusMark(c.status), shortDate(c.datetime)].filter(Boolean).join(' · ')}`;
}

function askText(a: Extract<Act, { type: 'ask' }>, lang: L): string {
  const table = a.caseType === 'deposit' ? { ...SLOT_NAME, ...DEPOSIT_SLOT_NAME } : SLOT_NAME;
  const names = a.slots.filter((s) => s !== 'withdrawal_choice').map((s) => nameOf(table as Record<Slot, [string, string, string]>, s, lang));
  const list = joinList(names, lang);
  if (a.mode === 'initial') return initialAsk(a.caseType, a.slots, lang, list);
  if (a.mode === 'reminder') return pick(lang, `Ji sir, ${list} bhej dijiye jab ready ho 👍`, `Sure sir, please send ${list} whenever ready 👍`, `जी सर, ${list} तैयार होने पर भेज दीजिए 👍`);
  if (a.mode === 'not_found_yet') return pick(lang, `Sir, mujhe abhi tak ${list} nahi mila hai 🙏 Please ek baar bhej dijiye.`, `Sir, I haven't received ${list} yet 🙏 Please send it once more.`, `सर, मुझे अभी तक ${list} नहीं मिला है 🙏 कृपया एक बार भेज दीजिए।`);
  return pick(lang, `Ab ${list} bhej dijiye sir, phir main aage check karta hoon.`, `Please send ${list} sir, and I'll check further.`, `अब ${list} भेज दीजिए सर, फिर मैं आगे चेक करता हूँ।`);
}

/** Each requested item on its own line, with its icon. */
const itemLines = (items: Array<[Slot, string]>) => items.map(([slot, name]) => `${SLOT_EMOJI[slot] ?? '•'} ${cap(name)}`).join('\n');

function initialAsk(caseType: CaseType, slots: Slot[], lang: L, list: string): string {
  switch (caseType) {
    case 'deposit': {
      // Everything needed, asked once: a friendly lead-in, then one item per line.
      const items = slots.map((s): [Slot, string] => [s, nameOf((FIRST_ASK_NAME[s] ? FIRST_ASK_NAME : SLOT_NAME) as Record<Slot, [string, string, string]>, s, lang)]);
      if (items.length < 2) return pick(lang, `Sir, deposit check karne ke liye ${items[0]?.[1]} bhej dijiye 🙏`, `Sir, to check the deposit please send ${items[0]?.[1]} 🙏`, `सर, डिपॉज़िट चेक करने के लिए ${items[0]?.[1]} भेज दीजिए 🙏`);
      const lead = pick(lang, 'Sir, deposit check karne ke liye ye details bhej dijiye 🙏', 'Sir, to check the deposit please send these 🙏', 'सर, डिपॉज़िट चेक करने के लिए ये डिटेल्स भेज दीजिए 🙏');
      return `${lead}\n\n${itemLines(items)}`;
    }
    case 'withdrawal': {
      const [ref, statement] = pickList(lang,
        ['Withdrawal ID ya withdrawal history ka screenshot', 'Jis account me amount aana tha uska bank statement PDF'],
        ['Withdrawal ID or a screenshot of your withdrawal history', 'Bank statement PDF of the account the amount should have reached'],
        ['विड्रॉल ID या विड्रॉल हिस्ट्री का स्क्रीनशॉट', 'जिस अकाउंट में राशि आनी थी उसका बैंक स्टेटमेंट PDF'],
      );
      // Whatever already arrived is not asked for again: the two items are all a withdrawal needs.
      if (!slots.includes('bank_statement')) {
        return pick(lang, `Sir, withdrawal check karne ke liye ${ref} bhej dijiye 🙏`, `Sir, to check the withdrawal please send the ${ref} 🙏`, `सर, विड्रॉल चेक करने के लिए ${ref} भेज दीजिए 🙏`);
      }
      if (!slots.includes('withdrawal_ref')) {
        return pick(lang, `Sir, ab sirf ${statement} bhej dijiye 🙏`, `Sir, now only the ${statement} is needed 🙏`, `सर, अब सिर्फ ${statement} भेज दीजिए 🙏`);
      }
      const lead = pick(lang, 'Sir, withdrawal check karne ke liye ye details bhej dijiye 🙏', 'Sir, to check the withdrawal please send these 🙏', 'सर, विड्रॉल चेक करने के लिए ये डिटेल्स भेज दीजिए 🙏');
      return `${lead}\n\n${itemLines([['withdrawal_ref', ref!], ['bank_statement', statement!]])}`;
    }
    default:
      return pick(lang,
        `Samajh gaya sir 👍 ${cap(list || 'issue thoda detail mein')} bata dijiye aur ho sake to screenshot bhej dijiye.`,
        'Understood sir 👍 Please describe the issue briefly and share a screenshot if possible.',
        'समझ गया सर 👍 समस्या थोड़ा विस्तार से बताइए और हो सके तो स्क्रीनशॉट भेज दीजिए।');
  }
}

function renderAct(a: Act, lang: L): string {
  switch (a.type) {
    case 'greeting':
      if (a.again === 'how_are_you') return pick(lang, 'Main theek hoon sir, shukriya 😊 Bataiye, kya help chahiye?', "I'm doing well sir, thank you 😊 How can I help?", 'मैं ठीक हूँ सर, धन्यवाद 😊 बताइए, क्या मदद चाहिए?');
      if (a.again === 'hello') return pick(lang, 'Ji sir 😊 Bataiye, kya help chahiye?', 'Yes sir 😊 How can I help?', 'जी सर 😊 बताइए, क्या मदद चाहिए?');
      return pick(lang, 'Hello sir 👋 Kaise help karun?', 'Hi sir 👋 How can I help?', 'नमस्ते सर 👋 बताइए, कैसे मदद करूँ?');
    case 'thanks':
      return pick(lang, 'Welcome sir 😊', "You're welcome sir 😊", 'आपका स्वागत है सर 😊');
    case 'ack':
      return pick(lang, 'Ji sir 👍', 'Sure sir 👍', 'जी सर 👍');
    case 'frustration_ack':
      // Only mention "already sent" when something actually was.
      return a.hasDetails
        ? pick(lang, 'Samajh sakta hoon sir, pareshani ke liye sorry 🙏 Jo details aap bhej chuke hain, unhe dobara bhejne ki zarurat nahi hai.', "I understand sir, sorry for the trouble 🙏 You don't need to resend what you've already shared.", 'समझ सकता हूँ सर, परेशानी के लिए माफ़ी 🙏 जो डिटेल्स आप भेज चुके हैं, उन्हें दोबारा भेजने की ज़रूरत नहीं है।')
        : pick(lang, 'Samajh sakta hoon sir, pareshani ke liye sorry 🙏', 'I understand sir, sorry for the trouble 🙏', 'समझ सकता हूँ सर, परेशानी के लिए माफ़ी 🙏');
    case 'received': {
      const list = joinList(a.items.map((i) => nameOf(RECEIVED_NAME, i, lang)), lang);
      return pick(lang, `${cap(list)} mil gaya sir ✅`, `Got the ${list} sir ✅`, `${list} मिल गया सर ✅`);
    }
    case 'ask':
      return askText(a, lang);
    case 'promise_noted':
      return pick(lang, 'Theek hai sir 👍 Jab ready ho bhej dijiye.', 'Sure sir 👍 Please send it whenever it is ready.', 'ठीक है सर 👍 जब तैयार हो भेज दीजिए।');
    case 'export_confirmed':
      // Agreed wording, sent as is in every language.
      return 'Your details and documents have been shared with our team successfully. They will review your issue and work on resolving it as soon as possible. ✅';
    case 'deposit_solved':
      return pick(lang,
        'Sir, aapka deposit issue solve ho gaya hai. Inconvenience ke liye sorry. ✅',
        'Your deposit issue has been solved. Sorry for the inconvenience, Sir. ✅',
        'सर, आपका डिपॉज़िट इश्यू सॉल्व हो गया है। असुविधा के लिए माफ़ी। ✅');
    case 'clarify_issue_type':
      return pick(lang,
        'Samajh gaya sir 👍 Deposit ka issue hai ya withdrawal ka?\n\n💰 Deposit: paisa wallet me add nahi hua\n🏦 Withdrawal: paisa bank account me nahi aaya',
        'Understood sir 👍 Is this about a deposit or a withdrawal?\n\n💰 Deposit: money not added to your wallet\n🏦 Withdrawal: money not received in your bank account',
        'समझ गया सर 👍 डिपॉज़िट की समस्या है या विड्रॉल की?\n\n💰 डिपॉज़िट: पैसा वॉलेट में नहीं आया\n🏦 विड्रॉल: पैसा बैंक अकाउंट में नहीं आया');

    // ── Deposit outcomes ──────────────────────────────────────────────────
    case 'deposit_success':
      return card({
        icon: '✅',
        title: pick(lang, 'Deposit Successful', 'Deposit Successful', 'डिपॉज़िट सफल'),
        body: pick(lang, 'Sir, aapka payment successfully verify ho gaya hai.', 'Sir, your payment has been successfully verified.', 'सर, आपका पेमेंट सफलतापूर्वक वेरिफाई हो गया है।'),
        facts: [['🧾', label('orderId', lang), a.orderId], ['💰', label('amount', lang), inr(a.amount)]],
        next: pick(lang, 'Wallet balance refresh karke check kar lijiye.', 'Please refresh your wallet balance and check.', 'कृपया वॉलेट बैलेंस रिफ्रेश करके देखिए।'),
      });
    case 'deposit_pending':
      return card({
        icon: '⏳',
        title: pick(lang, 'Deposit Pending', 'Deposit Pending', 'डिपॉज़िट पेंडिंग'),
        body: pick(lang, 'Sir, aapka payment abhi pending dikh raha hai.', 'Sir, your payment is still pending.', 'सर, आपका पेमेंट अभी पेंडिंग दिख रहा है।'),
        facts: [['🧾', label('orderId', lang), a.orderId], ['💰', label('amount', lang), inr(a.amount)]],
      });
    case 'deposit_failed':
      return card({
        icon: '❌',
        title: pick(lang, 'Payment Failed', 'Payment Failed', 'पेमेंट फेल'),
        body: pick(lang, 'Sir, ye payment failed dikh raha hai.', 'Sir, this payment shows as failed.', 'सर, यह पेमेंट फेल दिख रहा है।'),
        facts: [['🧾', label('orderId', lang), a.orderId], ['💰', label('amount', lang), inr(a.amount)]],
        next: pick(lang,
          'Agar amount aapke account se kat gaya hai, to bank statement PDF bhej dijiye, verify karke aage check karte hain.',
          'If the amount was debited from your account, please send a bank statement PDF so it can be verified.',
          'अगर राशि आपके अकाउंट से कट गई है, तो बैंक स्टेटमेंट PDF भेज दीजिए।'),
      });
    case 'deposit_not_matched':
      return card({
        icon: '⚠️',
        title: pick(lang, 'Details Match Nahi Hui', 'Details Not Matched', 'डिटेल्स मैच नहीं हुईं'),
        body: pick(lang, 'Sir, aapke diye hue payment details hamare records se match nahi ho rahe 🙏', "Sir, the payment details you shared don't match our records 🙏", 'सर, आपकी दी हुई पेमेंट डिटेल्स हमारे रिकॉर्ड से मैच नहीं हो रहीं 🙏'),
        next: pick(lang,
          `Registration number ek baar check karke bhejiye.${a.askStatement ? ' Number sahi hai to bank statement PDF bhej dijiye, taaki payment verify ho sake.' : ''}`,
          `Please double-check your registration number.${a.askStatement ? ' If it is correct, send a bank statement PDF so the payment can be verified.' : ''}`,
          `रजिस्ट्रेशन नंबर एक बार चेक करके भेजिए।${a.askStatement ? ' नंबर सही है तो बैंक स्टेटमेंट PDF भेजिए, ताकि पेमेंट वेरिफाई हो सके।' : ''}`),
      });

    // ── Withdrawal outcomes ───────────────────────────────────────────────
    case 'withdrawal_success': {
      const amt = a.amount !== undefined ? inr(a.amount) : '';
      return card({
        icon: '✅',
        title: pick(lang, 'Withdrawal Successful', 'Withdrawal Successful', 'विड्रॉल सफल'),
        body: pick(lang,
          `Sir, aapka ${amt ? `${amt} ka ` : ''}withdrawal successfully process ho chuka hai.`,
          `Sir, your ${amt ? `${amt} ` : ''}withdrawal has been processed successfully.`,
          `सर, आपका ${amt ? `${amt} का ` : ''}विड्रॉल सफलतापूर्वक प्रोसेस हो चुका है।`),
        facts: [['🏦', label('bank', lang), a.bank], ['💳', label('account', lang), a.maskedAccount]],
        next: a.askStatement
          ? pick(lang,
            'Agar amount account me nahi dikh raha, to isi account ka recent bank statement PDF bhej dijiye.',
            'If it is not showing in your account, please send a recent bank statement PDF of this account.',
            'अगर राशि अकाउंट में नहीं दिख रही, तो इसी अकाउंट का हाल का बैंक स्टेटमेंट PDF भेज दीजिए।')
          : undefined,
      });
    }
    case 'ask_statement_for_account': {
      const dest = [a.bank, a.maskedAccount].filter(Boolean).join(' ');
      return withNext(
        pick(lang, 'Samajh gaya sir 🙏', 'Understood sir 🙏', 'समझ गया सर 🙏'),
        pick(lang,
          `Verification ke liye ${dest ? `${dest} account` : 'usi account'} ka recent bank statement PDF bhej dijiye.`,
          `For verification, please send a recent bank statement PDF of ${dest ? `the ${dest} account` : 'that account'}.`,
          `वेरिफिकेशन के लिए ${dest ? `${dest} अकाउंट` : 'उसी अकाउंट'} का हाल का बैंक स्टेटमेंट PDF भेज दीजिए।`),
      );
    }
    case 'withdrawal_processing': {
      const amt = a.amount !== undefined ? inr(a.amount) : '';
      return card({
        icon: '⏳',
        title: pick(lang, 'Withdrawal Processing', 'Withdrawal Processing', 'विड्रॉल प्रोसेसिंग में'),
        body: pick(lang,
          `Sir, aapka ${amt ? `${amt} ka ` : ''}withdrawal abhi processing mein hai.`,
          `Sir, your ${amt ? `${amt} ` : ''}withdrawal is still processing.`,
          `सर, आपका ${amt ? `${amt} का ` : ''}विड्रॉल अभी प्रोसेसिंग में है।`),
        next: pick(lang, 'Complete hone ke baad amount aapke bank account mein credit hoga.', 'Once it completes, the amount will be credited to your bank account.', 'पूरा होने के बाद राशि आपके बैंक अकाउंट में क्रेडिट होगी।'),
      });
    }
    case 'withdrawal_failed': {
      const amt = a.amount !== undefined ? inr(a.amount) : '';
      return card({
        icon: '❌',
        title: pick(lang, 'Withdrawal Failed', 'Withdrawal Failed', 'विड्रॉल फेल'),
        body: pick(lang,
          `Sir, aapka ${amt ? `${amt} ka ` : ''}withdrawal failed dikh raha hai.`,
          `Sir, your ${amt ? `${amt} ` : ''}withdrawal shows as failed.`,
          `सर, आपका ${amt ? `${amt} का ` : ''}विड्रॉल फेल दिख रहा है।`),
        facts: [['📝', label('reason', lang), a.reason]],
      });
    }
    case 'withdrawal_not_found':
      return card({
        icon: '🔍',
        title: pick(lang, 'Withdrawal ID Nahi Mili', 'Withdrawal ID Not Found', 'विड्रॉल ID नहीं मिली'),
        body: pick(lang, `Sir, Withdrawal ID ${a.withdrawalId} hamare records mein nahi mil rahi 🙏`, `Sir, I couldn't find Withdrawal ID ${a.withdrawalId} in our records 🙏`, `सर, विड्रॉल ID ${a.withdrawalId} हमारे रिकॉर्ड में नहीं मिल रही 🙏`),
        next: pick(lang, 'ID ek baar check karke bhejiye, ya withdrawal history ka screenshot bhej dijiye.', 'Please re-check the ID, or send a screenshot of your withdrawal history.', 'ID एक बार चेक करके भेजिए, या विड्रॉल हिस्ट्री का स्क्रीनशॉट भेजिए।'),
      });
    case 'choose_candidate':
      return [
        `📋 **${pick(lang, 'Kaunsa withdrawal check karein?', 'Which withdrawal should I check?', 'कौन सा विड्रॉल चेक करें?')}**`,
        pick(lang, `Sir, screenshot mein ${a.candidates.length} withdrawals dikh rahe hain:`, `Sir, I can see ${a.candidates.length} withdrawals in the screenshot:`, `सर, स्क्रीनशॉट में ${a.candidates.length} विड्रॉल दिख रहे हैं:`),
        a.candidates.slice(0, 6).map(candidateLine).join('\n'),
        `👉 ${pick(lang, 'Number likh dijiye, ya "upar wala" / "neeche wala" bata dijiye.', 'Reply with the number, or say "the top one" / "the last one".', 'नंबर लिख दीजिए, या "ऊपर वाला" / "नीचे वाला" बता दीजिए।')}`,
      ].join('\n\n');
    case 'candidate_selected': {
      const ord = ORDINAL[lang][a.candidate.position - 1] ?? `#${a.candidate.position}`;
      const what = [inr(a.candidate.amount), a.candidate.withdrawalId ? `(${a.candidate.withdrawalId})` : ''].filter(Boolean).join(' ');
      // Acknowledges the choice only: nothing has been checked yet when this is said.
      return pick(lang, `Theek hai sir, ${ord} ${what} 👍`, `Okay sir, ${ord} ${what} 👍`, `ठीक है सर, ${ord} ${what} 👍`).replace(/\s+/g, ' ');
    }

    // ── Documents ─────────────────────────────────────────────────────────
    case 'pdf_password_needed':
      return withNext(
        pick(lang, '🔐 Sir, ye PDF password protected hai.', '🔐 Sir, this PDF is password protected.', '🔐 सर, यह PDF पासवर्ड से सुरक्षित है।'),
        pick(lang, 'PDF ka password bhej dijiye. Password nahi hai to **Skip** likh dijiye.', "Please send the PDF password, or type **Skip** if you don't have it.", 'PDF का पासवर्ड भेज दीजिए। पासवर्ड नहीं है तो **Skip** लिख दीजिए।'),
      );
    case 'pdf_password_wrong':
      return withNext(
        pick(lang, '❌ Sir, ye password sahi nahi laga 🙏', "❌ Sir, that password didn't work 🙏", '❌ सर, यह पासवर्ड सही नहीं लगा 🙏'),
        pick(lang, 'Ek baar check karke dobara bhej dijiye.', 'Please check it and send it again.', 'एक बार चेक करके दोबारा भेजिए।'),
      );
    case 'statement_account_mismatch':
      return card({
        icon: '⚠️',
        title: pick(lang, 'Account Match Nahi Hua', 'Account Mismatch', 'अकाउंट मैच नहीं हुआ'),
        body: pick(lang, 'Sir, ye statement us account ka nahi lag raha jisme withdrawal gaya tha.', "Sir, this statement doesn't seem to be for the account the withdrawal was sent to.", 'सर, यह स्टेटमेंट उस अकाउंट का नहीं लग रहा जिसमें विड्रॉल गया था।'),
        facts: [['🏦', label('bank', lang), a.bank], ['💳', label('account', lang), a.maskedAccount]],
        next: pick(lang, 'Usi bank account ka recent statement PDF bhej dijiye.', 'Please send a recent statement PDF of that account.', 'कृपया उसी अकाउंट का हाल का स्टेटमेंट PDF भेजिए।'),
      });
    case 'statement_credit_found': {
      const when = shortDate(a.date);
      return card({
        icon: '✅',
        title: pick(lang, 'Credit Mil Gaya', 'Credit Found', 'क्रेडिट मिल गया'),
        body: pick(lang,
          `Sir, aapke bank statement mein ${inr(a.amount)} ka credit${when ? ` ${when} ko` : ''} dikh raha hai.`,
          `Sir, your bank statement shows the ${inr(a.amount)} credit${when ? ` on ${when}` : ''}.`,
          `सर, आपके बैंक स्टेटमेंट में ${inr(a.amount)} का क्रेडिट${when ? ` ${when} को` : ''} दिख रहा है।`),
        facts: [['🔢', label('utr', lang), a.utr]],
        next: pick(lang, 'Ek baar apne bank app mein check kar lijiye.', 'Please check once in your bank app.', 'कृपया अपने बैंक ऐप में एक बार देख लीजिए।'),
      });
    }
    case 'statement_outdated': {
      const d = shortDate(a.payoutDate);
      return withNext(
        pick(lang, `📅 Sir, ye statement ${d} se pehle ka hai.`, `📅 Sir, this statement ends before ${d}.`, `📅 सर, यह स्टेटमेंट ${d} से पहले का है।`),
        pick(lang, `${d} ke baad ka recent statement PDF bhej dijiye.`, `Please send a recent statement PDF that covers ${d}.`, `कृपया ${d} के बाद का स्टेटमेंट PDF भेजिए।`),
      );
    }
    case 'statement_unreadable':
      return withNext(
        pick(lang, '⚠️ Sir, ye PDF read nahi ho pa rahi 🙏', "⚠️ Sir, I can't read this PDF 🙏", '⚠️ सर, यह PDF पढ़ी नहीं जा रही 🙏'),
        pick(lang, 'Bank app ya net-banking se download ki hui statement PDF bhej dijiye.', 'Please send a statement PDF downloaded from your bank app or net-banking.', 'बैंक ऐप या नेट-बैंकिंग से डाउनलोड की हुई स्टेटमेंट PDF भेजिए।'),
      );
    case 'not_a_statement':
      return withNext(
        pick(lang, '⚠️ Sir, ye bank statement nahi lag raha 🙏', "⚠️ Sir, this doesn't look like a bank statement 🙏", '⚠️ सर, यह बैंक स्टेटमेंट नहीं लग रहा 🙏'),
        pick(lang, 'Bank ka account statement PDF bhej dijiye.', 'Please send your bank account statement PDF.', 'कृपया बैंक का अकाउंट स्टेटमेंट PDF भेजिए।'),
      );
    case 'evidence_unrelated':
      return pick(lang, '🖼️ Sir, ye image is issue se related nahi lag rahi 🙏', "🖼️ Sir, this image doesn't seem related to the issue 🙏", '🖼️ सर, यह इमेज इस समस्या से जुड़ी नहीं लग रही 🙏');
    case 'evidence_unsupported':
      switch (a.what) {
        case 'voice':
          return withNext(pick(lang, '🎙️ Sir, voice note abhi sun nahi pa raha 🙏', "🎙️ Sir, I can't listen to voice notes right now 🙏", '🎙️ सर, मैं अभी वॉइस नोट नहीं सुन पा रहा 🙏'), pick(lang, 'Please text mein likh dijiye.', 'Please type your message.', 'कृपया टेक्स्ट में लिखिए।'));
        case 'video':
          return withNext(pick(lang, '🎥 Sir, video abhi check nahi ho pa raha 🙏', "🎥 Sir, I can't check the video right now 🙏", '🎥 सर, वीडियो अभी चेक नहीं हो पा रहा 🙏'), pick(lang, 'Screenshot bhej dijiye.', 'Please send a screenshot instead.', 'कृपया स्क्रीनशॉट भेजिए।'));
        case 'file':
          return withNext(pick(lang, '📎 Sir, ye file open nahi ho rahi 🙏', "📎 Sir, I can't open this file 🙏", '📎 सर, यह फ़ाइल नहीं खुल रही 🙏'), pick(lang, 'PDF ya screenshot bhej dijiye.', 'Please send a PDF or a screenshot.', 'PDF या स्क्रीनशॉट भेजिए।'));
        default:
          return withNext(pick(lang, '🖼️ Sir, ye image clear read nahi ho pa rahi 🙏', "🖼️ Sir, I can't read this image clearly 🙏", '🖼️ सर, यह इमेज साफ़ नहीं पढ़ी जा रही 🙏'), pick(lang, 'Ek clear screenshot bhej dijiye.', 'Please send a clear screenshot.', 'एक साफ़ स्क्रीनशॉट भेजिए।'));
      }
    case 'general_answer':
      return a.knowledge[0] ?? pick(lang, 'Ji sir, noted 👍 Iske alawa koi help chahiye to bataiye.', 'Noted sir 👍 Let me know if you need help with anything else.', 'जी सर, नोट कर लिया 👍 और कोई मदद चाहिए तो बताइए।');
  }
}

const EMOJI = /\p{Extended_Pictographic}️?/gu;
/** A line that starts with an emoji, a keycap or a bullet is layout: a title, a fact, a list item, a next step. */
const LAYOUT_LINE = /^(?:\p{Extended_Pictographic}|\d️?⃣|•)/u;
const capFirstLetter = (s: string) => s.replace(/^(\P{L}*)(\p{L})/u, (_m, pre: string, letter: string) => pre + letter.toUpperCase());

/**
 * Style guards applied to the whole message: address the customer once, keep emoji in sentences to
 * a couple (layout lines carry their own icon), and keep the line structure the templates chose.
 * Text written by the model may contain markdown, which Telegram would show literally: it is
 * stripped (`fromModel`). Templates use `**bold**` on purpose; response/format.ts renders it.
 */
export function polish(text: string, address: 'sir' | 'bhai' = 'sir', opts: { fromModel?: boolean } = {}): string {
  let seenSir = false;
  const dropSir = (sentence: string) =>
    capFirstLetter(
      sentence
        .replace(/^((?:\p{Extended_Pictographic}️?\s*)*)(sir|सर),?\s*/iu, '$1')
        .replace(/,?\s+(sir|सर)(?!\p{L})/giu, '')
        .replace(/\s+([,.!?])/g, '$1'),
    );
  let out = text
    .split('\n')
    .map((line) =>
      line
        .split(/(?<=[.!?।✅❌🙏👍⏳🔐😊]) +/u)
        .map((sentence) => {
          if (!/\bsir\b|सर/i.test(sentence)) return sentence;
          if (!seenSir) {
            seenSir = true;
            return sentence;
          }
          return dropSir(sentence);
        })
        .join(' '),
    )
    .join('\n');
  if (opts.fromModel) {
    out = out
      .replace(/\*\*([^*\n]+)\*\*/g, '$1')
      .replace(/(?<![\w*])\*([^*\n]+)\*(?![\w*])/g, '$1')
      .replace(/__([^_\n]+)__/g, '$1')
      .replace(/`([^`\n]+)`/g, '$1')
      .replace(/^\s*[-*]\s+/gm, '• ');
  }
  let inline = 0;
  out = out
    .split('\n')
    .map((line) => (!opts.fromModel && LAYOUT_LINE.test(line) ? line : line.replace(EMOJI, (m) => (++inline <= 2 ? m : ''))))
    .join('\n');
  // Mirror how the customer addresses us.
  if (address === 'bhai') out = out.replace(/\bsir\b/g, 'bhai').replace(/\bSir\b/g, 'Bhai').replace(/सर(?!\p{L})/gu, 'भाई');
  return out
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/[ \t]+$/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * One message from several acts. Acts are separate thoughts ("got it" / "now send this"), so they
 * become separate paragraphs rather than one long line — except a bare acknowledgement, which
 * belongs on the same line as what follows it.
 */
export function renderActs(acts: Act[], lang: L, address: 'sir' | 'bhai' = 'sir'): string {
  const parts = acts.map((a) => ({ short: SHORT_ACTS.has(a.type), text: renderAct(a, lang) })).filter((p) => p.text);
  let out = '';
  for (const [i, p] of parts.entries()) {
    if (i === 0) out = p.text;
    else out += `${p.short || parts[i - 1]!.short ? ' ' : '\n\n'}${p.text}`;
  }
  return polish(out, address);
}

/** Acts that are a few words long: they read as a lead-in, not as their own paragraph. */
const SHORT_ACTS = new Set<Act['type']>(['greeting', 'thanks', 'ack', 'promise_noted']);
