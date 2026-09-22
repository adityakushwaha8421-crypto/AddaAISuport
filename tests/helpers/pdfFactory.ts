import { createHash, randomBytes } from 'node:crypto';

/**
 * Builds small single-page text PDFs for tests, optionally encrypted with the PDF Standard
 * Security Handler (RC4 128-bit, V=2 R=3) — the same scheme many bank e-statements use.
 */

const PAD = Buffer.from('28BF4E5E4E758A4164004E56FFFA01082E2E00B6D0683E802F0CA9FE6453697A', 'hex');

const md5 = (...parts: Buffer[]) => {
  const h = createHash('md5');
  for (const p of parts) h.update(p);
  return h.digest();
};

function rc4(key: Buffer, data: Buffer): Buffer {
  const s = Array.from({ length: 256 }, (_, i) => i);
  let j = 0;
  for (let i = 0; i < 256; i++) {
    j = (j + s[i]! + key[i % key.length]!) & 255;
    [s[i], s[j]] = [s[j]!, s[i]!];
  }
  const out = Buffer.alloc(data.length);
  let i = 0;
  j = 0;
  for (let k = 0; k < data.length; k++) {
    i = (i + 1) & 255;
    j = (j + s[i]!) & 255;
    [s[i], s[j]] = [s[j]!, s[i]!];
    out[k] = data[k]! ^ s[(s[i]! + s[j]!) & 255]!;
  }
  return out;
}

const padPassword = (pw: string) => Buffer.concat([Buffer.from(pw, 'latin1'), PAD]).subarray(0, 32);
const xorKey = (key: Buffer, i: number) => Buffer.from(key.map((b) => b ^ i));

function computeO(owner: string, user: string, n = 16): Buffer {
  let h = md5(padPassword(owner));
  for (let i = 0; i < 50; i++) h = md5(h.subarray(0, n));
  const key = h.subarray(0, n);
  let out = rc4(key, padPassword(user));
  for (let i = 1; i <= 19; i++) out = rc4(xorKey(key, i), out);
  return out;
}

function computeKey(user: string, o: Buffer, p: number, id: Buffer, n = 16): Buffer {
  const pBuf = Buffer.alloc(4);
  pBuf.writeInt32LE(p);
  let h = md5(padPassword(user), o, pBuf, id);
  for (let i = 0; i < 50; i++) h = md5(h.subarray(0, n));
  return h.subarray(0, n);
}

function computeU(key: Buffer, id: Buffer): Buffer {
  let out = rc4(key, md5(PAD, id));
  for (let i = 1; i <= 19; i++) out = rc4(xorKey(key, i), out);
  return Buffer.concat([out, Buffer.alloc(16)]);
}

const objectKey = (key: Buffer, num: number, gen: number) => {
  const b = Buffer.from([num & 255, (num >> 8) & 255, (num >> 16) & 255, gen & 255, (gen >> 8) & 255]);
  return md5(key, b).subarray(0, Math.min(key.length + 5, 16));
};

const escapePdf = (s: string) => s.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');

export function buildPdf(lines: string[], opts: { userPassword?: string } = {}): Buffer {
  const content = Buffer.from(
    `BT /F1 9 Tf 36 800 Td 12 TL\n${lines.map((l) => `(${escapePdf(l)}) Tj T*`).join('\n')}\nET`,
    'latin1',
  );
  const id = randomBytes(16);
  const P = -3904;
  let encrypt: { o: Buffer; u: Buffer; key: Buffer } | undefined;
  if (opts.userPassword !== undefined) {
    const o = computeO(`${opts.userPassword}-owner`, opts.userPassword);
    const key = computeKey(opts.userPassword, o, P, id);
    encrypt = { o, u: computeU(key, id), key };
  }
  const stream = encrypt ? rc4(objectKey(encrypt.key, 4, 0), content) : content;

  const objects: Buffer[] = [
    Buffer.from('<< /Type /Catalog /Pages 2 0 R >>'),
    Buffer.from('<< /Type /Pages /Kids [3 0 R] /Count 1 >>'),
    Buffer.from('<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>'),
    Buffer.concat([Buffer.from(`<< /Length ${stream.length} >>\nstream\n`), stream, Buffer.from('\nendstream')]),
    Buffer.from('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>'),
  ];
  if (encrypt) {
    objects.push(
      Buffer.from(`<< /Filter /Standard /V 2 /R 3 /Length 128 /P ${P} /O <${encrypt.o.toString('hex')}> /U <${encrypt.u.toString('hex')}> >>`),
    );
  }

  const chunks: Buffer[] = [Buffer.from('%PDF-1.4\n%\xE2\xE3\xCF\xD3\n', 'latin1')];
  const offsets: number[] = [];
  let pos = chunks[0]!.length;
  objects.forEach((body, i) => {
    offsets.push(pos);
    const obj = Buffer.concat([Buffer.from(`${i + 1} 0 obj\n`), body, Buffer.from('\nendobj\n')]);
    chunks.push(obj);
    pos += obj.length;
  });
  const xref = [
    'xref',
    `0 ${objects.length + 1}`,
    '0000000000 65535 f ',
    ...offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n `),
  ].join('\n');
  const trailer =
    `\ntrailer\n<< /Size ${objects.length + 1} /Root 1 0 R ${encrypt ? `/Encrypt ${objects.length} 0 R ` : ''}` +
    `/ID [<${id.toString('hex')}> <${id.toString('hex')}>] >>\nstartxref\n${pos}\n%%EOF\n`;
  chunks.push(Buffer.from(xref + trailer));
  return Buffer.concat(chunks);
}
