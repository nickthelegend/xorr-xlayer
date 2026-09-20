/**
 * The xStocks catalog as something you can browse: every wrapped xStock on X Layer, its sector, and
 * what it is worth (2026-09-19).
 *
 *   `price`           — what one wrapped share trades at on X Layer, from the Uniswap v3 pools that
 *                       would fill it (`xStockPriceUsd` → `stocks.ts`). This is what a buy costs.
 *   `underlyingPrice` — what the listed share is marked at, from the issuer's own `stockData` mark for the same
 *                       token on Solana (Jupiter's price API) times this wrapper's `convertToAssets` multiplier —
 *                       `market/nasdaq.ts:referencePriceUsd`, the same number the agent's off-hours guard measures
 *                       drift against. This said the field had to stay null because "nothing equivalent exists here",
 *                       which was true of Backed's asset API (checked 2026-09-19: listing and trading hours, no mark)
 *                       and not of the feed this repo was already reading. Null only when that feed cannot be had:
 *                       no Solana mint for the token, Jupiter unreachable, or the multiplier unreadable.
 *
 * A token the pools will not price gets `feed: 'unavailable'` and `price: null` — a real row, and
 * never a number. A catalog that silently dropped what it could not price would hide that the app
 * cannot trade it; on the testnet, where these wrappers do not exist, prices are still a mainnet
 * question (see `uniswap.ts`), so an unavailable row there means the quoter could not be reached.
 */
import { XSTOCKS, xStockPriceUsd, type XStockSector } from './xstocks.js';
import { referencePricesUsd } from '../market/nasdaq.js';

export type XStockCatalogRow = {
  symbol: string;
  name: string;
  /** The share it tracks (TSLA). */
  ticker: string;
  /** The ERC-4626 wrapper on X Layer — what trades. */
  address: string;
  decimals: number;
  sector: XStockSector;
  /** What one wrapped token costs in USD on X Layer right now, or null when nothing would price it. */
  price: number | null;
  /** The exchange mark for the underlying share. Null: no source on X Layer publishes one (see the header). */
  underlyingPrice: number | null;
  /** Percent move over 24 hours. Null is "not reported", not "flat" — no 24h feed is read here. */
  change24hPct: number | null;
  /** Pool depth behind `price`, in USD. Null: not read here. */
  liquidityUsd: number | null;
  /** When the underlying mark was taken, ISO-8601. Null when there is no underlying mark. */
  underlyingAt: string | null;
  /**
   * Whether this row has a price at all.
   *
   * `unavailable` is a state the screen renders, not a row it hides — it IS the answer to "can I
   * trade this right now".
   */
  feed: 'live' | 'unavailable';
};

/** A finite, positive number, or null. A zero price is not a price. */
function positive(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : null;
}

/**
 * The catalog, priced.
 *
 * One pool quote per row, in parallel; each is cached for 30 s in `stocks.ts`, so a screen that
 * refreshes does not re-quote. A read that fails is that row's `null`, never the catalog's error.
 */
export async function xStockCatalog(): Promise<XStockCatalogRow[]> {
  const tokens = Object.values(XSTOCKS);
  const at = new Date().toISOString();
  const [prices, underlying] = await Promise.all([
    Promise.all(tokens.map((t) => xStockPriceUsd(t.symbol).catch(() => null))),
    // One request for all eleven marks, not eleven.
    referencePricesUsd(tokens.map((t) => t.symbol)).catch(() => new Map<string, number>()),
  ]);

  return tokens.map((t, i) => {
    const price = positive(prices[i]);
    const mark = positive(underlying.get(t.symbol) ?? null);
    return {
      symbol: t.symbol,
      name: t.name,
      ticker: t.ticker,
      address: t.address,
      decimals: t.decimals,
      sector: t.sector,
      price,
      underlyingPrice: mark,
      change24hPct: null,
      liquidityUsd: null,
      // The mark is read now; stamping it lets a screen say how fresh it is rather than implying it is live forever.
      underlyingAt: mark === null ? null : at,
      feed: price === null ? ('unavailable' as const) : ('live' as const),
    };
  });
}

/**
 * The sectors present in the catalog, in the order the filter should offer them.
 *
 * Derived from the tokens rather than listed again, so a token added with a new sector appears in
 * the filter without anyone remembering to add it twice. `Index funds` sorts last: it is the bucket
 * for the things that are not a sector, and it reads wrong anywhere but the end.
 */
export function xStockSectors(): XStockSector[] {
  const seen = new Set<XStockSector>();
  for (const t of Object.values(XSTOCKS)) seen.add(t.sector);
  return [...seen].sort((a, b) => {
    if (a === 'Index funds') return 1;
    if (b === 'Index funds') return -1;
    return a.localeCompare(b);
  });
}
