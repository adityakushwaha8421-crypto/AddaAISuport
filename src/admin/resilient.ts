import type { Logger } from 'pino';
import type { AdminGateway, DepositOrder, DepositQuery, LookupResult, PayoutDetails } from '../domain/admin.js';
import type { Metrics } from '../observability/metrics.js';

export interface ResilienceOptions {
  timeoutMs: number;
  cacheTtlMs: number;
  retries: number;
  breakerThreshold: number;
  breakerCooldownMs: number;
  log: Logger;
  metrics?: Metrics;
  now?: () => number;
}

class TimeoutError extends Error {}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new TimeoutError(`timed out after ${ms}ms`)), ms);
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        reject(e);
      },
    );
  });
}

/**
 * Wraps any AdminGateway with: per-call timeout, bounded retries for transient failures,
 * a circuit breaker (stop hammering a broken panel), a short TTL cache and single-flight
 * de-duplication (two concurrent lookups for the same id share one browser round-trip).
 */
export class ResilientAdminGateway implements AdminGateway {
  readonly name: string;
  private readonly cache = new Map<string, { at: number; value: LookupResult<unknown> }>();
  private readonly inflight = new Map<string, Promise<LookupResult<unknown>>>();
  private failures = 0;
  private openUntil = 0;

  constructor(
    private readonly inner: AdminGateway,
    private readonly opts: ResilienceOptions,
  ) {
    this.name = `resilient(${inner.name})`;
  }

  private now() {
    return this.opts.now?.() ?? Date.now();
  }

  get circuitOpen(): boolean {
    return this.now() < this.openUntil;
  }

  findPayout(withdrawalId: string): Promise<LookupResult<PayoutDetails | null>> {
    const id = withdrawalId.trim().toUpperCase();
    return this.run(`payout:${id}`, 'findPayout', () => this.inner.findPayout(id)) as Promise<LookupResult<PayoutDetails | null>>;
  }

  findDeposits(q: DepositQuery): Promise<LookupResult<DepositOrder[]>> {
    const key = `deposits:${q.registrationNumber}:${q.from?.toISOString().slice(0, 10) ?? ''}:${q.to?.toISOString().slice(0, 10) ?? ''}`;
    return this.run(key, 'findDeposits', () => this.inner.findDeposits(q)) as Promise<LookupResult<DepositOrder[]>>;
  }

  /** Drop cached results (e.g. user says "abhi check karo" after a status change). */
  invalidate(prefix?: string): void {
    for (const k of [...this.cache.keys()]) if (!prefix || k.startsWith(prefix)) this.cache.delete(k);
  }

  private async run(key: string, op: string, call: () => Promise<LookupResult<unknown>>): Promise<LookupResult<unknown>> {
    const cached = this.cache.get(key);
    if (cached && this.now() - cached.at < this.opts.cacheTtlMs) {
      const v = cached.value;
      return v.ok ? { ...v, cached: true } : v;
    }
    if (this.circuitOpen) {
      this.opts.metrics?.adminCalls.inc({ op, outcome: 'circuit_open' });
      return { ok: false, error: 'circuit_open', message: 'Admin panel temporarily unavailable' };
    }
    const existing = this.inflight.get(key);
    if (existing) return existing;
    const p = this.attempt(op, call).then((res) => {
      if (res.ok) this.cache.set(key, { at: this.now(), value: res });
      return res;
    });
    this.inflight.set(key, p);
    try {
      return await p;
    } finally {
      this.inflight.delete(key);
    }
  }

  private async attempt(op: string, call: () => Promise<LookupResult<unknown>>): Promise<LookupResult<unknown>> {
    let last: LookupResult<unknown> = { ok: false, error: 'unavailable', message: 'not attempted' };
    for (let i = 0; i <= this.opts.retries; i++) {
      const started = this.now();
      try {
        last = await withTimeout(call(), this.opts.timeoutMs);
      } catch (err) {
        last = err instanceof TimeoutError
          ? { ok: false, error: 'timeout', message: err.message }
          : { ok: false, error: 'unavailable', message: (err as Error).message };
      }
      this.opts.metrics?.adminLatency.observe(this.now() - started, { op });
      this.opts.metrics?.adminCalls.inc({ op, outcome: last.ok ? 'ok' : last.error });
      if (last.ok) {
        this.failures = 0;
        return last;
      }
      // Auth / parse / disabled errors won't fix themselves on retry.
      if (last.error === 'auth' || last.error === 'parse' || last.error === 'disabled') break;
    }
    if (!last.ok && last.error !== 'disabled') {
      this.failures++;
      this.opts.log.warn({ op, error: last.error, failures: this.failures }, 'admin lookup failed');
      if (this.failures >= this.opts.breakerThreshold) {
        this.openUntil = this.now() + this.opts.breakerCooldownMs;
        this.opts.log.error({ cooldownMs: this.opts.breakerCooldownMs }, 'admin circuit opened');
      }
    }
    return last;
  }

  async close(): Promise<void> {
    await this.inner.close?.();
  }
}
