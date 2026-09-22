import { Api } from 'telegram';
import { describe, expect, it } from 'vitest';
import { silentLogger } from '../../src/observability/logger.js';
import { UserTransport } from '../../src/telegram/user/userTransport.js';

/** GramJS forwardMessages() returns one array per chunk: an array of arrays, with holes on mapping failures. */
const msg = (id: number, extra: Partial<ConstructorParameters<typeof Api.Message>[0]> = {}) =>
  new Api.Message({ id, peerId: new Api.PeerUser({ userId: BigInt(1) as never }), message: '', date: Math.floor(Date.now() / 1000), ...extra });

function transportWith(client: Record<string, unknown>) {
  const t = new UserTransport({ apiId: 1, apiHash: 'x', sessions: { load: async () => undefined, save: async () => undefined, clear: async () => undefined }, log: silentLogger });
  (t as unknown as { client: unknown }).client = client;
  return t;
}

describe('forwardMessage', () => {
  it('reads the forwarded message id out of the nested result', async () => {
    const t = transportWith({ forwardMessages: async () => [[msg(42)]] });
    expect(await t.forwardMessage('100', 7, '200')).toEqual({ messageId: 42 });
  });

  it('falls back to the newest message in the chat when GramJS could not map the result, if it is our fresh forward', async () => {
    const t = transportWith({
      forwardMessages: async () => [[undefined]],
      getMessages: async () => [msg(77, { out: true, fwdFrom: new Api.MessageFwdHeader({ date: 0 }) })],
    });
    expect(await t.forwardMessage('100', 7, '200')).toEqual({ messageId: 77 });
  });

  it('reports failure when nothing can be attributed to the forward', async () => {
    const t = transportWith({
      forwardMessages: async () => [[]],
      getMessages: async () => [msg(78, { out: true })], // not a forward
    });
    expect(await t.forwardMessage('100', 7, '200')).toBeUndefined();
  });
});

describe('messagesExist', () => {
  it('returns only the ids Telegram actually has', async () => {
    const t = transportWith({ getMessages: async () => [msg(1), undefined, new Api.MessageEmpty({ id: 3 })] });
    expect(await t.messagesExist('200', [1, 2, 3])).toEqual([1]);
  });
});
