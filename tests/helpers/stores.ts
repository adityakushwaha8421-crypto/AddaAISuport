import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { newDb } from 'pg-mem';
import { MemoryStore } from '../../src/storage/memory.js';
import { PostgresStore, type PoolLike } from '../../src/storage/postgres.js';
import type { Store } from '../../src/storage/types.js';

export interface StoreFactory {
  name: string;
  create(): Promise<Store>;
}

export const memoryFactory: StoreFactory = { name: 'memory', create: async () => new MemoryStore() };

export const pgMemFactory: StoreFactory = {
  name: 'pg-mem',
  async create() {
    const db = newDb();
    db.public.registerFunction({ name: 'now', returns: 'timestamptz' as any, implementation: () => new Date(), impure: true });
    const { Pool } = db.adapters.createPg();
    const store = new PostgresStore(new Pool() as unknown as PoolLike);
    await store.migrate();
    return store;
  },
};

/** Real Postgres, only when TEST_DATABASE_URL is provided. Each run uses a fresh schema. */
export const realPgFactory: StoreFactory | undefined = process.env.TEST_DATABASE_URL
  ? {
      name: 'postgres',
      async create() {
        const schema = `t_${randomUUID().replace(/-/g, '').slice(0, 12)}`;
        const admin = new pg.Client({ connectionString: process.env.TEST_DATABASE_URL });
        await admin.connect();
        await admin.query(`CREATE SCHEMA ${schema}`);
        await admin.end();
        const pool = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL, options: `-c search_path=${schema}` });
        const store = new PostgresStore(pool as unknown as PoolLike);
        await store.migrate();
        return store;
      },
    }
  : undefined;

export const allStoreFactories: StoreFactory[] = [memoryFactory, pgMemFactory, ...(realPgFactory ? [realPgFactory] : [])];
