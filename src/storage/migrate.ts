import type { Logger } from 'pino';
import { MIGRATIONS } from './migrations.js';

/** Minimal query surface shared by pg.Pool and pg-mem adapters. */
export interface Queryable {
  query(text: string, params?: unknown[]): Promise<{ rows: any[]; rowCount: number | null }>;
}

/** `db` must be a single connection (not a pool) so BEGIN/COMMIT apply to the same session. */
export async function migrate(db: Queryable, log?: Logger): Promise<string[]> {
  await db.query(
    `CREATE TABLE IF NOT EXISTS schema_migrations (id text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`,
  );
  const { rows } = await db.query(`SELECT id FROM schema_migrations`);
  const applied = new Set(rows.map((r) => r.id as string));
  const ran: string[] = [];
  for (const m of MIGRATIONS) {
    if (applied.has(m.id)) continue;
    await db.query('BEGIN');
    try {
      await db.query(m.sql);
      await db.query(`INSERT INTO schema_migrations (id) VALUES ($1)`, [m.id]);
      await db.query('COMMIT');
      ran.push(m.id);
      log?.info({ migration: m.id }, 'migration applied');
    } catch (err) {
      await db.query('ROLLBACK');
      throw err;
    }
  }
  return ran;
}
