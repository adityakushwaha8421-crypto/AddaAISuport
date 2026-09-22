/** Indian bank name normalisation. IFSC prefix → canonical bank, plus common name variants. */

const IFSC_PREFIX_BANK: Record<string, string> = {
  SBIN: 'State Bank of India', HDFC: 'HDFC Bank', ICIC: 'ICICI Bank', UTIB: 'Axis Bank', KKBK: 'Kotak Mahindra Bank',
  PUNB: 'Punjab National Bank', BARB: 'Bank of Baroda', CNRB: 'Canara Bank', UBIN: 'Union Bank of India',
  IDFB: 'IDFC First Bank', YESB: 'Yes Bank', INDB: 'IndusInd Bank', PYTM: 'Paytm Payments Bank',
  AIRP: 'Airtel Payments Bank', FINO: 'Fino Payments Bank', AUBL: 'AU Small Finance Bank', FDRL: 'Federal Bank',
  IDIB: 'Indian Bank', CBIN: 'Central Bank of India', UCBA: 'UCO Bank', BKID: 'Bank of India', IBKL: 'IDBI Bank',
  MAHB: 'Bank of Maharashtra', IOBA: 'Indian Overseas Bank', PSIB: 'Punjab & Sind Bank', KARB: 'Karnataka Bank',
  KVBL: 'Karur Vysya Bank', SIBL: 'South Indian Bank', RATN: 'RBL Bank', ESFB: 'Equitas Small Finance Bank',
  UJVN: 'Ujjivan Small Finance Bank', JAKA: 'Jammu & Kashmir Bank', DBSS: 'DBS Bank', CITI: 'Citibank',
  IPOS: 'India Post Payments Bank', JIOP: 'Jio Payments Bank', NSPB: 'NSDL Payments Bank', TMBL: 'Tamilnad Mercantile Bank',
};

const NAME_PATTERNS: Array<[RegExp, string]> = [
  [/\b(state bank of india|sbi)\b/i, 'State Bank of India'],
  [/\bhdfc\b/i, 'HDFC Bank'],
  [/\bicici\b/i, 'ICICI Bank'],
  [/\baxis\b/i, 'Axis Bank'],
  [/\bkotak\b/i, 'Kotak Mahindra Bank'],
  [/\b(punjab national bank|pnb)\b/i, 'Punjab National Bank'],
  [/\b(bank of baroda|bob)\b/i, 'Bank of Baroda'],
  [/\bcanara\b/i, 'Canara Bank'],
  [/\bunion bank\b/i, 'Union Bank of India'],
  [/\bidfc\b/i, 'IDFC First Bank'],
  [/\byes bank\b/i, 'Yes Bank'],
  [/\bindusind\b/i, 'IndusInd Bank'],
  [/\bpaytm payments? bank\b/i, 'Paytm Payments Bank'],
  [/\bairtel payments? bank\b/i, 'Airtel Payments Bank'],
  [/\bfino\b/i, 'Fino Payments Bank'],
  [/\bau small finance\b/i, 'AU Small Finance Bank'],
  [/\bfederal bank\b/i, 'Federal Bank'],
  [/\bindian overseas bank\b/i, 'Indian Overseas Bank'],
  [/\bindian bank\b/i, 'Indian Bank'],
  [/\bcentral bank of india\b/i, 'Central Bank of India'],
  [/\buco bank\b/i, 'UCO Bank'],
  [/\bbank of india\b/i, 'Bank of India'],
  [/\bidbi\b/i, 'IDBI Bank'],
  [/\bbank of maharashtra\b/i, 'Bank of Maharashtra'],
  [/\bindia post payments? bank\b/i, 'India Post Payments Bank'],
  [/\brbl\b/i, 'RBL Bank'],
];

export function bankFromIfsc(ifsc: string | undefined): string | undefined {
  return ifsc ? IFSC_PREFIX_BANK[ifsc.slice(0, 4).toUpperCase()] : undefined;
}

export function canonicalBank(name: string | undefined): string | undefined {
  if (!name) return undefined;
  for (const [re, canon] of NAME_PATTERNS) if (re.test(name)) return canon;
  return undefined;
}

/** Find the first bank mentioned in free text (statement header, admin field). */
export function detectBank(text: string): string | undefined {
  // Prefer the most specific names first ("Indian Overseas Bank" before "Indian Bank").
  return canonicalBank(text);
}
