import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Server } from 'node:http';
import { silentLogger } from '../../src/observability/logger.js';
import { Metrics } from '../../src/observability/metrics.js';
import { startHealthServer } from '../../src/observability/health.js';
import { gatewayRoutes } from '../../src/telegram/gatewayApi.js';
import { RemoteChatFolders, RemoteTransport } from '../../src/telegram/remote.js';
import { FakeFolders, FakeTransport } from '../helpers/harness.js';
import { ChatFolders } from '../../src/monitoring/chatFolders.js';

/** A worker talking to a gateway over real HTTP: the one Telegram session, shared safely. */
let server: Server;
let port: number;
const telegram = new FakeTransport();
const folderApi = new FakeFolders();
const folders = new ChatFolders({ folders: folderApi, titles: { match: 'Match issues', support: 'Support' }, log: silentLogger });

beforeAll(async () => {
  server = await startHealthServer(0, { store: () => true }, new Metrics(), '127.0.0.1', {
    routes: gatewayRoutes({ token: 'secret-token', transport: telegram, folders, log: silentLogger }),
  });
  port = (server.address() as { port: number }).port;
});
afterAll(() => server.close());

describe('gateway internal API ↔ RemoteTransport', () => {
  it('sends, forwards, verifies, downloads and reads folders through the gateway', async () => {
    const remote = new RemoteTransport({ baseUrl: `http://127.0.0.1:${port}`, token: 'secret-token', log: silentLogger });
    await remote.start({ onMessage: async () => undefined });
    expect(remote.healthy()).toBe(true);

    const sent = await remote.sendText('100', 'hello', { html: true });
    expect(telegram.sent).toEqual([{ chatId: '100', messageId: 1, text: 'hello', replyTo: undefined }]);
    const fwd = await remote.forwardMessage('100', 7, '8869616760');
    expect(fwd).toEqual({ messageId: 1 });
    expect(await remote.messagesExist('8869616760', [1, 2])).toEqual([1]);
    expect(await remote.messagesExist('100', [sent.messageId])).toEqual([1]);

    telegram.files.set('f1', Buffer.from([0x25, 0x50, 0x44, 0x46, 0x2d, 0x00, 0xff]));
    const bytes = await remote.downloadMedia({ kind: 'document', fileRef: 'f1', fileUniqueId: 'f1', mimeType: 'application/pdf' });
    expect([...bytes]).toEqual([0x25, 0x50, 0x44, 0x46, 0x2d, 0x00, 0xff]); // binary intact

    const rf = new RemoteChatFolders(remote);
    expect(await rf.place('100', 'support')).toMatchObject({ support: 'added' });
    expect(folderApi.has('Support', '100')).toBe(true);
    expect(await rf.humanReplied('100')).toBe('removed');
    expect(folderApi.has('Support', '100')).toBe(false);
    expect(await remote.seenByHuman('100', 1)).toBe(false);
  });

  it('refuses a wrong token and unknown operations without retrying them', async () => {
    const bad = new RemoteTransport({ baseUrl: `http://127.0.0.1:${port}`, token: 'wrong', log: silentLogger });
    const before = telegram.sent.length;
    await expect(bad.sendText('100', 'x')).rejects.toMatchObject({ status: 401 });
    expect(telegram.sent).toHaveLength(before); // nothing sent, and not retried into the gateway 4 times
    const res = await fetch(`http://127.0.0.1:${port}/internal/telegram/nope`, { method: 'POST', headers: { authorization: 'Bearer secret-token' }, body: '{}' });
    expect(res.status).toBe(404);
  });

  it('a gateway outage is retried, then reported', async () => {
    const down = new RemoteTransport({ baseUrl: 'http://127.0.0.1:1', token: 'secret-token', log: silentLogger, timeoutMs: 500 });
    await expect(down.messagesExist('1', [1])).rejects.toThrow();
    expect(down.healthy()).toBe(false);
  });

  it('/readyz reports draining and dependency state', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/readyz`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ready: true, components: { store: true } });
  });
});
