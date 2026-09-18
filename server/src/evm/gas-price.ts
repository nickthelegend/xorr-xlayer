/**
 * What gas costs right now, and what a transaction of a given size costs in dollars (PLAN.md 3.13).
 *
 * The chain's own `eth_gasPrice`: on X Layer, a fork of it or its testnet, what the node the executor sends to charges.
 * Gas is paid in OKB, so a fee in dollars is priced in OKB — never another chain's gas token.
 */
import { formatEther, formatGwei } from 'viem';
import { publicClient } from './client.js';
import { priceOf } from '../market/prices.js';

export type GasPrice = { wei: bigint; source: 'chain' };

export async function gasPrice(): Promise<GasPrice> {
  return { wei: await publicClient.getGasPrice(), source: 'chain' };
}

export type NetworkCost = {
  priceGwei: number;
  source: GasPrice['source'];
  units: number | null;
  feeUsd: number | null;
};

/**
 * The price, and — when the size is known and OKB can be priced — what `units` of gas cost in dollars. `priceMs` is how
 * long OKB's price may take: past it the fee is unknown, never a guess.
 */
export async function networkCost(
  units: number | undefined,
  opts: { price?: GasPrice; priceMs?: number } = {},
): Promise<NetworkCost> {
  const price = opts.price ?? (await gasPrice());
  const priceGwei = Number(formatGwei(price.wei));
  if (!units || !(units > 0)) return { priceGwei, source: price.source, units: null, feeUsd: null };
  const okbUsd = await priceOf('WOKB', opts.priceMs).catch(() => undefined);
  const feeOkb = Number(formatEther(price.wei * BigInt(Math.round(units))));
  return { priceGwei, source: price.source, units, feeUsd: okbUsd === undefined ? null : feeOkb * okbUsd };
}
