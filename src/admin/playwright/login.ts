/**
 * Establish (or refresh) the admin-panel browser session and verify the selectors work:
 *   npm run admin:login [-- WD-12345-67890]
 * Uses ADMIN_* credentials from .env; prints no secrets. Set ADMIN_HEADLESS=false to watch.
 */
import 'dotenv/config';
import { loadEnv, secretValues } from '../../config/env.js';
import { createLogger } from '../../observability/logger.js';
import { scrubber } from '../../security/scrubber.js';
import { loadAdminPanelConfig } from './config.js';
import { PlaywrightAdminGateway } from './gateway.js';

async function main() {
  const env = loadEnv({ ...process.env, ADMIN_MODE: 'playwright' }, ['admin']);
  scrubber.register(...secretValues(env));
  const log = createLogger({ level: 'info', pretty: true });
  const gw = new PlaywrightAdminGateway({
    baseUrl: env.ADMIN_BASE_URL!, username: env.ADMIN_USERNAME!, password: env.ADMIN_PASSWORD!,
    config: await loadAdminPanelConfig(env.ADMIN_CONFIG_FILE), storageStateFile: env.ADMIN_STORAGE_STATE_FILE,
    encryptionKey: env.SESSION_ENCRYPTION_KEY, headless: env.ADMIN_HEADLESS, timeoutMs: env.ADMIN_TIMEOUT_MS,
    executablePath: env.ADMIN_BROWSER_PATH, channel: env.ADMIN_BROWSER_CHANNEL, log,
  });
  try {
    await gw.loginOnce();
    log.info('admin login OK; session stored');
    const probe = process.argv[2];
    if (probe) {
      const r = await gw.findPayout(probe);
      log.info({ ok: r.ok, found: r.ok ? r.data !== null : undefined, status: r.ok ? r.data?.status : r.error }, 'probe lookup');
    }
  } finally {
    await gw.close();
  }
}

main().catch((err) => {
  console.error(scrubber.scrub(err instanceof Error ? err.message : String(err)));
  process.exit(1);
});
