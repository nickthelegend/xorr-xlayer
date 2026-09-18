/**
 * Public market data.
 *
 * The app used to call CoinGecko straight from the browser. CoinGecko sends no
 * `access-control-allow-origin`, so on web every quote and every candle died in a CORS preflight
 * and the whole market surface fell back to simulated numbers — the exact failure PLAN.md §1.3
 * item 8 is meant to prevent.
 *
 * Routing it through the executor fixes that and buys three things the client cannot have:
 * one shared rate-limit queue instead of one per open tab, the stale-value fallback in
 * `http/get.ts`, and a single definition of which symbols have a real feed.
 *
 * These two routes are deliberately public: a spot price is not user data, and gating it behind a
 * session would mean an unauthenticated visitor sees a market list of dashes.
 */
import { Hono } from 'hono';
import { getJson, staleValue } from '../http/get.js';
import { readChain } from '../http/chain-read.js';
import { log } from '../http/request-id.js';
import { COINGECKO_IDS, COINGECKO_PRICE_URL, type CoingeckoPrices } from '../market/ids.js';
import { CAN_SETTLE, TOKENS, canonicalSymbol, quote } from '../venues/oneinch.js';
import { STOCKS, equitiesFunctional, isStock, observedHistory } from '../venues/stocks.js';
import { classificationFor, earningsCalendar } from '../market/edgar.js';
import { aavePoolIsDeployedHere, usdcSupplyYield, usdcReserve } from '../market/yield.js';
import { logosFor, warmLogos } from '../market/logos.js';
import { withdrawCalldata } from '../venues/aave.js';
import { suppliedUsd } from '../evm/balances.js';
import { publicClient } from '../evm/client.js';
import { ADDRESSES } from '../evm/chains.js';
import { currentWallet } from './wallet-context.js';
import { isAddress, type Address } from 'viem';
import { addressOfBasename, basenameOf } from '../evm/basename.js';
import type { Context } from 'hono';
import { findPerp, perpMetrics, PriceTooSlow } from '../market/perp.js';
import { PERP_RANGES, perpCandles, perpMarkets, type PerpRange } from '../market/hyperliquid.js';
import { crossCheck } from '../market/crosscheck.js';
import { corporateAction } from '../market/corporate-action.js';

export const market = new Hono();

/** Aave's "all of it" sentinel. A rebasing balance cannot be emptied with a number. */
const MAX_UINT256 = (1n << 256n) - 1n;

/**
 * The caller's wallet, or undefined.
 *
 * This module is mostly public routes and has no wallet helper of its own; the two below are the
 * exceptions because a supplied balance belongs to somebody.
 */
/*
 * Delegates to `currentWallet` rather than asking again.
 *
 * This was its own `WHERE user_id = $1 LIMIT 1` with no ORDER BY — one of nine such copies, each
 * free to return a different wallet than the others on an account with more than one row. The
 * damage is not that a query is duplicated: it is that your agents, your alerts, your limits and
 * your trades could each be resolved against a DIFFERENT wallet within one signed-in session.
 * One definition, in `wallet-context`, is the whole point of that module.
 */
async function currentWalletFor(c: Context): Promise<{ address: string } | undefined> {
  return currentWallet(c);
}

const COINGECKO = 'https://api.coingecko.com/api/v3';
const STALE_TOLERANCE_MS = 10 * 60_000;

/**
 * History keeps far longer than a price does.
 *
 * `STALE_TOLERANCE_MS` is the right answer for a spot quote — ten minutes is already generous for
 * a number someone might trade on. It is the wrong answer for a day of candles, and applying it to
 * both is what made the re-warm unwinnable: roughly 27 upstream URLs, spaced 1.1s apart and backing
 * off on every 429, cannot all be refreshed inside ten minutes on a rate-limited tier. Measured on
 * the deployed executor, `/market/sparklines` oscillated between five and nine of nine symbols
 * while the sweep chased a cliff it could not outrun.
 *
 * A 1-day OHLC series twenty minutes old is the same picture; the last candle moves and nothing
 * else does. Serving it beats serving a gap, and the sweep gets room to work instead of racing.
 * The spot price is unaffected and still has its own ten minutes.
 */
const HISTORY_STALE_TOLERANCE_MS = 60 * 60_000;

/**
 * Stale-while-revalidate.
 *
 * The public price tier rate-limits, and `http/get.ts` answers that with spaced retries and
 * exponential backoff — correct for a scheduled buy, far too slow for a chart. A cold `days=1`
 * request measured 26s, which is longer than any client is willing to wait, so the app timed out
 * on data the server was about to have.
 *
 * So: if there is a value inside the staleness window, return it now and refresh in the
 * background. Only a request with nothing cached at all waits, and even that falls back to the
 * last good body before failing. A price a minute old beats a spinner; a price nobody has ever
 * fetched is the only case worth blocking on.
 */
const FRESH_MS = 30_000;

/**
 * One upstream fetch per cold URL, however many clients are waiting on it.
 *
 * The background-refresh path deduped through `refreshing`; the COLD path did not. So every
 * request for a URL nobody had fetched yet started its own `getJson`, with its own retry ladder,
 * against an upstream that rate-limits by IP. The app polls, which meant a cold symbol produced a
 * steady stream of concurrent fetches, each one making the rate limit worse and none of them ever
 * populating the cache.
 *
 * The result was not a slow chart, it was a permanently broken one. In the deployed logs:
 * `GET /market/ohlc 503 8002ms` over and over for ETH and BTC — the two symbols the market list
 * and the default chart both request, so the two with the most concurrent cold readers — while
 * SOL and XAUT, warmed once before the stampede started, served in 1ms from cache. CoinGecko
 * answered the identical URL in 200 from anywhere else. One request measured 31.5 seconds.
 *
 * Sharing the promise fixes the cause: the first caller starts the fetch, everyone else awaits
 * the same one, and the cache gets its single write. The deadline below is per-CALLER, not per
 * fetch — a client still gives up after `COLD_DEADLINE_MS`, and the shared fetch it was waiting
 * on keeps running so the next request is served warm.
 */
const inflight = new Map<string, Promise<unknown>>();

function sharedFetch<T>(url: string, timeoutMs: number): Promise<T> {
  const existing = inflight.get(url) as Promise<T> | undefined;
  if (existing) return existing;
  const p = getJson<T>(url, 0, timeoutMs).finally(() => inflight.delete(url));
  inflight.set(url, p);
  // Nobody is guaranteed to await this copy — a caller can time out first — and an unhandled
  // rejection would take the process down.
  void p.catch(() => undefined);
  return p;
}

async function getWithStale<T>(
  url: string,
  timeoutMs = 12_000,
  staleToleranceMs = STALE_TOLERANCE_MS,
): Promise<T> {
  const cached = staleValue<T>(url, staleToleranceMs);
  const fresh = staleValue<T>(url, FRESH_MS);
  if (fresh) return fresh;

  if (cached) {
    // Same map, so a background refresh and a cold caller never race for the same upstream slot.
    void sharedFetch<T>(url, timeoutMs);
    return cached;
  }

  // Nothing cached at all: start the fetch, but do not let a UI request sit through the whole
  // retry ladder. Under a rate limit that ladder has measured over a minute, and no screen should
  // block for that. Give up at the deadline and let the fetch finish in the background, so the
  // next request — a retry, a refresh, another viewer — is instant.
  const fetching = sharedFetch<T>(url, timeoutMs);

  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new ColdFetchPending(url)), COLD_DEADLINE_MS);
  });
  try {
    return await Promise.race([fetching, deadline]);
  } catch (e) {
    const last = staleValue<T>(url, staleToleranceMs);
    if (last) return last;
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

/** Not an error in the upstream — just "not yet". The route turns it into a 503 with a Retry-After. */
class ColdFetchPending extends Error {
  constructor(url: string) {
    super(`Still fetching ${url}`);
    this.name = 'ColdFetchPending';
  }
}

/** How long a first-ever request will wait before telling the client to come back. */
const COLD_DEADLINE_MS = 8_000;

/**
 * Every symbol we have a feed for, in ONE upstream call — and it is the SAME call the
 * executor's `priceOf` makes. `ids.ts` owns the string; see the note there for what having two
 * of them cost. The cache in `http/get.ts` is keyed by URL, so sharing it means a chart refresh
 * warms the price a scheduled buy is about to fill at.
 */
const ALL_IDS_URL = COINGECKO_PRICE_URL;

/** GET /market/quotes?symbols=BTC,ETH — spot + 24h change. Unknown symbols are omitted. */
market.get('/market/quotes', async (c) => {
  try {
  const symbols = (c.req.query('symbols') ?? '')
    .split(',')
    .map((s) => s.trim().toUpperCase())
    .filter((s) => COINGECKO_IDS[s]);
  if (symbols.length === 0) return c.json({});

  const data = await getWithStale<CoingeckoPrices>(ALL_IDS_URL);

  const out: Record<string, { price: number; change24h: number; source: string }> = {};
  for (const sym of symbols) {
    const row = data[COINGECKO_IDS[sym]!];
    if (row && typeof row.usd === 'number') {
      out[sym] = { price: row.usd, change24h: row.usd_24h_change ?? 0, source: 'coingecko' };
    }
  }
    return c.json(out);
  } catch (e) {
    // Not yet fetched is "come back", not "broken". A 500 would make the app show an error for
    // data that is thirty seconds away.
    if (e instanceof ColdFetchPending) {
      c.header('retry-after', '3');
      return c.json({ error: 'warming', detail: 'Prices are being fetched; retry shortly.' }, 503);
    }
    throw e;
  }
});

/** GET /market/ohlc?symbol=BTC&days=30 — raw OHLC rows; the client folds them to 12 candles. */
market.get('/market/ohlc', async (c) => {
  // Uppercased: `COINGECKO_IDS` is all-caps crypto with no equities in it, the one lookup rule 3 allows.
  const symbol = (c.req.query('symbol') ?? '').trim().toUpperCase();
  /*
   * Refusals a client can act on, by name.
   *
   * These put a sentence where a client reads a code — `{error: "bad days"}` — and a request with no symbol at all got
   * a 404 reading "no feed for ", with a hole where the symbol should be. Missing is the caller's to fix (400); a
   * symbol nothing prices is a 404 that says which.
   */
  if (!symbol) return c.json({ error: 'missing_symbol', detail: 'Pass ?symbol=, for example ?symbol=BTC.' }, 400);
  const id = COINGECKO_IDS[symbol];
  if (!id) return c.json({ error: 'no_feed', detail: `No price feed for ${symbol}.` }, 404);

  const days = Number(c.req.query('days') ?? 30);
  if (!Number.isFinite(days) || days <= 0) {
    return c.json({ error: 'invalid_days', detail: 'days is a number of days above zero.' }, 400);
  }

  try {
    const rows = await getWithStale<[number, number, number, number, number][]>(
      `${COINGECKO}/coins/${id}/ohlc?vs_currency=usd&days=${days}`,
      12_000,
      HISTORY_STALE_TOLERANCE_MS,
    );
    return c.json({ symbol, days, rows });
  } catch (e) {
    if (e instanceof ColdFetchPending) {
      c.header('retry-after', '3');
      return c.json({ error: 'warming', detail: 'History is being fetched; retry shortly.' }, 503);
    }
    throw e;
  }
});

/**
 * GET /market/sparklines?symbols=BTC,ETH — one day of closes for many symbols, in one request.
 *
 * The market rows want a 90×30 glyph each, and the per-symbol `/market/ohlc` would make that nine
 * round trips for one screen. Every one of them is a cache hit the server already holds, so the
 * cost is entirely in the requests rather than the data.
 *
 * A symbol whose history has not warmed yet is OMITTED, not sent as an empty array or a flat line.
 * `Sparkline` draws nothing below two points, so a row simply has no glyph until the data exists —
 * which is the honest rendering. A flat line would say the price did not move.
 */
market.get('/market/sparklines', async (c) => {
  const symbols = (c.req.query('symbols') ?? '')
    .split(',')
    .map((s) => s.trim().toUpperCase())
    .filter((s) => COINGECKO_IDS[s])
    .slice(0, 24);
  if (symbols.length === 0) return c.json({});

  const out: Record<string, number[]> = {};
  await Promise.all(
    symbols.map(async (sym) => {
      try {
        const rows = await getWithStale<[number, number, number, number, number][]>(
          `${COINGECKO}/coins/${COINGECKO_IDS[sym]}/ohlc?vs_currency=usd&days=1`,
          12_000,
          HISTORY_STALE_TOLERANCE_MS,
        );
        // Closes only, thinned to what a 90px glyph can actually show.
        const closes = rows.map((r) => r[4]).filter((n) => Number.isFinite(n));
        if (closes.length > 1) out[sym] = thin(closes, 24);
      } catch {
        // Warming or unavailable: leave the symbol out. See above.
      }
    }),
  );
  return c.json(out);
});

/** Evenly sample a series down to at most `count` points, always keeping the last one. */
function thin(series: number[], count: number): number[] {
  if (series.length <= count) return series;
  const step = (series.length - 1) / (count - 1);
  return Array.from({ length: count }, (_, i) => series[Math.round(i * step)]!);
}

/**
 * The tokenized equity a request names, or the refusal it has earned.
 *
 * Both routes below answered a missing `?symbol` and a symbol that is not an equity with one 404, and put the sentence
 * in `error` — so a request with no symbol read " is not a tokenized equity". Missing is the caller's to fix (400); a
 * symbol that is not an equity is a 404 that says which.
 */
function equityAsked(
  raw: string | undefined,
): { symbol: string } | { status: 400 | 404; body: { error: string; detail: string } } {
  const asked = raw?.trim();
  if (!asked) {
    return { status: 400, body: { error: 'missing_symbol', detail: 'Pass ?symbol=, for example ?symbol=NVDAc.' } };
  }
  const symbol = canonicalSymbol(asked);
  if (!isStock(symbol)) {
    return { status: 404, body: { error: 'not_an_equity', detail: `${symbol} is not a tokenized equity.` } };
  }
  return { symbol };
}

/**
 * GET /market/stocks/history?symbol=NVDAc — the series we have actually observed.
 *
 * These assets have no feed and no free candle source, so the only honest history is our own
 * timestamped readings from the route that prices them. It starts when we started watching and the
 * response says so, rather than back-filling a shape nobody measured.
 */
/**
 * When a tokenized equity last reported, and when it is projected to report next.
 *
 * Straight from EDGAR — the dates are the regulator's own filing record, not a vendor's calendar.
 * `earningsCalendar` has driven the event-driven planner and one verification check since it was
 * written and was reachable from nowhere in the app, which is odd for a product that ships an agent
 * whose entire mandate is trading around these dates.
 *
 * `nextAt` is a PROJECTION from the observed cadence and the response says so, with the gaps it was
 * projected from. A predicted date rendered next to real ones without that distinction is the kind
 * of number someone trades on.
 */
market.get('/market/earnings', async (c) => {
  const asked = equityAsked(c.req.query('symbol'));
  if ('body' in asked) return c.json(asked.body, asked.status);
  const { symbol } = asked;
  /*
   * A record that could not be read is not a record with nothing in it.
   *
   * `.catch(() => null)` folded a fetch that failed into "No filings found" — a 502 whose sentence claimed there were
   * none. No entry for the company is a 404, and stays one until the record changes; a record that could not be read is
   * a 502, worth asking again. Neither sentence names who publishes the record: the code carries the specifics, and the
   * screens these reach name no vendor.
   */
  let cal: Awaited<ReturnType<typeof earningsCalendar>>;
  try {
    cal = await earningsCalendar(symbol);
  } catch (e) {
    log.warn(`[earnings] could not read the filings of ${symbol}: ${e instanceof Error ? e.message : String(e)}`);
    return c.json(
      { error: 'filings_unavailable', detail: `The filing record for ${symbol} could not be read just now.` },
      502,
    );
  }
  if (!cal) return c.json({ error: 'no_filings', detail: `No filings were found for ${symbol}.` }, 404);
  return c.json(cal);
});

/**
 * What the regulator says each of these companies does — the sectors behind the allocation donut.
 *
 * Several symbols at once because the chart asks about a whole portfolio, and one request per holding would be a round
 * trip per slice. Each answer is independent: one symbol the SEC has no classification for does not cost the others
 * theirs, so the response is a map with `null` where there is no answer.
 *
 * **`null` is a real answer and the client keeps it as one.** A filer with no SIC on record — some trusts, index ETFs
 * among them — genuinely has none, and the donut draws that as Unclassified rather than guessing from the ticker. A
 * lookup that merely failed is also null here; both mean "this build cannot say", which is exactly what the chart shows.
 */
market.get('/market/classification', async (c) => {
  const asked = (c.req.query('symbols') ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s !== '');
  if (asked.length === 0) {
    return c.json({ error: 'no_symbols', detail: 'symbols is a comma-separated list of tickers.' }, 400);
  }
  if (asked.length > 50) {
    return c.json({ error: 'too_many_symbols', detail: 'At most 50 symbols in one request.' }, 400);
  }
  const unique = [...new Set(asked)];
  const found = await Promise.all(
    unique.map(async (symbol) => {
      const hit = await classificationFor(symbol).catch(() => null);
      return [symbol, hit === null ? null : { sector: hit.description, sic: hit.sic }] as const;
    }),
  );
  return c.json(Object.fromEntries(found));
});

market.get('/market/stocks/history', async (c) => {
  const asked = equityAsked(c.req.query('symbol'));
  if ('body' in asked) return c.json(asked.body, asked.status);
  const { symbol } = asked;
  /*
   * `hours=abc` is refused, not read as "no readings".
   *
   * NaN survived the clamp, reached the interval as "NaN hours", and Postgres refused it — which `observedHistory`
   * swallowed into an empty series, so an equity with readings answered 200 "No readings yet".
   */
  const hours = Number(c.req.query('hours') ?? 720);
  if (!Number.isFinite(hours) || hours <= 0) {
    return c.json({ error: 'invalid_hours', detail: 'hours is a number of hours above zero.' }, 400);
  }
  const points = await observedHistory(symbol, Math.min(Math.max(hours, 1), 24 * 365));
  return c.json({
    symbol,
    points,
    /** Said plainly so a screen never implies more history than exists. */
    observedSince: points[0]?.at ?? null,
    note:
      points.length === 0
        ? 'No readings yet. These have no market-data feed; the series begins when this deployment first priced them.'
        : `${points.length} readings since ${new Date(points[0]!.at).toISOString()}.`,
  });
});

/** GET /market/symbols — which symbols have a real feed. */
market.get('/market/symbols', (c) => c.json(Object.keys(COINGECKO_IDS)));

/**
 * GET /market/logos?symbols=BTC,NVDAc — real logos, from the registries that actually know.
 *
 * Public, because it is the same information the market list already shows and it identifies
 * nothing about the caller. A symbol neither upstream knows answers `{ url: null }` and the client
 * keeps its gradient mark, which is why this cannot put a wrong face on an instrument.
 */
market.get('/market/logos', async (c) => {
  const raw = (c.req.query('symbols') ?? '').trim();
  if (!raw) return c.json({});
  // Bounded so one caller cannot fan out into hundreds of upstream lookups on a rate-limited key.
  const symbols = raw.split(',').map((s) => canonicalSymbol(s.trim())).filter(Boolean).slice(0, 60);
  return c.json(await logosFor(symbols));
});

/**
 * GET /market/tradable — the symbols the executor can actually settle on this chain.
 *
 * Public, and load-bearing: the app used to offer "Buy $50 of SOL weekly" on a Base build, which
 * would have created a strategy no signed transaction could ever fill. Anything not in this list
 * is a chart you can look at, not an order you can place.
 */
market.get('/market/tradable', async (c) => {
  /*
   * "Real address" and "tradable here" are different questions, and answering the first while being
   * asked the second is how the app came to offer a Buy button it could not honour.
   *
   * The equities are in `TOKENS` because their addresses are real on Base. On a fork of Base they
   * do not function — they carry one byte of code and `totalSupply()` reverts — so every one of
   * them was listed as tradable, `isTradable('NVDAc')` returned true, and `/order/NVDAc` rendered a
   * complete ticket with a live price and an enabled "Buy $250 of NVDAc". The fill then reverted
   * `TF`. The screen was confidently wrong, which is the one thing this route exists to prevent:
   * anything not in this list is a chart you can look at, not an order you can place.
   */
  /*
   * Nothing is tradable where nothing can settle (PLAN.md 3.7).
   *
   * 1inch has no deployment on Base Sepolia, so every symbol listed here rendered an enabled Buy for an order
   * that could only fail at settlement. An empty list disables Buy with the reason the order screen already
   * gives any symbol this list does not name.
   */
  if (!CAN_SETTLE) return c.json([]);
  return c.json(await functioningHere());
});

/**
 * What a strategy can follow on this chain — priced, with a balance that can be read — whether or not a fill
 * can settle here (PLAN.md 3.7).
 *
 * Where fills settle this is `/market/tradable`. Where they do not, `/market/tradable` is empty, and onboarding
 * still needs symbols to draw the approved portfolio over: without them approving on Base Sepolia refused with
 * "nothing to rebalance" and a new user could not finish. The portfolio is created watched instead — it reports
 * what it would trade and moves nothing — over these.
 */
market.get('/market/watchable', async (c) => c.json(await functioningHere()));

/**
 * The registry less the equities where they do not function, each at the address a fill would move.
 *
 * Exported for `routes/withdrawals.ts`: a withdrawal may move exactly the tokens Send offers, and one list is how the
 * two cannot disagree about which those are.
 */
export async function functioningHere(): Promise<{ symbol: string; address: string; decimals: number }[]> {
  const equitiesOk = await equitiesFunctional();
  return Object.entries(TOKENS)
    .filter(([symbol]) => equitiesOk || !isStock(symbol))
    .map(([symbol, t]) => ({
      symbol,
      address: SETTLEMENT_ADDRESS[symbol] ?? t.address,
      decimals: t.decimals,
    }));
}

/**
 * The address a fill actually moves on THIS chain, for the symbols where that differs.
 *
 * `TOKENS` is deliberately all-mainnet — its own comment says so, because 1inch is only ever asked
 * about chain 8453 and a Sepolia address makes the quote 400. That is right for quoting and wrong
 * for this route, which promises "the symbols the executor can actually settle on this chain" and
 * hands each one an address. On the Sepolia build it published mainnet USDC,
 * 0x833589fC…02913, while /venues and /approvals — which read ADDRESSES — showed Circle's Sepolia
 * deployment, 0x036CbD53…3dCF7e, for the same token on the same screen-load. One of those is the
 * contract a user would inspect on a block explorer, and it was not the one on /tokens.
 *
 * Only the four the chain sets differ on. The equities are absent on purpose: they are mainnet
 * ERC-20s, `equitiesFunctional()` filters them out entirely on a chain where they do not work, so
 * anywhere they survive this filter the registry address IS the settlement address.
 */
const SETTLEMENT_ADDRESS: Record<string, string> = {};
// Only what the chain has: the testnet has no WETH or BTC, and an address with no code is not a settlement address.
for (const [symbol, address] of [
  ['ETH', ADDRESSES.nativeToken],
  ['WETH', ADDRESSES.weth],
  ['USDC', ADDRESSES.usdc],
  ['CBBTC', ADDRESSES.btc],
] as const) {
  if (address) SETTLEMENT_ADDRESS[symbol] = address;
}

/**
 * GET /yield/supply — the real USDC supply rate on Aave v3, Base.
 *
 * Public: it is a published on-chain rate, identical for every visitor, and the home screen shows
 * it before a user has a wallet.
 */
/**
 * The Aave supply rate, or a reason there isn't one — never a bare 500.
 *
 * This was `c.json(await usdcSupplyYield())` with no catch, and `usdcReserve` throws for two real
 * reasons: the Base mainnet RPC did not answer, and the rate it returned was implausible
 * (`apy <= 0 || apy > 1`), which is a deliberate refusal to publish a nonsense number. Either one
 * reached the client as an empty 500 — caught by the screen sweep, which recorded
 * `500 /yield/supply` and a console error on a screen whose UI looked fine.
 *
 * 503 with `retry-after`, matching `/market/ohlc` and `/perp/:symbol`: the rate does come back, so
 * this is worth retrying, and `isRetryable` treats 5xx as retryable. The sentence matters more than
 * the code — an endpoint this public should never answer with nothing at all.
 */
market.get('/yield/supply', async (c) => {
  try {
    return c.json(await usdcSupplyYield());
  } catch (e) {
    c.header('retry-after', '5');
    return c.json(
      {
        error: 'rate_unavailable',
        detail: `The Aave v3 supply rate could not be read just now: ${
          e instanceof Error ? e.message : String(e)
        }`,
      },
      503,
    );
  }
});

/**
 * GET /market/stocks — the tokenized equities, priced off the venue that would fill the trade.
 *
 * There is no CoinGecko feed for these, and quoting the underlying NYSE print would be the wrong
 * number anyway: what a user pays is what 1inch routes on Base right now. So the price is derived
 * from a real quote — swap $1,000 of USDC in, see how many tokens come out — which is the same
 * call the order ticket makes. A symbol whose route fails comes back with `feed: 'unavailable'` and
 * no price, and the UI stamps it, rather than showing a plausible-looking invention.
 */
const STOCK_PROBE_USD = 1_000;

/**
 * One cached snapshot for everyone, answered at once and refreshed behind the answer.
 *
 * Eight 1inch quotes take several seconds even in parallel, because the outbound queue in
 * `http/get.ts` spaces requests to stay inside the rate limit. Without this the markets screen
 * blocks on every mount and renders its empty state first. The prices are identical for every
 * user, so caching them is not a shortcut — it is the correct shape.
 *
 * A 30-second snapshot that then made its next caller wait out the whole probe still made someone
 * wait: 8.1 s for Markets and Search on the hosted app (2026-09-14), whenever nobody had asked in
 * the last half minute. So a snapshot past its TTL is still served — for at most STOCK_STALE_MS —
 * while one probe refreshes it; only a process with no snapshot, or one too old to stand behind,
 * makes its caller wait.
 */
let stockCache: { at: number; rows: unknown[] } | null = null;
let stockProbe: Promise<unknown[]> | null = null;
const STOCK_TTL_MS = 30_000;
const STOCK_STALE_MS = 5 * 60_000;

market.get('/market/stocks', async (c) => {
  const age = stockCache ? Date.now() - stockCache.at : Infinity;
  if (stockCache && age < STOCK_TTL_MS) return c.json(stockCache.rows);
  if (stockCache && age < STOCK_STALE_MS) {
    void refreshStocks().catch(() => undefined);
    return c.json(stockCache.rows);
  }
  return c.json(await refreshStocks());
});

/** One probe at a time: callers arriving while it runs share it instead of queueing eight more quotes. */
function refreshStocks(): Promise<unknown[]> {
  stockProbe ??= probeStocks().finally(() => {
    stockProbe = null;
  });
  return stockProbe;
}

async function probeStocks(): Promise<unknown[]> {
  const rows = await Promise.all(
    Object.values(STOCKS).map(async (s) => {
      try {
        const q = await quote({ inSymbol: 'USDC', outSymbol: s.symbol, amount: STOCK_PROBE_USD });
        if (!(q.outAmount > 0)) throw new Error('no route');
        return {
          symbol: s.symbol,
          name: s.name,
          address: s.address,
          price: STOCK_PROBE_USD / q.outAmount,
          venues: q.venues,
          feed: 'live' as const,
        };
      } catch {
        return {
          symbol: s.symbol,
          name: s.name,
          address: s.address,
          price: null,
          venues: [] as string[],
          feed: 'unavailable' as const,
        };
      }
    }),
  );
  stockCache = { at: Date.now(), rows };
  return rows;
}

/**
 * Warm the windows every screen opens on.
 *
 * The public price tier is slow to serve a cold request under load, and the first person to open
 * the app should not be the one who pays for it. This fetches the quote list and the five chart
 * windows once at boot, in the background, so the cache is populated before anyone asks.
 *
 * Failures are ignored on purpose: a warm-up that cannot reach the upstream is not a reason to
 * refuse to start, and the request path already handles a cold cache.
 */
export function warmMarketCache(): void {
  // The logo batch ahead of everything: one request every market list shows, and the sweep below never asked for it (E106).
  void warmLogos();
  // The equities first: the slowest answer the Markets screen waits on, and one probe serves everyone.
  void refreshStocks().catch(() => undefined);

  // Ordered by what a cold user hits first: the market list, then the default 1D chart, then the
  // rest of the timeframe pills. The upstream serves these one at a time behind a rate limit, so
  // the order is the difference between a fast first screen and a fast last one.
  const urls = [ALL_IDS_URL];

  // The window every asset screen opens on, for EVERY symbol with a feed. Warming only three
  // symbols meant opening LINK or AAVE waited on a cold fetch behind a rate limiter, and the
  // screen showed its warming state for someone who had done nothing unusual.
  const ids = [...new Set(Object.values(COINGECKO_IDS))];
  for (const id of ids) {
    urls.push(`${COINGECKO}/coins/${id}/ohlc?vs_currency=usd&days=1`);
  }

  // The remaining timeframe pills, for the symbols a session is most likely to open. Warming every
  // window for every symbol would be 48 requests through a 1.1s-spaced queue, which starves the
  // very first request it is meant to help.
  for (const days of [30, 7, 90]) {
    for (const symbol of ['BTC', 'ETH', 'WETH']) {
      const id = COINGECKO_IDS[symbol];
      if (id) urls.push(`${COINGECKO}/coins/${id}/ohlc?vs_currency=usd&days=${days}`);
    }
  }

  /*
   * The backtest's history — a different endpoint, and it was not warmed at all.
   *
   * `market_chart` is what tier 5's setup screen and every agent backtest read, and a cold one
   * measured **61 seconds** against the free tier's retry ladder. A screen that promises "run
   * against real history at your current limits" and then sits for a minute is a screen people
   * assume is broken.
   *
   * One request per symbol, at the LONGEST lookback, because `backtest/engine.ts` slices a
   * shorter window out of a longer one it already holds: three URLs here make 30d, 90d, 6m and 1y
   * instant for all three symbols. Warming the short windows instead would be twelve requests and
   * buy less.
   */
  for (const symbol of ['BTC', 'ETH', 'WETH']) {
    const id = COINGECKO_IDS[symbol];
    if (id) urls.push(`${COINGECKO}/coins/${id}/market_chart?vs_currency=usd&days=365`);
  }

  // Keep trying until each one lands. A single pass is not enough on a rate-limited tier: the
  // first sweep can exhaust its retries while the queue is backed up, and then the endpoint stays
  // cold until a user happens to ask for it — which is precisely the request that should be fast.
  const pending = new Set(urls);
  const sweep = async () => {
    for (const url of [...pending]) {
      if (staleValue(url, FRESH_MS)) {
        pending.delete(url);
        continue;
      }
      try {
        await getJson(url, FRESH_MS);
        pending.delete(url);
      } catch {
        // Leave it pending; the next sweep tries again.
      }
    }
    if (pending.size > 0) {
      setTimeout(() => void sweep(), WARM_RETRY_MS).unref?.();
      return;
    }
    /*
     * And then do it again, forever.
     *
     * The sweep used to stop the moment everything had landed, which reads as finished and is
     * not: `STALE_TOLERANCE_MS` is ten minutes, so every warmed URL falls out of tolerance shortly
     * after and is cold again. Nothing re-warmed it, so the next person to open a market list got
     * a cold fetch behind a rate limiter — for data the server had held twenty minutes earlier.
     *
     * Measured on the deployed executor: up for 2,546 seconds, and only four of nine symbols had
     * a sparkline. Polling it by hand brought all nine back within a hundred seconds, which is the
     * proof that nothing was wrong except that no one was asking.
     *
     * A pass every five minutes stays inside the ten-minute tolerance with room for the pass
     * itself, and skips anything fetched in the last `FRESH_MS` — so a busy deployment does almost
     * no extra work and an idle one never goes cold.
     */
    setTimeout(() => {
      for (const url of urls) pending.add(url);
      void sweep();
    }, REWARM_MS).unref?.();
  };
  void sweep();
  keepPricesFresh();
}

/**
 * How long between full re-warms. Must stay under `STALE_TOLERANCE_MS` by more than one pass takes,
 * or the cache is cold again before the sweep that refills it has finished.
 */
const REWARM_MS = 5 * 60_000;

/** How long to wait before another go at whatever has not warmed yet. */
const WARM_RETRY_MS = 20_000;

/**
 * The price URL is a heartbeat, not a one-shot.
 *
 * Warming once at boot is only enough while someone is looking. `http/get.ts` treats a cache entry
 * as fresh for 30s, so on an idle server the entry aged out and the very next caller went upstream
 * cold — straight into the rate-limit ladder. For a screen that is a spinner; for `priceOf` it was
 * the 8s deadline, a fallback to the last good value, and a claim that took 8009ms to report a
 * price the process had had in memory the whole time.
 *
 * Refreshing the single price URL just inside the freshness window means every caller — a chart, a
 * leaderboard, a scheduled buy about to be filled — reads it from memory. It costs two requests a
 * minute to one URL, which is what asking for all fourteen symbols at once bought us.
 *
 * Only the price URL. The OHLC windows are per symbol per timeframe; refreshing those on a timer
 * would be forty-eight requests through a 1.1s-spaced queue and would starve this one.
 */
const PRICE_REFRESH_MS = 25_000;

function keepPricesFresh(): void {
  const tick = () => {
    // `0` TTL forces the fetch rather than reading the entry we are trying to replace.
    void getJson(ALL_IDS_URL, 0).catch(() => undefined);
  };
  setInterval(tick, PRICE_REFRESH_MS).unref?.();
}


/**
 * GET /perp/:symbol — one futures contract, from the venue that lists it.
 *
 * Public: a venue's market data is not user data. 404 when no venue lists the contract, because a
 * futures screen with no mark has nothing true to put on it.
 */
market.get('/perp/:symbol', async (c) => {
  let m;
  try {
    m = await perpMetrics(c.req.param('symbol'));
  } catch (e) {
    /*
     * "The venue is slow" is a different answer from "there is no such contract", and only one of
     * them is worth retrying. Same shape as `/market/ohlc`'s warming reply.
     */
    if (e instanceof PriceTooSlow) {
      c.header('retry-after', '3');
      return c.json({ error: 'warming', detail: 'The futures venue did not answer; retry shortly.' }, 503);
    }
    throw e;
  }
  if (!m) return c.json({ error: 'no_feed', detail: 'No futures contract for this symbol.' }, 404);
  return c.json(m);
});

/**
 * GET /market/futures — every live perpetual on Hyperliquid, busiest first (2026-09-13).
 *
 * Public, like the rest of `/market/*`. xorr does not trade these; this is what the Futures screens
 * draw.
 */
market.get('/market/futures', async (c) => {
  try {
    return c.json({ venue: 'Hyperliquid', markets: await perpMarkets() });
  } catch {
    c.header('retry-after', '3');
    return c.json({ error: 'warming', detail: 'The futures venue did not answer; retry shortly.' }, 503);
  }
});

/** GET /perp/:symbol/candles?range=1D|1W|1M|1Y — the venue's own candles for one contract. */
market.get('/perp/:symbol/candles', async (c) => {
  const range = c.req.query('range') ?? '1D';
  if (!(PERP_RANGES as readonly string[]).includes(range)) {
    return c.json({ error: 'bad_range', detail: `range must be one of ${PERP_RANGES.join(', ')}` }, 400);
  }
  try {
    const contract = findPerp(await perpMarkets(), c.req.param('symbol'));
    if (!contract) return c.json({ error: 'no_feed', detail: 'No futures contract for this symbol.' }, 404);
    return c.json(await perpCandles(contract.symbol, range as PerpRange));
  } catch {
    c.header('retry-after', '3');
    return c.json({ error: 'warming', detail: 'The futures venue did not answer; retry shortly.' }, 503);
  }
});

/**
 * What this wallet has supplied to Aave, and what it is earning.
 *
 * Separate from `/yield/supply`, which is the RATE and is public. This is a position and belongs
 * to a wallet, so it needs a session.
 */
market.get('/yield/position', async (c) => {
  const w = await currentWalletFor(c);
  if (!w) return c.json({ suppliedUsd: 0, available: false, reason: 'no_wallet' });
  try {
    const reserve = await usdcReserve();
    const code = await publicClient.getCode({ address: reserve.pool }).catch(() => undefined);
    if ((code?.length ?? 0) <= 4) {
      return c.json({
        suppliedUsd: 0,
        apy: reserve.apy,
        available: false,
        // Named, because "0 supplied" and "no lending pool on this chain" look identical otherwise.
        reason: `Aave v3 is not deployed at ${reserve.pool} on this network.`,
        pool: reserve.pool,
        aToken: reserve.aToken,
        asset: reserve.asset,
      });
    }
    return c.json({
      suppliedUsd: await suppliedUsd(w.address as Address),
      apy: reserve.apy,
      pool: reserve.pool,
      aToken: reserve.aToken,
      asset: reserve.asset,
      available: true,
    });
  } catch (e) {
    return c.json({ error: e instanceof Error ? e.message : String(e) }, 502);
  }
});

/**
 * The exact transaction the USER signs to withdraw. Encoded here, not in the client.
 *
 * The asset address comes from the reserve rather than a constant, so a client cannot end up
 * withdrawing the wrong token if Aave migrates one. `usd: null` means everything — Aave takes
 * `type(uint256).max` for that, and it is the only way to actually empty a rebasing position
 * instead of leaving a few seconds' interest behind.
 */
market.post('/yield/withdraw-calldata', async (c) => {
  const w = await currentWalletFor(c);
  if (!w) return c.json({ error: 'no_wallet' }, 400);
  const body = await c.req.json().catch(() => ({}));
  const usd = body?.usd;
  const all = usd === null || usd === undefined || usd === 'max';

  /*
   * The amount is checked before it is converted, and before anything is read.
   *
   * `BigInt(Math.floor(Number('abc') * 1e6))` threw a RangeError ahead of the zero guard, so a body the caller had to
   * fix answered 500 — "retry" — instead of naming what was wrong.
   */
  const invalidAmount = { error: 'invalid_amount', detail: 'usd is a dollar amount above zero, or null for all of it.' };
  const asked = typeof usd === 'number' || typeof usd === 'string' ? Number(usd) : NaN;
  if (!all && !(Number.isFinite(asked) && asked > 0)) return c.json(invalidAmount, 400);

  /*
   * No pool on this chain, no calldata for one.
   *
   * The pool address is Base mainnet's, and this built `withdraw()` against it wherever the executor ran — so on a
   * chain with no pool at that address the wallet was handed a transaction to an account with no code, while
   * `/yield/position` on the same executor already said `available: false`. 409: nothing about the request is wrong,
   * and nothing on this chain can make it right.
   */
  if (!(await readChain('the lending pool', () => aavePoolIsDeployedHere()))) {
    return c.json(
      { error: 'aave_not_deployed', detail: 'No lending pool is deployed on this network, so there is nothing to withdraw.' },
      409,
    );
  }

  const reserve = await usdcReserve();
  const amountRaw = all ? MAX_UINT256 : BigInt(Math.floor(asked * 1e6));
  // Above zero and still less than a millionth of a dollar: nothing a pool can pay out.
  if (amountRaw <= 0n) return c.json(invalidAmount, 400);

  return c.json({
    to: reserve.pool,
    data: withdrawCalldata({
      asset: reserve.asset,
      amountRaw,
      // To the owner. The server cannot name a different recipient — this is the whole reason the
      // calldata is safe to have a server build.
      owner: w.address as Address,
    }),
    /** So the screen can say "all of it" rather than a number that is already slightly stale. */
    isMax: amountRaw === MAX_UINT256,
  });
});

/**
 * Basename lookup, both directions. Public: a name is a public record on a public chain.
 *
 * `?name=` resolves forward, `?address=` resolves in reverse. Null is a normal answer and comes
 * back as a 200 — most addresses have no name, and treating that as an error would make every
 * screen that asks have to special-case the common case.
 */
market.get('/basename', async (c) => {
  const name = c.req.query('name');
  const address = c.req.query('address');
  if (name) return c.json({ name, address: await addressOfBasename(name) });
  if (address && isAddress(address)) {
    return c.json({ address, name: await basenameOf(address as Address) });
  }
  // A code where a client reads one; the sentence it used to carry in `error` is the detail.
  return c.json({ error: 'invalid_query', detail: 'Pass ?name=<basename> or a valid ?address=0x….' }, 400);
});

/**
 * The same asset, priced two ways. Public, like every other price route.
 *
 * Deliberately its own endpoint rather than a field on `/market/quotes`: the second source costs a
 * round trip to a rate-limited API, and paying that for every symbol on a list screen to answer a
 * question only the asset screen asks would be a poor trade.
 */
/**
 * The split or dividend this equity has queued, from its own mint.
 *
 * Always 200, including when nothing can be read: `status: 'unavailable'` is a real answer the
 * asset screen renders, and a 404 here would make "we could not check" indistinguishable from a
 * bad request on a screen that has to tell the two apart.
 */
market.get('/market/corporate-action', async (c) => {
  // Mixed-case, for the same reason `/market/crosscheck` is: the registry spells them `NVDAx`.
  const symbol = c.req.query('symbol') ?? '';
  if (!symbol) {
    return c.json({ error: 'missing_symbol', detail: 'Pass ?symbol=, for example ?symbol=NVDAx.' }, 400);
  }
  return c.json(await corporateAction(symbol));
});

market.get('/market/crosscheck', async (c) => {
  /*
   * Not uppercased. The tokenized equities are registered mixed-case — `NVDAc`, not `NVDAC` — so
   * normalising here silently missed every one of them and fell through to a wrong answer.
   */
  const symbol = c.req.query('symbol') ?? '';
  if (!symbol) return c.json({ error: 'missing_symbol', detail: 'Pass ?symbol=, for example ?symbol=WETH.' }, 400);
  return c.json(await crossCheck(symbol));
});
