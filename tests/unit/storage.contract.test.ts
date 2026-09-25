import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Store } from '../../src/storage/types.js';
import { allStoreFactories } from '../helpers/stores.js';

describe.each(allStoreFactories)('Store contract: $name', (factory) => {
  let store: Store;
  beforeEach(async () => {
    store = await factory.create();
  });
  afterEach(async () => {
    await store.close();
  });

  it('keeps small settings shared by every process (the bot switch)', async () => {
    expect(await store.settings.get('bot.enabled')).toBeUndefined();
    await store.settings.set('bot.enabled', false);
    expect(await store.settings.get('bot.enabled')).toBe(false);
    await store.settings.set('bot.enabled', true);
    expect(await store.settings.get('bot.enabled')).toBe(true);
    await store.settings.set('greeting', { text: 'hi', n: 2 });
    expect(await store.settings.get('greeting')).toEqual({ text: 'hi', n: 2 });
  });

  it('upserts users without clobbering known fields', async () => {
    await store.users.upsert({ id: 'u1', chatId: 'c1', username: 'ravi', firstName: 'Ravi' });
    const u = await store.users.upsert({ id: 'u1', chatId: 'c1' });
    expect(u.username).toBe('ravi');
    expect(u.firstName).toBe('Ravi');
    expect((await store.users.get('u1'))?.chatId).toBe('c1');
    expect(await store.users.get('nobody')).toBeUndefined();
    const at = new Date('2026-09-25T10:00:00Z');
    await store.users.setGreetedAt('u1', at);
    expect((await store.users.get('u1'))?.greetedAt).toEqual(at);
    await store.users.upsert({ id: 'u1', chatId: 'c1' });
    expect((await store.users.get('u1'))?.greetedAt).toEqual(at); // an upsert keeps it
  });

  it('deduplicates inbound messages by (chat, telegram id, direction)', async () => {
    const base = { chatId: 'c1', userId: 'u1', telegramMessageId: 10, direction: 'in' as const, media: [], meta: {} };
    const a = await store.messages.insert({ ...base, text: 'hello' });
    const b = await store.messages.insert({ ...base, text: 'hello again' });
    expect(a.inserted).toBe(true);
    expect(b.inserted).toBe(false);
    expect(b.message.text).toBe('hello');
    // Same telegram id in the other direction is a different row.
    const c = await store.messages.insert({ ...base, direction: 'out', text: 'reply' });
    expect(c.inserted).toBe(true);
  });

  it('returns recent messages in chronological order and finds by telegram id', async () => {
    for (let i = 1; i <= 5; i++) {
      await store.messages.insert({
        chatId: 'c1', userId: 'u1', telegramMessageId: i, direction: i % 2 ? 'in' : 'out', text: `m${i}`,
        media: [], meta: i === 4 ? { kind: 'evidence_request' } : {},
        createdAt: new Date(Date.UTC(2026, 0, 1, 0, 0, i)),
      });
    }
    const recent = await store.messages.recent('c1', 3);
    expect(recent.map((m) => m.text)).toEqual(['m3', 'm4', 'm5']);
    const m4 = await store.messages.find('c1', 4);
    expect(m4?.meta.kind).toBe('evidence_request');
  });

  it('marks inbound messages as looked at', async () => {
    const base = { chatId: 'c1', userId: 'u1', direction: 'in' as const, media: [], meta: {} };
    await store.messages.insert({ ...base, telegramMessageId: 1, text: 'a' });
    await store.messages.insert({ ...base, telegramMessageId: 2, text: 'b' });
    await store.messages.markProcessed('c1', [1]);
    expect((await store.messages.find('c1', 1))?.processedAt).toBeInstanceOf(Date);
    expect((await store.messages.find('c1', 2))?.processedAt).toBeUndefined();
  });
});
