/**
 * Transaction history — what settled on chain for this wallet (PLAN.md 3.14).
 *
 * Mirrors `GET /history` field for field. `amount` stays the exact integer the chain carries, as a string: parsing a
 * uint256 into a number here would round it, and anything comparing it would compare the rounded copy. `unitsOf`
 * places the decimal point for display from the token's own decimals — and is null where the executor's registry does
 * not know the token, because an integer with a guessed decimal point is not an approximation, it is another number.
 */
import { api } from './api';

export type HistoryToken = { symbol: string; decimals: number; address: string };

/** What the executor recorded for the same transaction, when one of its runs sent it. */
export type HistoryRun = {
  /** The strategy's kind — `dca`, `exit-rules`, `swap`. */
  kind: string;
  /** Where the executor settled it: `1inch`, `aqua`, `swapvm`, `aave`. */
  venue: string | null;
  side: string | null;
  units: number | null;
  /** Dollars as the executor measured them. */
  usd: number | null;
  symbol: string;
};

export type HistoryItem = {
  /** `spent` and `closed` are the delegation contract's own events; `1inch` is 1inch's history of the wallet, on Base. */
  kind: 'spent' | 'closed' | '1inch';
  txHash: string;
  block: number;
  /** The block's time, or null when the executor could not read that block. */
  at: string | null;
  /** The executor's name for a venue it settles on, otherwise the contract's address. */
  venue: string | null;
  /** Null for a token the executor's registry does not list. */
  token: HistoryToken | null;
  /** Base units, exactly. Null only for a 1inch event that moved no token. */
  amount: string | null;
  /** Dollars only where the amount is the settlement token itself. */
  usd: number | null;
  run?: HistoryRun;
  /** What 1inch calls the event, and which way its token moved for this wallet. */
  oneinch?: { type: string; direction: 'in' | 'out' | null };
  /** A block-explorer URL, or a `fork:` or `local:` label where no explorer has seen the transaction. */
  explorer: string;
};

export type HistoryResponse = {
  owner: string;
  chain: string;
  source: 'chain' | 'chain+1inch';
  /** The blocks the chain read covered. The read is bounded, so an empty list means empty in here. */
  window: { fromBlock: number; toBlock: number; since: string | null };
  /** A part of the history that could not be read, and why. The rest is still true. */
  unavailable: { source: '1inch'; reason: string } | null;
  /** Newest first. */
  items: HistoryItem[];
};

export function history(limit = 50): Promise<HistoryResponse> {
  return api.get<HistoryResponse>(`/history?limit=${limit}`);
}

/**
 * The amount in the token's own units, for display, or null where there is no listed token to place the point from.
 * The point is placed in the string, so no float touches the integer before it is.
 */
export function unitsOf(item: Pick<HistoryItem, 'amount' | 'token'>): number | null {
  if (!item.token || item.amount === null || !/^\d+$/.test(item.amount)) return null;
  const { decimals } = item.token;
  const digits = item.amount.padStart(decimals + 1, '0');
  const point = digits.length - decimals;
  return Number(`${digits.slice(0, point)}.${digits.slice(point) || '0'}`);
}
