import { describe, expect, it } from 'vitest';
import { extractPassword, PASSWORD_PLACEHOLDER } from '../../src/nlu/password.js';
import { SecretScrubber } from '../../src/security/scrubber.js';

describe('PDF password parsing', () => {
  it.each([
    'Password:- YENU1304',
    'Password: YENU1304',
    'PDF Password:- YENU1304',
    'password = YENU1304',
    'password YENU1304',
    'The password is YENU1304',
    'password hai YENU1304 sir',
    'pwd: YENU1304',
    'पासवर्ड YENU1304',
  ])('explicit: %s', (text) => {
    const r = extractPassword(text, { awaitingPassword: false });
    expect(r.candidates).toEqual(['YENU1304']);
    expect(r.explicit).toBe(true);
    expect(r.redactedText).not.toContain('YENU1304');
    expect(r.redactedText).toContain(PASSWORD_PLACEHOLDER);
  });

  it('takes a bare token as the password only while waiting for one', () => {
    expect(extractPassword('YENU1304', { awaitingPassword: true }).candidates).toEqual(['YENU1304']);
    expect(extractPassword('YENU1304', { awaitingPassword: false }).candidates).toEqual([]);
  });

  it('picks the password-looking token from a short sentence while waiting', () => {
    const r = extractPassword('ye lo ABCD1234', { awaitingPassword: true });
    expect(r.candidates).toEqual(['ABCD1234']);
    expect(r.redactedText).toBe(`ye lo ${PASSWORD_PLACEHOLDER}`);
  });

  it.each(['password protected hai', 'password kya hai', 'password chahiye kya', 'mere pass statement nahi hai', 'ok', 'haan'])(
    'no false positive: %s',
    (text) => {
      expect(extractPassword(text, { awaitingPassword: text.length < 5 }).candidates).toEqual([]);
    },
  );

  it.each(['skip', 'password nahi hai', 'password mujhe nahi pata', 'no password'])('detects skip: %s', (text) => {
    const r = extractPassword(text, { awaitingPassword: true });
    expect(r.skip).toBe(true);
    expect(r.candidates).toEqual([]);
  });
});

describe('secret scrubber', () => {
  const s = new SecretScrubber();
  s.register('super-secret-admin-pw');
  it('masks registered values and typed secrets', () => {
    expect(s.scrub('login with super-secret-admin-pw')).toBe('login with [REDACTED]');
    expect(s.scrub('PDF Password:- YENU1304')).not.toContain('YENU1304');
    expect(s.scrub('otp 482913')).toBe('otp [REDACTED]');
    expect(s.scrub('postgres://app:hunter2@db/x')).toBe('postgres://app:[REDACTED]@db/x');
  });
  it('keeps Hinglish "pass" (near) intact', () => {
    expect(s.scrub('mere pass statement nahi hai')).toBe('mere pass statement nahi hai');
  });
  it('deep-scrubs objects and masks sensitive keys', () => {
    const out = s.scrubDeep({ password: 'x', nested: { note: 'password: abc123' }, err: new Error('boom') });
    expect(out.password).toBe('[REDACTED]');
    expect(out.nested.note).not.toContain('abc123');
    expect(out.err).toBeInstanceOf(Error);
  });
});
