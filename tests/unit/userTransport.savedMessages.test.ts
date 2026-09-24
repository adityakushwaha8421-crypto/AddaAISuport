import { describe, expect, it, vi } from 'vitest';
import { silentLogger } from '../../src/observability/logger.js';
import { MemorySessionStore } from '../../src/telegram/user/sessionStore.js';
import { UserTransport } from '../../src/telegram/user/userTransport.js';

/**
 * Saved Messages (the account's chat with itself) is the owner's admin console. Telegram delivers
 * those messages without the `out` flag, so they must be recognised by the chat id, not the flag.
 */
function transport() {
  const t = new UserTransport({ apiId: 1, apiHash: 'x', sessions: new MemorySessionStore(), log: silentLogger, ownSendGraceMs: 1 });
  (t as unknown as { selfId: string }).selfId = '8412466614';
  return t as unknown as { onEvent(ev: unknown, handlers: unknown): Promise<void>; sentByUs: Map<string, Set<number>> };
}
const event = (chatId: string, id: number, message: string, out: boolean) => ({ isPrivate: true, message: { chatId: { toString: () => chatId }, id, message, out, senderId: { toString: () => chatId } } });

describe('Saved Messages routing', () => {
  it('a message in the chat with ourselves goes to onAdminCommand, out flag or not', async () => {
    const t = transport();
    const onAdminCommand = vi.fn(async () => undefined);
    const onOwnOutgoing = vi.fn(async () => undefined);
    const onMessage = vi.fn(async () => undefined);
    await t.onEvent(event('8412466614', 1, '/botoff', false), { onAdminCommand, onOwnOutgoing, onMessage });
    await t.onEvent(event('8412466614', 2, '/boton', true), { onAdminCommand, onOwnOutgoing, onMessage });
    expect(onAdminCommand.mock.calls.map((c) => (c as unknown[])[0])).toEqual([
      { chatId: '8412466614', messageId: 1, fromUserId: '8412466614', text: '/botoff' },
      { chatId: '8412466614', messageId: 2, fromUserId: '8412466614', text: '/boton' },
    ]);
    expect(onOwnOutgoing).not.toHaveBeenCalled(); // never a "human took over" for our own console
    expect(onMessage).not.toHaveBeenCalled(); // never a customer turn
  });

  it('our own reply in Saved Messages is not fed back as a command', async () => {
    const t = transport();
    t.sentByUs.set('8412466614', new Set([7]));
    const onAdminCommand = vi.fn(async () => undefined);
    await t.onEvent(event('8412466614', 7, '✅ Bot is ON', true), { onAdminCommand, onMessage: async () => undefined });
    expect(onAdminCommand).not.toHaveBeenCalled();
  });

  it("a human typing in a customer's chat is still a takeover, not a command", async () => {
    const t = transport();
    const onAdminCommand = vi.fn(async () => undefined);
    const onOwnOutgoing = vi.fn(async () => undefined);
    await t.onEvent(event('5595717485', 3, '/botoff', true), { onAdminCommand, onOwnOutgoing, onMessage: async () => undefined });
    expect(onAdminCommand).not.toHaveBeenCalled();
    expect(onOwnOutgoing).toHaveBeenCalledWith({ chatId: '5595717485', messageId: 3, text: '/botoff' });
  });
});

describe('export bot chat routing', () => {
  const t2 = () => {
    const t = new UserTransport({ apiId: 1, apiHash: 'x', sessions: new MemorySessionStore(), log: silentLogger, ownSendGraceMs: 1, exportChatId: '8869616760' });
    (t as unknown as { selfId: string }).selfId = '8412466614';
    return t as unknown as { onEvent(ev: unknown, handlers: unknown): Promise<void> };
  };
  it("the bot's message goes to onExportMessage; the account's own message there is nothing (not a customer, not a takeover)", async () => {
    const t = t2();
    const onExportMessage = vi.fn(async () => undefined);
    const onOwnOutgoing = vi.fn(async () => undefined);
    const onMessage = vi.fn(async () => undefined);
    await t.onEvent(event('8869616760', 5, '✅ PAYMENT CONFIRMED\nUser ID: 6135570708', false), { onExportMessage, onOwnOutgoing, onMessage });
    await t.onEvent(event('8869616760', 6, 'forwarded evidence', true), { onExportMessage, onOwnOutgoing, onMessage });
    expect(onExportMessage).toHaveBeenCalledTimes(1);
    expect(onExportMessage).toHaveBeenCalledWith({ messageId: 5, text: '✅ PAYMENT CONFIRMED\nUser ID: 6135570708', replyToMessageId: undefined });
    expect(onOwnOutgoing).not.toHaveBeenCalled();
    expect(onMessage).not.toHaveBeenCalled();
  });
});
