/**
 * Aave v3 on Base — the venue for tier 4, "move idle cash to yield".
 *
 * A separate venue from 1inch, and the delegation treats it as one: the user allowlists the Aave
 * Pool the same way they allowlist the router, and the same daily cap applies. Supplying is
 * spending in the sense the cap cares about — capital leaves the wallet — so it goes through
 * `spend()` rather than the close path.
 *
 * The aToken goes to the OWNER, never to us. `supply(asset, amount, onBehalfOf, referralCode)`
 * takes the recipient explicitly, which is the whole reason this venue is usable inside a
 * non-custodial delegation at all.
 */
import { encodeFunctionData, type Address, type Hex } from 'viem';

/*
 * The aToken address is deliberately NOT a constant here. `usdcReserve()` reads it from the Pool,
 * so there is one source of truth for which receipt token the user ends up holding — a hardcoded
 * second copy is the kind of thing that keeps working right up until Aave migrates a reserve.
 */

/** Aave v3 Pool on Base. Verified: getReserveData returns a live USDC reserve. */
export const AAVE_POOL: Address = '0xA238Dd80C259a72e81d7e4664a9801593F98d1c5';

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
 * Calldata to supply USDC on the owner's behalf.
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
