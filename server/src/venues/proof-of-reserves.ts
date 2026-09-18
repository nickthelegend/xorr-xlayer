/**
 * Proof of reserves for Backed Finance xStocks (PLAN.md §8.4).
 *
 * Every xStock is a claim on a real share held by a custodian. Backed publishes what its
 * attestor sees — shares held against tokens in circulation — and xStocks exposes it as a public,
 * unauthenticated endpoint. Reading it is what lets a position say "1:1 backed" and mean it.
 *
 * The one rule here: a ratio is either measured or absent. An xStock whose backing cannot be read
 * right now reports `unverified` and says why. It never falls back to 1.0, never interpolates from
 * an older snapshot, and never reports a number the attestor did not publish — a fabricated
 * backing ratio on a tokenized-equity app is worse than no badge at all.
 *
 * Source: https://api.xstocks.fi/api/v2/public/proof-of-reserves (documented at
 * https://docs.xstocks.fi/apis/openapi/proof-of-reserves). The attestation itself is produced by
 * The Network Firm with read-only access to Backed's custody accounts.
 */
import { query } from '../db/index.js';

const POR_URL = 'https://api.xstocks.fi/api/v2/public/proof-of-reserves';

/** The endpoint refuses a request with no User-Agent, so send one that names us. */
const UA = 'xorr-executor/1.0 (+https://xorr.finance)';

/** Attestations refresh roughly every ten minutes upstream; re-reading faster buys nothing. */
const CACHE_TTL_MS = 5 * 60_000;

/** A page is capped at 100 and there are ~900 symbols, so the whole set is a handful of requests. */
const PAGE_SIZE = 100;
const MAX_PAGES = 15;

export type CustodyHolding = {
  provider: string;
  quantity: number;
  symbol: string;
};

export type ReserveBacking = {
  symbol: string;
  /** Shares the custodian is attested to hold. */
  sharesHeld: number;
  /** Tokens in circulation on-chain. */
  circulatingSupply: number;
  /** sharesHeld / circulatingSupply. At or above 1 means fully backed. */
  ratio: number;
  custodians: CustodyHolding[];
  /** When the attestor observed this, not when we read it. */
  asOf: string;
};

/**
 * Backing is either measured or it is not. There is deliberately no third shape that carries a
 * number with a caveat attached, because a number with a caveat gets rendered as a number.
 */
export type BackingStatus =
  | { status: 'verified'; backing: ReserveBacking }
  | { status: 'unverified'; reason: string };

type PorNode = {
  symbol?: string;
  timestamp?: string;
  sharesHeld?: string;
  circulatingSupply?: string;
  holdings?: { provider?: string; quantity?: string; symbol?: string }[];
};

let cache: { at: number; bySymbol: Map<string, ReserveBacking> } | undefined;
let inFlight: Promise<Map<string, ReserveBacking>> | undefined;

function parseNode(node: PorNode): ReserveBacking | null {
  const symbol = node.symbol?.trim();
  const held = Number(node.sharesHeld);
  const circulating = Number(node.circulatingSupply);
  if (!symbol || !node.timestamp) return null;
  if (!Number.isFinite(held) || !Number.isFinite(circulating)) return null;
  // A supply of zero has no ratio to report; saying so beats dividing by it.
  if (!(circulating > 0) || held < 0) return null;

  return {
    symbol,
    sharesHeld: held,
    circulatingSupply: circulating,
    ratio: held / circulating,
    custodians: (node.holdings ?? []).flatMap((h) => {
      const quantity = Number(h.quantity);
      if (!h.provider || !Number.isFinite(quantity)) return [];
      return [{ provider: h.provider, quantity, symbol: h.symbol ?? symbol }];
    }),
    asOf: node.timestamp,
  };
}

async function fetchAllPages(): Promise<Map<string, ReserveBacking>> {
  const bySymbol = new Map<string, ReserveBacking>();

  for (let page = 0; page < MAX_PAGES; page++) {
    const res = await fetch(`${POR_URL}?page=${page}&pageSize=${PAGE_SIZE}`, {
      headers: { Accept: 'application/json', 'User-Agent': UA },
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) {
      throw new Error(`proof-of-reserves HTTP ${res.status}`);
    }
    const body = (await res.json()) as { nodes?: PorNode[]; page?: { hasNextPage?: boolean } };

    for (const node of body.nodes ?? []) {
      const parsed = parseNode(node);
      // Keep the freshest attestation if a symbol ever appears more than once.
      if (parsed && (!bySymbol.has(parsed.symbol) || parsed.asOf > bySymbol.get(parsed.symbol)!.asOf)) {
        bySymbol.set(parsed.symbol, parsed);
      }
    }
    if (!body.page?.hasNextPage) break;
  }

  if (bySymbol.size === 0) {
    throw new Error('proof-of-reserves returned no usable rows');
  }
  return bySymbol;
}

/**
 * Every symbol the attestor currently publishes, cached briefly.
 *
 * Concurrent callers share one upstream read: a page of positions asks for backing once per row,
 * and nine HTTP requests per row would be its own outage.
 */
export async function readAllBacking(): Promise<Map<string, ReserveBacking>> {
  if (cache && Date.now() - cache.at < CACHE_TTL_MS) return cache.bySymbol;
  inFlight ??= fetchAllPages()
    .then((bySymbol) => {
      cache = { at: Date.now(), bySymbol };
      void persist(bySymbol);
      return bySymbol;
    })
    .finally(() => {
      inFlight = undefined;
    });
  return inFlight;
}

/**
 * Backing for one xStock, or an honest account of why it is unknown.
 */
export async function backingFor(symbol: string): Promise<BackingStatus> {
  let all: Map<string, ReserveBacking>;
  try {
    all = await readAllBacking();
  } catch (err) {
    // A stale attestation is still an unread one. Say so rather than serve yesterday's ratio.
    return {
      status: 'unverified',
      reason: `Could not reach the xStocks proof-of-reserves attestation: ${
        err instanceof Error ? err.message : String(err)
      }`,
    };
  }

  const backing = all.get(symbol);
  if (!backing) {
    return {
      status: 'unverified',
      reason: `The attestation does not currently publish ${symbol}.`,
    };
  }
  return { status: 'verified', backing };
}

/**
 * Keep each attestation we read.
 *
 * The endpoint publishes only the latest observation per symbol, so history exists only if we
 * remember it — which is what lets a position show when its backing was last attested, and how
 * that has moved.
 */
async function persist(bySymbol: Map<string, ReserveBacking>): Promise<void> {
  for (const b of bySymbol.values()) {
    await query(
      `INSERT INTO reserve_attestations (symbol, shares_held, circulating_supply, ratio, custodians, as_of)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (symbol, as_of) DO NOTHING`,
      [b.symbol, b.sharesHeld, b.circulatingSupply, b.ratio, JSON.stringify(b.custodians), b.asOf],
    ).catch(() => undefined);
  }
}

/** Attestations we have recorded for a symbol, newest first. */
export async function backingHistory(symbol: string, limit = 30): Promise<ReserveBacking[]> {
  const rows = await query<{
    symbol: string;
    shares_held: string;
    circulating_supply: string;
    ratio: string;
    custodians: CustodyHolding[] | null;
    as_of: Date;
  }>(
    `SELECT symbol, shares_held, circulating_supply, ratio, custodians, as_of
       FROM reserve_attestations WHERE symbol = $1 ORDER BY as_of DESC LIMIT $2`,
    [symbol, limit],
  ).catch(() => []);

  return rows.map((r) => ({
    symbol: r.symbol,
    sharesHeld: Number(r.shares_held),
    circulatingSupply: Number(r.circulating_supply),
    ratio: Number(r.ratio),
    custodians: r.custodians ?? [],
    asOf: r.as_of.toISOString(),
  }));
}

/**
 * The attestations we have on record for a symbol, with enough context to draw them honestly.
 *
 * `observations` is the count, and it is reported rather than left for a reader to infer from the
 * shape of a line. Two points a day apart and two hundred over a month make very different claims
 * about how steady a token's backing has been, and a chart alone cannot tell them apart.
 *
 * Nothing is interpolated or backfilled: gaps stay gaps. We started recording when this feature
 * shipped, so an empty or short series means "we have not watched this for long", never "this
 * token had no backing before now".
 */
export async function backingSeries(
  symbol: string,
  limit = 180,
): Promise<{
  symbol: string;
  observations: number;
  points: { ratio: number; sharesHeld: number; circulatingSupply: number; asOf: string }[];
  /** The span actually covered, or null with fewer than two points. */
  from: string | null;
  to: string | null;
}> {
  const history = await backingHistory(symbol, limit);
  // Oldest first, which is the order a chart draws in.
  const points = history
    .slice()
    .reverse()
    .map((h) => ({
      ratio: h.ratio,
      sharesHeld: h.sharesHeld,
      circulatingSupply: h.circulatingSupply,
      asOf: h.asOf,
    }));

  return {
    symbol,
    observations: points.length,
    points,
    from: points.length > 1 ? points[0]!.asOf : null,
    to: points.length > 1 ? points[points.length - 1]!.asOf : null,
  };
}

/** Drop the memo so the next read goes upstream. */
export function clearBackingCache(): void {
  cache = undefined;
  inFlight = undefined;
}
