import pg from 'pg';
import type { Logger } from 'pino';
import type { Env } from '../config/env.js';
import { MemoryQueue } from '../queue/memory.js';
import { PostgresQueue } from '../queue/postgres.js';
import type { Queue } from '../queue/types.js';
import { MemoryStore } from './memory.js';
import { PostgresStore, type PoolLike } from './postgres.js';
import type { Store } from './types.js';

export * from './types.js';
export { MemoryStore } from './memory.js';
export { PostgresStore } from './postgres.js';

/** The job queue lives next to the data: Postgres-backed when the store is, in-memory otherwise. */
export function createQueue(store: Store): Queue {
  return store instanceof PostgresStore ? new PostgresQueue(store.pool) : new MemoryQueue();
}

export async function createStore(env: Env, log: Logger): Promise<Store> {
  if (env.STORE === 'memory') {
    log.warn('Using in-memory store: state is lost on restart (development only)');
    return new MemoryStore();
  }
  const pool = new pg.Pool({ connectionString: env.DATABASE_URL, max: env.DATABASE_POOL_MAX });
  pool.on('error', (err) => log.error({ err }, 'postgres pool error'));
  const store = new PostgresStore(pool as unknown as PoolLike);
  await store.migrate(log);
  return store;
}
