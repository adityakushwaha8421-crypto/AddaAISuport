/** Token bucket: `rate` tokens per second, up to `burst` stored. `take()` resolves when a token is available. */
export class TokenBucket {
  private tokens: number;
  private last: number;

  constructor(private readonly rate: number, private readonly burst: number, private readonly now: () => number = Date.now) {
    this.tokens = burst;
    this.last = now();
  }

  private refill() {
    const t = this.now();
    this.tokens = Math.min(this.burst, this.tokens + ((t - this.last) / 1000) * this.rate);
    this.last = t;
  }

  async take(): Promise<void> {
    for (;;) {
      this.refill();
      if (this.tokens >= 1) {
        this.tokens -= 1;
        return;
      }
      const waitMs = Math.max(5, ((1 - this.tokens) / this.rate) * 1000);
      await new Promise<void>((r) => setTimeout(r, waitMs).unref());
    }
  }
}

/** One bucket per key (a chat), created on demand and forgotten when idle. */
export class KeyedBuckets {
  private readonly buckets = new Map<string, { b: TokenBucket; used: number }>();
  constructor(private readonly rate: number, private readonly burst: number) {}

  async take(key: string): Promise<void> {
    let e = this.buckets.get(key);
    if (!e) {
      e = { b: new TokenBucket(this.rate, this.burst), used: 0 };
      this.buckets.set(key, e);
    }
    e.used = Date.now();
    await e.b.take();
    if (this.buckets.size > 5000) {
      const cutoff = Date.now() - 60_000;
      for (const [k, v] of this.buckets) if (v.used < cutoff) this.buckets.delete(k);
    }
  }
}

/** Counting semaphore for bounding concurrent calls to a slow dependency (LLM, admin panel). */
export class Semaphore {
  private active = 0;
  private readonly waiters: Array<() => void> = [];
  constructor(private readonly limit: number) {}

  async run<T>(fn: () => Promise<T>): Promise<T> {
    while (this.active >= this.limit) await new Promise<void>((r) => this.waiters.push(r));
    this.active++;
    try {
      return await fn();
    } finally {
      this.active--;
      this.waiters.shift()?.();
    }
  }

  get inUse(): number {
    return this.active;
  }
}
