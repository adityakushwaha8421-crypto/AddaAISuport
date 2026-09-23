import { describe, expect, it } from 'vitest';
import { assemble } from '../../src/app.js';
import { REPLIES } from '../../src/control/adminCommands.js';
import { CUSTOMER_MESSAGING_ENABLED, ENABLED_CUSTOMER_MESSAGES } from '../../src/control/customerMessaging.js';
import { BotOffError } from '../../src/control/guardedTransport.js';
import type { InboundMessage, MediaRef } from '../../src/domain/messages.js';
import { silentLogger } from '../../src/observability/logger.js';
import { Metrics } from '../../src/observability/metrics.js';
import { MemoryStore } from '../../src/storage/memory.js';
import type { SendOptions, Transport, TransportHandlers } from '../../src/telegram/transport.js';

/**
 * The agent without a reply system: every message from a customer is received and stored, and
 * nothing — not one message — goes back to any customer, ON or OFF. Admin commands still answer
 * the admin. Any future code path that tries to message a customer is refused by the transport.
 */
const ADMIN = '500000001';
const SUPPORT = '-100999';
const EXPORT_BOT = '8869616760';

class FakeTransport implements Transport {
  readonly sent: Array<{ chatId: string; text: string }> = [];
  readonly forwards: Array<{ to: string }> = [];
  typing = 0;
  handlers?: TransportHandlers;
  async start(h: TransportHandlers) {
    this.handlers = h;
  }
  async stop() {}
  healthy() {
    return true;
  }
  async sendText(chatId: string, text: string, _opts?: SendOptions) {
    this.sent.push({ chatId, text });
    return { messageId: this.sent.length };
  }
  async forwardMessage(_from: string, _id: number, to: string) {
    this.forwards.push({ to });
    return { messageId: this.forwards.length };
  }
  async downloadMedia(_ref: MediaRef) {
    return Buffer.alloc(0);
  }
  async messagesExist(_chatId: string, ids: number[]) {
    return ids;
  }
  async sendTyping() {
    this.typing++;
  }
}

function build() {
  const store = new MemoryStore();
  const transport = new FakeTransport();
  const app = assemble({ store, transport, log: silentLogger, metrics: new Metrics() }, { adminIds: [ADMIN], supportChatId: SUPPORT, exportChatId: EXPORT_BOT });
  let n = 0;
  const msg = (userId: string, text?: string, media: MediaRef[] = []): InboundMessage => ({
    chatId: userId, userId, messageId: ++n, date: new Date(), text, media, sender: { firstName: 'C' },
  });
  return { store, transport, app, msg };
}

const customerSends = (t: FakeTransport) => t.sent.filter((s) => s.chatId !== ADMIN);

describe('receive-only agent', () => {
  it('ships with customer messaging disabled and nothing allowed through', () => {
    expect(CUSTOMER_MESSAGING_ENABLED).toBe(false);
    expect(ENABLED_CUSTOMER_MESSAGES.size).toBe(0);
  });

  it('stores every customer message and sends ZERO automatic messages — text, media, greetings, issues, anything', async () => {
    const { store, transport, app, msg } = build();
    const texts = ['Hi', 'hello sir', 'deposit nahi hua', 'withdrawal nahi aaya', 'match cancel ho gaya points nahi mile', 'kya bhejna hai?', 'thanks', 'kuch bhi random 12345', '/start', 'human se baat karao'];
    for (const [i, t] of texts.entries()) await app.onMessage(msg(`c${i % 3}`, t));
    await app.onMessage(msg('c0', undefined, [{ kind: 'photo', fileRef: 'f1', fileUniqueId: 'f1', mimeType: 'image/jpeg' }]));
    await app.onMessage(msg('c1', 'statement', [{ kind: 'document', fileRef: 'f2', fileUniqueId: 'f2', mimeType: 'application/pdf', fileName: 's.pdf' }]));
    expect(transport.sent).toHaveLength(0);
    expect(transport.forwards).toHaveLength(0);
    expect(transport.typing).toBe(0);
    const c0 = await store.messages.recent('c0', 20);
    expect(c0.length).toBeGreaterThan(0);
    expect(c0.every((m) => m.direction === 'in' && m.processedAt && m.meta.ignored === 'no_reply_system')).toBe(true);
    expect((await store.users.get('c1'))?.chatId).toBe('c1');
  });

  it('the same while OFF and after ON again; admin commands still answer the admin', async () => {
    const { store, transport, app, msg } = build();
    await app.onMessage(msg(ADMIN, '/botoff'));
    expect(transport.sent.at(-1)).toEqual({ chatId: ADMIN, text: REPLIES.off });
    await app.onMessage(msg('c9', 'deposit nahi hua'));
    expect((await store.messages.recent('c9', 1))[0]?.meta.ignored).toBe('bot_off');
    await app.onMessage(msg(ADMIN, '/boton'));
    expect(transport.sent.at(-1)).toEqual({ chatId: ADMIN, text: REPLIES.on });
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
    await app.onExportMessage({ messageId: 3, text: '✅ PAYMENT CONFIRMED\n👤 Customer: X (User ID: 6135570708)' });
    await app.onExportForward({ messageId: 4, kind: 'photo' });
    expect(transport.sent).toHaveLength(0);
    expect(transport.forwards).toHaveLength(0);
  });

  it('the guarded transport refuses any future attempt to message a customer, ON or OFF; team chats and admin replies are not customers', async () => {
    const { transport, app } = build();
    await expect(app.transport.sendText('c1', 'Sir, ...')).rejects.toBeInstanceOf(BotOffError);
    await expect(app.transport.forwardMessage('c1', 1, 'c2')).rejects.toBeInstanceOf(BotOffError);
    await app.transport.sendTyping('c1');
    expect(transport.sent).toHaveLength(0);
    expect(transport.typing).toBe(0);
    // Team chats are reachable (nothing uses them yet), so a future workflow can file tickets/exports.
    await app.transport.sendText(SUPPORT, 'ticket');
    expect(transport.sent).toEqual([{ chatId: SUPPORT, text: 'ticket' }]);
  });
});
