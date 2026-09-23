import { describe, expect, it } from 'vitest';
import { assemble } from '../../src/app.js';
import { REPLIES } from '../../src/control/adminCommands.js';
import { CUSTOMER_MESSAGING_ENABLED, ENABLED_CUSTOMER_MESSAGES } from '../../src/control/customerMessaging.js';
import { BotOffError } from '../../src/control/guardedTransport.js';
import type { InboundMessage, MediaRef } from '../../src/domain/messages.js';
import { silentLogger } from '../../src/observability/logger.js';
import { Metrics } from '../../src/observability/metrics.js';
import { MemoryStore } from '../../src/storage/memory.js';

/**
 * Everything that is NOT the one evidence request or the one solved note: received and stored,
 * and nothing goes back to the customer, ON or OFF. Admin commands still answer the admin. Any
 * code path that tries to send a customer anything else is refused by the transport.
 */
import { ADMIN, EXPORT_BOT, FakeTransport, SUPPORT, customerSends } from '../helpers/fakeTransport.js';

function build() {
  const store = new MemoryStore();
  const transport = new FakeTransport();
  const app = assemble({ store, transport, log: silentLogger, metrics: new Metrics() }, { adminIds: [ADMIN], supportChatId: SUPPORT, exportChatId: EXPORT_BOT });
  const msg = (userId: string, text?: string, media: MediaRef[] = []): InboundMessage => transport.inbound(userId, text, media);
  return { store, transport, app, msg };
}

describe('receive-only agent', () => {
  it('ships with customer messaging disabled except the two workflow kinds', () => {
    expect(CUSTOMER_MESSAGING_ENABLED).toBe(false);
    expect([...ENABLED_CUSTOMER_MESSAGES].sort()).toEqual(['evidence_request', 'payment_confirmed']);
  });

  it('stores every customer message and sends ZERO automatic messages for anything that is not a deposit/withdrawal issue', async () => {
    const { store, transport, app, msg } = build();
    const texts = ['Hi', 'hello sir', 'match cancel ho gaya points nahi mile', 'kya bhejna hai?', 'thanks', 'kuch bhi random 12345', '/start', 'human se baat karao', 'otp nahi aaya', 'app crash ho raha hai'];
    for (const [i, t] of texts.entries()) await app.onMessage(msg(`c${i % 3}`, t));
    await app.onMessage(msg('c0', undefined, [{ kind: 'photo', fileRef: 'f1', fileUniqueId: 'f1', mimeType: 'image/jpeg' }]));
    await app.onMessage(msg('c1', 'statement', [{ kind: 'document', fileRef: 'f2', fileUniqueId: 'f2', mimeType: 'application/pdf', fileName: 's.pdf' }]));
    expect(transport.sent).toHaveLength(0);
    const c0 = await store.messages.recent('c0', 20);
    expect(c0.length).toBeGreaterThan(0);
    expect(c0.every((m) => m.direction === 'in' && m.processedAt)).toBe(true);
    expect((await store.users.get('c1'))?.chatId).toBe('c1');
  });

  it('the same while OFF and after ON again; admin commands still answer the admin', async () => {
    const { store, transport, app, msg } = build();
    await app.onMessage(msg(ADMIN, '/botoff'));
    expect(transport.sent.at(-1)).toMatchObject({ chatId: ADMIN, text: REPLIES.off });
    expect(await app.onMessage(msg('c9', 'deposit nahi hua'))).toBe('bot_off');
    expect((await store.messages.recent('c9', 1))[0]?.processedAt).toBeDefined();
    await app.onMessage(msg(ADMIN, '/boton'));
    expect(transport.sent.at(-1)).toMatchObject({ chatId: ADMIN, text: REPLIES.on });
    await app.onMessage(msg('c9', 'hello?'));
    expect(customerSends(transport)).toHaveLength(0);
    // A customer typing the commands changes nothing and gets nothing.
    await app.onMessage(msg('c8', '/botoff'));
    expect(await app.botSwitch.isOnNow()).toBe(true);
    expect(customerSends(transport)).toHaveLength(0);
  });

  it('a duplicate delivery of the same message is stored once', async () => {
    const { store, app, msg } = build();
    const m = msg('c5', 'hi');
    await app.onMessage(m);
    await app.onMessage(m);
    expect(await store.messages.recent('c5', 10)).toHaveLength(1);
  });

  it('team-side events are received and do nothing', async () => {
    const { transport, app } = build();
    await app.onSupportMessage({ chatId: SUPPORT, messageId: 1, fromUserId: 'h1', text: 'reply to ticket' });
    await app.onOwnOutgoing({ chatId: 'c1', messageId: 2, text: 'human typed this' });
    await app.onExportMessage({ messageId: 3, text: 'Files received 👍' });
    expect(transport.sent).toHaveLength(0);
  });

  it('the guarded transport refuses any other attempt to message a customer; team chats and admin replies are not customers', async () => {
    const { transport, app } = build();
    await expect(app.transport.sendText('c1', 'Sir, ...')).rejects.toBeInstanceOf(BotOffError);
    await expect(app.transport.sendText('c1', 'Sir, ...', { kind: 'reminder' })).rejects.toBeInstanceOf(BotOffError);
    await expect(app.transport.sendText('c1', 'Sir, ...', { kind: 'greeting' })).rejects.toBeInstanceOf(BotOffError);
    expect(transport.sent).toHaveLength(0);
    // Team chats are reachable (nothing uses them yet), so a future workflow can file tickets/exports.
    await app.transport.sendText(SUPPORT, 'ticket');
    expect(transport.sent).toMatchObject([{ chatId: SUPPORT, text: 'ticket' }]);
  });
});
