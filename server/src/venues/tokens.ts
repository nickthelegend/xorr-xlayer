/**
 * The tokens xorr trades on X Layer, how each reaches USDC, and the rules every amount follows (2026-09-19).
 *
 * This lived inside the 1inch client (`venues/oneinch.ts`), which threw at import without a 1inch key — so the whole
 * executor could not start without an API key for a venue that does not run on X Layer. The registry is its own module
 * now, and the venue that uses it is `venues/uniswap.ts`.
 *
 * Every address and every route below was read on X Layer mainnet (196): the token contracts from their issuers
 * (Circle, Paxos, Tether, OKX, Backed/xStocks), the pools from Uniswap v3's factory with their live balances. A token is
 * routable only through a pool that holds real liquidity — WETH has none against any stablecoin here, so it is held and
 * shown but not traded.
 */
import type { Address } from 'viem';
import { QUOTE_ADDRESSES, IS_MAINNET_STATE, ADDRESSES } from '../evm/chains.js';
import { STOCKS } from './stocks.js';

/**
 * What every buy is paid in and every sell settles back into.
 *
 * Named rather than spelled `'USDC'` at each site because it is a role, not a ticker: the daily cap is denominated in it,
 * and a strategy whose target IS it has no swap to make.
 */
export const SETTLEMENT_SYMBOL = 'USDC';

/**
 * One hop of a route toward USDC: the next token and the Uniswap v3 fee tier of the pool between them (hundredths of a
 * basis point: 100 = 0.01%, 500 = 0.05%).
 */
export type Hop = { via: string; fee: number };

export type TokenInfo = {
  address: Address;
  decimals: number;
  /**
   * The pools from this token to USDC, in order. `[]` is USDC itself; `null` means there is no pool with real liquidity
   * on X Layer, so the token can be held and shown but not traded.
   */
  toUsdc: Hop[] | null;
};

/**
 * The registry. MAINNET addresses, always: prices are a mainnet question even on the testnet, and a fill only happens on
 * mainnet or its fork (`CAN_SETTLE`).
 */
export const TOKENS: Record<string, TokenInfo> = {
  USDC: { address: QUOTE_ADDRESSES.usdc, decimals: 6, toUsdc: [] },
  /** Paxos Global Dollar. USDC/USDG 0.01% pool 0xbB9a35F7…0d40 (~$490k each side on 2026-09-19). */
  USDG: { address: QUOTE_ADDRESSES.usdg, decimals: 6, toUsdc: [{ via: 'USDC', fee: 100 }] },
  /** Tether's USD₮0. USDT0/USDC 0.01% pool 0xEEeB3C1F…012D (~$650k). What OKX withdraws on X Layer; Aave's live market. */
  USDT0: { address: '0x779Ded0c9e1022225f8E0630b35a9b54bE713736', decimals: 6, toUsdc: [{ via: 'USDC', fee: 100 }] },
  /** OKX's wrapped BTC. XBTC/USDG 0.05% pool 0x520F8c07…5b76 (~$1.1M). */
  XBTC: {
    address: QUOTE_ADDRESSES.btc,
    decimals: 8,
    toUsdc: [
      { via: 'USDG', fee: 500 },
      { via: 'USDC', fee: 100 },
    ],
  },
  /** Wrapped OKB, the gas token. WOKB/USDT0 0.05% pool 0xe3BE6A01…5082 (~$1.5M). */
  WOKB: {
    address: QUOTE_ADDRESSES.wokb,
    decimals: 18,
    toUsdc: [
      { via: 'USDT0', fee: 500 },
      { via: 'USDC', fee: 100 },
    ],
  },
  /** Held and shown, not traded: no WETH pool on X Layer holds real liquidity against a stablecoin. */
  WETH: { address: QUOTE_ADDRESSES.weth, decimals: 18, toUsdc: null },
  ...Object.fromEntries(
    Object.values(STOCKS).map((s) => [s.symbol, { address: s.address, decimals: s.decimals, toUsdc: s.toUsdc }]),
  ),
};

/** Tokens a trade can be made in: the ones with a route. */
export function isRoutable(symbol: string): boolean {
  return (TOKENS[canonicalSymbol(symbol)]?.toUsdc ?? null) !== null;
}

/**
 * A symbol as the registry spells it, from however the caller spelled it.
 *
 * THE RULE, in one place, so nobody re-derives it:
 *   1. Crypto symbols are uppercase — `USDC`, `XBTC`, `WOKB`.
 *   2. Tokenized equities carry a lowercase `x` — `TSLAx`, `NVDAx`. The suffix distinguishes the token from the company.
 *   3. **No boundary may uppercase a caller's symbol.** Resolve through `canonicalSymbol` instead.
 *
 * Rule 3 exists because breaking it is invisible: uppercasing works for every crypto symbol, which is everything anyone
 * checks by hand, and three production bugs in one week came from it on the Base build.
 */
const CANONICAL = new Map(Object.keys(TOKENS).map((k) => [k.toUpperCase(), k]));

export function canonicalSymbol(raw: string): string {
  return CANONICAL.get(raw.trim().toUpperCase()) ?? raw.trim();
}

export type SwapQuote = {
  inSymbol: string;
  outSymbol: string;
  inAmount: number;
  outAmount: number;
  minimumOut: number;
  slippagePct: number;
  /** The venues the route goes through — the order ticket's Route row. */
  venues: string[];
  /** How far the executed rate sits below the mid, as a percentage — or null when it cannot be measured, which is not zero. */
  priceImpactPct: number | null;
  route: string;
  /** The venue's gas estimate for this route, when it gave one. Undefined is not zero. */
  estimatedGas?: number;
};

export type SwapCalldata = {
  to: Address;
  data: `0x${string}`;
  value: string;
  /**
   * The least this route may deliver, in raw OUT units. `XorrDelegation` holds the owner's balance to it across the call
   * (PLAN.md 1.4), so it is derived from the venue's own answer rather than estimated a second time.
   */
  minOut: bigint;
};

/** "Max slippage 0.30%". */
export const DEFAULT_SLIPPAGE_PCT = 0.3;

/**
 * How much slippage each kind of trade accepts, and why they differ. A scheduled buy can wait; a stop-loss cannot, since
 * the market moving is why it fired; a panic exit can wait least of all. These are ceilings, not targets.
 */
export const SLIPPAGE = {
  scheduled: DEFAULT_SLIPPAGE_PCT,
  stop: 1,
  panic: 2,
} as const;

const IMPACT_MARGIN = 1.5;
const MAX_SLIPPAGE_PCT = 3;

/**
 * The urgency ceiling, widened by what the quote itself says this trade will cost on this pool, capped — beyond the cap
 * the trade should fail and say why rather than pay for its own market impact. Rounded UP to two decimals (after settling
 * binary noise, so a clean 1.2 stays 1.2).
 */
export function slippageFor(base: number, priceImpactPct: number | null): number {
  if (priceImpactPct === null || !Number.isFinite(priceImpactPct) || priceImpactPct <= 0) return base;
  const widened = Math.min(Math.max(base, priceImpactPct * IMPACT_MARGIN), MAX_SLIPPAGE_PCT);
  return Math.ceil(Number((widened * 100).toFixed(6))) / 100;
}

/** Where a swap can actually land: X Layer mainnet or its fork, and only where the router is deployed. */
export const CAN_SETTLE = IS_MAINNET_STATE && ADDRESSES.uniswapRouter !== null;

/** "Direct", one venue by name, or "Best of N venues". */
export function routeLabel(venues: string[]): string {
  if (venues.length === 0) return 'Direct';
  if (venues.length === 1) return venues[0]!;
  return `Best of ${venues.length} venues`;
}
