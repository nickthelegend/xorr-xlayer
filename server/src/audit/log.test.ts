/** Audit hashing — PLAN.md 12.11. Pure; the DB-backed chain is proven in executor.chain.test.ts. */
import { describe, expect, it } from 'vitest';
import { canonical, hashEntry } from './log.js';

const entry = {
  prevHash: '0'.repeat(64),
  walletId: 'w1',
  at: '2026-09-05T12:00:00.000Z',
  agent: 'Momentum Scout',
  action: 'Bought 4.2 SOL',
  detail: 'Breakout above 20d high',
  amount: '−$370.02',
  kind: 'trade',
  signature: 'sig1',
  payload: { runId: 'r1', strategyId: 's1' },
};

describe('canonical JSON', () => {
  it('sorts object keys so storage order cannot change the digest', () => {
    expect(canonical({ b: 1, a: 2 })).toBe('{"a":2,"b":1}');
    expect(canonical({ a: 2, b: 1 })).toBe(canonical({ b: 1, a: 2 }));
  });

  it('sorts nested keys too', () => {
    expect(canonical({ x: { z: 1, y: 2 } })).toBe('{"x":{"y":2,"z":1}}');
  });

  it('preserves array order — arrays are sequences, not sets', () => {
    expect(canonical([3, 1, 2])).toBe('[3,1,2]');
    expect(canonical([1, 2, 3])).not.toBe(canonical([3, 2, 1]));
  });

  it('handles the primitives that appear in a payload', () => {
    expect(canonical(null)).toBe('null');
    expect(canonical('a')).toBe('"a"');
    expect(canonical(42)).toBe('42');
    expect(canonical(true)).toBe('true');
  });
});

describe('the hash commits to every field', () => {
  it('is stable for identical input', () => {
    expect(hashEntry(entry)).toBe(hashEntry(entry));
    expect(hashEntry(entry)).toMatch(/^[0-9a-f]{64}$/);
  });

  it('THIS is the bug that broke the chain: JSONB key order must not matter', () => {
    const reordered = { ...entry, payload: { strategyId: 's1', runId: 'r1' } };
    expect(hashEntry(reordered)).toBe(hashEntry(entry));
  });

  it('changing any field changes the hash', () => {
    const fields: (keyof typeof entry)[] = [
      'prevHash',
      'walletId',
      'at',
      'agent',
      'action',
      'detail',
      'amount',
      'kind',
      'signature',
    ];
    for (const f of fields) {
      const tampered = { ...entry, [f]: `${String(entry[f])}x` };
      expect(hashEntry(tampered), `${f} is not committed to`).not.toBe(hashEntry(entry));
    }
    expect(hashEntry({ ...entry, payload: { runId: 'r2' } })).not.toBe(hashEntry(entry));
  });

  it('a broken link changes every hash after it — which is the point of a chain', () => {
    const a = hashEntry(entry);
    const b = hashEntry({ ...entry, prevHash: a });
    const tamperedA = hashEntry({ ...entry, detail: 'tampered' });
    const bAfterTamper = hashEntry({ ...entry, prevHash: tamperedA });
    expect(bAfterTamper).not.toBe(b);
  });
});
