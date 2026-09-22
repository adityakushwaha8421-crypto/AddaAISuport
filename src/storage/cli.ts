/** npm run db:migrate — apply pending schema migrations. */
import 'dotenv/config';
import pg from 'pg';
import { createLogger } from '../observability/logger.js';
import { PostgresStore, type PoolLike } from './postgres.js';

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is not set');
  const log = createLogger({ level: 'info', pretty: true });
  const store = new PostgresStore(new pg.Pool({ connectionString: url, max: 1 }) as unknown as PoolLike);
  const ran = await store.migrate(log);
  log.info({ applied: ran }, ran.length ? 'migrations applied' : 'schema up to date');
  await store.close();
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message.replace(/\/\/[^@\s]+@/g, '//[REDACTED]@') : err);
  process.exit(1);
});
