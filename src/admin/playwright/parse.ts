/** Pure helpers turning scraped admin-panel text into typed values (unit-testable without a browser). */

export interface LabelValue {
  label: string;
  value: string;
}

const normLabel = (s: string) => s.toLowerCase().replace(/[:*#]/g, '').replace(/\s+/g, ' ').trim();

/** Map scraped label/value pairs onto field names using synonym lists (first match wins). */
export function mapLabels(pairs: LabelValue[], synonyms: Record<string, string[]>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [field, names] of Object.entries(synonyms)) {
    const wanted = names.map(normLabel);
    // exact label match first, then "starts with" (e.g. "Account Number (masked)")
    const hit =
      pairs.find((p) => wanted.includes(normLabel(p.label))) ??
      pairs.find((p) => wanted.some((w) => normLabel(p.label).startsWith(w)));
    if (hit && hit.value.trim() && hit.value.trim() !== '-') out[field] = hit.value.trim();
  }
  return out;
}

/** Map table headers to column indexes. */
export function mapColumns(headers: string[], synonyms: Record<string, string[]>): Record<string, number> {
  const out: Record<string, number> = {};
  const hs = headers.map(normLabel);
  for (const [field, names] of Object.entries(synonyms)) {
    const wanted = names.map(normLabel);
    let idx = hs.findIndex((h) => wanted.includes(h));
    if (idx < 0) idx = hs.findIndex((h) => wanted.some((w) => h.startsWith(w)));
    if (idx >= 0) out[field] = idx;
  }
  return out;
}

export function parseMoney(s: string | undefined): number | undefined {
  if (!s) return undefined;
  const m = s.replace(/[₹,\s]|INR|Rs\.?/gi, '').match(/-?\d+(?:\.\d+)?/);
  const n = m ? Number(m[0]) : NaN;
  return Number.isFinite(n) ? n : undefined;
}

const MONTHS: Record<string, number> = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };

/** Parse admin timestamps ("05/09/2026 10:00 AM", "2026-09-05 10:00:00", "5 Sep 2026, 10:00") → ISO. */
export function parseAdminDate(s: string | undefined, tz = '+05:30'): string | undefined {
  if (!s) return undefined;
  const t = s.trim();
  if (/^\d{4}-\d{2}-\d{2}T.*(Z|[+-]\d{2}:?\d{2})$/.test(t)) return new Date(t).toISOString();
  let y: number | undefined, mo: number | undefined, d: number | undefined;
  let m = t.match(/(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (m) [y, mo, d] = [+m[1]!, +m[2]!, +m[3]!];
  else if ((m = t.match(/(\d{1,2})[/.-](\d{1,2})[/.-](\d{2,4})/))) [d, mo, y] = [+m[1]!, +m[2]!, +m[3]!];
  else if ((m = t.match(/(\d{1,2})\s+([A-Za-z]{3})[a-z]*\.?,?\s+(\d{4})/))) [d, mo, y] = [+m[1]!, MONTHS[m[2]!.toLowerCase()], +m[3]!];
  if (!y || !mo || !d) return undefined;
  if (y < 100) y += 2000;
  const tm = t.match(/(\d{1,2}):(\d{2})(?::(\d{2}))?\s*(am|pm)?/i);
  let hh = tm ? +tm[1]! : 0;
  const mm = tm ? +tm[2]! : 0;
  const ss = tm?.[3] ? +tm[3] : 0;
  if (tm?.[4]) hh = (hh % 12) + (/pm/i.test(tm[4]) ? 12 : 0);
  const iso = `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}T${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}:${String(ss).padStart(2, '0')}${tz}`;
  const dt = new Date(iso);
  return Number.isNaN(dt.getTime()) ? undefined : dt.toISOString();
}

/**
 * Runs inside the browser: collect label/value pairs from common admin layouts
 * (dl/dt/dd, two-cell table rows, label+value siblings, "Label: value" lines).
 */
export const COLLECT_PAIRS_SCRIPT = `(root) => {
  const pairs = [];
  const text = (el) => (el?.innerText ?? el?.textContent ?? '').replace(/\\s+/g, ' ').trim();
  root.querySelectorAll('dt').forEach((dt) => { const dd = dt.nextElementSibling; if (dd && dd.tagName === 'DD') pairs.push({ label: text(dt), value: text(dd) }); });
  root.querySelectorAll('tr').forEach((tr) => { const cells = tr.querySelectorAll('th,td'); if (cells.length === 2) pairs.push({ label: text(cells[0]), value: text(cells[1]) }); });
  root.querySelectorAll('label, .label, [class*="label"], strong, b').forEach((l) => {
    const sib = l.nextElementSibling;
    if (sib) pairs.push({ label: text(l), value: sib.value ?? text(sib) });
  });
  (root.innerText ?? '').split(/\\n/).forEach((line) => { const m = line.match(/^([A-Za-z][A-Za-z /#().-]{1,40}):\\s*(.+)$/); if (m) pairs.push({ label: m[1], value: m[2] }); });
  return pairs.filter((p) => p.label && p.label.length <= 60);
}`;

export const COLLECT_TABLE_SCRIPT = `(table) => {
  const text = (el) => (el?.innerText ?? el?.textContent ?? '').replace(/\\s+/g, ' ').trim();
  const headRow = table.querySelector('thead tr') ?? table.querySelector('tr');
  const headers = headRow ? Array.from(headRow.querySelectorAll('th,td')).map(text) : [];
  const bodyRows = Array.from(table.querySelectorAll('tbody tr')).filter((r) => r !== headRow);
  const rows = (bodyRows.length ? bodyRows : Array.from(table.querySelectorAll('tr')).slice(1)).map((r) => Array.from(r.querySelectorAll('td,th')).map(text));
  return { headers, rows };
}`;
