import { describe, expect, it } from 'vitest';
import { parseOrdinalReference, resolveReference } from '../../src/context/references.js';

const rows = [
  { position: 1, withdrawalId: 'WD-1', confidence: 0.9 },
  { position: 2, withdrawalId: 'WD-2', confidence: 0.9 },
  { position: 3, withdrawalId: 'WD-3', confidence: 0.9 },
];

describe('ordinal reference parsing', () => {
  it.each([
    ['upper wala', { kind: 'index', index: 1 }],
    ['upar wala', { kind: 'index', index: 1 }],
    ['sabse upar wala check karo', { kind: 'index', index: 1 }],
    ['top wala', { kind: 'index', index: 1 }],
    ['pehla wala', { kind: 'index', index: 1 }],
    ['first one', { kind: 'index', index: 1 }],
    ['second wala', { kind: 'index', index: 2 }],
    ['dusra wala bhai', { kind: 'index', index: 2 }],
    ['teesra', { kind: 'index', index: 3 }],
    ['2 number wala', { kind: 'index', index: 2 }],
    ['last wala', { kind: 'last', strict: true }],
    ['sabse neeche wala', { kind: 'last', strict: true }],
    ['neeche wala', { kind: 'last', strict: false }],
    ['ye wala', { kind: 'this' }],
    ['isi ka', { kind: 'this' }],
    ['ऊपर वाला', { kind: 'index', index: 1 }],
  ])('%s', (text, expected) => {
    expect(parseOrdinalReference(text)).toEqual(expected);
  });

  it.each(['mujhe top up karna hai', 'mera withdrawal abhi tak nahi aaya bank mein please check karo', 'lineup de diya karo'])(
    'ignores non-references: %s',
    (text) => {
      expect(parseOrdinalReference(text)).toBeUndefined();
    },
  );
});

describe('reference resolution', () => {
  it('resolves by visual order regardless of input order', () => {
    const shuffled = [rows[2]!, rows[0]!, rows[1]!];
    const r = resolveReference({ kind: 'index', index: 1 }, shuffled);
    expect(r).toMatchObject({ status: 'resolved', item: { withdrawalId: 'WD-1' } });
    expect(resolveReference({ kind: 'last', strict: true }, shuffled)).toMatchObject({ item: { withdrawalId: 'WD-3' } });
  });

  it('treats loose "neeche" as the bottom row only when there are two rows', () => {
    expect(resolveReference({ kind: 'last', strict: false }, rows.slice(0, 2))).toMatchObject({ item: { withdrawalId: 'WD-2' } });
    expect(resolveReference({ kind: 'last', strict: false }, rows).status).toBe('ambiguous');
  });

  it('handles out-of-range and "this"', () => {
    expect(resolveReference({ kind: 'index', index: 5 }, rows).status).toBe('out_of_range');
    expect(resolveReference({ kind: 'this' }, rows.slice(0, 1))).toMatchObject({ status: 'resolved' });
    expect(resolveReference({ kind: 'this' }, rows).status).toBe('ambiguous');
    expect(resolveReference({ kind: 'index', index: 1 }, []).status).toBe('no_candidates');
  });
});
