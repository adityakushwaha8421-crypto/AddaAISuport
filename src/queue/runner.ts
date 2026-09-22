import { randomUUID } from 'node:crypto';
import type { Logger } from 'pino';
import type { Metrics } from '../observability/metrics.js';
import { scrubber } from '../security/scrubber.js';
import type { Job, JobType, Queue } from './types.js';

export type JobHandler = (job: Job, log: Logger) => Promise<void>;

export interface RunnerOptions {
  queue: Queue;
  handlers: Partial<Record<JobType, JobHandler>>;
  log: Logger;
  metrics?: Metrics;
  /** Jobs run at once by this runner. */
  concurrency?: number;
  /** A job not completed within this is assumed crashed and returned to the queue. */
  leaseMs?: number;
  pollMs?: number;
  maxAttempts?: number;
  clock?: () => Date;
  /** Runner name in logs and leases (defaults to a random id). */
  name?: string;
}

/** Exponential backoff with jitter: 2s, 4s, 8s … capped at 5 minutes. */
export function backoffMs(attempt: number, baseMs = 2000, capMs = 5 * 60_000): number {
  const exp = Math.min(capMs, baseMs * 2 ** Math.max(0, attempt - 1));
  return Math.round(exp * (0.7 + Math.random() * 0.6));
}

/**
 * Pulls jobs from the queue and runs them with bounded concurrency. Every job keeps its lease
 * alive while it runs; a runner that dies stops heartbeating and the reaper returns the job to
 * the queue for someone else. `drain()` stops claiming and waits for in-flight jobs (graceful
 * shutdown); the handlers are idempotent, so a job cut off mid-way is safe to re-run.
 */
export class JobRunner {
  readonly name: string;
  private readonly concurrency: number;
  private readonly leaseMs: number;
  private readonly pollMs: number;
  private readonly maxAttempts: number;
  private readonly inFlight = new Set<Promise<void>>();
  private stopping = false;
  private loop?: Promise<void>;
  private reaper?: NodeJS.Timeout;
  private wake?: () => void;

  constructor(private readonly o: RunnerOptions) {
    this.name = o.name ?? `w-${randomUUID().slice(0, 8)}`;
    this.concurrency = o.concurrency ?? 4;
    this.leaseMs = o.leaseMs ?? 120_000;
    this.pollMs = o.pollMs ?? 500;
    this.maxAttempts = o.maxAttempts ?? 8;
  }

  private now() {
    return this.o.clock?.() ?? new Date();
  }

  start(): void {
    if (this.loop) return;
    this.stopping = false;
    this.loop = this.run();
    this.reaper = setInterval(() => void this.o.queue.reapExpired(this.now()).then((n) => n && this.o.log.warn({ reaped: n }, 'jobs returned to the queue after their lease expired')), Math.max(1000, this.leaseMs / 2));
    this.reaper.unref();
  }

  /** Nudge the loop (a job was just enqueued locally). */
  poke(): void {
    this.wake?.();
  }

  /** Stop claiming, finish what is running. */
  async drain(): Promise<void> {
    this.stopping = true;
    if (this.reaper) clearInterval(this.reaper);
    this.wake?.();
    await this.loop;
    await Promise.allSettled([...this.inFlight]);
    this.loop = undefined;
  }

  get running(): number {
    return this.inFlight.size;
  }

  /** Process everything runnable right now, then return (tests, one-shot maintenance). */
  async runUntilIdle(): Promise<number> {
    let done = 0;
    for (;;) {
      await this.o.queue.reapExpired(this.now());
      const job = await this.o.queue.claim(this.name, this.leaseMs, Object.keys(this.o.handlers) as JobType[]);
      if (!job) {
        if (!this.inFlight.size) return done;
        await Promise.race([...this.inFlight]);
        continue;
      }
      const p = this.execute(job);
      this.inFlight.add(p);
      void p.finally(() => this.inFlight.delete(p));
      if (this.inFlight.size >= this.concurrency) await Promise.race([...this.inFlight]);
      done++;
    }
  }

  private async run(): Promise<void> {
    while (!this.stopping) {
      if (this.inFlight.size >= this.concurrency) {
        await Promise.race([...this.inFlight]);
        continue;
      }
      let job: Job | undefined;
      try {
        job = await this.o.queue.claim(this.name, this.leaseMs, Object.keys(this.o.handlers) as JobType[]);
      } catch (err) {
        this.o.log.error({ err }, 'queue claim failed');
      }
      if (!job) {
        await new Promise<void>((r) => {
          this.wake = r;
          setTimeout(r, this.pollMs).unref();
        });
        this.wake = undefined;
        continue;
      }
      const p = this.execute(job);
      this.inFlight.add(p);
      void p.finally(() => this.inFlight.delete(p));
    }
  }

  private async execute(job: Job): Promise<void> {
    const { queue, handlers, metrics } = this.o;
    const log = this.o.log.child({ job: job.id, jobType: job.type, key: job.orderingKey, attempt: job.attempts, runner: this.name });
    const handler = handlers[job.type];
    const started = Date.now();
    let lost = false;
    const beat = setInterval(() => {
      queue.heartbeat(job.id, this.name, this.leaseMs).then((ok) => {
        if (!ok) {
          lost = true;
          log.warn('job lease lost while running; its result will be discarded');
        }
      }, () => undefined);
    }, Math.max(1000, this.leaseMs / 3));
    beat.unref();
    try {
      if (!handler) throw new Error(`no handler for job type ${job.type}`);
      await handler(job, log);
      if (!lost) await queue.complete(job.id, this.name);
      metrics?.jobs.inc({ type: job.type, outcome: 'ok' });
    } catch (err) {
      const message = scrubber.scrub((err as Error).message ?? String(err));
      const retry = job.attempts < this.maxAttempts;
      const retryAt = retry ? new Date(this.now().getTime() + backoffMs(job.attempts)) : undefined;
      if (!lost) await queue.fail(job.id, this.name, message, retryAt).catch((e) => log.error({ err: e }, 'could not record job failure'));
      metrics?.jobs.inc({ type: job.type, outcome: retry ? 'retry' : 'dead' });
      log[retry ? 'warn' : 'error']({ err, retryAt }, retry ? 'job failed; will retry' : 'job failed permanently');
    } finally {
      clearInterval(beat);
      metrics?.jobLatency.observe(Date.now() - started);
    }
  }
}
