import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { adminPanelConfigSchema } from '../../src/admin/playwright/config.js';
import { PlaywrightAdminGateway } from '../../src/admin/playwright/gateway.js';
import { mapColumns, mapLabels, parseAdminDate, parseMoney } from '../../src/admin/playwright/parse.js';
import { silentLogger } from '../../src/observability/logger.js';

describe('admin scraping helpers', () => {
  it('maps labels with synonyms and ignores placeholders', () => {
    const f = mapLabels(
      [{ label: 'Payout ID:', value: 'WD-1' }, { label: 'Account No', value: '5010 0123 4567' }, { label: 'UTR', value: '-' }],
      { withdrawalId: ['Withdrawal ID', 'Payout ID'], accountNumber: ['Account Number', 'Account No'], utr: ['UTR'] },
    );
    expect(f).toEqual({ withdrawalId: 'WD-1', accountNumber: '5010 0123 4567' });
  });
  it('maps table columns', () => {
    expect(mapColumns(['Order ID', 'Amount (₹)', 'Status', 'Created At'], { orderId: ['Order ID'], amount: ['Amount'], createdAt: ['Created At'] })).toEqual({ orderId: 0, amount: 1, createdAt: 3 });
  });
  it('parses money and panel dates (IST by default)', () => {
    expect(parseMoney('₹1,450.00')).toBe(1450);
    expect(parseMoney('INR 700')).toBe(700);
    expect(parseAdminDate('05/09/2026 10:00 AM')).toBe('2026-09-05T04:30:00.000Z');
    expect(parseAdminDate('2026-09-05 22:15:00')).toBe('2026-09-05T16:45:00.000Z');
    expect(parseAdminDate('5 Sep 2026, 10:00')).toBe('2026-09-05T04:30:00.000Z');
    expect(parseAdminDate('garbage')).toBeUndefined();
  });
});

/** Find a Chromium Playwright can drive (installed build, or an older cached headless shell). */
function browserPath(): string | undefined | null {
  const cache = join(process.env.HOME ?? '', 'Library/Caches/ms-playwright');
  const linuxCache = join(process.env.HOME ?? '', '.cache/ms-playwright');
  for (const root of [cache, linuxCache]) {
    if (!existsSync(root)) continue;
    for (const d of readdirSync(root).filter((x) => x.startsWith('chromium_headless_shell-')).sort().reverse()) {
      for (const sub of readdirSync(join(root, d))) {
        const exe = join(root, d, sub, 'chrome-headless-shell');
        if (existsSync(exe)) return exe;
      }
    }
  }
  return null;
}

const PAYOUTS: Record<string, string> = {
  'WD-15436-64215': `<dl><dt>Withdrawal ID</dt><dd>WD-15436-64215</dd><dt>Amount</dt><dd>₹1,450.00</dd><dt>Status</dt><dd>Success</dd>
    <dt>Beneficiary Name</dt><dd>RAHUL KUMAR</dd><dt>Bank Name</dt><dd>HDFC Bank</dd><dt>Branch</dt><dd>Andheri East</dd>
    <dt>Account Number</dt><dd>50100123456789</dd><dt>IFSC Code</dt><dd>HDFC0001234</dd><dt>UTR</dt><dd>523456789012</dd>
    <dt>Gateway</dt><dd>PayoutX</dd><dt>Vendor Order ID</dt><dd>VX-88121</dd><dt>Requested At</dt><dd>05/09/2026 09:40 AM</dd>
    <dt>Processed At</dt><dd>05/09/2026 10:00 AM</dd></dl>`,
};

function page(title: string, body: string, loggedIn = true) {
  return `<!doctype html><html><head><title>${title}</title></head><body>${loggedIn ? '<nav><a class="logout" href="/logout">Logout</a></nav>' : ''}<main>${body}</main></body></html>`;
}

function startPanel(): Promise<{ server: Server; url: string }> {
  const server = createServer((req, res) => {
    const u = new URL(req.url ?? '/', 'http://x');
    const authed = (req.headers.cookie ?? '').includes('sid=ok');
    const send = (html: string, status = 200, headers: Record<string, string> = {}) => {
      res.writeHead(status, { 'content-type': 'text/html', ...headers });
      res.end(html);
    };
    if (u.pathname === '/login' && req.method === 'POST') {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        const p = new URLSearchParams(body);
        if (p.get('username') === 'agent' && p.get('password') === 's3cret') send('', 302, { location: '/dashboard', 'set-cookie': 'sid=ok; Path=/' });
        else send(page('Login', '<div class="alert-danger">Invalid credentials</div><form method="post"><input name="username"><input type="password" name="password"><button type="submit">Login</button></form>', false));
      });
      return;
    }
    if (u.pathname === '/login') return send(page('Login', '<form method="post"><input name="username"><input type="password" name="password"><button type="submit">Login</button></form>', false));
    if (!authed) return send('', 302, { location: '/login' });
    if (u.pathname === '/dashboard') return send(page('Dashboard', '<h1>Welcome</h1>'));
    if (u.pathname === '/payouts') {
      const q = u.searchParams.get('search') ?? '';
      const form = `<form><input name="search" value="${q}"><button>Search</button></form>`;
      if (!q) return send(page('Payouts', form));
      const rows = Object.keys(PAYOUTS).filter((id) => id === q).map((id) => `<tr><td>${id}</td><td>₹1,450</td><td><a href="/payouts/${id}">View</a></td></tr>`);
      return send(page('Payouts', `${form}${rows.length ? `<table><thead><tr><th>ID</th><th>Amount</th><th></th></tr></thead><tbody>${rows.join('')}</tbody></table>` : '<p>No records found</p>'}`));
    }
    if (u.pathname.startsWith('/payouts/')) {
      const id = decodeURIComponent(u.pathname.split('/')[2] ?? '');
      return send(page('Payout', `<section class="payout-detail">${PAYOUTS[id] ?? ''}</section>`));
    }
    if (u.pathname === '/deposits') {
      const q = u.searchParams.get('search') ?? '';
      const form = `<form><input name="search" value="${q}"><button>Search</button></form>`;
      if (!q) return send(page('Deposits', form));
      if (q !== '9810822372') return send(page('Deposits', `${form}<p>No records found</p>`));
      return send(page('Deposits', `${form}<table><thead><tr><th>Order ID</th><th>Amount</th><th>Status</th><th>UTR</th><th>Created At</th></tr></thead><tbody>
        <tr><td>ORD771001</td><td>₹500.00</td><td>Success</td><td>612345678901</td><td>11/09/2026 09:15 AM</td></tr>
        <tr><td>ORD771002</td><td>₹1,000.00</td><td>Pending</td><td></td><td>10/09/2026 06:00 PM</td></tr></tbody></table>`));
    }
    send('not found', 404);
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => {
    const addr = server.address();
    resolve({ server, url: `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}` });
  }));
}

const exe = browserPath();
const config = adminPanelConfigSchema.parse(JSON.parse(readFileSync('config/admin.json', 'utf8')));

describe.skipIf(exe === null)('PlaywrightAdminGateway against a local mock panel', () => {
  let panel: { server: Server; url: string };
  let gw: PlaywrightAdminGateway;
  const stateFile = join(tmpdir(), `fa-admin-state-${process.pid}.json`);

  beforeAll(async () => {
    panel = await startPanel();
    gw = new PlaywrightAdminGateway({
      baseUrl: panel.url, username: 'agent', password: 's3cret', config, storageStateFile: stateFile, encryptionKey: 'test-key-0123456789abcdef',
      headless: true, timeoutMs: 8000, executablePath: exe ?? undefined, log: silentLogger,
    });
  });
  afterAll(async () => {
    await gw?.close();
    panel?.server.close();
  });

  it('logs in, searches, opens View and reads the payout detail', async () => {
    const r = await gw.findPayout('WD-15436-64215');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data).toMatchObject({
      withdrawalId: 'WD-15436-64215', amount: 1450, status: 'SUCCESS', bankName: 'HDFC Bank', accountNumber: '50100123456789',
      ifsc: 'HDFC0001234', utr: '523456789012', beneficiaryName: 'RAHUL KUMAR', gateway: 'PayoutX', vendorOrderId: 'VX-88121',
      processedAt: '2026-09-05T04:30:00.000Z',
    });
    // Session state is stored encrypted, never as plain cookies.
    expect(readFileSync(stateFile, 'utf8')).not.toContain('sid');
  });

  it('returns null (not an error) for an unknown withdrawal', async () => {
    expect(await gw.findPayout('WD-00000-00000')).toMatchObject({ ok: true, data: null });
  });

  it('reads deposit orders from the table', async () => {
    const r = await gw.findDeposits({ registrationNumber: '9810822372' });
    expect(r.ok && r.data.map((o) => [o.orderId, o.amount, o.status, o.utr])).toEqual([
      ['ORD771001', 500, 'SUCCESS', '612345678901'],
      ['ORD771002', 1000, 'PENDING', undefined],
    ]);
    expect(await gw.findDeposits({ registrationNumber: '9000000000' })).toMatchObject({ ok: true, data: [] });
  });

  it('reports rejected credentials as an auth error', async () => {
    const bad = new PlaywrightAdminGateway({
      baseUrl: panel.url, username: 'agent', password: 'wrong', config, storageStateFile: join(tmpdir(), `fa-bad-${process.pid}.json`),
      headless: true, timeoutMs: 5000, executablePath: exe ?? undefined, log: silentLogger,
    });
    try {
      expect(await bad.findPayout('WD-15436-64215')).toMatchObject({ ok: false, error: 'auth' });
    } finally {
      await bad.close();
    }
  });
});
