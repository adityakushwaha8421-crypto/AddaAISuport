import type { Queryable } from '../storage/migrate.js';
import type { EnqueueInput, Job, JobStats, JobType, MergeInput, Queue } from './types.js';

/** A pool-like object: pg.Pool in production, pg-mem's adapter in tests. */
export interface QueuePool extends Queryable {
  connect(): Promise<Queryable & { release(): void }>;
}

const toJob = (r: Record<string, unknown>): Job => ({
  id: String(r.id),
  type: r.type as JobType,
  orderingKey: String(r.ordering_key),
  payload: typeof r.payload === 'string' ? (JSON.parse(r.payload) as Record<string, unknown>) : ((r.payload as Record<string, unknown>) ?? {}),
  attempts: Number(r.attempts),
  runAt: new Date(r.run_at as string),
  createdAt: new Date(r.created_at as string),
});

/**
 * The jobs table as a queue shared by every process. Claiming is one atomic UPDATE guarded by
 * `status = 'pending'`, so two workers can never take the same job; `FOR UPDATE SKIP LOCKED`
 * (real Postgres) only stops them from queueing on the same row.
 */
export class PostgresQueue implements Queue {
  private readonly skipLocked: string;

  constructor(private readonly db: QueuePool, opts: { skipLocked?: boolean; clock?: () => Date } = {}) {
    this.skipLocked = opts.skipLocked === false ? '' : ' FOR UPDATE SKIP LOCKED';
    this.clock = opts.clock ?? (() => new Date());
  }
  private readonly clock: () => Date;

  async enqueue(input: EnqueueInput) {
    if (input.idempotencyKey) {
      // Looked up first: the unique index is the guarantee, this keeps the common case cheap and
      // survives drivers that report the conflicting row as "returned".
      const dup = await this.db.query(`SELECT id FROM jobs WHERE idempotency_key = $1`, [input.idempotencyKey]);
      if (dup.rows[0]) return { id: String(dup.rows[0].id), created: false };
    }
    const { rows } = await this.db.query(
      `INSERT INTO jobs (type, ordering_key, payload, run_at, idempotency_key)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (idempotency_key) DO NOTHING
       RETURNING id`,
      [input.type, input.orderingKey, JSON.stringify(input.payload), input.runAt ?? this.clock(), input.idempotencyKey ?? null],
    );
    if (rows[0]) return { id: String(rows[0].id), created: true };
    const existing = await this.db.query(`SELECT id FROM jobs WHERE idempotency_key = $1`, [input.idempotencyKey]);
    return { id: String(existing.rows[0]?.id ?? ''), created: false };
  }

  async enqueueOrMerge(input: MergeInput) {
    const conn = await this.db.connect();
    try {
      await conn.query('BEGIN');
      const { rows } = await conn.query(
        `SELECT id, payload FROM jobs WHERE status = 'pending' AND type = $1 AND ordering_key = $2 ORDER BY id DESC LIMIT 1 FOR UPDATE`,
        [input.type, input.orderingKey],
      );
      if (rows[0]) {
        const existing = toJob({ ...rows[0], type: input.type, ordering_key: input.orderingKey, attempts: 0, run_at: 0, created_at: 0 }).payload;
        let runAt = input.runAt ?? this.clock();
        if (input.maxRunAt && runAt > input.maxRunAt) runAt = input.maxRunAt;
        await conn.query(`UPDATE jobs SET payload = $2, run_at = $3 WHERE id = $1`, [rows[0].id, JSON.stringify(input.merge(existing)), runAt]);
        await conn.query('COMMIT');
        return { id: String(rows[0].id), merged: true };
      }
      const ins = await conn.query(
        `INSERT INTO jobs (type, ordering_key, payload, run_at, idempotency_key) VALUES ($1, $2, $3, $4, $5) RETURNING id`,
        [input.type, input.orderingKey, JSON.stringify(input.payload), input.runAt ?? this.clock(), input.idempotencyKey ?? null],
      );
      await conn.query('COMMIT');
      return { id: String(ins.rows[0].id), merged: false };
    } catch (err) {
      await conn.query('ROLLBACK').catch(() => undefined);
      throw err;
    } finally {
      conn.release();
    }
  }

  async claim(worker: string, leaseMs: number, types?: JobType[]) {
    const now = this.clock();
    const typeFilter = types?.length ? ` AND type IN (${types.map((_, i) => `$${i + 2}`).join(',')})` : '';
    // Oldest runnable job per ordering key, keys with a running job excluded.
    const { rows } = await this.db.query(
      `SELECT id FROM jobs
       WHERE status = 'pending' AND run_at <= $1${typeFilter}
         AND ordering_key NOT IN (SELECT ordering_key FROM jobs WHERE status = 'running')
         AND id IN (SELECT min(id) FROM jobs WHERE status = 'pending' GROUP BY ordering_key)
       ORDER BY id LIMIT 1${this.skipLocked}`,
      [now, ...(types ?? [])],
    );
    if (!rows[0]) return undefined;
    const claimed = await this.db.query(
      `UPDATE jobs SET status = 'running', worker = $2, leased_until = $3, attempts = attempts + 1
       WHERE id = $1 AND status = 'pending' RETURNING *`,
      [rows[0].id, worker, new Date(now.getTime() + leaseMs)],
    );
    return claimed.rows[0] ? toJob(claimed.rows[0]) : undefined; // lost the race: the caller polls again
  }

  async heartbeat(id: string, worker: string, leaseMs: number) {
    const { rowCount } = await this.db.query(
      `UPDATE jobs SET leased_until = $3 WHERE id = $1 AND worker = $2 AND status = 'running'`,
      [id, worker, new Date(this.clock().getTime() + leaseMs)],
    );
    return (rowCount ?? 0) > 0;
  }

  async complete(id: string, worker: string) {
    await this.db.query(`DELETE FROM jobs WHERE id = $1 AND worker = $2 AND status = 'running'`, [id, worker]);
  }

  async fail(id: string, worker: string, error: string, retryAt?: Date) {
    await this.db.query(
      `UPDATE jobs SET status = $3, run_at = $4, worker = NULL, leased_until = NULL, last_error = $5
       WHERE id = $1 AND worker = $2 AND status = 'running'`,
      [id, worker, retryAt ? 'pending' : 'dead', retryAt ?? this.clock(), error.slice(0, 500)],
    );
  }

  async release(id: string, worker: string, runAt: Date) {
    await this.db.query(
      `UPDATE jobs SET status = 'pending', run_at = $3, worker = NULL, leased_until = NULL, attempts = GREATEST(attempts - 1, 0)
       WHERE id = $1 AND worker = $2 AND status = 'running'`,
      [id, worker, runAt],
    );
  }

  async reapExpired(now = this.clock()) {
    const { rowCount } = await this.db.query(
      `UPDATE jobs SET status = 'pending', worker = NULL, leased_until = NULL, last_error = 'lease expired'
       WHERE status = 'running' AND leased_until < $1`,
      [now],
    );
    return rowCount ?? 0;
  }

  async stats(): Promise<JobStats> {
    const { rows } = await this.db.query(`SELECT status, count(*)::int AS n FROM jobs GROUP BY status`);
    const s: JobStats = { pending: 0, running: 0, dead: 0, failed: 0 };
    for (const r of rows) if (r.status in s) s[r.status as keyof JobStats] = Number(r.n);
    const failed = await this.db.query(`SELECT count(*)::int AS n FROM jobs WHERE status = 'pending' AND last_error IS NOT NULL`);
    s.failed = Number(failed.rows[0]?.n ?? 0);
    return s;
  }
}
