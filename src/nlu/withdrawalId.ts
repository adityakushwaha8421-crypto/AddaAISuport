/**
 * A withdrawal's id as the app prints it: "WD-19106-67317", with or without the gateway prefix the
 * team's tools add ("BXWD-49437-70854"), dashes or underscores, any case. Returned upper-case, in
 * order of appearance, without the prefix differences collapsed (the id is compared as typed).
 */
const WITHDRAWAL_ID = /(?<![A-Za-z0-9])(?:BX)?(?:WD|WDR|WID)[-_]?\d{3,}(?:[-_]\d{2,})*(?![A-Za-z0-9])/gi;

export function extractWithdrawalIds(text: string | undefined): string[] {
  if (!text) return [];
  const found: string[] = [];
  for (const m of text.matchAll(WITHDRAWAL_ID)) {
    const id = m[0].toUpperCase().replace(/_/g, '-');
    if (!found.includes(id)) found.push(id);
  }
  return found;
}

/** "BXWD-1-2" and "WD-1-2" name the same withdrawal. */
export const sameWithdrawalId = (a: string, b: string) => a.toUpperCase().replace(/^BX/, '').replace(/[-_]/g, '') === b.toUpperCase().replace(/^BX/, '').replace(/[-_]/g, '');
