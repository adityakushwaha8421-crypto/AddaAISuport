import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { Logger } from 'pino';
import type { Browser, BrowserContext, BrowserContextOptions, Page } from 'playwright';
import {
  normaliseDepositStatus, normalisePayoutStatus, type AdminGateway, type DepositOrder, type DepositQuery, type LookupResult, type PayoutDetails,
} from '../../domain/admin.js';
import { decryptSecret, encryptSecret } from '../../security/crypto.js';
import { DEFAULT_DEPOSIT_COLUMNS, DEFAULT_PAYOUT_LABELS, type AdminPanelConfig } from './config.js';
import { COLLECT_PAIRS_SCRIPT, COLLECT_TABLE_SCRIPT, mapColumns, mapLabels, parseAdminDate, parseMoney, type LabelValue } from './parse.js';

export interface PlaywrightGatewayOptions {
  baseUrl: string;
  username: string;
  password: string;
  config: AdminPanelConfig;
  /** Cookies/localStorage of the logged-in session (encrypted when a key is given). */
  storageStateFile: string;
  encryptionKey?: string;
  headless: boolean;
  timeoutMs: number;
  executablePath?: string;
  channel?: string;
  maxPages?: number;
  log: Logger;
}

class AuthError extends Error {}

/** Wrap an in-page script (kept as a string so it is not transpiled) into a serialisable function. */
const inPage = <T>(script: string) => new Function('el', `return (${script})(el)`) as (el: unknown) => T;

/**
 * Admin panel access through a real browser (the panel has no API). Keeps one logged-in browser
 * context, re-logs in transparently when the session expires, and never logs credentials or
 * cookies. Searching → opening "View" → reading the detail labels mirrors what an agent does.
 */
export class PlaywrightAdminGateway implements AdminGateway {
  readonly name = 'playwright';
  private browser?: Browser;
  private context?: BrowserContext;
  private starting?: Promise<BrowserContext>;
  private active = 0;
  private readonly waiters: Array<() => void> = [];

  constructor(private readonly o: PlaywrightGatewayOptions) {}

  private url(path: string) {
    return new URL(path, this.o.baseUrl).toString();
  }

  private async loadState(): Promise<Record<string, unknown> | undefined> {
    try {
      const raw = await readFile(this.o.storageStateFile, 'utf8');
      return JSON.parse(this.o.encryptionKey ? decryptSecret(raw, this.o.encryptionKey) : raw);
    } catch {
      return undefined;
    }
  }

  private async saveState(): Promise<void> {
    if (!this.context) return;
    const json = JSON.stringify(await this.context.storageState());
    await mkdir(dirname(this.o.storageStateFile), { recursive: true, mode: 0o700 });
    await writeFile(this.o.storageStateFile, this.o.encryptionKey ? encryptSecret(json, this.o.encryptionKey) : json, { mode: 0o600 });
    await chmod(this.o.storageStateFile, 0o600);
  }

  private async ensureContext(): Promise<BrowserContext> {
    if (this.context) return this.context;
    this.starting ??= (async () => {
      const { chromium } = await import('playwright');
      this.browser = await chromium.launch({ headless: this.o.headless, executablePath: this.o.executablePath, channel: this.o.channel });
      const storageState = (await this.loadState()) as BrowserContextOptions['storageState'];
      this.context = await this.browser.newContext({ storageState, ignoreHTTPSErrors: false });
      this.context.setDefaultTimeout(this.o.timeoutMs);
      return this.context;
    })();
    try {
      return await this.starting;
    } finally {
      this.starting = undefined;
    }
  }

  private async withPage<T>(fn: (page: Page) => Promise<T>): Promise<T> {
    while (this.active >= (this.o.maxPages ?? 2)) await new Promise<void>((r) => this.waiters.push(r));
    this.active++;
    const ctx = await this.ensureContext();
    const page = await ctx.newPage();
    try {
      return await fn(page);
    } finally {
      await page.close().catch(() => undefined);
      this.active--;
      this.waiters.shift()?.();
    }
  }

  private async isLoggedIn(page: Page): Promise<boolean> {
    return page.locator(this.o.config.login.loggedInMarker).first().isVisible().catch(() => false);
  }

  private async login(page: Page): Promise<void> {
    const l = this.o.config.login;
    await page.goto(this.url(this.o.config.loginPath));
    if (await this.isLoggedIn(page)) return;
    await page.locator(l.username).first().fill(this.o.username);
    await page.locator(l.password).first().fill(this.o.password);
    await page.locator(l.submit).first().click();
    const ok = await Promise.race([
      page.locator(l.loggedInMarker).first().waitFor({ state: 'visible' }).then(() => true),
      l.errorMarker ? page.locator(l.errorMarker).first().waitFor({ state: 'visible' }).then(() => false) : new Promise<boolean>(() => {}),
    ]).catch(() => false);
    if (!ok) throw new AuthError('Admin login failed (credentials rejected or login page changed)');
    await this.saveState();
    this.o.log.info('admin panel session established');
  }

  /** Navigate to a page, logging in first if the panel bounced us to the login screen. */
  private async open(page: Page, path: string): Promise<void> {
    await page.goto(this.url(path));
    const onLogin = new URL(page.url()).pathname.startsWith(new URL(this.url(this.o.config.loginPath)).pathname)
      || (await page.locator(this.o.config.login.password).first().isVisible().catch(() => false));
    if (onLogin) {
      await this.login(page);
      await page.goto(this.url(path));
    }
  }

  private async search(page: Page, cfg: AdminPanelConfig['payout']['search'], query: string): Promise<boolean> {
    if (cfg.urlTemplate) {
      await this.open(page, cfg.urlTemplate.replace('{query}', encodeURIComponent(query)));
    } else {
      if (!cfg.path || !cfg.input) throw new Error('admin search config needs urlTemplate or path+input');
      await this.open(page, cfg.path);
      await page.locator(cfg.input).first().fill(query);
      if (cfg.submit) await page.locator(cfg.submit).first().click();
      else await page.locator(cfg.input).first().press('Enter');
    }
    try {
      return await Promise.race([
        page.locator(cfg.resultRow).first().waitFor({ state: 'visible' }).then(() => true),
        cfg.noResults ? page.locator(cfg.noResults).first().waitFor({ state: 'visible' }).then(() => false) : new Promise<boolean>(() => {}),
      ]);
    } catch (err) {
      // With an explicit "no results" marker, a timeout means the panel misbehaved — never report
      // that as "not found" to a customer. Without one, an empty result list is indistinguishable.
      if (cfg.noResults) throw err;
      this.o.log.warn('admin search: no rows and no noResults selector configured; treating as empty');
      return false;
    }
  }

  private wrap<T>(op: () => Promise<T>): Promise<LookupResult<T>> {
    return op().then(
      (data) => ({ ok: true as const, data, fetchedAt: new Date().toISOString() }),
      (err: Error) => {
        const auth = err instanceof AuthError;
        const timeout = /timeout/i.test(err.message);
        this.o.log.warn({ error: auth ? 'auth' : timeout ? 'timeout' : 'unavailable', msg: err.message.split('\n')[0] }, 'admin browser lookup failed');
        return { ok: false as const, error: auth ? 'auth' : timeout ? 'timeout' : 'unavailable', message: err.message.split('\n')[0] ?? 'error' };
      },
    );
  }

  async findPayout(withdrawalId: string): Promise<LookupResult<PayoutDetails | null>> {
    const cfg = this.o.config.payout;
    return this.wrap(() =>
      this.withPage(async (page) => {
        if (!(await this.search(page, cfg.search, withdrawalId))) return null;
        const row = page.locator(cfg.search.resultRow).filter({ hasText: withdrawalId }).first();
        if (!(await row.count())) return null;
        if (cfg.search.viewButton) {
          await row.locator(cfg.search.viewButton).first().click();
          await page.locator(cfg.detail).first().waitFor({ state: 'visible' });
        }
        const pairs = await page.locator(cfg.detail).first().evaluate(inPage<LabelValue[]>(COLLECT_PAIRS_SCRIPT));
        const f = mapLabels(pairs, { ...DEFAULT_PAYOUT_LABELS, ...cfg.labels });
        const tz = this.o.config.timezone;
        const details: PayoutDetails = {
          withdrawalId: f.withdrawalId ?? withdrawalId,
          amount: parseMoney(f.amount),
          status: normalisePayoutStatus(f.status),
          statusRaw: f.status,
          beneficiaryName: f.beneficiaryName,
          bankName: f.bankName,
          branch: f.branch,
          accountNumber: f.accountNumber?.replace(/\s/g, ''),
          ifsc: f.ifsc?.toUpperCase(),
          utr: f.utr,
          gateway: f.gateway,
          vendorOrderId: f.vendorOrderId,
          requestedAt: parseAdminDate(f.requestedAt, tz),
          processedAt: parseAdminDate(f.processedAt, tz),
          registrationNumber: f.registrationNumber,
          failureReason: f.failureReason,
        };
        if (details.withdrawalId.toUpperCase() !== withdrawalId.toUpperCase()) {
          throw new Error(`Detail view shows ${details.withdrawalId}, expected ${withdrawalId}`);
        }
        return details;
      }),
    );
  }

  async findDeposits(q: DepositQuery): Promise<LookupResult<DepositOrder[]>> {
    const cfg = this.o.config.deposit;
    return this.wrap(() =>
      this.withPage(async (page) => {
        if (!(await this.search(page, cfg.search, q.registrationNumber))) return [];
        const table = page.locator(cfg.table).first();
        const { headers, rows } = await table.evaluate(inPage<{ headers: string[]; rows: string[][] }>(COLLECT_TABLE_SCRIPT));
        const col = mapColumns(headers, { ...DEFAULT_DEPOSIT_COLUMNS, ...cfg.columns });
        if (col.orderId === undefined || col.status === undefined) throw new Error('Deposit table columns not recognised');
        const tz = this.o.config.timezone;
        return rows
          .map((r): DepositOrder => ({
            orderId: r[col.orderId!] ?? '',
            amount: col.amount !== undefined ? parseMoney(r[col.amount]) : undefined,
            status: normaliseDepositStatus(r[col.status!]),
            statusRaw: r[col.status!],
            utr: col.utr !== undefined ? r[col.utr] || undefined : undefined,
            createdAt: col.createdAt !== undefined ? parseAdminDate(r[col.createdAt], tz) : undefined,
            gateway: col.gateway !== undefined ? r[col.gateway] || undefined : undefined,
            registrationNumber: col.registrationNumber !== undefined ? r[col.registrationNumber] : q.registrationNumber,
          }))
          .filter((o) => o.orderId)
          .filter((o) => !o.createdAt || ((!q.from || Date.parse(o.createdAt) >= q.from.getTime()) && (!q.to || Date.parse(o.createdAt) <= q.to.getTime())));
      }),
    );
  }

  /** Interactive/first-time login (used by `npm run admin:login`). */
  async loginOnce(): Promise<void> {
    await this.withPage((page) => this.login(page));
  }

  async close(): Promise<void> {
    await this.context?.close().catch(() => undefined);
    await this.browser?.close().catch(() => undefined);
    this.context = undefined;
    this.browser = undefined;
  }
}
