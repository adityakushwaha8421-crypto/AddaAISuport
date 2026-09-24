import pg from 'pg';
import type { Logger } from 'pino';
import type { Env } from '../config/env.js';
import { MemoryStore } from './memory.js';
import { PostgresStore, type PoolLike } from './postgres.js';
import type { Store } from './types.js';

export * from './types.js';
export { MemoryStore } from './memory.js';
export { PostgresStore } from './postgres.js';

export async function createStore(env: Env, log: Logger): Promise<Store> {
  if (env.STORE === 'memory') {
    log.warn({ requestsFile: env.REQUESTS_STATE_FILE }, 'Using in-memory store: messages and users are lost on restart; the evidence-request ledger and the ON/OFF switch are kept on disk');
    return new MemoryStore({ requestsFile: env.REQUESTS_STATE_FILE });
  }
  const pool = new pg.Pool({ connectionString: env.DATABASE_URL, max: env.DATABASE_POOL_MAX });
  pool.on('error', (err) => log.error({ err }, 'postgres pool error'));
  const store = new PostgresStore(pool as unknown as PoolLike);
  await store.migrate(log);
  return store;
}
