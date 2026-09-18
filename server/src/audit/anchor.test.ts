/**
 * `agreement` decides whether the trail we hold still matches what Base was told, and the whole
 * value of anchoring rests on one of its branches being right: the one that says DIVERGED.
 *
 * Getting `ahead` wrong is the dangerous mistake, because `ahead` is a pass. A trail that has more
 * rows than were anchored is the ordinary state between anchors — and a trail that was REWRITTEN
 * also has "more rows than were anchored" if the rewrite is longer. Comparing lengths alone would
 * wave that through, which would leave the check reporting healthy on exactly the event it exists
 * to catch.
 *
 * Neither the database nor the chain is needed to prove that: both are supplied directly.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { Hex } from 'viem';

/** The rows a wallet's trail holds, oldest first, as `hash` values. */
let hashes: string[] = [];

vi.mock('../db/index.js', () => ({
  one: async (sql: string, params: unknown[]) => {
    // `localHead` asks for the newest row plus a count.
    if (/ORDER BY seq DESC/.test(sql)) {
      const last = hashes[hashes.length - 1];
      return last ? { hash: last, n: String(hashes.length) } : undefined;
    }
    // `agreement` asks for the row AT the anchored length, by offset.
    if (/OFFSET/.test(sql)) {
      const offset = Number(params[1]);
      const hit = hashes[offset];
      return hit ? { hash: hit } : undefined;
    }
    return undefined;
  },
  query: async () => [],
  tx: async (fn: (c: unknown) => unknown) => fn({}),
}));

/** What the chain says, swapped per test. */
let onChain: { head: Hex; entryCount: number; at: number; blockNo: number } | undefined;

vi.mock('../evm/client.js', () => ({
  publicClient: {
    readContract: async () =>
      onChain
        ? {
            head: onChain.head,
            entryCount: BigInt(onChain.entryCount),
            at: BigInt(onChain.at),
            blockNo: BigInt(onChain.blockNo),
          }
        : { head: `0x${'0'.repeat(64)}`, entryCount: 0n, at: 0n, blockNo: 0n },
  },
  walletClient: { writeContract: async () => '0xdead', chain: undefined },
  delegateAccount: { address: '0x00000000000000000000000000000000000000A1' },
}));

process.env.ANCHOR_ADDRESS = '0x00000000000000000000000000000000000000B1';
const { agreement } = await import('./anchor.js');

const OWNER = '0x00000000000000000000000000000000000000C1' as const;
const chainAnchor = (head: string, entryCount: number) => ({
  head: head as Hex,
  entryCount,
  at: 1_788_000_000,
  blockNo: 46_000_000,
});

beforeEach(() => {
  hashes = [];
  onChain = undefined;
});

describe('does the trail still agree with what Base was told', () => {
  it('says none when nothing has ever been anchored', async () => {
    hashes = ['0xaa', '0xbb'];
    const a = await agreement('w1', OWNER);
    expect(a.state).toBe('none');
    expect(a.entryCount).toBe(2);
  });

  it('says match when the head on-chain is the head we hold', async () => {
    hashes = ['0xaa', '0xbb'];
    onChain = chainAnchor('0xbb', 2);
    expect((await agreement('w1', OWNER)).state).toBe('match');
  });

  it('says ahead when rows were written after the anchor and the anchored row is untouched', async () => {
    hashes = ['0xaa', '0xbb', '0xcc'];
    onChain = chainAnchor('0xbb', 2);
    const a = await agreement('w1', OWNER);
    expect(a.state).toBe('ahead');
    expect(a.entryCount).toBe(3);
  });

  /*
   * The one that matters. A LONGER trail whose anchored position no longer hashes to what was
   * published is a rewrite, and a length comparison alone would call it "ahead" and pass.
   */
  it('says diverged when the trail grew but the anchored row was rewritten', async () => {
    hashes = ['0xaa', '0xZZ-rewritten', '0xcc'];
    onChain = chainAnchor('0xbb', 2);
    expect((await agreement('w1', OWNER)).state).toBe('diverged');
  });

  it('says diverged when the trail is shorter than what was anchored', async () => {
    hashes = ['0xaa'];
    onChain = chainAnchor('0xbb', 2);
    expect((await agreement('w1', OWNER)).state).toBe('diverged');
  });

  it('says diverged when the head changed without the length changing', async () => {
    hashes = ['0xaa', '0xdifferent'];
    onChain = chainAnchor('0xbb', 2);
    expect((await agreement('w1', OWNER)).state).toBe('diverged');
  });

  it('compares hashes without caring about 0x casing', async () => {
    hashes = ['0xAA', '0xBB'];
    onChain = chainAnchor('0xbb', 2);
    expect((await agreement('w1', OWNER)).state).toBe('match');
  });
});
