import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ConflictError, type Store } from '../../src/storage/types.js';
import { allStoreFactories } from '../helpers/stores.js';

describe.each(allStoreFactories)('Store contract: $name', (factory) => {
  let store: Store;
  beforeEach(async () => {
    store = await factory.create();
  });
  afterEach(async () => {
    await store.close();
  });

  it('upserts users without clobbering known fields', async () => {
    await store.users.upsert({ id: 'u1', chatId: 'c1', username: 'ravi', firstName: 'Ravi' });
    const u = await store.users.upsert({ id: 'u1', chatId: 'c1' });
    expect(u.username).toBe('ravi');
    await store.users.setHumanTakeover('u1', new Date('2030-01-01T00:00:00Z'));
    expect((await store.users.get('u1'))?.humanTakeoverUntil?.toISOString()).toBe('2030-01-01T00:00:00.000Z');
    const focus = '8b0c7d0e-6a55-4b7e-9d2a-0a0a0a0a0a0a';
    await store.users.setFocus('u1', focus);
    expect((await store.users.get('u1'))?.focusCaseId).toBe(focus);
    await store.users.setFocus('u1', undefined);
    expect((await store.users.get('u1'))?.focusCaseId).toBeUndefined();
  });

  it('remembers customer facts across cases', async () => {
    await store.users.upsert({ id: 'u1', chatId: 'c1' });
    expect((await store.users.get('u1'))?.memory).toMatchObject({ registrationNumbers: [], stats: { cases: 0 } });
    await store.users.saveMemory('u1', {
      style: { sirCount: 2, bhaiCount: 0, messages: 4, words: 30 },
      registrationNumbers: [{ value: '9810822372', verified: true, lastUsedAt: '2026-09-11T10:00:00.000Z' }],
      bank: { name: 'HDFC Bank', maskedAccount: 'XXXX6789', lastSeenAt: '2026-09-11T10:00:00.000Z' },
      recentCases: [{ id: 'case-1', type: 'withdrawal', status: 'resolved', ref: 'WD-1', amount: 1450, at: '2026-09-11T10:00:00.000Z' }],
      stats: { cases: 1, resolved: 1, escalated: 0, lastIssueType: 'withdrawal' },
    });
    const m = (await store.users.get('u1'))!.memory;
    expect(m.registrationNumbers[0]).toMatchObject({ value: '9810822372', verified: true });
    expect(m.bank?.maskedAccount).toBe('XXXX6789');
    expect(m.stats).toMatchObject({ cases: 1, resolved: 1 });
    // Another user's memory is untouched.
    await store.users.upsert({ id: 'u2', chatId: 'c2' });
    expect((await store.users.get('u2'))?.memory.registrationNumbers).toEqual([]);
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
        media: [], meta: i === 4 ? { candidates: [{ position: 1, withdrawalId: 'WD-1', confidence: 0.9 }] } : {},
        createdAt: new Date(Date.UTC(2026, 0, 1, 0, 0, i)),
      });
    }
    const recent = await store.messages.recent('c1', 3);
    expect(recent.map((m) => m.text)).toEqual(['m3', 'm4', 'm5']);
    const m4 = await store.messages.find('c1', 4);
    expect(m4?.meta.candidates?.[0]?.withdrawalId).toBe('WD-1');
  });

  it('saves cases with optimistic concurrency', async () => {
    const c = await store.cases.create({ userId: 'u1', chatId: 'c1', type: 'withdrawal' });
    expect(c.version).toBe(1);
    expect(c.facts.asks).toEqual({});
    const saved = await store.cases.save({ ...c, withdrawalId: 'WD-15436-64215', amount: 500.5, step: 'lookup' });
    expect(saved.version).toBe(2);
    expect(saved.amount).toBe(500.5);
    await expect(store.cases.save({ ...c, step: 'stale' })).rejects.toBeInstanceOf(ConflictError);
    const active = await store.cases.listActive('u1');
    expect(active).toHaveLength(1);
    expect(active[0]?.withdrawalId).toBe('WD-15436-64215');
  });

  it('lists open cases whose export failed, for the retry worker', async () => {
    const failed = await store.cases.create({ userId: 'u1', chatId: 'c1', type: 'deposit' });
    await store.cases.save({ ...failed, facts: { ...failed.facts, export: { status: 'failed', at: '2026-09-11T12:00:00Z', attempts: 1, forwarded: { 3: 9 }, reason: 'verification_unavailable' } } });
    const sent = await store.cases.create({ userId: 'u1', chatId: 'c1', type: 'deposit' });
    await store.cases.save({ ...sent, facts: { ...sent.facts, export: { status: 'verified', at: '2026-09-11T12:00:00Z', attempts: 1, forwarded: {} } } });
    const closed = await store.cases.create({ userId: 'u1', chatId: 'c1', type: 'deposit' });
    await store.cases.save({ ...closed, status: 'closed', facts: { ...closed.facts, export: { status: 'failed', at: '2026-09-11T12:00:00Z', attempts: 1, forwarded: {} } } });
    const list = await store.cases.listExportFailed();
    expect(list.map((c) => c.id)).toEqual([failed.id]);
    expect(list[0]?.facts.export?.forwarded).toEqual({ 3: 9 });
    expect((await store.cases.listExported()).map((c) => c.id)).toEqual([sent.id]);
  });

  it('round-trips structured evidence', async () => {
    const e = await store.evidence.insert({
      userId: 'u1', chatId: 'c1', messageId: 7, mediaKind: 'photo', fileRef: 'f1', fileUniqueId: 'uniq1',
      category: 'withdrawal_screenshot', categoryConfidence: 0.92, status: 'processed', notes: [],
      withdrawals: [
        { position: 1, withdrawalId: 'WD-1', amount: 500, confidence: 0.9 },
        { position: 2, withdrawalId: 'WD-2', amount: 700, confidence: 0.9 },
      ],
    });
    expect((await store.evidence.findByFile('u1', 'uniq1'))?.id).toBe(e.id);
    const [fromMsg] = await store.evidence.listByMessage('c1', 7);
    expect(fromMsg?.withdrawals?.map((w) => w.withdrawalId)).toEqual(['WD-1', 'WD-2']);
    await store.evidence.update({ ...e, sha256: 'abc', status: 'processed' });
    expect((await store.evidence.findBySha('u1', 'abc'))?.id).toBe(e.id);
    expect(await store.evidence.listByIds([e.id, 'missing-id-0000-0000-000000000000'.slice(0, 36)])).toHaveLength(1);
  });

  it('allows only one open ticket per case', async () => {
    const c = await store.cases.create({ userId: 'u1', chatId: 'c1', type: 'deposit' });
    const t1 = await store.tickets.createIfAbsent({ caseId: c.id, userId: 'u1', chatId: 'c1', reason: 'insufficient_evidence', summary: {} });
    const t2 = await store.tickets.createIfAbsent({ caseId: c.id, userId: 'u1', chatId: 'c1', reason: 'insufficient_evidence', summary: {} });
    expect(t1.created).toBe(true);
    expect(t2.created).toBe(false);
    expect(t2.ticket.id).toBe(t1.ticket.id);
    await store.tickets.update(t1.ticket.id, { status: 'delivered', supportChatId: '-100', supportMessageId: 55, attempts: 1 });
    expect((await store.tickets.findBySupportMessage('-100', 55))?.id).toBe(t1.ticket.id);
    expect(await store.tickets.listUndelivered(5)).toHaveLength(0);
    await store.tickets.update(t1.ticket.id, { status: 'closed' });
    const t3 = await store.tickets.createIfAbsent({ caseId: c.id, userId: 'u1', chatId: 'c1', reason: 'business_rule', summary: {} });
    expect(t3.created).toBe(true);
  });

  it('outbox enqueue is idempotent per key', async () => {
    const a = await store.outbox.enqueue({ key: 'turn:1', chatId: 'c1', text: 'hi', meta: {} });
    const b = await store.outbox.enqueue({ key: 'turn:1', chatId: 'c1', text: 'different', meta: {} });
    expect(a.created).toBe(true);
    expect(b.created).toBe(false);
    expect(b.entry.text).toBe('hi');
    await store.outbox.markSent(a.entry.id, 99);
    expect((await store.outbox.getByKey('turn:1'))?.telegramMessageId).toBe(99);
    expect(await store.outbox.listPending(3)).toHaveLength(0);
  });

  it('tracks processed inbound messages for crash recovery', async () => {
    const base = { chatId: 'c1', userId: 'u1', direction: 'in' as const, media: [], meta: {} };
    await store.messages.insert({ ...base, telegramMessageId: 1, text: 'a' });
    await store.messages.insert({ ...base, telegramMessageId: 2, text: 'b' });
    await store.messages.insert({ ...base, direction: 'out', telegramMessageId: 3, text: 'bot' });
    expect((await store.messages.listUnprocessed(new Date(0))).map((m) => m.telegramMessageId)).toEqual([1, 2]);
    await store.messages.markProcessed('c1', [1], { turnId: '11111111-1111-4111-8111-111111111111' });
    const left = await store.messages.listUnprocessed(new Date(0));
    expect(left.map((m) => m.telegramMessageId)).toEqual([2]);
    expect((await store.messages.find('c1', 1))?.processedAt).toBeInstanceOf(Date);
  });

  it('tracks turns', async () => {
    const t = await store.turns.create({ chatId: 'c1', userId: 'u1', messageIds: [1, 2] });
    await store.turns.update(t.id, { status: 'responded', trace: { a: 1 }, completedAt: new Date() });
    const got = await store.turns.get(t.id);
    expect(got?.status).toBe('responded');
    expect(got?.messageIds).toEqual([1, 2]);
    expect(got?.trace).toEqual({ a: 1 });
  });
});
