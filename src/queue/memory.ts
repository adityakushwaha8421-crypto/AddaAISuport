import { randomUUID } from 'node:crypto';
import type { EnqueueInput, Job, JobStats, JobType, MergeInput, Queue } from './types.js';

interface Row extends Job {
  seq: number;
  status: 'pending' | 'running' | 'dead';
  idempotencyKey?: string;
  worker?: string;
  leasedUntil?: Date;
  lastError?: string;
}

/**
 * In-memory queue with the exact semantics of the Postgres one (ordering keys, leases, merge,
 * idempotency), for single-process runs and tests. Not shared between processes.
 */
export class MemoryQueue implements Queue {
  private readonly rows = new Map<string, Row>();
  private seq = 0;
  constructor(private readonly clock: () => Date = () => new Date()) {}

  async enqueue(input: EnqueueInput) {
    if (input.idempotencyKey) {
      const dup = [...this.rows.values()].find((r) => r.idempotencyKey === input.idempotencyKey);
      if (dup) return { id: dup.id, created: false };
    }
    const row = this.insert(input);
    return { id: row.id, created: true };
  }

  async enqueueOrMerge(input: MergeInput) {
    const existing = [...this.rows.values()]
      .filter((r) => r.status === 'pending' && r.type === input.type && r.orderingKey === input.orderingKey)
      .sort((a, b) => b.seq - a.seq)[0];
    if (existing) {
      existing.payload = input.merge(existing.payload);
      let runAt = input.runAt ?? this.clock();
      if (input.maxRunAt && runAt > input.maxRunAt) runAt = input.maxRunAt;
      existing.runAt = runAt;
      return { id: existing.id, merged: true };
    }
    const row = this.insert(input);
    return { id: row.id, merged: false };
  }

  async claim(worker: string, leaseMs: number, types?: JobType[]) {
    const now = this.clock();
    const running = new Set([...this.rows.values()].filter((r) => r.status === 'running').map((r) => r.orderingKey));
    const candidates = [...this.rows.values()]
      .filter((r) => r.status === 'pending' && (!types || types.includes(r.type)))
      .sort((a, b) => a.seq - b.seq);
    const earliestPerKey = new Map<string, Row>();
    for (const r of candidates) if (!earliestPerKey.has(r.orderingKey)) earliestPerKey.set(r.orderingKey, r);
    const job = candidates.find((r) => r.runAt <= now && !running.has(r.orderingKey) && earliestPerKey.get(r.orderingKey) === r);
    if (!job) return undefined;
    job.status = 'running';
    job.worker = worker;
    job.leasedUntil = new Date(now.getTime() + leaseMs);
    job.attempts += 1;
    return this.view(job);
  }

  async heartbeat(id: string, worker: string, leaseMs: number) {
    const r = this.rows.get(id);
    if (!r || r.status !== 'running' || r.worker !== worker) return false;
    r.leasedUntil = new Date(this.clock().getTime() + leaseMs);
    return true;
  }

  async complete(id: string, worker: string) {
    const r = this.rows.get(id);
    if (r && r.status === 'running' && r.worker === worker) this.rows.delete(id);
  }

  async fail(id: string, worker: string, error: string, retryAt?: Date) {
    const r = this.rows.get(id);
    if (!r || r.status !== 'running' || r.worker !== worker) return;
    r.lastError = error;
    r.worker = undefined;
    r.leasedUntil = undefined;
    if (retryAt) {
      r.status = 'pending';
      r.runAt = retryAt;
    } else r.status = 'dead';
  }

  async release(id: string, worker: string, runAt: Date) {
    const r = this.rows.get(id);
    if (!r || r.status !== 'running' || r.worker !== worker) return;
    r.status = 'pending';
    r.worker = undefined;
    r.leasedUntil = undefined;
    r.runAt = runAt;
    r.attempts = Math.max(0, r.attempts - 1);
  }

  async reapExpired(now = this.clock()) {
    let n = 0;
    for (const r of this.rows.values()) {
      if (r.status === 'running' && r.leasedUntil && r.leasedUntil < now) {
        r.status = 'pending';
        r.worker = undefined;
        r.leasedUntil = undefined;
        r.lastError = 'lease expired';
        n++;
      }
    }
    return n;
  }

  async stats(): Promise<JobStats> {
    const s: JobStats = { pending: 0, running: 0, dead: 0, failed: 0 };
    for (const r of this.rows.values()) {
      s[r.status]++;
      if (r.status === 'pending' && r.lastError) s.failed++;
    }
    return s;
  }

  /** Test helper: every job, any status. */
  all(): Array<Job & { status: string; attempts: number; lastError?: string }> {
    return [...this.rows.values()].sort((a, b) => a.seq - b.seq).map((r) => ({ ...this.view(r), status: r.status, lastError: r.lastError }));
  }

  private insert(input: EnqueueInput): Row {
    const row: Row = {
      id: randomUUID(), seq: ++this.seq, type: input.type, orderingKey: input.orderingKey, payload: input.payload, attempts: 0,
      runAt: input.runAt ?? this.clock(), createdAt: this.clock(), status: 'pending', idempotencyKey: input.idempotencyKey,
    };
    this.rows.set(row.id, row);
    return row;
  }

  private view(r: Row): Job {
    return { id: r.id, type: r.type, orderingKey: r.orderingKey, payload: r.payload, attempts: r.attempts, runAt: r.runAt, createdAt: r.createdAt };
  }
}
