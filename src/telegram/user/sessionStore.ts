import { chmod, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { decryptSecret, encryptSecret } from '../../security/crypto.js';

/**
 * Where the Telegram user-account session lives. The session string is equivalent to a logged-in
 * device: it is only ever held in memory or written encrypted with mode 0600. It is never logged.
 */
export interface SessionStore {
  load(): Promise<string | undefined>;
  save(session: string): Promise<void>;
  clear(): Promise<void>;
}

export class EncryptedFileSessionStore implements SessionStore {
  constructor(
    private readonly path: string,
    private readonly keyMaterial: string,
  ) {
    if (!keyMaterial || keyMaterial.length < 16) throw new Error('SESSION_ENCRYPTION_KEY must be at least 16 characters');
  }

  async load(): Promise<string | undefined> {
    let raw: string;
    try {
      raw = await readFile(this.path, 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw err;
    }
    try {
      return decryptSecret(raw, this.keyMaterial);
    } catch {
      throw new Error(`Session file ${this.path} could not be decrypted (wrong SESSION_ENCRYPTION_KEY or corrupted file)`);
    }
  }

  async save(session: string): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
    const tmp = `${this.path}.${process.pid}.tmp`;
    await writeFile(tmp, encryptSecret(session, this.keyMaterial), { encoding: 'utf8', mode: 0o600 });
    await rename(tmp, this.path); // atomic replace
    await chmod(this.path, 0o600);
  }

  async clear(): Promise<void> {
    await rm(this.path, { force: true });
  }
}

/** For tests / ephemeral runs. */
export class MemorySessionStore implements SessionStore {
  private value: string | undefined;
  constructor(initial?: string) {
    this.value = initial;
  }
  async load() {
    return this.value;
  }
  async save(session: string) {
    this.value = session;
  }
  async clear() {
    this.value = undefined;
  }
}

/**
 * The session string itself, from TELEGRAM_SESSION in .env — the simplest setup: no encryption key,
 * no session file. Telegram string sessions do not change after login, so a changed session at
 * runtime is only reported (never written back into .env, never logged).
 */
export class StringSessionStore implements SessionStore {
  private current: string;
  constructor(session: string, private readonly onChange?: () => void) {
    this.current = session.trim();
    if (!this.current) throw new Error('TELEGRAM_SESSION is empty');
  }
  async load() {
    return this.current;
  }
  async save(session: string) {
    if (session === this.current) return;
    this.current = session;
    this.onChange?.();
  }
  async clear() {
    /* the string lives in .env: nothing to delete here */
  }
}

/**
 * Which store the configuration calls for: TELEGRAM_SESSION set → the string, as is; otherwise the
 * encrypted session file (needs SESSION_ENCRYPTION_KEY, written by `npm run telegram:login`).
 */
export function sessionStoreFromEnv(env: { TELEGRAM_SESSION?: string; TELEGRAM_SESSION_FILE: string; SESSION_ENCRYPTION_KEY?: string }, onStringChange?: () => void): SessionStore {
  if (env.TELEGRAM_SESSION?.trim()) return new StringSessionStore(env.TELEGRAM_SESSION, onStringChange);
  if (!env.SESSION_ENCRYPTION_KEY) throw new Error('Set TELEGRAM_SESSION (npm run telegram:session) or SESSION_ENCRYPTION_KEY + npm run telegram:login');
  return new EncryptedFileSessionStore(env.TELEGRAM_SESSION_FILE, env.SESSION_ENCRYPTION_KEY);
}

/**
 * Uses the encrypted session file when present; otherwise bootstraps from a session string
 * supplied via TELEGRAM_SESSION and immediately stores it (encrypted) in the file.
 */
export class BootstrapSessionStore implements SessionStore {
  constructor(
    private readonly file: SessionStore,
    private readonly bootstrap?: string,
  ) {}

  async load(): Promise<string | undefined> {
    const stored = await this.file.load();
    if (stored) return stored;
    if (!this.bootstrap) return undefined;
    await this.file.save(this.bootstrap);
    return this.bootstrap;
  }

  save(session: string) {
    return this.file.save(session);
  }

  clear() {
    return this.file.clear();
  }
}
