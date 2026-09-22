import { newDb } from 'pg-mem';
import { describe, expect, it } from 'vitest';
import { MemoryQueue } from '../../src/queue/memory.js';
import { PostgresQueue } from '../../src/queue/postgres.js';
import { backoffMs, JobRunner } from '../../src/queue/runner.js';
import type { Queue } from '../../src/queue/types.js';
import { silentLogger } from '../../src/observability/logger.js';
import { PostgresStore, type PoolLike } from '../../src/storage/postgres.js';

let nowMs = Date.parse('2026-09-14T10:00:00Z');
const clock = () => new Date(nowMs);

const factories: Array<{ name: string; create: () => Promise<Queue> }> = [
  { name: 'memory', create: async () => new MemoryQueue(clock) },
  {
    name: 'postgres (pg-mem)',
    async create() {
      const db = newDb();
      db.public.registerFunction({ name: 'now', returns: 'timestamptz' as never, implementation: () => new Date(nowMs), impure: true });
      const { Pool } = db.adapters.createPg();
      const store = new PostgresStore(new Pool() as unknown as PoolLike);
      await store.migrate();
      return new PostgresQueue(store.pool, { skipLocked: false, clock });
    },
  },
];

describe.each(factories)('Queue contract: $name', ({ create }) => {
  it('claims in creation order and never two jobs of one ordering key at once', async () => {
    const q = await create();
    await q.enqueue({ type: 'turn', orderingKey: 'a', payload: { n: 1 } });
    await q.enqueue({ type: 'turn', orderingKey: 'a', payload: { n: 2 } });
    await q.enqueue({ type: 'turn', orderingKey: 'b', payload: { n: 3 } });
    const j1 = (await q.claim('w1', 60_000))!;
    expect(j1.payload).toEqual({ n: 1 });
    const j2 = (await q.claim('w2', 60_000))!;
    expect(j2.payload).toEqual({ n: 3 }); // 'a' is busy: the next key, not the next job
    expect(await q.claim('w3', 60_000)).toBeUndefined();
    await q.complete(j1.id, 'w1');
    expect((await q.claim('w3', 60_000))?.payload).toEqual({ n: 2 });
  });

  it('idempotency keys stop the same job being queued twice', async () => {
    const q = await create();
    const a = await q.enqueue({ type: 'export_message', orderingKey: 'x', payload: {}, idempotencyKey: 'export:1' });
    const b = await q.enqueue({ type: 'export_message', orderingKey: 'x', payload: {}, idempotencyKey: 'export:1' });
    expect(a.created).toBe(true);
    expect(b).toEqual({ id: a.id, created: false });
    expect((await q.stats()).pending).toBe(1);
  });

  it('merges a burst into one pending job, bounded by the first message max wait', async () => {
    const q = await create();
    const first = new Date(nowMs);
    const r1 = await q.enqueueOrMerge({ type: 'turn', orderingKey: 'c', payload: { ids: [1] }, runAt: new Date(nowMs + 1500), maxRunAt: new Date(first.getTime() + 5000), merge: (e) => ({ ids: [...(e.ids as number[]), 1] }) });
    nowMs += 1000;
    const r2 = await q.enqueueOrMerge({ type: 'turn', orderingKey: 'c', payload: { ids: [2] }, runAt: new Date(nowMs + 1500), maxRunAt: new Date(first.getTime() + 5000), merge: (e) => ({ ids: [...(e.ids as number[]), 2] }) });
    expect(r1.merged).toBe(false);
    expect(r2).toEqual({ id: r1.id, merged: true });
    expect(await q.claim('w', 60_000)).toBeUndefined(); // debounce not over
    nowMs += 1600;
    const job = (await q.claim('w', 60_000))!;
    expect(job.payload).toEqual({ ids: [1, 2] });
    // A running job is not merged into: the next message becomes a new job behind it.
    const r3 = await q.enqueueOrMerge({ type: 'turn', orderingKey: 'c', payload: { ids: [3] }, merge: (e) => e });
    expect(r3.merged).toBe(false);
  });

  it('a lost worker: the lease expires, the reaper returns the job, another worker finishes it', async () => {
    const q = await create();
    await q.enqueue({ type: 'turn', orderingKey: 'd', payload: { n: 1 } });
    const job = (await q.claim('dead', 1000))!;
    expect(await q.claim('alive', 1000)).toBeUndefined();
    nowMs += 1500;
    expect(await q.reapExpired(clock())).toBe(1);
    expect(await q.heartbeat(job.id, 'dead', 1000)).toBe(false); // the dead worker, if it comes back, learns it lost the lease
    const again = (await q.claim('alive', 1000))!;
    expect(again.id).toBe(job.id);
    expect(again.attempts).toBe(2);
    await q.complete(again.id, 'alive');
    expect((await q.stats()).running).toBe(0);
  });

  it('failures retry at the given time; without a retry time the job is dead', async () => {
    const q = await create();
    await q.enqueue({ type: 'turn', orderingKey: 'e', payload: {} });
    const j = (await q.claim('w', 60_000))!;
    await q.fail(j.id, 'w', 'boom', new Date(nowMs + 10_000));
    expect(await q.claim('w', 60_000)).toBeUndefined();
    expect((await q.stats()).failed).toBe(1);
    nowMs += 10_001;
    const j2 = (await q.claim('w', 60_000))!;
    await q.fail(j2.id, 'w', 'boom again');
    expect((await q.stats()).dead).toBe(1);
    expect(await q.claim('w', 60_000)).toBeUndefined();
  });

  it('only the leaseholder can complete or fail a job', async () => {
    const q = await create();
    await q.enqueue({ type: 'turn', orderingKey: 'f', payload: {} });
    const j = (await q.claim('w1', 60_000))!;
    await q.complete(j.id, 'someone-else');
    expect((await q.stats()).running).toBe(1);
    await q.complete(j.id, 'w1');
    expect((await q.stats()).running).toBe(0);
  });
});

describe('JobRunner', () => {
  it('runs jobs with bounded concurrency, keeps per-key order, retries with backoff, and gives up after max attempts', async () => {
    const q = new MemoryQueue(clock);
    const seen: Array<{ key: string; n: number }> = [];
    let active = 0;
    let peak = 0;
    let failuresLeft = 2;
    const runner = new JobRunner({
      queue: q, log: silentLogger, concurrency: 3, leaseMs: 60_000, maxAttempts: 3, clock, name: 'r',
      handlers: {
        async turn(job) {
          active++;
          peak = Math.max(peak, active);
          await new Promise((r) => setTimeout(r, 5));
          if (job.payload.key === 'flaky' && failuresLeft-- > 0) {
            active--;
            throw new Error('transient');
          }
          if (job.payload.key === 'broken') {
            active--;
            throw new Error('permanent');
          }
          seen.push({ key: String(job.payload.key), n: Number(job.payload.n) });
          active--;
        },
      },
    });
    for (const key of ['a', 'b', 'c', 'd']) for (let n = 1; n <= 3; n++) await q.enqueue({ type: 'turn', orderingKey: key, payload: { key, n } });
    await q.enqueue({ type: 'turn', orderingKey: 'flaky', payload: { key: 'flaky', n: 1 } });
    await q.enqueue({ type: 'turn', orderingKey: 'broken', payload: { key: 'broken', n: 1 } });

    await runner.runUntilIdle();
    for (const key of ['a', 'b', 'c', 'd']) expect(seen.filter((s) => s.key === key).map((s) => s.n)).toEqual([1, 2, 3]);
    expect(peak).toBeGreaterThan(1);
    expect(peak).toBeLessThanOrEqual(3);
    // Failed jobs wait for their backoff; move time on and run again until settled.
    for (let i = 0; i < 4; i++) {
      nowMs += 6 * 60_000;
      await runner.runUntilIdle();
    }
    expect(seen.filter((s) => s.key === 'flaky')).toHaveLength(1); // succeeded on the third attempt, exactly once
    const stats = await q.stats();
    expect(stats.dead).toBe(1); // 'broken' gave up after 3 attempts
    expect(stats.pending).toBe(0);
  });

  it('backoff grows and is capped', () => {
    expect(backoffMs(1)).toBeGreaterThanOrEqual(1400);
    expect(backoffMs(1)).toBeLessThanOrEqual(2600);
    expect(backoffMs(20)).toBeLessThanOrEqual(5 * 60_000 * 1.3);
  });
});
