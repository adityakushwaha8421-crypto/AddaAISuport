/**
 * PDF inspection: detects whether a PDF is actually password protected BEFORE ever asking the
 * user for a password, and extracts text lines (reading order: top→bottom, left→right).
 */

export type PdfInspection =
  | { status: 'ok'; pages: number; lines: string[]; encrypted: boolean }
  | { status: 'needs_password' }
  | { status: 'wrong_password' }
  | { status: 'unreadable'; reason: 'corrupt' | 'no_text_layer' | 'too_large' };

const MAX_PAGES = 30;

type PdfJs = typeof import('pdfjs-dist/legacy/build/pdf.mjs');
let pdfjsPromise: Promise<PdfJs> | undefined;
const loadPdfJs = () => (pdfjsPromise ??= import('pdfjs-dist/legacy/build/pdf.mjs'));

interface TextItem {
  str: string;
  transform: number[];
  width?: number;
}

/** Group positioned text items into visual lines. */
function itemsToLines(items: TextItem[]): string[] {
  const rows: Array<{ y: number; parts: Array<{ x: number; s: string; w: number }> }> = [];
  for (const it of items) {
    if (!it.str || !it.str.trim()) continue;
    const x = it.transform[4] ?? 0;
    const y = it.transform[5] ?? 0;
    let row = rows.find((r) => Math.abs(r.y - y) < 2.5);
    if (!row) rows.push((row = { y, parts: [] }));
    row.parts.push({ x, s: it.str, w: it.width ?? it.str.length * 4 });
  }
  return rows
    .sort((a, b) => b.y - a.y)
    .map((r) => {
      const parts = r.parts.sort((a, b) => a.x - b.x);
      let line = '';
      let end = -Infinity;
      for (const p of parts) {
        line += line && p.x - end > 12 ? '  ' : line ? ' ' : '';
        line += p.s.trim();
        end = p.x + p.w;
      }
      return line.replace(/\s{3,}/g, '  ').trim();
    })
    .filter(Boolean);
}

export async function inspectPdf(data: Buffer, password?: string): Promise<PdfInspection> {
  const { getDocument } = await loadPdfJs();
  // pdfjs detaches the array it is given: always pass a copy so the caller can retry passwords.
  const task = getDocument({
    data: new Uint8Array(data),
    password,
    verbosity: 0,
    disableFontFace: true,
    useSystemFonts: false,
  });
  let doc;
  try {
    doc = await task.promise;
  } catch (err) {
    await task.destroy().catch(() => undefined);
    const e = err as { name?: string; code?: number };
    if (e?.name === 'PasswordException') return e.code === 2 ? { status: 'wrong_password' } : { status: 'needs_password' };
    return { status: 'unreadable', reason: 'corrupt' };
  }
  try {
    if (doc.numPages > 200) return { status: 'unreadable', reason: 'too_large' };
    const lines: string[] = [];
    for (let i = 1; i <= Math.min(doc.numPages, MAX_PAGES); i++) {
      const page = await doc.getPage(i);
      const tc = await page.getTextContent();
      lines.push(...itemsToLines(tc.items as TextItem[]));
      page.cleanup();
    }
    if (lines.join('').replace(/\s/g, '').length < 20) return { status: 'unreadable', reason: 'no_text_layer' };
    return { status: 'ok', pages: doc.numPages, lines, encrypted: password !== undefined };
  } finally {
    await task.destroy();
  }
}
