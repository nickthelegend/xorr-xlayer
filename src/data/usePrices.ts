/**
 * Live prices for any screen that quotes one.
 *
 * The handoff hardcoded a reference price per screen ($88.32 SOL, $3,412.10 gold). Those were
 * fine as design values and are wrong as product: the order ticket was telling a user they would
 * receive 2.8306 SOL for $250 while SOL actually traded at $104.25.
 *
 * Every screen that shows a quantity, a conversion or a notional reads from here instead.
 * A symbol with no live feed comes back `undefined` and the screen labels it, per PLAN §1.3.8.
 */
import { useMemo } from 'react';
import { repos } from './index';
import { useAsync } from './useAsync';

export type LivePrice = { price: number; change24h?: number; warming?: boolean } | undefined;

export function usePrices(symbols: string[]) {
  const key = symbols.join(',');
  const { data, loading, error, reload } = useAsync(
    () => repos.markets.quotes(key ? key.split(',') : []),
    [key],
  );
  return { quotes: data ?? {}, loading, error, reload };
}

export function usePrice(symbol: string | undefined) {
  const symbols = useMemo(() => (symbol ? [symbol] : []), [symbol]);
  const { quotes, loading, error, reload } = usePrices(symbols);
  return { quote: symbol ? quotes[symbol] : undefined, loading, error, reload };
}

/**
 * Format a unit conversion against a live price, or say plainly that there is no price.
 *
 * `failed` is a read that did not answer. That is unknown, not absent, so it is a dash: "No live XBTC price" about a
 * feed nobody heard from is the claim the quotes read stopped making when it began to throw.
 */
export function unitsFor(amountUsd: number, quote: LivePrice, symbol: string, failed = false): string {
  if (quote?.warming) return `Fetching the ${symbol} price…`;
  if (!quote && failed) return '—';
  if (!quote || quote.price <= 0) return `No live ${symbol} price`;
  return `${(amountUsd / quote.price).toFixed(4)} ${symbol}`;
}
