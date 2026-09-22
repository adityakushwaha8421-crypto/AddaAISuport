/** Customer/support-facing masking helpers. */

/** "123456789012" → "XXXXXXXX9012". Keeps already-masked input readable. */
export function maskAccount(account: string | undefined | null, visible = 4): string | undefined {
  if (!account) return undefined;
  const cleaned = account.replace(/[\s-]/g, '');
  const digits = cleaned.replace(/[^0-9]/g, '');
  if (digits.length === 0) return undefined;
  const tail = cleaned.slice(-visible);
  const maskLen = Math.max(cleaned.length - visible, 4);
  return `${'X'.repeat(maskLen)}${tail}`;
}

/** Short customer-facing form: "XXXX9012". */
export function shortMaskAccount(account: string | undefined | null): string | undefined {
  if (!account) return undefined;
  const digits = account.replace(/[^0-9]/g, '');
  if (digits.length < 4) return undefined;
  return `XXXX${digits.slice(-4)}`;
}

export function maskPhone(phone: string | undefined | null): string | undefined {
  if (!phone) return undefined;
  const d = phone.replace(/\D/g, '');
  if (d.length < 6) return 'XXXX';
  return `${d.slice(0, 2)}XXXXXX${d.slice(-2)}`;
}

/** "Rahul Kumar" → "R***l K***r". */
export function maskName(name: string | undefined | null): string | undefined {
  if (!name) return undefined;
  return name
    .trim()
    .split(/\s+/)
    .map((w) => (w.length <= 2 ? w : `${w[0]}${'*'.repeat(Math.min(w.length - 2, 6))}${w[w.length - 1]}`))
    .join(' ');
}
