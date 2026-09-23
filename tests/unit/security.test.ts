import { mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ConfigError, loadEnv, looksLikeSessionString, secretValues } from '../../src/config/env.js';
import { decryptSecret, encryptSecret } from '../../src/security/crypto.js';
import { maskAccount, maskName, maskPhone, shortMaskAccount } from '../../src/security/masking.js';
import { BootstrapSessionStore, EncryptedFileSessionStore, MemorySessionStore, sessionStoreFromEnv, StringSessionStore } from '../../src/telegram/user/sessionStore.js';

describe('secrets at rest', () => {
  it('round-trips AES-GCM envelopes and detects tampering / wrong keys', () => {
    const env = encryptSecret('1BVtsOK8Bu…session', 'passphrase-long-enough');
    expect(env).not.toContain('session');
    expect(decryptSecret(env, 'passphrase-long-enough')).toBe('1BVtsOK8Bu…session');
    expect(() => decryptSecret(env, 'another-passphrase')).toThrow();
    const raw = Buffer.from(env, 'base64');
    raw[raw.length - 1] = raw[raw.length - 1]! ^ 1;
    expect(() => decryptSecret(raw.toString('base64'), 'passphrase-long-enough')).toThrow();
  });

  it('stores the Telegram session encrypted with 0600 permissions', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'fa-sess-'));
    const file = join(dir, 'nested', 'tg.session.enc');
    const store = new EncryptedFileSessionStore(file, '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef');
    expect(await store.load()).toBeUndefined();
    await store.save('SESSION-STRING-VALUE');
    expect(readFileSync(file, 'utf8')).not.toContain('SESSION-STRING-VALUE');
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(await store.load()).toBe('SESSION-STRING-VALUE');
    await expect(new EncryptedFileSessionStore(file, 'a-different-key-entirely!').load()).rejects.toThrow(/could not be decrypted/);
    writeFileSync(file, 'garbage');
    await expect(store.load()).rejects.toThrow();
    expect(() => new EncryptedFileSessionStore(file, 'short')).toThrow();
  });
});

describe('session bootstrap', () => {
  const fakeSession = `1${'A'.repeat(351)}=`;

  it('imports TELEGRAM_SESSION into the encrypted store once, then uses the store', async () => {
    const file = new MemorySessionStore();
    expect(await new BootstrapSessionStore(file, fakeSession).load()).toBe(fakeSession);
    expect(await file.load()).toBe(fakeSession);
    await file.save('ROTATED');
    expect(await new BootstrapSessionStore(file, fakeSession).load()).toBe('ROTATED');
    expect(await new BootstrapSessionStore(new MemorySessionStore()).load()).toBeUndefined();
  });

  it('TELEGRAM_SESSION is used as is, and needs no encryption key or file', async () => {
    let changes = 0;
    const store = new StringSessionStore(fakeSession, () => changes++);
    expect(await store.load()).toBe(fakeSession);
    await store.save(fakeSession);
    expect(changes).toBe(0);
    await store.save('ROTATED');
    expect([changes, await store.load()]).toEqual([1, 'ROTATED']);
    expect(sessionStoreFromEnv({ TELEGRAM_SESSION: fakeSession, TELEGRAM_SESSION_FILE: 'x' })).toBeInstanceOf(StringSessionStore);
    expect(sessionStoreFromEnv({ TELEGRAM_SESSION_FILE: 'x', SESSION_ENCRYPTION_KEY: 'k'.repeat(32) })).toBeInstanceOf(EncryptedFileSessionStore);
    expect(() => sessionStoreFromEnv({ TELEGRAM_SESSION_FILE: 'x' })).toThrow(/telegram:session/);
    const base = { NODE_ENV: 'production', STORE: 'memory', TELEGRAM_API_ID: '1', TELEGRAM_API_HASH: 'x'.repeat(32) };
    expect(() => loadEnv({ ...base, TELEGRAM_SESSION: fakeSession })).not.toThrow(); // no SESSION_ENCRYPTION_KEY needed
    expect(() => loadEnv({ ...base, TELEGRAM_SESSION: 'not-a-session' })).toThrow(/does not look like a Telegram session string/);
    expect(() => loadEnv(base)).toThrow(/TELEGRAM_SESSION.*or SESSION_ENCRYPTION_KEY/);
  });

  it('refuses a session string pasted into a path setting (it would become directory names on disk)', () => {
    const base = { NODE_ENV: 'production', STORE: 'memory', TELEGRAM_API_ID: '1', TELEGRAM_API_HASH: 'x'.repeat(32), TELEGRAM_SESSION: fakeSession };
    expect(() => loadEnv({ ...base, TELEGRAM_SESSION_FILE: fakeSession })).toThrow(/TELEGRAM_SESSION_FILE must be a file path/);
    expect(() => loadEnv({ ...base, INSTANCE_LOCK_FILE: 'a'.repeat(300) })).toThrow(/INSTANCE_LOCK_FILE must be a file path/);
    expect(loadEnv({ ...base, TELEGRAM_SESSION_FILE: 'secrets/telegram.session.enc' }).INSTANCE_LOCK_FILE).toBe('secrets/agent.lock');
  });

  it('rejects a session string pasted into SESSION_ENCRYPTION_KEY, with a fix-it message', () => {
    expect(looksLikeSessionString(fakeSession)).toBe(true);
    expect(looksLikeSessionString('0123456789abcdef'.repeat(4))).toBe(false);
    expect(() => loadEnv({ NODE_ENV: 'production', STORE: 'memory', TELEGRAM_API_ID: '1', TELEGRAM_API_HASH: 'x'.repeat(32), SESSION_ENCRYPTION_KEY: fakeSession }))
      .toThrow(/move it to TELEGRAM_SESSION/);
  });
});

describe('masking', () => {
  it('masks accounts, phones and names', () => {
    expect(maskAccount('50100123456789')).toBe('XXXXXXXXXX6789');
    expect(shortMaskAccount('50100123456789')).toBe('XXXX6789');
    expect(shortMaskAccount('XXXXXX6789')).toBe('XXXX6789');
    expect(maskPhone('9810822372')).toBe('98XXXXXX72');
    expect(maskName('Rahul Kumar')).toBe('R***l K***r');
  });
});

describe('environment', () => {
  const account = { NODE_ENV: 'production', STORE: 'memory', TELEGRAM_API_ID: '12345', TELEGRAM_API_HASH: 'deadbeefcafebabe', SESSION_ENCRYPTION_KEY: 'k'.repeat(32) };

  it('requires the Telegram account credentials and never echoes secret values', () => {
    expect(() => loadEnv({ NODE_ENV: 'production', STORE: 'memory' })).toThrow(ConfigError);
    expect(() => loadEnv({ ...account, TELEGRAM_API_ID: undefined })).toThrow(/TELEGRAM_API_ID/);
    try {
      loadEnv({ ...account, SESSION_ENCRYPTION_KEY: undefined, STORE: 'postgres' });
      expect.unreachable();
    } catch (e) {
      expect((e as Error).message).toMatch(/SESSION_ENCRYPTION_KEY/);
      expect((e as Error).message).toMatch(/DATABASE_URL/);
      expect((e as Error).message).not.toContain('deadbeefcafebabe');
    }
    expect(secretValues(loadEnv(account))).toEqual(expect.arrayContaining(['deadbeefcafebabe', 'k'.repeat(32)]));
  });

  it('lets CLI tools require only what they use', () => {
    expect(() => loadEnv({ NODE_ENV: 'production', STORE: 'postgres' }, ['store'])).toThrow(/DATABASE_URL/);
    expect(loadEnv({ NODE_ENV: 'production' }, []).STORE).toBe('postgres');
  });
});

describe('single instance per Telegram account', () => {
  it('refuses a second live instance and replaces stale locks', async () => {
    const { acquireInstanceLock, AlreadyRunningError } = await import('../../src/util/instanceLock.js');
    const dir = mkdtempSync(join(tmpdir(), 'fa-lock-'));
    const lock = join(dir, 'tg.session.enc.lock');
    writeFileSync(lock, String(process.ppid)); // a live process that isn't us
    expect(() => acquireInstanceLock(lock)).toThrow(AlreadyRunningError);
    writeFileSync(lock, '999999'); // dead pid → stale
    const release = acquireInstanceLock(lock);
    expect(readFileSync(lock, 'utf8')).toBe(String(process.pid));
    release();
    expect(() => readFileSync(lock)).toThrow();
  });
});
