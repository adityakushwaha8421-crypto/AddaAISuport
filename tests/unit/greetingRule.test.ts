import { describe, expect, it } from 'vitest';
import { emptyMemory, localDay, noteVisit } from '../../src/domain/memory.js';
import { guardResponse } from '../../src/response/guard.js';

describe('the customer\'s calendar day', () => {
  it('is computed in the customers\' timezone', () => {
    const t = new Date('2026-09-11T20:30:00Z'); // 02:00 IST on the 12th
    expect(localDay(t, 'Asia/Kolkata')).toBe('2026-09-12');
    expect(localDay(t, 'UTC')).toBe('2026-09-11');
  });

  it('marks the first visit of each day and no other', () => {
    const tz = 'Asia/Kolkata';
    let m = emptyMemory();
    let v = noteVisit(m, new Date('2026-09-11T06:30:00Z'), tz); // 12:00 IST
    expect(v.firstOfDay).toBe(true);
    m = v.memory;
    v = noteVisit(m, new Date('2026-09-11T18:00:00Z'), tz); // 23:30 IST, same day
    expect(v.firstOfDay).toBe(false);
    expect(v.memory).toBe(m); // unchanged, nothing to save
    v = noteVisit(m, new Date('2026-09-11T18:40:00Z'), tz); // 00:10 IST next day
    expect(v.firstOfDay).toBe(true);
    expect(v.memory.lastSeenOn).toBe('2026-09-12');
  });
});

describe('the guard keeps model phrasing from greeting on its own', () => {
  const ctx = (acts: Parameters<typeof guardResponse>[1]['acts']) => ({ acts, draft: 'Sir, lineup match se pehle contest page par dikhta hai.', userText: 'lineup kab aayega' });
  it('rejects an opening hello the plan does not contain', () => {
    expect(guardResponse('Hello sir 👋 Lineup match se pehle contest page par dikhta hai.', ctx([{ type: 'general_answer', question: 'q', knowledge: ['k'] }]))).toMatchObject({ ok: false, reason: 'unplanned_greeting' });
    expect(guardResponse('Good morning! Lineup match se pehle contest page par dikhta hai.', ctx([{ type: 'general_answer', question: 'q', knowledge: ['k'] }])).ok).toBe(false);
  });
  it('allows it when the plan greets, and never trips on "hi" inside a sentence', () => {
    expect(guardResponse('Hello sir 👋 Kaise help karun?', ctx([{ type: 'greeting' }])).ok).toBe(true);
    expect(guardResponse('Sir, lineup match se pehle contest page par dikhta hai, hi-lo nahi.', ctx([{ type: 'general_answer', question: 'q', knowledge: ['k'] }])).ok).toBe(true);
  });
});
