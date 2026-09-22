/**
 * Interactive one-time authorisation of the Telegram user account.
 *   npm run telegram:login
 * Writes an AES-256-GCM encrypted session to TELEGRAM_SESSION_FILE. Never prints the session,
 * the API hash, the login code or the 2FA password.
 */
import 'dotenv/config';
import { TelegramClient, sessions } from 'telegram';
import { loadEnv, secretValues } from '../../config/env.js';
import { scrubber } from '../../security/scrubber.js';
import { prompt } from './prompt.js';
import { EncryptedFileSessionStore } from './sessionStore.js';

async function main() {
  const env = loadEnv(process.env, ['telegram']);
  scrubber.register(...secretValues(env));
  if (!env.TELEGRAM_API_ID || !env.TELEGRAM_API_HASH || !env.SESSION_ENCRYPTION_KEY) {
    throw new Error('TELEGRAM_API_ID, TELEGRAM_API_HASH and SESSION_ENCRYPTION_KEY must be set in .env');
  }
  const store = new EncryptedFileSessionStore(env.TELEGRAM_SESSION_FILE, env.SESSION_ENCRYPTION_KEY);
  const client = new TelegramClient(new sessions.StringSession(''), env.TELEGRAM_API_ID, env.TELEGRAM_API_HASH, {
    connectionRetries: 5,
  });
  client.setLogLevel('error' as never);

  await client.start({
    phoneNumber: async () => env.TELEGRAM_PHONE ?? (await prompt('Phone number (with country code): ')),
    phoneCode: async () => prompt('Login code sent by Telegram: ', { hidden: true }),
    password: async (hint?: string) => prompt(`Two-step verification password${hint ? ` (hint: ${hint})` : ''}: `, { hidden: true }),
    onError: async (err: Error) => {
      console.error(`Login error: ${scrubber.scrub(err.message)}`);
      return false; // keep trying (e.g. wrong code)
    },
  });

  const me = await client.getMe();
  await store.save(client.session.save() as unknown as string);
  console.log(`Authorised as ${'username' in me && me.username ? '@' + me.username : 'user'}; encrypted session saved to ${env.TELEGRAM_SESSION_FILE}`);
  await client.disconnect();
  process.exit(0);
}

main().catch((err) => {
  console.error(scrubber.scrub(err instanceof Error ? err.message : String(err)));
  process.exit(1);
});
