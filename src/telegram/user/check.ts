/**
 * Verify the Telegram account setup without starting the agent:
 *   npm run telegram:check
 * Checks the session is authorised, shows which account it is, and whether SUPPORT_GROUP_CHAT_ID
 * resolves. Prints no secrets.
 */
import 'dotenv/config';
import bigInt from 'big-integer';
import { Api, Logger, TelegramClient, sessions } from 'telegram';
import { LogLevel } from 'telegram/extensions/Logger.js';
import { loadEnv, secretValues } from '../../config/env.js';
import { scrubber } from '../../security/scrubber.js';
import { BootstrapSessionStore, EncryptedFileSessionStore } from './sessionStore.js';
import { parseAllowedUsers } from './userTransport.js';

async function main() {
  const env = loadEnv(process.env, ['telegram']);
  scrubber.register(...secretValues(env));
  const store = new BootstrapSessionStore(new EncryptedFileSessionStore(env.TELEGRAM_SESSION_FILE, env.SESSION_ENCRYPTION_KEY!), env.TELEGRAM_SESSION);
  const session = await store.load();
  if (!session) throw new Error('No session. Run `npm run telegram:login` (or set TELEGRAM_SESSION).');

  const client = new TelegramClient(new sessions.StringSession(session), env.TELEGRAM_API_ID!, env.TELEGRAM_API_HASH!, {
    connectionRetries: 3,
    baseLogger: new Logger(LogLevel.ERROR),
  });
  try {
    await client.connect();
    if (!(await client.checkAuthorization())) {
      console.log('✗ Session is NOT authorised (revoked or expired). Run `npm run telegram:login`.');
      process.exitCode = 1;
      return;
    }
    const me = (await client.getMe()) as Api.User;
    console.log(`✓ Session authorised: ${[me.firstName, me.lastName].filter(Boolean).join(' ')}${me.username ? ` (@${me.username})` : ''}, id ${me.id}`);
    console.log(`✓ Encrypted session file: ${env.TELEGRAM_SESSION_FILE}`);

    const allowed = parseAllowedUsers(env.TELEGRAM_ALLOWED_USERS);
    console.log(allowed ? `• Replies limited to: ${[...allowed].join(', ')}` : '• Replies: everyone who messages the account privately');
    console.log(`• Saved contacts ${env.TELEGRAM_IGNORE_CONTACTS ? 'are ignored' : 'also get AI replies'} (TELEGRAM_IGNORE_CONTACTS)`);

    const sg = env.SUPPORT_GROUP_CHAT_ID;
    if (!sg) {
      console.log('✗ SUPPORT_GROUP_CHAT_ID not set: handoffs cannot be delivered.');
      return;
    }
    await client.getDialogs({ limit: 200 });
    try {
      const e = await client.getEntity(bigInt(sg));
      if (e instanceof Api.User) {
        const self = e.id.toString() === me.id.toString();
        console.log(`⚠ SUPPORT_GROUP_CHAT_ID is a person${self ? ' — your own account (handoffs go to Saved Messages)' : `: ${e.firstName ?? ''}${e.username ? ` (@${e.username})` : ''}`}. A group (id starting with -100) is recommended.`);
      } else {
        const title = (e as Api.Chat | Api.Channel).title;
        console.log(`✓ Support chat: "${title}" (${e.className})`);
      }
    } catch {
      console.log(`✗ SUPPORT_GROUP_CHAT_ID ${sg} not found among this account's chats. Is the account a member?`);
    }
  } finally {
    await client.disconnect();
    await client.destroy().catch(() => undefined);
  }
}

main()
  .catch((err) => {
    console.error(scrubber.scrub(err instanceof Error ? err.message : String(err)));
    process.exitCode = 1;
  })
  .finally(() => setTimeout(() => process.exit(), 200));
