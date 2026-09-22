import { describe, expect, it } from 'vitest';
import { FixtureAdminGateway } from '../../src/admin/fixture.js';
import { ResilientAdminGateway } from '../../src/admin/resilient.js';
import { normaliseDepositStatus, normalisePayoutStatus, type AdminGateway } from '../../src/domain/admin.js';
import { silentLogger } from '../../src/observability/logger.js';
import { ADMIN_FIXTURES } from '../helpers/fixtures.js';

const opts = (over = {}) => ({ timeoutMs: 200, cacheTtlMs: 60_000, retries: 1, breakerThreshold: 2, breakerCooldownMs: 1000, log: silentLogger, ...over });

describe('admin lookup', () => {
  it('finds payouts and deposits (fixture)', async () => {
    const fx = new FixtureAdminGateway(structuredClone(ADMIN_FIXTURES));
    expect(await fx.findPayout('wd-15436-64215')).toMatchObject({ ok: true, data: { status: 'SUCCESS', amount: 1450 } });
    expect(await fx.findPayout('WD-0')).toMatchObject({ ok: true, data: null });
    const d = await fx.findDeposits({ registrationNumber: '9810822372', from: new Date('2026-09-11T00:00:00+05:30') });
    expect(d.ok && d.data.map((o) => o.orderId)).toEqual(['ORD771001']);
  });

  it('normalises admin status vocabularies', () => {
    expect(normalisePayoutStatus('Completed')).toBe('SUCCESS');
    expect(normalisePayoutStatus('In Progress')).toBe('PROCESSING');
    expect(normalisePayoutStatus('on hold')).toBe('PENDING');
    expect(normalisePayoutStatus('Declined')).toBe('FAILED');
    expect(normalisePayoutStatus('weird')).toBe('UNKNOWN');
    expect(normaliseDepositStatus('captured')).toBe('SUCCESS');
    expect(normaliseDepositStatus('expired')).toBe('FAILED');
  });

  it('caches results and de-duplicates concurrent lookups (no duplicate tool calls)', async () => {
    const fx = new FixtureAdminGateway(structuredClone(ADMIN_FIXTURES));
    const gw = new ResilientAdminGateway(fx, opts());
    await Promise.all([gw.findPayout('WD-15436-64215'), gw.findPayout('WD-15436-64215'), gw.findPayout('wd-15436-64215')]);
    const again = await gw.findPayout('WD-15436-64215');
    expect(again).toMatchObject({ ok: true, cached: true });
    expect(fx.calls).toHaveLength(1);
  });

  it('retries transient failures', async () => {
    const fx = new FixtureAdminGateway(structuredClone(ADMIN_FIXTURES));
    fx.failNext(1);
    const gw = new ResilientAdminGateway(fx, opts());
    expect(await gw.findPayout('WD-15436-64215')).toMatchObject({ ok: true });
    expect(fx.calls).toHaveLength(2);
  });

  it('times out slow panels and opens the circuit after repeated failures', async () => {
    let t = 0;
    const slow: AdminGateway = {
      name: 'slow',
      findPayout: () => new Promise(() => {}),
      findDeposits: () => new Promise(() => {}),
    };
    const gw = new ResilientAdminGateway(slow, opts({ timeoutMs: 20, retries: 0, now: () => t }));
    expect(await gw.findPayout('WD-1')).toMatchObject({ ok: false, error: 'timeout' });
    expect(await gw.findPayout('WD-2')).toMatchObject({ ok: false, error: 'timeout' });
    expect(gw.circuitOpen).toBe(true);
    expect(await gw.findPayout('WD-3')).toMatchObject({ ok: false, error: 'circuit_open' });
    t += 2000;
    expect(gw.circuitOpen).toBe(false);
  });
});
