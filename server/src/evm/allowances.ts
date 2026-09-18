/**
 * Who may pull a token from this wallet, and how much (PLAN.md 3.12).
 *
 * Two spenders matter. The delegation contract is the one the app asks the user to approve, so the executor can
 * trade inside the cap. The Uniswap v3 router is the one the app never needs approved — the delegation approves it for
 * exactly one trade and resets it to zero — so an allowance from the wallet to the router was granted somewhere else,
 * and is worth seeing and taking back. Both are read from the chain.
 */
import { erc20Abi, formatUnits, type Address } from 'viem';
import { publicClient } from './client.js';
import { ADDRESSES, QUOTE_ADDRESSES } from './chains.js';

/**
 * An allowance at least this large is unlimited: no token's supply comes near 2^254.
 *
 * Not `=== max uint256`. The fork tooling approves 2^255, and WETH counts an allowance short of the
 * maximum down with every sale, so the Railway fork's WETH allowance read as a 59-digit number of
 * WETH on the Approvals screen. The same bar as `EFFECTIVELY_UNLIMITED` in src/wallet/grantPlan.ts.
 */
const UNLIMITED = 1n << 254n;

export type TokenAllowance = {
  symbol: string;
  address: Address;
  decimals: number;
  /** The exact uint256, as a decimal string. Null when it could not be read. */
  allowance: string | null;
  display: string | null;
  unlimited: boolean;
  none: boolean;
  /** The read failed. Said so, rather than shown as "None" — an allowance nobody could read is not no allowance. */
  unread: boolean;
};

export function allowanceView(
  token: { symbol: string; address: Address; decimals: number },
  raw: bigint | undefined,
): TokenAllowance {
  return {
    ...token,
    allowance: raw === undefined ? null : raw.toString(),
    display: raw === undefined ? null : formatUnits(raw, token.decimals),
    unlimited: raw !== undefined && raw >= UNLIMITED,
    none: raw === 0n,
    unread: raw === undefined,
  };
}

/** An allowance read from the token contract; undefined when the read failed. */
export async function chainAllowance(token: Address, owner: Address, spender: Address): Promise<bigint | undefined> {
  return publicClient
    .readContract({ address: token, abi: erc20Abi, functionName: 'allowance', args: [owner, spender] })
    .catch(() => undefined);
}

/** The swap router a wallet might have approved elsewhere, read from the chain. */
export async function routerSpender(): Promise<{ address: Address; source: 'chain' }> {
  return { address: (ADDRESSES.uniswapRouter ?? QUOTE_ADDRESSES.uniswapRouter) as Address, source: 'chain' };
}

/** The wallet's allowance to the router, from the token contract. */
export async function routerAllowance(
  token: Address,
  owner: Address,
  _source: 'chain',
  router: Address,
): Promise<bigint | undefined> {
  return chainAllowance(token, owner, router);
}
