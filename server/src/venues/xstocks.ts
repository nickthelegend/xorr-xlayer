/**
 * xStocks on X Layer — the catalog view of the wrapped-xStock registry (2026-09-19).
 *
 * `venues/stocks.ts` is the registry the trade path reads (wrapper address, raw token, decimals, pool route). This module
 * adds what a browsable catalog needs on top — the sector — and keeps the names the market, bot and catalog modules have
 * always imported (`XSTOCKS`, `xStockKey`, `xStockPriceUsd`, `xStocksFunctional`), so they did not change shape when the
 * product moved from Solana mints to X Layer ERC-4626 wrappers.
 *
 * `address` is the WRAPPER — what trades in the Uniswap pools, what a wallet holds, what a grant approves. `raw` is the
 * rebasing xStock behind it, whose `multiplier()` equals the wrapper's `convertToAssets(1e18)`: the corporate-action
 * signal (`venues/corporate-actions.ts`).
 */
import type { Address } from 'viem';
import { STOCKS, equitiesFunctional, resetEquitiesFunctional, stockKey, stockPriceUsd, clearStockPriceCache } from './stocks.js';

export { recordObservation } from './stocks.js';

/**
 * What the underlying listing is, in GICS sector names. `Index funds` is not a GICS sector and is not pretending to be:
 * SPYx and QQQx track baskets spanning every sector, so filing them under one would be false.
 */
export type XStockSector =
  | 'Technology'
  | 'Communication Services'
  | 'Consumer Discretionary'
  | 'Financials'
  | 'Index funds';

export type XStockToken = {
  /** The symbol the app shows (e.g. TSLAx). */
  symbol: string;
  /** The listed company or fund. */
  name: string;
  /** The share it tracks (TSLA). */
  ticker: string;
  /** The ERC-4626 wrapper on X Layer — what trades. */
  address: Address;
  /** The raw rebasing xStock behind the wrapper. */
  raw: Address;
  decimals: number;
  sector: XStockSector;
};

/** Reference data about each listing, like its name — not a market observation. */
const SECTORS: Record<string, XStockSector> = {
  NVDAx: 'Technology',
  AAPLx: 'Technology',
  MSFTx: 'Technology',
  MSTRx: 'Technology',
  TSLAx: 'Consumer Discretionary',
  AMZNx: 'Consumer Discretionary',
  GOOGLx: 'Communication Services',
  METAx: 'Communication Services',
  COINx: 'Financials',
  SPYx: 'Index funds',
  QQQx: 'Index funds',
};

export const XSTOCKS: Record<string, XStockToken> = Object.fromEntries(
  Object.values(STOCKS).map((s) => [
    s.symbol,
    {
      symbol: s.symbol,
      name: s.name,
      ticker: s.ticker,
      address: s.address,
      raw: s.raw,
      decimals: s.decimals,
      sector: SECTORS[s.symbol] ?? 'Technology',
    },
  ]),
);

/** Case-insensitive lookup — `TSLAX` finds `TSLAx`. */
export function xStockKey(symbol: string): string | undefined {
  return stockKey(symbol);
}

export function isXStock(symbol: string): boolean {
  return xStockKey(symbol) !== undefined;
}

/** A wrapped xStock's price in USD, from the Uniswap pools that would fill it (`stocks.ts`). Null when unpriced. */
export function xStockPriceUsd(symbol: string): Promise<number | null> {
  return stockPriceUsd(symbol);
}

export function clearXStockPriceCache(): void {
  clearStockPriceCache();
}

/** Whether the wrappers have code and a supply on the chain this executor is on (mainnet or its fork: yes; testnet: no). */
export function xStocksFunctional(): Promise<boolean> {
  return equitiesFunctional();
}

export function resetXStocksFunctional(): void {
  resetEquitiesFunctional();
}
