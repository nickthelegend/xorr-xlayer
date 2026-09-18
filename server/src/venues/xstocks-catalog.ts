/**
 * The xStocks catalog as something you can browse: every token, its sector, and what it is worth.
 *
 * Two different numbers live on each row and the difference between them is the point.
 *
 *   `price`          — what one token trades at on Solana, from the pools. This is what a buy costs.
 *   `underlyingPrice`— what the issuer's own feed marks the listed share at. This is what the stock
 *                      is worth on its exchange.
 *
 * They are close and they are not equal: a tokenized share trades at whatever the AMM's inventory
 * says, and that drifts from the exchange mark by the depth of the pool. Showing only one of them
 * would be hiding the spread somebody actually pays, so the row carries both and the screen can say
 * which is which.
 *
 * Both come from Jupiter's price endpoint, which returns the pool price, the issuer's `stockData`
 * mark, 24h change and pool depth for a batch of mints in one request. A mint the endpoint does not
 * answer for gets `feed: 'unavailable'` and `price: null` — a real row, and never a number. The
 * equities screen (`routes/market.ts`) has taken that shape since it shipped, for the same reason:
 * a catalog that silently dropped what it could not price would hide that the app cannot trade it.
 */
import { getJson, staleValue } from '../http/get.js';
import { XSTOCKS, type XStockSector } from './xstocks.js';

/** Jupiter's price endpoint. Public, and the one place that carries the issuer's own mark. */
const PRICE_URL = 'https://lite-api.jup.ag/price/v3';

/**
 * One mint as the price endpoint reports it.
 *
 * Only the fields this catalog reads are named. `stockData` is optional on purpose — it is the
 * issuer's feed for the underlying listing, and a mint can be priced by the pools without it.
 */
type PriceEntry = {
  usdPrice?: number;
  priceChange24h?: number;
  liquidity?: number;
  stockData?: { price?: number; updatedAt?: string };
};

export type XStockCatalogRow = {
  symbol: string;
  name: string;
  address: string;
  decimals: number;
  sector: XStockSector;
  /** What one token costs in USD on Solana right now, or null when nothing would price it. */
  price: number | null;
  /** What the issuer's feed marks the underlying share at, or null when this mint carries no such feed. */
  underlyingPrice: number | null;
  /** Percent move over 24 hours, as the feed reports it. Null is "not reported", not "flat". */
  change24hPct: number | null;
  /** Pool depth behind `price`, in USD. How much the number on this row is worth trusting. */
  liquidityUsd: number | null;
  /** When the underlying mark was taken, ISO-8601. Null when there is no underlying mark. */
  underlyingAt: string | null;
  /**
   * Whether this row has a price at all.
   *
   * `unavailable` is a state the screen renders, not a row it hides — on a cluster where these
   * mints do not exist every row is unavailable, and that IS the answer to "can I trade these here".
   */
  feed: 'live' | 'unavailable';
};

/** Live for half a minute; a stale answer beats a screen of dashes for ten. */
const TTL_MS = 30_000;
const STALE_TOLERANCE_MS = 10 * 60_000;

/** A finite, positive number, or null. Guards every field read off the wire. */
function num(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

function positive(v: unknown): number | null {
  const n = num(v);
  return n !== null && n > 0 ? n : null;
}

/**
 * The catalog, priced.
 *
 * One request for every mint rather than one per row: eleven probes behind a shared rate limit is
 * how a browsable list becomes a spinner. `getJson` owns the lane, the breaker and the cache.
 */
export async function xStockCatalog(): Promise<XStockCatalogRow[]> {
  const tokens = Object.values(XSTOCKS);
  const url = `${PRICE_URL}?ids=${tokens.map((t) => t.address).join(',')}`;

  let prices: Record<string, PriceEntry> = {};
  try {
    prices = await getJson<Record<string, PriceEntry>>(url, TTL_MS);
  } catch {
    /*
     * The last good answer, if it is recent enough to still mean something.
     *
     * Ten minutes is the tolerance `/market/stocks` already uses for a spot price. Past that the
     * rows go to `unavailable` rather than showing a number whose age nobody can see.
     */
    prices = staleValue<Record<string, PriceEntry>>(url, STALE_TOLERANCE_MS) ?? {};
  }

  return tokens.map((t) => {
    const entry = prices[t.address];
    const price = positive(entry?.usdPrice);
    return {
      symbol: t.symbol,
      name: t.name,
      address: t.address,
      decimals: t.decimals,
      sector: t.sector,
      price,
      underlyingPrice: positive(entry?.stockData?.price),
      // Zero is a real reading here — a stock that did not move — so this one is not `positive`.
      change24hPct: num(entry?.priceChange24h),
      liquidityUsd: positive(entry?.liquidity),
      underlyingAt: entry?.stockData?.updatedAt ?? null,
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
