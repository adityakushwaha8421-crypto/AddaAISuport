/**
 * Durable job queue. Everything slow or fallible (AI turns, media, human-action relays, export
 * bot replies) runs as a job: persisted before it is attempted, leased while it runs, retried
 * with backoff, and released back to the queue when a worker dies mid-way.
 *
 * Ordering: jobs sharing an `orderingKey` (a customer chat) never run concurrently and run in
 * creation order, across every worker. That is what keeps one customer's messages in order and
 * one customer's state touched by one worker at a time.
 */
export type JobType = 'turn' | 'support_message' | 'own_outgoing' | 'export_message' | 'export_forward';

export interface Job {
  id: string;
  type: JobType;
  orderingKey: string;
  payload: Record<string, unknown>;
  attempts: number;
  runAt: Date;
  createdAt: Date;
}

export interface EnqueueInput {
  type: JobType;
  orderingKey: string;
  payload: Record<string, unknown>;
  /** Do not run before this time (debounce, backoff). */
  runAt?: Date;
  /** Same key → the job is not created twice (Telegram redelivery, gateway retry). */
  idempotencyKey?: string;
}

export interface MergeInput extends EnqueueInput {
  /** Fold the new payload into a pending job of the same type and ordering key. */
  merge: (existing: Record<string, unknown>) => Record<string, unknown>;
  /** A merged job never waits beyond this (the first message's max wait). */
  maxRunAt?: Date;
}

export type JobStats = { pending: number; running: number; dead: number; failed: number };

export interface Queue {
  enqueue(input: EnqueueInput): Promise<{ id: string; created: boolean }>;
  /** Merge into a pending (not yet running) job with the same type + ordering key, else create. */
  enqueueOrMerge(input: MergeInput): Promise<{ id: string; merged: boolean }>;
  /** Lease the oldest runnable job whose ordering key has nothing running. */
  claim(worker: string, leaseMs: number, types?: JobType[]): Promise<Job | undefined>;
  /** Extend a lease; false when the lease was lost (reaped) — the worker must stop. */
  heartbeat(id: string, worker: string, leaseMs: number): Promise<boolean>;
  complete(id: string, worker: string): Promise<void>;
  /** Retry at `retryAt`; without it the job is dead (kept for inspection). */
  fail(id: string, worker: string, error: string, retryAt?: Date): Promise<void>;
  /** Put a claimed job back untouched, to run at `runAt` (the agent is paused): not an attempt. */
  release(id: string, worker: string, runAt: Date): Promise<void>;
  /** Return expired leases to the queue (a worker crashed). */
  reapExpired(now?: Date): Promise<number>;
  stats(): Promise<JobStats>;
}
