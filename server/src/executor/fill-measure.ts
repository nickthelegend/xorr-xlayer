/**
 * What actually arrived, measured rather than assumed.
 *
 * A quote is a prediction and a fill is a fact. The units written to the audit trail are read from
 * the chain before and after the transaction, so the number a user sees is the number the chain
 * gave them rather than the number the router expected to.
 *
 * Split out of `run.ts` because these are pure reads that know nothing about runs, periods or
 * policies — and everything left in that file knows about all three. Extracted by function
 * boundary rather than by line range, after a first attempt sliced through a type declaration and
 * had to be reverted.
 */
import { erc20Abi, formatUnits, type Address } from 'viem';
import { publicClient } from '../evm/client.js';
import { ADDRESSES } from '../evm/chains.js';
import { TOKENS as VENUE_TOKENS } from '../venues/tokens.js';
import { priceOf } from '../market/prices.js';

/** The owner's balance of a token, exactly as the chain holds it. Undefined if it cannot be read. */
export async function rawBalanceOf(owner: Address, symbol: string): Promise<bigint | undefined> {
  const token = VENUE_TOKENS[symbol];
  if (!token) return undefined;
  return publicClient
    .readContract({ address: token.address, abi: erc20Abi, functionName: 'balanceOf', args: [owner] })
    .catch(() => undefined);
}

/**
 * How many units of `symbol` moved, in the token's own decimals.
 *
 * Undefined when either read failed — in which case the caller keeps its estimate rather than
 * recording a zero, since a zero here would erase the position.
 */
export async function measuredDelta(params: {
  owner: Address;
  symbol: string;
  before: bigint | undefined;
}): Promise<number | undefined> {
  if (params.before === undefined) return undefined;
  const token = VENUE_TOKENS[params.symbol];
  const after = await rawBalanceOf(params.owner, params.symbol);
  if (after === undefined || !token) return undefined;
  return Number(formatUnits(after - params.before, token.decimals));
}

/**
 * Roughly how many base units of `symbol` a dollar amount buys, for the venue depth check.
 *
 * Approximate on purpose: it decides which venue to ASK, and the venue then quotes for real. A
 * price lookup that failed should not block the trade, so it falls back to no depth constraint.
 *
 * `deadlineMs` is a screen's patience for the price (`http/patience.ts`). A run leaves it out, and waits.
 */
export async function estimateOutUnits(
  usd: number,
  symbol: string,
  decimals: number,
  deadlineMs?: number,
): Promise<bigint | undefined> {
  try {
    const px = await priceOf(symbol, deadlineMs);
    if (!(px > 0)) return undefined;
    return BigInt(Math.floor((usd / px) * 10 ** decimals));
  } catch {
    return undefined;
  }
}

/**
 * The owner's settlement-token balance, exactly as the chain holds it — what a sale's proceeds are
 * measured against (PLAN.md 2.8). Undefined if it cannot be read.
 *
 * The settlement address, not the routing registry's: `TOKENS` is Base mainnet everywhere, and the
 * USDC a sale pays into is the one `XORR_CHAIN` settles in.
 */
export async function usdcRawOf(owner: Address): Promise<bigint | undefined> {
  return publicClient
    .readContract({ address: ADDRESSES.usdc, abi: erc20Abi, functionName: 'balanceOf', args: [owner] })
    .catch(() => undefined);
}

/**
 * The USDC that arrived since `before`, in dollars.
 *
 * Undefined when either read failed or nothing arrived — a sale pays a non-zero floor by contract
 * (PLAN.md 1.4), so "nothing" means the reading cannot be trusted, and the caller keeps its estimate
 * and says so rather than recording a sale for zero.
 */
export async function proceedsSince(owner: Address, before: bigint | undefined): Promise<number | undefined> {
  if (before === undefined) return undefined;
  const after = await usdcRawOf(owner);
  if (after === undefined || after <= before) return undefined;
  return Number(formatUnits(after - before, 6));
}
