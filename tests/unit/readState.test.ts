import { beforeEach, describe, expect, it } from 'vitest';
import { ReadTracker } from '../../src/telegram/user/readState.js';

let now = 0;
let t: ReadTracker;
beforeEach(() => {
  now = 1_000_000;
  t = new ReadTracker({ graceMs: 3000, now: () => now });
});

describe('ReadTracker', () => {
  it('knows nothing about messages from before it was listening', () => {
    expect(t.seen('c', 5)).toBeUndefined();
    t.incoming('c', 7);
    expect(t.seen('c', 7)).toBe(false);
    expect(t.seen('c', 6)).toBeUndefined();
  });

  it('a human read covers messages up to it, not the ones after', () => {
    t.incoming('c', 10);
    expect(t.read('c', 10)).toBe('human');
    expect(t.seen('c', 10)).toBe(true);
    t.incoming('c', 11);
    expect(t.seen('c', 11)).toBe(false);
  });

  it('keeps chats apart', () => {
    t.incoming('a', 3);
    t.incoming('b', 3);
    t.read('a', 3);
    expect([t.seen('a', 3), t.seen('b', 3)]).toEqual([true, false]);
  });

  it('a read caused by our own reply going out is not a human read', () => {
    t.incoming('c', 10);
    const done = t.sending('c');
    expect(t.read('c', 10)).toBe('own_send');
    done();
    expect(t.seen('c', 10)).toBe(false);
  });

  it('a read just after our send covering only what we had is ours; later, or covering newer, is a human', () => {
    t.incoming('c', 10);
    t.sending('c')();
    now += 2000;
    expect(t.read('c', 10)).toBe('own_send');
    t.incoming('c', 12);
    expect(t.read('c', 12)).toBe('human'); // message 12 arrived after the send: someone opened the chat
    t.incoming('c', 13);
    t.sending('c')();
    now += 4000;
    expect(t.read('c', 13)).toBe('human');
  });

  it('never moves backwards', () => {
    t.incoming('c', 20);
    t.read('c', 20);
    t.read('c', 15);
    expect(t.seen('c', 20)).toBe(true);
  });
});
