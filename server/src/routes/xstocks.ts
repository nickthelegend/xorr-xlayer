/**
 * GET /market/xstocks — the tokenized-equity catalog, browsable.
 *
 * The app could trade an xStock by name and could not show you what there was to trade. This
 * publishes `XSTOCKS` — the wrapped xStocks on X Layer — with the sector of each underlying listing
 * and its Uniswap v3 pool price (see `venues/xstocks-catalog.ts`).
 *
 * Public, for the same reason the rest of `/market/*` is: a catalog of what is listed and what it
 * costs is not user data, and gating it means a signed-out visitor sees a list of dashes.
 *
 * A row with no price is a row, not an omission. `feed: 'unavailable'` and `price: null` is the
 * honest answer when the pools cannot be quoted, and dropping those rows would hide exactly the
 * fact that matters — that the app cannot trade them right now.
 */
import { Hono } from 'hono';
import { log } from '../http/request-id.js';
import { requireUser } from '../auth/middleware.js';
import { xStockCatalog, xStockSectors, type XStockCatalogRow } from '../venues/xstocks-catalog.js';
import { xStockQuote, DEFAULT_SLIPPAGE_BPS } from '../venues/xstocks-quote.js';
import { UnpricedError } from '../venues/errors.js';

export const xstockRoutes = new Hono();

export type XStockCatalogResponse = {
  rows: XStockCatalogRow[];
  /** The sectors present, in the order the filter offers them. */
  sectors: string[];
  /** How many rows nothing would price. The screen says this out loud rather than making it countable. */
  unpriced: number;
};

xstockRoutes.get('/market/xstocks', async (c) => {
  const rows = await xStockCatalog();
  const unpriced = rows.filter((r) => r.feed !== 'live').length;

  /*
   * Worth a line in the log when nothing priced.
   *
   * All unavailable means the Uniswap quoter on X Layer could not be reached (or answered for no
   * pool) — which looks from the app like a quiet catalog. Silence here is how it gets missed.
   */
  if (unpriced === rows.length && rows.length > 0) {
    log.warn(`[xstocks] catalog priced none of ${rows.length} wrapped xStocks`);
  }

  const body: XStockCatalogResponse = { rows, sectors: xStockSectors(), unpriced };
  return c.json(body);
});

/**
 * GET /market/xstocks/quote — what this order costs, before it is placed.
 *
 * Behind a session, unlike the catalog beside it: a catalogue entry is a public fact about a listed
 * asset, and this is a quote for one person's order at one size. It also costs an upstream request
 * per call, which is not something to leave open.
 *
 * A pair nothing will price is a 502 naming the pair, not a breakdown of zeroes — zeroes on this
 * screen read as a free trade.
 */
xstockRoutes.get('/market/xstocks/quote', async (c) => {
  requireUser(c);

  const symbol = c.req.query('symbol') ?? '';
  const sideParam = c.req.query('side') ?? 'buy';
  const usd = Number(c.req.query('usd'));

  if (sideParam !== 'buy' && sideParam !== 'sell') {
    return c.json({ error: 'invalid_side', detail: 'side is buy or sell.' }, 400);
  }
  if (!(Number.isFinite(usd) && usd > 0)) {
    return c.json({ error: 'invalid_amount', detail: 'usd is the size of the order, above zero.' }, 400);
  }

  /*
   * The tolerance, in basis points, bounded where `/swap/quote` bounds its own.
   *
   * Out of range is refused rather than clamped: a ticket that asked for 0.1% and was quoted at 3%
   * would show a floor nobody agreed to, and the person reading it has no way to tell.
   */
  const asked = c.req.query('slippageBps');
  const slippageBps = asked === undefined ? DEFAULT_SLIPPAGE_BPS : Number(asked);
  if (!(Number.isInteger(slippageBps) && slippageBps >= 5 && slippageBps <= 300)) {
    return c.json(
      { error: 'invalid_slippage', detail: 'slippageBps is a whole number between 5 and 300.' },
      400,
    );
  }

  try {
    return c.json(await xStockQuote({ symbol, side: sideParam, usd, slippageBps }));
  } catch (e) {
    /*
     * No quote is a real answer and the ticket renders it as one. It is distinguished from a fault
     * so the screen can say "nobody would price this right now" instead of offering a retry for
     * something retrying will not fix.
     */
    if (e instanceof UnpricedError) {
      return c.json({ error: 'no_quote', detail: e.message }, 502);
    }
    throw e;
  }
});
