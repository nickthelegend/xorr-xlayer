/**
 * The X Layer multiplier reader: what it reads as current, what it calls scheduled, and that it
 * never turns a token that did not answer into a multiplier of 1.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';

const h = vi.hoisted(() => ({ multicall: vi.fn(), query: vi.fn() }));
vi.mock('../evm/client.js', () => ({ publicClient: { multicall: h.multicall } }));
vi.mock('../evm/throttle.js', () => ({ pastTheThrottle: <T>(work: () => Promise<T>) => work() }));
vi.mock('../db/index.js', () => ({ query: h.query }));

const { readMultiplier, recordMultiplierObservation, recentObservations, MultiplierUnreadable } = await import(
  './multiplier.js'
);
const { XSTOCKS } = await import('./xstocks.js');

const E18 = 10n ** 18n;
const NOW = Date.parse('2026-09-19T00:00:00Z');
const ok = <T>(result: T) => ({ status: 'success' as const, result });
const fail = { status: 'failure' as const, error: new Error('reverted') };

/** The four reads in order: wrapper convertToAssets, raw getCurrentMultiplier, newMultiplier, activation. */
function chain(wrapper: bigint, current: bigint, next: bigint, activationSec: bigint) {
  h.multicall.mockResolvedValue([ok(wrapper), ok([current, 0n, 4n]), ok(next), ok(activationSec)]);
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('reading the multiplier', () => {
  it('reads the wrapper, cross-checked against the raw token, from one multicall', async () => {
    // SPYx as read on chain 2026-09-19.
    chain(1005714560286254000n, 1005714560286254000n, 1005714560286254000n, 0n);
    const r = await readMultiplier('SPYx', NOW);
    expect(r.multiplier).toBeCloseTo(1.005714560286254, 15);
    expect(r.exact).toBe('1.005714560286254');
    expect(r.wrapper).toBe(XSTOCKS.SPYx!.address);
    expect(r.pending).toBeNull();
    expect(h.multicall).toHaveBeenCalledTimes(1);
    const { contracts } = h.multicall.mock.calls[0]![0];
    expect(contracts[0]).toMatchObject({ address: XSTOCKS.SPYx!.address, functionName: 'convertToAssets', args: [E18] });
    expect(contracts[1]).toMatchObject({ address: XSTOCKS.SPYx!.raw, functionName: 'getCurrentMultiplier' });
  });

  it('reports a schedule only while its activation time is ahead', async () => {
    const at = BigInt(NOW / 1000 + 86_400);
    chain(E18, E18, 2n * E18, at);
    const r = await readMultiplier('NVDAx', NOW);
    expect(r.pending).toEqual({
      multiplier: 2,
      exact: '2',
      effectiveAtMs: Number(at) * 1000,
      effectiveAt: new Date(Number(at) * 1000).toISOString(),
    });

    // Past the activation the contract already reports the new value as current: nothing pending.
    chain(2n * E18, 2n * E18, 2n * E18, BigInt(NOW / 1000 - 60));
    expect((await readMultiplier('NVDAx', NOW)).pending).toBeNull();
  });

  it('throws — never 1 — when the wrapper does not answer', async () => {
    h.multicall.mockResolvedValue([fail, ok([E18, 0n, 0n]), ok(E18), ok(0n)]);
    await expect(readMultiplier('NVDAx', NOW)).rejects.toBeInstanceOf(MultiplierUnreadable);
  });

  it('throws when the raw token does not answer', async () => {
    h.multicall.mockResolvedValue([ok(E18), fail, ok(E18), ok(0n)]);
    await expect(readMultiplier('NVDAx', NOW)).rejects.toBeInstanceOf(MultiplierUnreadable);
  });

  it('throws when the wrapper and the raw token disagree beyond rounding', async () => {
    chain(E18, 2n * E18, 2n * E18, 0n);
    await expect(readMultiplier('NVDAx', NOW)).rejects.toThrow(/disagree/);
  });

  it('accepts a last-wei difference as the ERC-4626 rounding it is', async () => {
    chain(E18 - 1n, E18, E18, 0n);
    expect((await readMultiplier('NVDAx', NOW)).multiplier).toBeCloseTo(1, 12);
  });

  it('throws for a symbol that is not an xStock, without touching the chain', async () => {
    await expect(readMultiplier('WETH', NOW)).rejects.toBeInstanceOf(MultiplierUnreadable);
    expect(h.multicall).not.toHaveBeenCalled();
  });
});

describe('recording it', () => {
  const reading = {
    symbol: 'SPYx',
    wrapper: XSTOCKS.SPYx!.address,
    raw: XSTOCKS.SPYx!.raw,
    decimals: 18,
    multiplier: 1.0057,
    exact: '1.0057',
    pending: null,
  };
  const at = new Date('2026-09-19T00:05:00Z');

  it('writes the exact value, keyed on the wrapper, only when it differs from the last row', async () => {
    h.query.mockResolvedValue([{ id: '1' }]);
    expect(await recordMultiplierObservation(reading, at)).toBe('recorded');
    const [sql, params] = h.query.mock.calls[0]!;
    expect(sql).toMatch(/WHERE NOT EXISTS/);
    expect(params).toEqual([XSTOCKS.SPYx!.address, 'SPYx', '1.0057', 18, null, null, at.toISOString()]);
  });

  it('says unchanged when the value is the one already on record', async () => {
    h.query.mockResolvedValue([]);
    expect(await recordMultiplierObservation(reading, at)).toBe('unchanged');
  });

  it('says failed, not unchanged, when the write fails', async () => {
    h.query.mockRejectedValue(new Error('db down'));
    expect(await recordMultiplierObservation(reading, at)).toBe('failed');
  });

  it('lets a failed history read throw rather than look like an empty history', async () => {
    h.query.mockRejectedValue(new Error('db down'));
    await expect(recentObservations(XSTOCKS.SPYx!.address)).rejects.toThrow('db down');
  });
});
