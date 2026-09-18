/**
 * The property that matters is that a refused window is RETRIED, never skipped.
 *
 * Skipping would lose whatever was shipped inside it and lose it silently, which is the exact
 * failure this module exists to end rather than relocate.
 *
 * And a topic filter, when one is given, is asked of every window — a window asked without it would
 * return other owners' events as this owner's (PLAN.md 3.14).
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';

const getLogs = vi.fn();
const getCode = vi.fn();
vi.mock('./client.js', () => ({
  publicClient: { getLogs: (a: unknown) => getLogs(a), getCode: (a: unknown) => getCode(a) },
}));

process.env.LOG_WINDOW_BLOCKS = '1000';
const { getLogsPaged, isRangeRefusal, deploymentBlock } = await import('./logs.js');

const EVENT = { type: 'event', name: 'Shipped', inputs: [] } as const;
const ADDRESS = '0x00000000000000000000000000000000000000A1' as const;

beforeEach(() => {
  getLogs.mockReset();
});

describe('paging eth_getLogs', () => {
  it('splits a wide range into windows and returns every log', async () => {
    getLogs.mockImplementation(async ({ fromBlock }: { fromBlock: bigint }) => [
      { blockNumber: fromBlock },
    ]);
    const logs = await getLogsPaged({ address: ADDRESS, event: EVENT, fromBlock: 0n, toBlock: 2_999n });
    expect(getLogs).toHaveBeenCalledTimes(3);
    expect(logs).toHaveLength(3);
    // Contiguous, no gaps: 0–999, 1000–1999, 2000–2999.
    expect(logs.map((l) => (l as unknown as { blockNumber: bigint }).blockNumber)).toEqual([0n, 1000n, 2000n]);
  });

  it('reads the limit out of the refusal and retries the same window', async () => {
    let refused = false;
    getLogs.mockImplementation(async ({ fromBlock, toBlock }: { fromBlock: bigint; toBlock: bigint }) => {
      if (!refused && toBlock - fromBlock + 1n > 200n) {
        refused = true;
        throw new Error('-32614 eth_getLogs is limited to a 200 range');
      }
      return [{ blockNumber: fromBlock, span: toBlock - fromBlock + 1n }];
    });
    const logs = await getLogsPaged({ address: ADDRESS, event: EVENT, fromBlock: 0n, toBlock: 398n });
    // The refused window is re-asked at the provider's own number, starting from the SAME block.
    expect((logs[0] as unknown as { blockNumber: bigint }).blockNumber).toBe(0n);
    expect((logs[0] as unknown as { span: bigint }).span).toBe(200n);
  });

  it('halves the window when the refusal names no number, and still covers the range', async () => {
    const served: [bigint, bigint][] = [];
    getLogs.mockImplementation(async ({ fromBlock, toBlock }: { fromBlock: bigint; toBlock: bigint }) => {
      if (toBlock - fromBlock + 1n > 250n) throw new Error('query returned more than 10000 results');
      served.push([fromBlock, toBlock]);
      return [{ blockNumber: fromBlock }];
    });
    // 300 blocks against a 250-block ceiling the provider does not name.
    const logs = await getLogsPaged({ address: ADDRESS, event: EVENT, fromBlock: 0n, toBlock: 299n });
    expect(logs.length).toBeGreaterThan(1);
    // Every block is covered exactly once, with no gap where a shipped book could hide.
    expect(served[0]![0]).toBe(0n);
    expect(served[served.length - 1]![1]).toBe(299n);
    for (let i = 1; i < served.length; i += 1) {
      expect(served[i]![0], 'a gap between windows').toBe(served[i - 1]![1] + 1n);
    }
  });

  it('rethrows a failure that is not about the range', async () => {
    getLogs.mockRejectedValue(new Error('unknown event signature'));
    await expect(
      getLogsPaged({ address: ADDRESS, event: EVENT, fromBlock: 0n, toBlock: 10n }),
    ).rejects.toThrow('unknown event signature');
  });

  it('recognises the refusals these providers actually send', () => {
    expect(isRangeRefusal(new Error('eth_getLogs is limited to a 2,000 range'))).toBe(true);
    expect(isRangeRefusal(new Error('exceeds max block range'))).toBe(true);
    expect(isRangeRefusal(new Error('execution reverted'))).toBe(false);
  });
});

/** An event that indexes its owner, as `XorrDelegation`'s `Spent` does — so a node can match the topic itself. */
const OWNED = {
  type: 'event',
  name: 'Spent',
  inputs: [
    { name: 'owner', type: 'address', indexed: true },
    { name: 'amount', type: 'uint256', indexed: false },
  ],
} as const;
const OWNER = '0x95A0b368588713011a15f4b1041423f31B08e615' as const;

type Asked = { address: string; event: unknown; args?: unknown; fromBlock: bigint; toBlock: bigint };
const asked = () => getLogs.mock.calls.map(([q]) => q as Asked);

describe('an indexed-topic filter (PLAN.md 3.14)', () => {
  it('is handed to every window unchanged, and the range is still covered without a gap', async () => {
    getLogs.mockImplementation(async ({ fromBlock }: { fromBlock: bigint }) => [{ blockNumber: fromBlock }]);

    const logs = await getLogsPaged({ address: ADDRESS, event: OWNED, args: { owner: OWNER }, fromBlock: 0n, toBlock: 2_499n });

    expect(logs).toHaveLength(3);
    expect(asked().map((q) => [q.fromBlock, q.toBlock])).toEqual([
      [0n, 999n],
      [1_000n, 1_999n],
      [2_000n, 2_499n],
    ]);
    for (const q of asked()) {
      expect(q.event).toBe(OWNED);
      expect(q.args).toEqual({ owner: OWNER });
    }
  });

  it('rides the retry of a refused window, so a smaller window never widens to every owner', async () => {
    let refused = false;
    getLogs.mockImplementation(async () => {
      if (!refused) {
        refused = true;
        throw new Error('eth_getLogs is limited to a 500 range');
      }
      return [];
    });

    await getLogsPaged({ address: ADDRESS, event: OWNED, args: { owner: OWNER }, fromBlock: 0n, toBlock: 999n });

    // The refused 0–999, then the same blocks again at the provider's number — each still asking for this owner.
    expect(asked().map((q) => [q.fromBlock, q.toBlock])).toEqual([
      [0n, 999n],
      [0n, 499n],
      [500n, 999n],
    ]);
    expect(asked().map((q) => q.args)).toEqual([{ owner: OWNER }, { owner: OWNER }, { owner: OWNER }]);
  });

  it('is left out of the request when none is given, so the book scans ask exactly what they always asked', async () => {
    getLogs.mockResolvedValue([]);

    await getLogsPaged({ address: ADDRESS, event: EVENT, fromBlock: 0n, toBlock: 1_500n });

    expect(getLogs).toHaveBeenCalledTimes(2);
    for (const q of asked()) expect(Object.keys(q).sort()).toEqual(['address', 'event', 'fromBlock', 'toBlock']);
  });
});

describe('X Layer', () => {
  it('reads the public RPC\'s own wording of its 100-block limit, wrapped by a fork or not', async () => {
    const asked: bigint[] = [];
    getLogs.mockImplementation(async ({ fromBlock, toBlock }: { fromBlock: bigint; toBlock: bigint }) => {
      if (toBlock - fromBlock + 1n > 100n) {
        throw new Error('Fork Error: Transport(HttpError { body: "block range greater than 100 max" })');
      }
      asked.push(toBlock - fromBlock + 1n);
      return [];
    });
    await getLogsPaged({ address: ADDRESS, event: EVENT, fromBlock: 0n, toBlock: 299n });
    expect(asked).toEqual([100n, 100n, 100n]);
  });

  it('finds the first block with code, so a scan never starts before the contract existed', async () => {
    getCode.mockImplementation(async ({ blockNumber }: { blockNumber: bigint }) => (blockNumber >= 70_990_941n ? '0x60' : '0x'));
    const addr = '0x00000000000000000000000000000000000000B2' as const;
    expect(await deploymentBlock(addr, 71_000_000n)).toBe(70_990_941n);
    const calls = getCode.mock.calls.length;
    // Once per address per process.
    expect(await deploymentBlock(addr, 71_000_000n)).toBe(70_990_941n);
    expect(getCode.mock.calls.length).toBe(calls);
  });
});
