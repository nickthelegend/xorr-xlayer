/**
 * The symbols this build can actually place an order for.
 *
 * Mirrors the routable part of `TOKENS` in server/src/venues/tokens.ts (with the wrapped xStocks from
 * server/src/venues/stocks.ts), and `tradable.live.test.ts` fails if the two ever drift. It exists
 * because the market list and the tradable set are genuinely different things: the app shows crypto
 * instruments plus stocks, commodities and indices, and on X Layer only a handful of those have a
 * Uniswap v3 pool with real liquidity. Offering a Buy on the rest would put a strategy in the
 * database that no signed transaction could ever fill.
 *
 * WETH is in the registry and deliberately not here: no WETH pool on X Layer holds real liquidity
 * against a stablecoin, so it is held and shown, never traded.
 */
export const TRADABLE = [
  // Crypto with a route to USDC on X Layer.
  'USDC',
  'USDG',
  'USDT0',
  'XBTC',
  'WOKB',
  // Wrapped xStocks — ERC-4626 wrappers, ordinary ERC-20s to the swap path. See server/src/venues/stocks.ts.
  'NVDAx',
  'TSLAx',
  'AAPLx',
  'MSFTx',
  'AMZNx',
  'GOOGLx',
  'METAx',
  'MSTRx',
  'COINx',
  'SPYx',
  'QQQx',
] as const;

export type TradableSymbol = (typeof TRADABLE)[number];

/**
 * What a market symbol settles into on X Layer.
 *
 * Buying "BTC" here means buying XBTC, OKX's wrapped bitcoin, and buying "OKB" means buying WOKB —
 * the market is real, and the instrument that represents it on this chain has a different ticker.
 * Telling someone "BTC is not tradable" when the app can and does buy XBTC for them would be true in
 * the most useless way. ETH has no entry: WETH is held on X Layer but nothing routes it.
 */
export const SETTLES_AS: Record<string, string> = {
  BTC: 'XBTC',
  OKB: 'WOKB',
};

/** The token a market symbol actually trades as, or the symbol itself. */
export function settlementSymbol(symbol: string): string {
  const upper = symbol.toUpperCase();
  return SETTLES_AS[upper] ?? symbol;
}

/** Case-insensitive: a route param may arrive as `xbtc`, and the equities carry a lowercase `x` (`NVDAx`). */
export function isTradable(symbol: string): boolean {
  const upper = symbol.toUpperCase();
  const settled = (SETTLES_AS[upper] ?? upper).toUpperCase();
  return (TRADABLE as readonly string[]).some((t) => t.toUpperCase() === settled);
}

/** What the default buy is when a screen has to pick one. */
export const DEFAULT_BUY: string = 'XBTC';

/**
 * What the SERVER says can be settled, which is not always what this list says.
 *
 * `TRADABLE` above is a compile-time mirror of the token registry — it answers "is this a symbol we
 * know how to route". That is a different question from "can this deployment settle it", and the
 * two come apart on the tokenized equities: their wrappers are real on X Layer mainnet and have no
 * code on the testnet, and a static list would offer a Buy button for all eleven regardless. Live
 * price, unit conversion, an enabled "Buy $250 of NVDAx", and a fill that reverts.
 *
 * So the order path asks the executor rather than a constant. `/market/tradable` now filters by
 * whether the token actually answers on the running chain.
 *
 * The pre-answer default is the static list — the same behaviour as before — because the alternative
 * is refusing trades that are perfectly fine for the second before the fetch lands. On a deployment
 * where equities do not work that leaves a brief window; the order ticket closes it by awaiting the
 * real answer rather than rendering from the default.
 */
let settleable: Set<string> | undefined;
let settleableInFlight: Promise<Set<string>> | undefined;

export async function settleableSymbols(): Promise<Set<string>> {
  if (settleable) return settleable;
  settleableInFlight ??= (async () => {
    try {
      const { api } = await import('./api');
      const rows = await api.get<{ symbol: string }[]>('/market/tradable');
      settleable = new Set(rows.map((r) => r.symbol.toUpperCase()));
      return settleable;
    } catch {
      settleableInFlight = undefined;
      // Unknown, not empty. An empty set here would refuse every trade on one failed request.
      return new Set((TRADABLE as readonly string[]).map((t) => t.toUpperCase()));
    }
  })();
  return settleableInFlight;
}

/** Testing only. */
export function resetSettleable(): void {
  settleable = undefined;
  settleableInFlight = undefined;
}

/** Can this deployment actually settle it — asked of the executor, not of a constant. */
export async function isSettleable(symbol: string): Promise<boolean> {
  const upper = symbol.toUpperCase();
  const settled = (SETTLES_AS[upper] ?? upper).toUpperCase();
  return (await settleableSymbols()).has(settled);
}

/**
 * The symbols something can put a PRICE on, which is a third question again.
 *
 * `TRADABLE` answers "do we know how to route this" and `settleableSymbols` answers "can this
 * deployment fill it". Neither answers "can anything price it", and that is the question a price
 * alert asks: ETH is priceable and not tradable on X Layer, so an alert on it is perfectly reasonable
 * and `isTradable` would refuse it.
 *
 * Mirrors the executor's `priceOf`: a tokenized equity is priced by the venue that would fill it,
 * and everything else needs an entry in the crypto feed table. `/market/symbols` publishes that
 * table and `/market/stocks` publishes the equities, so the client asks rather than keeping a
 * fourth copy of a list — the mistake `propose.ts` made with its own private feed map.
 *
 * Undefined on failure, never empty: an empty set would refuse every alert on one failed request,
 * and the server checks this again anyway. Unknown means "let it through and let the server
 * answer", which is the same posture `settleableSymbols` takes.
 */
let priceable: Set<string> | undefined;
let priceableInFlight: Promise<Set<string> | undefined> | undefined;

export async function priceableSymbols(): Promise<Set<string> | undefined> {
  if (priceable) return priceable;
  priceableInFlight ??= (async () => {
    try {
      const { api } = await import('./api');
      /*
       * Three reads, because the executor publishes three (`server/src/market/feeds.ts`): the crypto
       * feed table, the equities, and the xStock catalog priced by the Uniswap v3 pools that would
       * fill them. On X Layer the last two list the same wrapped xStocks; both are read so an alert
       * is never refused because one of them was quiet. The catalog was once missing, and the field
       * refused an alert on NVDAx — "nothing prices it" — while the executor was pricing it all day.
       */
      const [crypto, stocks, xstocks] = await Promise.all([
        api.get<string[]>('/market/symbols'),
        api.get<{ symbol: string }[]>('/market/stocks'),
        api.get<{ rows: { symbol: string }[] }>('/market/xstocks'),
      ]);
      /*
       * Every catalogued xStock, including the ones with no price at this moment.
       *
       * "Nothing can ever price this" and "nothing will route it right now" are different facts and
       * only the first is a reason to refuse an alert. An xStock whose pool is quiet has a feed; the
       * alert sits armed and fires when the route comes back, which is what someone setting one
       * during a quiet hour actually wants.
       */
      priceable = new Set([
        ...crypto,
        ...stocks.map((s) => s.symbol),
        ...xstocks.rows.map((r) => r.symbol),
      ]);
      return priceable;
    } catch {
      priceableInFlight = undefined;
      return undefined;
    }
  })();
  return priceableInFlight;
}

/**
 * The set's own spelling of a symbol the user typed, or `undefined` if nothing prices it.
 *
 * Case-insensitive, and it returns the CANONICAL spelling rather than an uppercased one — the
 * tokenized equities carry a lowercase suffix (`NVDAx`), and uppercasing them is the boundary
 * mistake `venues/tokens.ts` documents three production bugs from. A user typing `nvdax` gets
 * `NVDAx` back, not `NVDAX`.
 */
export function resolvePriceable(symbol: string, known: Set<string> | undefined): string | undefined {
  const typed = symbol.trim();
  if (!typed) return undefined;
  if (!known) return typed;                        // cannot say; let the server answer
  for (const s of known) if (s.toLowerCase() === typed.toLowerCase()) return s;
  return undefined;
}

/** Testing only. */
export function resetPriceable(): void {
  priceable = undefined;
  priceableInFlight = undefined;
}
