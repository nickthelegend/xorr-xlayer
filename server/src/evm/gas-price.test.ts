/**
 * What gas costs (PLAN.md 3.13): 1inch's Gas Price API on Base, the chain's own price anywhere else, and a fee in
 * dollars only when both the size and ETH's price are known.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { StillFetching } from '../http/deadline.js';

const h = vi.hoisted(() => ({ chain: 'base-fork' }));
vi.mock('./chains.js', () => ({
  get CHAIN_KEY() {
    return h.chain;
  },
}));
vi.mock('./client.js', () => ({ publicClient: { getGasPrice: vi.fn() } }));
vi.mock('../venues/oneinch.js', () => ({ oneinchApi: vi.fn() }));
vi.mock('../market/prices.js', () => ({ priceOf: vi.fn() }));

const { publicClient } = await import('./client.js');
const { oneinchApi } = await import('../venues/oneinch.js');
const { priceOf } = await import('../market/prices.js');
const { gasPrice, networkCost } = await import('./gas-price.js');

beforeEach(() => {
  h.chain = 'base-fork';
  // 2 gwei.
  vi.mocked(publicClient.getGasPrice).mockReset().mockResolvedValue(2_000_000_000n);
  vi.mocked(oneinchApi)
    .mockReset()
    .mockResolvedValue({ baseFee: '5000000', medium: { maxPriorityFeePerGas: '1500000', maxFeePerGas: '7500000' } });
  vi.mocked(priceOf).mockReset().mockResolvedValue(2_500);
});

describe('the gas price', () => {
  it("on Base, is 1inch's normal-priority max fee, from the Gas Price API", async () => {
    h.chain = 'base';
    expect(await gasPrice()).toEqual({ wei: 7_500_000n, source: '1inch' });
    expect(oneinchApi).toHaveBeenCalledWith('/gas-price/v1.6/8453');
    expect(publicClient.getGasPrice).not.toHaveBeenCalled();
  });

  it("anywhere else, is the chain's own", async () => {
    expect(await gasPrice()).toEqual({ wei: 2_000_000_000n, source: 'chain' });
    expect(oneinchApi).not.toHaveBeenCalled();
  });
});

describe('what a route costs to send', () => {
  it('is units times the price, in dollars at the price of ETH', async () => {
    // 200,000 gas at 2 gwei is 0.0004 ETH, which at $2,500 is $1.
    const cost = await networkCost(200_000);
    expect(cost).toMatchObject({ priceGwei: 2, source: 'chain', units: 200_000 });
    expect(cost.feeUsd).toBeCloseTo(1, 10);
  });

  it('names the price and no fee when the size is unknown, or when ETH has no price', async () => {
    expect(await networkCost(undefined)).toEqual({ priceGwei: 2, source: 'chain', units: null, feeUsd: null });
    vi.mocked(priceOf).mockRejectedValue(new Error('no price'));
    expect(await networkCost(200_000)).toMatchObject({ units: 200_000, feeUsd: null });
  });

  it("prices ETH within the caller's patience, and takes a late price as no fee (E187)", async () => {
    await networkCost(200_000, { priceMs: 4_000 });
    expect(priceOf).toHaveBeenCalledWith('WETH', 4_000);
    vi.mocked(priceOf).mockRejectedValue(new StillFetching('the price of WETH'));
    expect(await networkCost(200_000, { priceMs: 4_000 })).toMatchObject({ priceGwei: 2, units: 200_000, feeUsd: null });
  });

  it('uses a gas price the caller already read, rather than asking the chain again', async () => {
    // 200,000 gas at 1 gwei is 0.0002 ETH, which at $2,500 is $0.50.
    const cost = await networkCost(200_000, { price: { wei: 1_000_000_000n, source: 'chain' } });
    expect(cost).toMatchObject({ priceGwei: 1, source: 'chain', units: 200_000 });
    expect(cost.feeUsd).toBeCloseTo(0.5, 10);
    expect(publicClient.getGasPrice).not.toHaveBeenCalled();
  });
});
