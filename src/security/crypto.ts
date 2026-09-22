import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';

/**
 * AES-256-GCM envelope for secrets at rest (Telegram session strings, admin storage state).
 * Format: base64( "v1" | iv(12) | tag(16) | ciphertext )
 */
const VERSION = Buffer.from('v1');

function deriveKey(material: string): Buffer {
  // Accept 32-byte hex/base64 keys directly; otherwise stretch the passphrase with SHA-256.
  if (/^[0-9a-f]{64}$/i.test(material)) return Buffer.from(material, 'hex');
  const b64 = Buffer.from(material, 'base64');
  if (b64.length === 32 && /^[A-Za-z0-9+/=]+$/.test(material)) return b64;
  return createHash('sha256').update(material, 'utf8').digest();
}

export function encryptSecret(plaintext: string, keyMaterial: string): string {
  const key = deriveKey(keyMaterial);
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return Buffer.concat([VERSION, iv, cipher.getAuthTag(), ct]).toString('base64');
}

export function decryptSecret(envelope: string, keyMaterial: string): string {
  const raw = Buffer.from(envelope.trim(), 'base64');
  if (raw.length < 30 || !raw.subarray(0, 2).equals(VERSION)) throw new Error('Unrecognised secret envelope');
  const iv = raw.subarray(2, 14);
  const tag = raw.subarray(14, 30);
  const ct = raw.subarray(30);
  const decipher = createDecipheriv('aes-256-gcm', deriveKey(keyMaterial), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8');
}

export function sha256(data: Buffer | string): string {
  return createHash('sha256').update(data).digest('hex');
}
