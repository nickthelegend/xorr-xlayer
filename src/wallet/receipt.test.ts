import { describe, expect, it } from 'vitest';
import type { Hex } from 'viem';
import { ReceiptTimeoutError, readAgain, receiptOf } from './receipt';

const HASH = `0x${'ab'.repeat(32)}` as Hex;

/** A clock that only moves when the waiter sleeps. */
function clock() {
  let t = 0;
  return { now: () => t, sleep: async (ms: number) => void (t += ms) };
}

describe('receiptOf', () => {
  /*
   * The mainnet failure (2026-09-26): one node announced the block, the next one asked had not reached it, and viem's
   * waiter surfaced its "block is out of range" as the result of a budget that had landed.
   */
  it('asks again through a node that is behind, and returns the receipt when one answers', async () => {
    const answers: (Error | { status: string })[] = [
      new Error('block is out of range'),
      new Error('Transaction receipt with hash could not be found'),
      { status: 'success' },
    ];
    const reader = { getTransactionReceipt: async () => {
      const next = answers.shift()!;
      if (next instanceof Error) throw next;
      return next;
    } };
    const receipt = await receiptOf(reader as never, HASH, clock());
    expect(receipt).toEqual({ status: 'success' });
    expect(answers).toHaveLength(0);
  });

  it('gives up with a timeout, not the last node error, once the time is spent', async () => {
    const reader = { getTransactionReceipt: async () => {
      throw new Error('block is out of range');
    } };
    const wait = receiptOf(reader as never, HASH, { ...clock(), timeoutMs: 5_000, everyMs: 1_000 });
    await expect(wait).rejects.toBeInstanceOf(ReceiptTimeoutError);
    await expect(wait).rejects.toThrow(/not confirmed it yet/);
  });
});

describe('readAgain', () => {
  it('reads again while the read is refused, and stops at the first answer', async () => {
    let calls = 0;
    const value = await readAgain(async () => {
      calls += 1;
      if (calls < 3) throw new Error('header not found');
      return 7;
    }, { sleep: async () => undefined });
    expect(value).toBe(7);
    expect(calls).toBe(3);
  });

  it('passes the last refusal on once the tries are spent', async () => {
    await expect(
      readAgain(async () => {
        throw new Error('header not found');
      }, { tries: 2, sleep: async () => undefined }),
    ).rejects.toThrow(/header not found/);
  });
});
