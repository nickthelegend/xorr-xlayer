/**
 * A trail entry written once per transaction (PLAN.md X76): the lock is taken before the look, a hash the trail already
 * carries writes nothing, and a hash is the same hash whatever its case.
 */
import { describe, expect, it, vi } from 'vitest';
import { oncePerTransaction, type Querier } from './once.js';

const HASH = '0xAB5f2c1d9e0a7b3c4d5e6f708192a3b4c5d6e7f8091a2b3c4d5e6f708192a3b4';
const KEY = { walletId: 'wallet-1', action: 'Trading permission granted', signature: HASH };

/** A client whose trail holds `entries` rows matching any look. */
function client(entries: number) {
  const calls: { text: string; params?: unknown[] }[] = [];
  const querier: Querier = {
    query: vi.fn(async (text: string, params?: unknown[]) => {
      calls.push({ text, params });
      return { rowCount: /FROM audit_log/.test(text) ? entries : null };
    }),
  };
  return { querier, calls };
}

describe('a trail entry written once per transaction', () => {
  it('takes a lock on the hash, then looks, then writes when the trail does not carry it', async () => {
    const { querier, calls } = client(0);
    const write = vi.fn(async () => undefined);
    await expect(oncePerTransaction(querier, KEY, write)).resolves.toBe(true);
    expect(calls[0]).toEqual({
      text: 'SELECT pg_advisory_xact_lock(hashtext($1))',
      params: [`trail:${KEY.action}:${HASH.toLowerCase()}`],
    });
    expect(calls[1]!.text).toMatch(/FROM audit_log WHERE wallet_id = \$1 AND action = \$2 AND lower\(signature\) = \$3/);
    expect(calls[1]!.params).toEqual([KEY.walletId, KEY.action, HASH.toLowerCase()]);
    expect(write).toHaveBeenCalledOnce();
  });

  it('writes nothing for a hash the trail already carries', async () => {
    const { querier } = client(1);
    const write = vi.fn(async () => undefined);
    await expect(oncePerTransaction(querier, KEY, write)).resolves.toBe(false);
    expect(write).not.toHaveBeenCalled();
  });

  it('locks and looks for the same hash whatever case it arrives in', async () => {
    const upper = client(0);
    const lower = client(0);
    await oncePerTransaction(upper.querier, KEY, async () => undefined);
    await oncePerTransaction(lower.querier, { ...KEY, signature: HASH.toLowerCase() }, async () => undefined);
    expect(upper.calls.map((c) => c.params)).toEqual(lower.calls.map((c) => c.params));
  });

  it('lets a failed write fail, so the transaction around it rolls back with nothing held', async () => {
    const { querier } = client(0);
    await expect(
      oncePerTransaction(querier, KEY, async () => {
        throw new Error('insert failed');
      }),
    ).rejects.toThrow('insert failed');
  });
});
