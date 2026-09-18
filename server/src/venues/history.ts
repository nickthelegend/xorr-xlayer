/**
 * The 1inch History API — a wallet's own history on Base, as 1inch indexed it (PLAN.md 3.14).
 *
 * The transaction history is the delegation contract's `Spent` and `Closed` events on every chain, because those are
 * the settlements this app made and the chain is their authority. On Base mainnet a wallet also has a life outside the
 * app — swaps it signed elsewhere, transfers in and out — and 1inch indexes that, so there the history reads this as
 * well, through the same key, request lane and breaker as the swap API (`oneinchApi`).
 *
 * Only on Base: 1inch indexes Base mainnet, and a fork's or a testnet's transactions are nowhere it could have seen them.
 *
 * The types are the fields the API sent back when this was written (2026-09-13), and `history.live.test.ts` keeps
 * asking. An answer without an `items` list is refused rather than read as a wallet with no history.
 */
import type { Address } from 'viem';
import { ONEINCH_CHAIN_ID } from '../evm/chains.js';
import { oneinchApi } from './oneinch.js';

/** One token movement inside an event. `amount` is in the token's base units, as a string. */
export type OneInchTokenAction = {
  chainId: string;
  /** The token contract. */
  address: string;
  /** `ERC20`, `ERC721`, `ERC1155` — an NFT moves with an `amount` of "1" and a `tokenId`. */
  standard: string;
  fromAddress: string;
  toAddress: string;
  amount: string;
  tokenId?: string;
  /** `In` or `Out`, relative to the wallet asked about. */
  direction: string;
};

export type OneInchHistoryEvent = {
  id: string;
  /** When 1inch recorded it. The block's own time is `details.blockTimeSec`. */
  timeMs: number;
  /** The wallet asked about, lowercased. */
  address: string;
  type: number;
  rating: string;
  direction: string;
  eventOrderInTransaction: number;
  details: {
    txHash: string;
    chainId: number;
    blockNumber: number;
    blockTimeSec: number;
    /** `completed` for a transaction that went through. */
    status: string;
    /** What happened, in 1inch's words: `Transfer`, `SwapExactInput`, `Approve`. */
    type: string;
    tokenActions: OneInchTokenAction[];
    /** Who sent the transaction, and the contract it called. */
    fromAddress: string;
    toAddress: string;
    nonce: number;
    /** The transaction's position in its block. */
    orderInBlock: number;
    feeInSmallestNative: string;
  };
};

type HistoryPage = { items?: unknown; cache_counter?: number };

/** The most events one read asks for — the history route shows no more than this. */
export const HISTORY_EVENTS_MAX = 200;

/**
 * The wallet's latest events on Base, newest first, as 1inch orders them.
 *
 * 1inch refuses some addresses outright — every busy contract tried, the aggregation router included, answered 422 —
 * and a refusal is thrown like any other failure: what an unreadable history means is the caller's to say.
 */
export async function oneinchHistory(address: Address, limit: number): Promise<OneInchHistoryEvent[]> {
  const n = Math.min(Math.max(Math.floor(limit), 1), HISTORY_EVENTS_MAX);
  const page = await oneinchApi<HistoryPage>(
    `/history/v2.0/history/${address}/events?chainId=${ONEINCH_CHAIN_ID}&limit=${n}`,
  );
  if (!Array.isArray(page?.items)) {
    throw new Error('The 1inch History API answered without an items list.');
  }
  return page.items as OneInchHistoryEvent[];
}
