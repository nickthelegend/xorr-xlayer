/**
 * Money in, as Deposit watches it land (FEATURES.md #21).
 *
 * Deposit reads the wallet's balances every few seconds. When a read shows a balance higher than the read before it, that
 * balance rolls to its new figure with one success tap: once for that arrival, and never for the first read, which is
 * what the wallet already held when the screen opened. Kept apart from the screen so the rule is tested where it is
 * written.
 */
import { quantity } from '../format';

/** The places Deposit draws each balance to. An arrival is a rise the screen can show, so the two are decided together. */
export const USDC_DIGITS = 2;
export const ETH_DIGITS = 4;

/** A balance as `/wallet/funds` sends it: its base units exactly, and the amount they make. */
type Balance = { raw: string; amount: number };

/** What of a `/wallet/funds` read an arrival is judged from. */
export type FundsRead = {
  owner: string;
  chain: string;
  usdc: Balance & { address: string };
  eth: Balance;
};

/** The reads so far, as arrivals. */
export type Arrivals = {
  /** The last read, to set the next one beside. */
  last: FundsRead | undefined;
  /** Reads that brought money to either balance: one success tap each. */
  count: number;
  /** Arrivals per balance. Each is a new figure rolling in. */
  usdc: number;
  eth: number;
};

export const NO_ARRIVALS: Arrivals = { last: undefined, count: 0, usdc: 0, eth: 0 };

/**
 * Whether a balance rose, in a way the screen can show.
 *
 * Decided in base units, exactly: the amounts are floats made from them, and two floats are no way to tell whether money
 * moved. And only when the figure on screen moves as well — dust too small for its places would roll a figure to itself,
 * and tap for something nobody can see.
 */
function rose(before: Balance, after: Balance, digits: number): boolean {
  if (!/^\d+$/.test(before.raw) || !/^\d+$/.test(after.raw)) return false;
  return BigInt(after.raw) > BigInt(before.raw) && quantity(after.amount, digits) !== quantity(before.amount, digits);
}

/** The arrivals, with the next read set beside the last. */
export function noteFunds(arrivals: Arrivals, next: FundsRead): Arrivals {
  const last = arrivals.last;
  // The first read is what the wallet held when the screen opened: nothing arrived.
  if (!last) return { ...arrivals, last: next };
  // Another wallet's balance, another network's or another token's is not money arriving in this one.
  const same =
    last.owner.toLowerCase() === next.owner.toLowerCase() &&
    last.chain === next.chain &&
    last.usdc.address.toLowerCase() === next.usdc.address.toLowerCase();
  const usdc = same && rose(last.usdc, next.usdc, USDC_DIGITS);
  const eth = same && rose(last.eth, next.eth, ETH_DIGITS);
  return {
    last: next,
    count: arrivals.count + (usdc || eth ? 1 : 0),
    usdc: arrivals.usdc + (usdc ? 1 : 0),
    eth: arrivals.eth + (eth ? 1 : 0),
  };
}
