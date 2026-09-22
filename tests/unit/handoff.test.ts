import { describe, expect, it } from 'vitest';
import { emptyFacts, type CaseRecord } from '../../src/domain/cases.js';
import { emptyMemory } from '../../src/domain/memory.js';
import { HandoffService } from '../../src/handoff/service.js';
import { buildHandoffSummary, renderSupportMessage } from '../../src/handoff/summary.js';
import { silentLogger } from '../../src/observability/logger.js';
import { MemoryStore } from '../../src/storage/memory.js';
import type { UserRecord } from '../../src/storage/types.js';
import { FakeTransport, SUPPORT_CHAT } from '../helpers/harness.js';

const NOW = new Date('2026-09-11T12:00:00Z');
const user: UserRecord = { id: 'u1', chatId: 'u1', username: 'rahul', firstName: 'Rahul', memory: emptyMemory(), createdAt: NOW, updatedAt: NOW };

async function withdrawalCase(store: MemoryStore): Promise<CaseRecord> {
  const c = await store.cases.create({ userId: 'u1', chatId: 'u1', type: 'withdrawal' });
  return {
    ...c,
    withdrawalId: 'WD-15436-64215', amount: 1450, utr: '523456789012', registrationNumber: '9810822372', missing: ['bank_statement'],
    facts: {
      ...emptyFacts(),
      claims: { notReceived: true },
      payout: {
        withdrawalId: 'WD-15436-64215', amount: 1450, status: 'SUCCESS', accountNumber: '50100123456789', ifsc: 'HDFC0001234', bankName: 'HDFC Bank',
        beneficiaryName: 'RAHUL KUMAR', fetchedAt: NOW.toISOString(),
      },
    },
  };
}

describe('handoff summary', () => {
  it('contains everything a human needs, with bank details masked and secrets scrubbed', async () => {
    const store = new MemoryStore();
    const c = await withdrawalCase(store);
    const s = buildHandoffSummary({
      c, reason: 'withdrawal_credit_missing', note: 'credit not in statement', user, evidence: [],
      history: [{ id: 'm', chatId: 'u1', userId: 'u1', telegramMessageId: 1, direction: 'in', text: 'Password: SECRET12 paisa nahi aaya', media: [], meta: {}, createdAt: NOW }],
    });
    const text = renderSupportMessage(s);
    for (const expected of ['WITHDRAWAL', 'WD-15436-64215', '₹1,450', 'SUCCESS', '523456789012', '9810822372', 'HDFC0001234', '@rahul', 'notReceived', 'bank_statement']) {
      expect(text).toContain(expected);
    }
    expect(text).not.toContain('50100123456789');
    expect(text).toContain('XXXXXXXXXX6789');
    expect(text).not.toContain('SECRET12');
    expect(text).not.toContain('RAHUL KUMAR');
  });
});

describe('HandoffService', () => {
  it('creates one ticket per case and reports delivery honestly', async () => {
    const store = new MemoryStore();
    const transport = new FakeTransport();
    const svc = new HandoffService({ store, transport, supportChatId: SUPPORT_CHAT, log: silentLogger });
    const c = await withdrawalCase(store);

    transport.failSupportSends = 1;
    const first = await svc.escalate(c, { reason: 'withdrawal_credit_missing' }, { user, evidence: [], history: [] });
    expect(first.delivered).toBe(false);
    expect(first.ticket.status).toBe('failed');

    const second = await svc.escalate(c, { reason: 'withdrawal_credit_missing' }, { user, evidence: [], history: [] });
    expect(second.delivered).toBe(true);
    expect(second.ticket.id).toBe(first.ticket.id);

    const third = await svc.escalate(c, { reason: 'user_requested_human' }, { user, evidence: [], history: [] });
    expect(third).toMatchObject({ delivered: true, alreadyDelivered: true });
    expect(transport.sent.filter((s) => s.chatId === SUPPORT_CHAT)).toHaveLength(1);
  });

  it('never claims delivery without a support group', async () => {
    const store = new MemoryStore();
    const svc = new HandoffService({ store, transport: new FakeTransport(), log: silentLogger });
    const r = await svc.escalate(await withdrawalCase(store), { reason: 'business_rule' }, { user, evidence: [], history: [] });
    expect(r.delivered).toBe(false);
    expect(r.ticket.lastError).toMatch(/not configured/);
  });

  it('threads updates under the delivered ticket and forwards evidence', async () => {
    const store = new MemoryStore();
    const transport = new FakeTransport();
    const svc = new HandoffService({ store, transport, supportChatId: SUPPORT_CHAT, log: silentLogger });
    const c = await withdrawalCase(store);
    const { ticket } = await svc.escalate(c, { reason: 'withdrawal_credit_missing' }, { user, evidence: [], history: [] });
    expect(await svc.appendUpdate(c.id, 'Customer sent statement', [42])).toBe(true);
    const update = transport.sent[transport.sent.length - 1]!;
    expect(update.replyTo).toBe(ticket.supportMessageId);
    expect(transport.forwards).toContainEqual({ from: 'u1', messageId: 42, to: SUPPORT_CHAT });
  });
});
