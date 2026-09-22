/**
 * One-time authorisation of the Telegram user account that produces a SESSION STRING:
 *   npm run telegram:session            → logs in, writes TELEGRAM_SESSION into .env
 *   npm run telegram:session -- --print → also prints the string (to move it to another machine)
 *
 * The string is equivalent to a logged-in device. It is written to .env (mode kept) and to
 * secrets/telegram.session.string (0600). Nothing else — not the code, the 2FA password or the
 * API hash — is ever printed.
 */
import 'dotenv/config';
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { TelegramClient, sessions } from 'telegram';
import { loadEnv, secretValues } from '../../config/env.js';
import { scrubber } from '../../security/scrubber.js';
import { prompt } from './prompt.js';

const ENV_PATH = resolve(process.cwd(), '.env');
const COPY_PATH = resolve(process.cwd(), 'secrets/telegram.session.string');

/** Set or replace TELEGRAM_SESSION in .env, leaving every other line as it is. */
async function writeEnv(session: string): Promise<'updated' | 'added' | 'created'> {
  let text = '';
  let existed = true;
  try {
    text = await readFile(ENV_PATH, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    existed = false;
  }
  const line = `TELEGRAM_SESSION=${session}`;
  const active = /^TELEGRAM_SESSION=.*$/m;
  const commented = /^#\s*TELEGRAM_SESSION=.*$/m;
  let out: string;
  let how: 'updated' | 'added' | 'created';
  if (active.test(text)) {
    out = text.replace(active, line);
    how = 'updated';
  } else if (commented.test(text)) {
    out = text.replace(commented, line);
    how = 'updated';
  } else {
    out = `${text.replace(/\s*$/, '')}\n${line}\n`;
    how = existed ? 'added' : 'created';
  }
  await writeFile(ENV_PATH, out, { encoding: 'utf8', mode: 0o600 });
  return how;
}

async function main() {
  const print = process.argv.includes('--print');
  // The old session (if any) must not be loaded: a fresh login is the point.
  const env = loadEnv({ ...process.env, TELEGRAM_SESSION: undefined, SESSION_ENCRYPTION_KEY: process.env.SESSION_ENCRYPTION_KEY || 'unused-for-string-sessions' }, ['telegram']);
  scrubber.register(...secretValues(env));
  if (!env.TELEGRAM_API_ID || !env.TELEGRAM_API_HASH) throw new Error('TELEGRAM_API_ID and TELEGRAM_API_HASH must be set in .env (https://my.telegram.org)');

  const client = new TelegramClient(new sessions.StringSession(''), env.TELEGRAM_API_ID, env.TELEGRAM_API_HASH, { connectionRetries: 5 });
  client.setLogLevel('error' as never);
  await client.start({
    phoneNumber: async () => env.TELEGRAM_PHONE ?? (await prompt('Phone number (with country code): ')),
    phoneCode: async () => prompt('Login code sent by Telegram: ', { hidden: true }),
    password: async (hint?: string) => prompt(`Two-step verification password${hint ? ` (hint: ${hint})` : ''}: `, { hidden: true }),
    onError: async (err: Error) => {
      console.error(`Login error: ${scrubber.scrub(err.message)}`);
      return false; // keep trying (e.g. a mistyped code)
    },
  });

  const me = await client.getMe();
  const session = client.session.save() as unknown as string;
  await client.disconnect();
  scrubber.register(session);

  const how = await writeEnv(session);
  await mkdir(dirname(COPY_PATH), { recursive: true, mode: 0o700 });
  await writeFile(COPY_PATH, `${session}\n`, { encoding: 'utf8', mode: 0o600 });
  await chmod(COPY_PATH, 0o600);

  const who = 'username' in me && me.username ? `@${me.username}` : 'the account';
  console.log(`Authorised as ${who}.`);
  console.log(`TELEGRAM_SESSION ${how} in ${ENV_PATH}; copy saved to ${COPY_PATH} (mode 0600).`);
  console.log('The agent now uses this session string directly. Start it with: npm start');
  if (print) {
    console.log('\nSession string (treat like a password — anyone holding it is logged in as you):');
    console.log(session);
  }
  process.exit(0);
}

main().catch((err) => {
  console.error(scrubber.scrub(err instanceof Error ? err.message : String(err)));
  process.exit(1);
});
