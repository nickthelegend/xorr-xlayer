/**
 * Real logos for every market the app lists.
 *
 * The asset marks were radial gradients keyed off the symbol — pretty, and they told you nothing.
 * Nine crypto rows that differ only in hue is a list you have to read rather than scan, and on the
 * Stocks tab it is worse: eight tokenized equities whose entire point is that they represent real
 * companies, drawn as anonymous coloured circles.
 *
 * Two real sources, chosen because each is authoritative for what it covers:
 *
 *   - **1inch Token API** (`/token/v1.2/8453/custom/:address`) for anything with a Base address —
 *     WETH, USDC, cbBTC and all eight equities. It answers with the token's own `logoURI`, which
 *     for NVDAc is an SVG 1inch serves and a `name` of "NVIDIA Corporation". This is the token
 *     registry the aggregator itself routes against, so it is the right authority for a token's
 *     identity, and it is the only source that knows the equities at all.
 *   - **CoinGecko** for everything priced by a feed rather than held on Base — BTC, SOL, XRP,
 *     DOGE, HYPE, AAVE, LINK, TON, and the gold pair. One request for all of them, for the reason
 *     spelled out over `COINGECKO_IMAGE_URL`.
 *
 * A symbol neither source knows — the commodities, the indices, the pre-IPO names — gets no logo,
 * and the client keeps the gradient mark for it. That is the honest outcome: an invented logo for
 * an instrument nobody issues would be exactly the fabricated-identity problem the gradients were
 * innocent of.
 *
 * **A logo is decoration and must never cost what a price costs.** The first version asked
 * `/coins/{id}` per symbol through the shared retry ladder, so a CoinGecko 429 — which the public
 * tier hands out freely — turned into five attempts with exponential backoff, serialised behind
 * one host lane: about twenty-eight seconds per symbol, and `/market/logos?symbols=BTC,SOL,XRP`
 * simply never came back. Hence the batch, and hence the deadline below.
 */
import { getJson } from '../http/get.js';
import { COINGECKO_IDS, COINGECKO_IMAGE_URL, type CoingeckoMarket } from './ids.js';
import { TOKENS } from '../venues/tokens.js';
import { ONEINCH_CHAIN_ID } from '../evm/chains.js';

const ONEINCH_TOKEN_API = 'https://api.1inch.dev/token/v1.2';

/**
 * Long, because a logo that resolved once is not going to change under us.
 *
 * This said twelve seconds — a transposition of the timeout below — which meant the batch was
 * re-fetched on essentially every market load and walked straight back into the rate limit it was
 * written to avoid.
 */
const TTL_MS = 6 * 60 * 60 * 1_000;
/** Short, because nothing on screen is waiting on the answer — the gradient is already drawn. */
const TIMEOUT_MS = 6_000;
/** One shot. See `GetOptions` — a logo may not spend a price's retry budget, or its lane. */
const NO_RETRY = { attempts: 1 } as const;
/**
 * The whole request's budget.
 *
 * Whatever has resolved by now is returned and the rest are simply absent, which the client reads
 * as "not yet" rather than "no logo". A market list must not sit behind a rate limiter.
 */
const DEADLINE_MS = 7_000;

export type Logo = {
  /** Absolute URL to a PNG or SVG, or null where neither source knows this symbol. */
  url: string | null;
  /** Which upstream answered. Rendered nowhere; it is here so `/verify` can say. */
  source: '1inch' | 'coingecko' | null;
};

/**
 * Only decided answers land here.
 *
 * "Both registries were asked and neither has one" is a fact about the instrument and is cached
 * forever. "CoinGecko rate-limited us" is a fact about today and is not cached at all — the first
 * version cached both as `{url: null}`, so a single 429 during startup marked Bitcoin as having no
 * logo for the life of the process.
 */
const cache = new Map<string, Logo>();
const inflight = new Map<string, Promise<Logo | undefined>>();

const NONE: Logo = { url: null, source: null };

/** Resolved and it has none, as distinct from `undefined`, which means we could not ask. */
type Answer = Logo | undefined;

/** The token registry the aggregator routes against — and the only source that knows the equities. */
async function fromOneInch(symbol: string): Promise<Answer> {
  const token = TOKENS[symbol];
  if (!token) return NONE;
  const key = process.env.ONEINCH_API_KEY;
  if (!key) return undefined;
  try {
    const res = await getJson<{ logoURI?: string }>(
      `${ONEINCH_TOKEN_API}/${ONEINCH_CHAIN_ID}/custom/${token.address}`,
      TTL_MS,
      TIMEOUT_MS,
      { Authorization: `Bearer ${key}` },
      NO_RETRY,
    );
    return res.logoURI ? { url: res.logoURI, source: '1inch' } : NONE;
  } catch {
    // An upstream that will not answer is not evidence the token has no logo.
    return undefined;
  }
}

/**
 * Every CoinGecko-priced symbol, in one request.
 *
 * Held here rather than leaning on `getJson`'s URL cache. That cache would in fact collapse N
 * callers into one call — but then "the market list costs CoinGecko a single request" would be a
 * property of another module's caching policy rather than of this one, true until someone tunes a
 * TTL somewhere else. It is the point of the batch, so it lives with the batch.
 *
 * A failure is not held: `map` is only set on success, and the in-flight promise is cleared either
 * way, so a rate limit costs one attempt and the next caller tries again.
 */
let cg: { map: Map<string, string>; at: number } | undefined;
let cgInflight: Promise<Map<string, string> | undefined> | undefined;

async function coingeckoImages(): Promise<Map<string, string> | undefined> {
  if (cg && Date.now() - cg.at < TTL_MS) return cg.map;
  if (cgInflight) return cgInflight;

  cgInflight = (async () => {
    try {
      const rows = await getJson<CoingeckoMarket[]>(
        COINGECKO_IMAGE_URL,
        TTL_MS,
        TIMEOUT_MS,
        {},
        NO_RETRY,
      );
      const byId = new Map<string, string>();
      for (const r of rows) if (r.id && r.image) byId.set(r.id, r.image);
      cg = { map: byId, at: Date.now() };
      return byId;
    } catch {
      return undefined;
    } finally {
      cgInflight = undefined;
    }
  })();
  return cgInflight;
}

/**
 * The logo for one symbol, or `undefined` when no source could be reached.
 *
 * 1inch first: where a symbol has a Base address, the token that trades IS the thing on screen,
 * and the equities exist nowhere else.
 */
export async function logoFor(symbol: string): Promise<Answer> {
  const hit = cache.get(symbol);
  if (hit) return hit;

  const pending = inflight.get(symbol);
  if (pending) return pending;

  const run = (async (): Promise<Answer> => {
    try {
      const viaOneInch = await fromOneInch(symbol);
      if (viaOneInch?.url) {
        cache.set(symbol, viaOneInch);
        return viaOneInch;
      }

      const id = COINGECKO_IDS[symbol];
      if (!id) {
        /*
         * Neither registry has a row for this symbol at all — the commodities, the indices, the
         * pre-IPO names. Nothing was asked of any upstream, so this is a settled answer and worth
         * caching, but only when 1inch had actually been consulted and had nothing.
         */
        if (viaOneInch === undefined) return undefined;
        cache.set(symbol, NONE);
        return NONE;
      }

      const images = await coingeckoImages();
      if (!images) return undefined;
      const url = images.get(id);
      const found: Logo = url ? { url, source: 'coingecko' } : NONE;
      cache.set(symbol, found);
      return found;
    } finally {
      inflight.delete(symbol);
    }
  })();
  inflight.set(symbol, run);
  return run;
}

/**
 * Every requested symbol that could be resolved inside the deadline.
 *
 * Symbols that timed out are ABSENT rather than null, so the client can tell "no logo exists" from
 * "ask again in a moment" — the same distinction the app makes everywhere else between a value
 * that is zero and a value that could not be read.
 */
export async function logosFor(symbols: readonly string[]): Promise<Record<string, Logo>> {
  const unique = [...new Set(symbols)];
  const out: Record<string, Logo> = {};

  const resolving = unique.map(async (s) => {
    const logo = await logoFor(s);
    if (logo) out[s] = logo;
  });

  // Whatever is done by the deadline. The rest keep resolving in the background and land in the
  // cache, so the next request — the client retries what it did not get — is instant.
  await Promise.race([
    Promise.allSettled(resolving),
    new Promise((r) => setTimeout(r, DEADLINE_MS)),
  ]);
  return out;
}

/** How many times the boot warm-up asks for the batch before leaving it to the next request. */
const WARM_ATTEMPTS = 4;
/** Between those asks: long enough that the CoinGecko lane has moved on from whatever limited the last one. */
const WARM_GAP_MS = 15_000;

/**
 * Fetch the CoinGecko batch at boot, so the first market list after a deploy has every logo.
 *
 * The market warm-up walks some thirty CoinGecko requests one at a time through the same host lane, and the image batch
 * was not among them: after a restart the first ask for BTC's logo queued behind all of them, or took the one 429 it is
 * allowed and went cold again. Measured on the hosted fork just after a deploy, four asks five seconds apart never
 * resolved it (docs/qa/ENDPOINTS.md E106). A request still gets one attempt; this is the only thing that asks again,
 * a bounded number of times, and its waits never hold the process open.
 *
 * Resolves true once the batch is held.
 */
export async function warmLogos(attempts = WARM_ATTEMPTS, gapMs = WARM_GAP_MS): Promise<boolean> {
  for (let i = 0; i < attempts; i += 1) {
    if (await coingeckoImages()) return true;
    if (i < attempts - 1) await new Promise<void>((resolve) => setTimeout(resolve, gapMs).unref?.());
  }
  return false;
}

/** Testing only. */
export function resetLogoCache(): void {
  cache.clear();
  inflight.clear();
  cg = undefined;
  cgInflight = undefined;
}
