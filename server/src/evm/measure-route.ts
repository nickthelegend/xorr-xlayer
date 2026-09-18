/**
 * What a route delivers on the chain that executes it, read from a dry run of the call that carries it (PLAN.md X77).
 *
 * 1inch prices a route against live Base. A fork of Base keeps its pools as they were at the block it forked from, and
 * drifts from Base by however far the market has moved since. On the Railway fork, hours after its fork block, a $15
 * buy the aggregator quoted at 0.0059994 WETH would have delivered 0.0059278: the router's own floor refused it
 * (`ReturnAmountIsNotEnough`), and every aggregator trade in that direction failed while the other direction filled.
 *
 * A dry run of `spend()` or `closePosition()` runs the router against the fork itself. Both return the venue's own
 * answer, and a 1inch router answers with the amount it delivered as its first word — `swap` returns it beside the
 * amount spent, the single-pool paths return it alone — so that word is what the route does here. Real Base prices and
 * executes the same state, and settles on the quote.
 */
import { hexToBigInt, size, slice, type Address, type Hex } from 'viem';
import { CHAIN_KEY } from './chains.js';
import { delegateAccount, publicClient } from './client.js';
import { DELEGATION_ABI, DELEGATION_ADDRESS } from './delegation.js';

/** Where 1inch's prices and the chain's pools can disagree: a fork of Base, not Base. */
export const PRICES_DRIFT = CHAIN_KEY === 'base-fork' || CHAIN_KEY === 'localnet';

export type RouteLeg = {
  owner: Address;
  /** The contract call that will carry the leg: `spend()` for a buy, `closePosition()` for a sale or a conversion. */
  via: 'spend' | 'closePosition';
  token: Address;
  venue: Address;
  /** Exactly what the real call will pull, in the pay token's raw units. */
  amount: bigint;
  tokenOut: Address;
  data: Hex;
};

/**
 * The amount the route delivers the owner on this chain, in the output token's raw units.
 *
 * Throws the chain's own refusal when the call cannot run at all — a cap, a missing allowance, a route that reverts at any
 * price — because that is the answer, and a quote cannot stand in for it.
 */
export async function deliveredOnChain(leg: RouteLeg): Promise<bigint> {
  // A floor of one, the least the contract accepts: this asks what the route does, not whether it clears a bar.
  const args = [leg.owner, leg.token, leg.venue, leg.amount, leg.tokenOut, 1n, leg.data] as const;
  const call = { account: delegateAccount, address: DELEGATION_ADDRESS, abi: DELEGATION_ABI, args } as const;
  const { result } =
    leg.via === 'closePosition'
      ? await publicClient.simulateContract({ ...call, functionName: 'closePosition' })
      : await publicClient.simulateContract({ ...call, functionName: 'spend' });
  const answer = result as Hex;
  if (size(answer) < 32) throw new Error('The route answered without saying what it delivered.');
  return hexToBigInt(slice(answer, 0, 32));
}
