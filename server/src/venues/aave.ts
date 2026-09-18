/**
 * Aave v3 on X Layer — the venue for tier 4, "move idle cash to yield" (PLAN.md P2.14, D15).
 *
 * The pool's address is a property of the chain, so it lives in `evm/chains.ts` (`AAVE_V3_POOL`, null where the chain
 * has no lending pool) beside every other venue the grant allowlists. Supplying is spending in the sense the daily cap
 * cares about — capital leaves the wallet — so it goes through `spend()` rather than the close path.
 *
 * The aToken goes to the OWNER, never to us. `supply(asset, amount, onBehalfOf, referralCode)` takes the recipient
 * explicitly, which is the whole reason this venue is usable inside a non-custodial delegation at all.
 *
 * The aToken address is deliberately NOT a constant here: `market/yield.ts` reads it from the pool's reserve, so there is
 * one source of truth for which receipt token the user ends up holding.
 */
import { encodeFunctionData, type Address, type Hex } from 'viem';

const POOL_ABI = [
  {
    type: 'function',
    name: 'supply',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'asset', type: 'address' },
      { name: 'amount', type: 'uint256' },
      { name: 'onBehalfOf', type: 'address' },
      { name: 'referralCode', type: 'uint16' },
    ],
    outputs: [],
  },
  {
    type: 'function',
    name: 'withdraw',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'asset', type: 'address' },
      { name: 'amount', type: 'uint256' },
      { name: 'to', type: 'address' },
    ],
    outputs: [{ type: 'uint256' }],
  },
] as const;

/**
 * Calldata to supply `asset` (USDT0, on X Layer) on the owner's behalf.
 *
 * `onBehalfOf` is the owner, so the aToken — and therefore the yield and the right to withdraw —
 * belongs to them from the moment the transaction lands. The delegation is a conduit and holds
 * nothing afterwards.
 */
export function supplyCalldata(params: { asset: Address; amountRaw: bigint; owner: Address }): Hex {
  return encodeFunctionData({
    abi: POOL_ABI,
    functionName: 'supply',
    args: [params.asset, params.amountRaw, params.owner, 0],
  });
}

/** Calldata to withdraw back to the owner. */
export function withdrawCalldata(params: {
  asset: Address;
  amountRaw: bigint;
  owner: Address;
}): Hex {
  return encodeFunctionData({
    abi: POOL_ABI,
    functionName: 'withdraw',
    args: [params.asset, params.amountRaw, params.owner],
  });
}
