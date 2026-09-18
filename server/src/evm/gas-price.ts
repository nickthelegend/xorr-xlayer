/**
 * What gas costs right now, and what a transaction of a given size costs in dollars (PLAN.md 3.13).
 *
 * On Base the price comes from 1inch's Gas Price API — the same provider that routes the trade. Anywhere else it
 * is the chain's own `eth_gasPrice`: 1inch prices Base mainnet only, and a fork or a testnet charges what its own
 * node says, not what mainnet does.
 */
import { formatEther, formatGwei } from 'viem';
import { publicClient } from './client.js';
import { CHAIN_KEY } from './chains.js';
import { oneinchApi } from '../venues/oneinch.js';
import { priceOf } from '../market/prices.js';

export type GasPrice = { wei: bigint; source: '1inch' | 'chain' };

/** `GET /gas-price/v1.6/8453` — the fields read here. */
type OneInchGasPrice = { baseFee: string; medium: { maxPriorityFeePerGas: string; maxFeePerGas: string } };

export async function gasPrice(): Promise<GasPrice> {
  if (CHAIN_KEY === 'base') {
    const r = await oneinchApi<OneInchGasPrice>('/gas-price/v1.6/8453');
    // What a transaction sent now at normal priority is prepared to pay per unit of gas.
    return { wei: BigInt(r.medium.maxFeePerGas), source: '1inch' };
  }
  return { wei: await publicClient.getGasPrice(), source: 'chain' };
}

export type NetworkCost = {
  priceGwei: number;
  source: GasPrice['source'];
  units: number | null;
  feeUsd: number | null;
};

/**
 * The price, and — when the size is known and ETH can be priced — what `units` of gas cost in dollars.
 *
 * `price` is a gas price the caller already read, so a route that reads it alongside something else does not ask twice.
 * `priceMs` is how long ETH's price may take: past it the fee is unknown, never a guess. Without it the fee waited as
 * long as the price feed took, and behind a swap quote on the hosted fork that was 97 seconds (docs/qa/ENDPOINTS.md E187).
 */
export async function networkCost(
  units: number | undefined,
  opts: { price?: GasPrice; priceMs?: number } = {},
): Promise<NetworkCost> {
  const price = opts.price ?? (await gasPrice());
  const priceGwei = Number(formatGwei(price.wei));
  if (!units || !(units > 0)) return { priceGwei, source: price.source, units: null, feeUsd: null };
  const ethUsd = await priceOf('WETH', opts.priceMs).catch(() => undefined);
  const feeEth = Number(formatEther(price.wei * BigInt(Math.round(units))));
  return { priceGwei, source: price.source, units, feeUsd: ethUsd === undefined ? null : feeEth * ethUsd };
}
