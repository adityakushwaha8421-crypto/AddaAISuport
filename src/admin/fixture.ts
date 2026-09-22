import { readFile } from 'node:fs/promises';
import type { AdminGateway, DepositOrder, DepositQuery, LookupResult, PayoutDetails } from '../domain/admin.js';

export interface AdminFixtures {
  payouts: PayoutDetails[];
  deposits: Array<DepositOrder & { registrationNumber: string }>;
}

/**
 * In-memory admin panel backed by fixture data. Used for local development (ADMIN_MODE=fixture)
 * and tests. Can simulate outages via `failNext`.
 */
export class FixtureAdminGateway implements AdminGateway {
  readonly name = 'fixture';
  readonly calls: Array<{ op: string; arg: string }> = [];
  private failures = 0;

  constructor(private data: AdminFixtures = { payouts: [], deposits: [] }) {}

  static async fromFile(path: string): Promise<FixtureAdminGateway> {
    return new FixtureAdminGateway(JSON.parse(await readFile(path, 'utf8')) as AdminFixtures);
  }

  setData(data: AdminFixtures): void {
    this.data = data;
  }

  upsertPayout(p: PayoutDetails): void {
    this.data.payouts = [...this.data.payouts.filter((x) => x.withdrawalId !== p.withdrawalId), p];
  }

  addDeposit(d: DepositOrder & { registrationNumber: string }): void {
    this.data.deposits.push(d);
  }

  /** Make the next `n` calls fail as if the panel were down. */
  failNext(n: number): void {
    this.failures = n;
  }

  private fail<T>(): LookupResult<T> | undefined {
    if (this.failures > 0) {
      this.failures--;
      return { ok: false, error: 'unavailable', message: 'simulated outage' };
    }
    return undefined;
  }

  async findPayout(withdrawalId: string): Promise<LookupResult<PayoutDetails | null>> {
    this.calls.push({ op: 'findPayout', arg: withdrawalId });
    const f = this.fail<PayoutDetails | null>();
    if (f) return f;
    const norm = (s: string) => s.toUpperCase().replace(/[\s_]/g, '');
    const hit = this.data.payouts.find((p) => norm(p.withdrawalId) === norm(withdrawalId));
    return { ok: true, data: hit ? structuredClone(hit) : null, fetchedAt: new Date().toISOString() };
  }

  async findDeposits(q: DepositQuery): Promise<LookupResult<DepositOrder[]>> {
    this.calls.push({ op: 'findDeposits', arg: q.registrationNumber });
    const f = this.fail<DepositOrder[]>();
    if (f) return f;
    const rows = this.data.deposits.filter((d) => {
      if (d.registrationNumber !== q.registrationNumber) return false;
      const at = d.createdAt ? Date.parse(d.createdAt) : undefined;
      if (at !== undefined && q.from && at < q.from.getTime()) return false;
      if (at !== undefined && q.to && at > q.to.getTime()) return false;
      return true;
    });
    return { ok: true, data: structuredClone(rows), fetchedAt: new Date().toISOString() };
  }
}

export class DisabledAdminGateway implements AdminGateway {
  readonly name = 'disabled';
  async findPayout(): Promise<LookupResult<PayoutDetails | null>> {
    return { ok: false, error: 'disabled', message: 'Admin integration disabled' };
  }
  async findDeposits(): Promise<LookupResult<DepositOrder[]>> {
    return { ok: false, error: 'disabled', message: 'Admin integration disabled' };
  }
}
