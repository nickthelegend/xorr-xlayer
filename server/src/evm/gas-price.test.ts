/**
 * What gas costs (PLAN.md 3.13): the chain's own price on every X Layer network, and a fee in dollars — priced in OKB,
 * X Layer's gas token — only when both the size and OKB's price are known.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { StillFetching } from '../http/deadline.js';

vi.mock('./client.js', () => ({ publicClient: { getGasPrice: vi.fn() } }));
vi.mock('../market/prices.js', () => ({ priceOf: vi.fn() }));

const { publicClient } = await import('./client.js');
const { priceOf } = await import('../market/prices.js');
const { gasPrice, networkCost } = await import('./gas-price.js');

beforeEach(() => {
  // 2 gwei.
  vi.mocked(publicClient.getGasPrice).mockReset().mockResolvedValue(2_000_000_000n);
  // OKB at $50.
  vi.mocked(priceOf).mockReset().mockResolvedValue(50);
});

describe('the gas price', () => {
  it("is the chain's own, read from the node the executor sends to", async () => {
    expect(await gasPrice()).toEqual({ wei: 2_000_000_000n, source: 'chain' });
    expect(publicClient.getGasPrice).toHaveBeenCalledTimes(1);
  });
});

describe('what a route costs to send', () => {
  it('is units times the price, in dollars at the price of OKB', async () => {
    // 200,000 gas at 2 gwei is 0.0004 OKB, which at $50 is $0.02.
    const cost = await networkCost(200_000);
    expect(cost).toMatchObject({ priceGwei: 2, source: 'chain', units: 200_000 });
    expect(cost.feeUsd).toBeCloseTo(0.02, 10);
    expect(priceOf).toHaveBeenCalledWith('WOKB', undefined);
  });

  it('names the price and no fee when the size is unknown, or when OKB has no price', async () => {
    expect(await networkCost(undefined)).toEqual({ priceGwei: 2, source: 'chain', units: null, feeUsd: null });
    vi.mocked(priceOf).mockRejectedValue(new Error('no price'));
    expect(await networkCost(200_000)).toMatchObject({ units: 200_000, feeUsd: null });
  });

  it("prices OKB within the caller's patience, and takes a late price as no fee (E187)", async () => {
    await networkCost(200_000, { priceMs: 4_000 });
    expect(priceOf).toHaveBeenCalledWith('WOKB', 4_000);
    vi.mocked(priceOf).mockRejectedValue(new StillFetching('the price of WOKB'));
    expect(await networkCost(200_000, { priceMs: 4_000 })).toMatchObject({ priceGwei: 2, units: 200_000, feeUsd: null });
  });

  it('uses a gas price the caller already read, rather than asking the chain again', async () => {
    // 200,000 gas at 1 gwei is 0.0002 OKB, which at $50 is $0.01.
    const cost = await networkCost(200_000, { price: { wei: 1_000_000_000n, source: 'chain' } });
    expect(cost).toMatchObject({ priceGwei: 1, source: 'chain', units: 200_000 });
    expect(cost.feeUsd).toBeCloseTo(0.01, 10);
    expect(publicClient.getGasPrice).not.toHaveBeenCalled();
  });
});
