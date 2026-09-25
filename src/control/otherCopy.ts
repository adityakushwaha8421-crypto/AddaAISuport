/**
 * Detects replies from ANOTHER copy of the bot on this account — the old reply system, still running
 * somewhere — by the wording it used. Messages the account sends that this process did not send are
 * either a human's or that copy's; these phrases were never typed by a human.
 */
const OLD_BOT_PHRASES: RegExp[] = [
  /kaise help karun/i,
  /samajh sakta hoon sir/i,
  /samajh gaya sir/i,
  /deposit ka issue hai ya withdrawal ka/i,
  /shared with our team successfully/i,
  /solve ho gaya hai\. inconvenience ke liye sorry/i,
  /mil gaya sir ✅/i,
  /theek hai sir 👍 jab ready ho/i,
  /ji sir, .* bhej dijiye jab ready ho/i,
  /mujhe abhi tak .* nahi mila hai 🙏/i,
  /welcome sir 😊/i,
  /kya help chahiye/i,
  /team check kar rahi hai|team is checking/i,
  /voice note abhi sun nahi pa raha/i,
  /please text mein likh dijiye/i,
  /issue thoda detail mein bhej dijiye/i,
  /phir main aage check karta hoon/i,
  /kaunsa wala check karna hai/i,
  /upar wala|neeche wala/i,
];

export interface OtherCopySighting {
  at: Date;
  chatId: string;
}

export function looksLikeOldBot(text: string | undefined): boolean {
  return !!text && OLD_BOT_PHRASES.some((r) => r.test(text));
}

/** Remembers recent sightings (in memory, last 50) for the log and `/status`. */
export class OtherCopyDetector {
  readonly sightings: OtherCopySighting[] = [];

  note(chatId: string, text: string | undefined, at: Date): boolean {
    if (!looksLikeOldBot(text)) return false;
    this.sightings.push({ at, chatId });
    if (this.sightings.length > 50) this.sightings.shift();
    return true;
  }

  /** Sightings in the last `hours` hours. */
  recent(now: Date, hours = 24): OtherCopySighting[] {
    const since = now.getTime() - hours * 3_600_000;
    return this.sightings.filter((s) => s.at.getTime() >= since);
  }
}
