/**
 * The reads behind the screens that show how this thing actually works.
 *
 * Everything here already existed on the executor and had nowhere to be looked at. That is not an
 * accident of scheduling — the app grew screens for what a user *does* (buy, hold, watch) and left
 * the surfaces that let them *check* it in the API. The approvals a delegation holds, the hash
 * chain over the audit trail, the policy engine, the price a second source
 * disagrees with: all of it real, none of it visible from the phone.
 *
 * These types mirror the executor's responses exactly, field for field. Where the server sends a
 * `uint256` as a string it stays a string — parsing it to a number here would round MAX_UINT256 to
 * 1.15e77 and every screen comparing it would be comparing a lie.
 */
import { api, ApiError } from './api';
import type { AnchorReport, RouteComparison } from './types';
import type {
  BookSort,
  StrategyBook,
  StrategyDetail,
  StrategyTier,
} from './strategyBook';
import type { Keyed } from './intentKey';
import type { TrailRow } from '@/audit/anchorCheck';

/* ─────────────────────────────────────────────────────────── trust and proof */

/**
 * One claim the product makes, checked against the running system.
 *
 * `skip` is a third status and carries real meaning: most of these need a wallet on the request, so
 * an anonymous report skips them rather than failing them. Rendering a skip as a failure would put
 * a wall of red in front of a reader for something that is not wrong.
 */
export type VerifyCheck = {
  id: string;
  claim: string;
  /** The exact call the check made — an RPC method, a query, a contract read. */
  how: string;
  status: 'pass' | 'fail' | 'skip';
  /** What came back. This is the evidence, and it is why the screen is worth having. */
  observed: string;
  ms: number;
};

export type VerifyReport = {
  checks: VerifyCheck[];
  passed: number;
  failed: number;
  skipped: number;
  chain: string;
  at: string;
};

/**
 * Whether the hash chain over the audit trail still holds.
 *
 * `kind` is the field that matters and the reason this is not one boolean. The server draws a line
 * the UI must not erase:
 *
 *   `content` — a row's stored hash does not match its own fields. Something EDITED the trail. That
 *               is tampering, and it is the alarm the whole structure exists to raise.
 *   `link`    — a row does not point at its predecessor, so rows fork instead of forming a line.
 *               That is damage from a concurrent write. It is permanent, because the trail is
 *               append-only, and it is not evidence that anyone altered a record.
 *
 * Reporting both as "broken" makes "two writers raced" read as "someone edited your audit log".
 */
export type ChainVerification = {
  ok: boolean;
  /** Rows examined. */
  checked: number;
  /** Rows whose own contents still hash to their stored hash, break or no break. */
  intact: number;
  brokenAtSeq?: string;
  kind?: 'link' | 'content';
};

/**
 * `GET /activity/export?format=json`: `exportTrail` in server/src/audit/log.ts, as `{ walletId, verified, rows }`.
 *
 * `verified` is the executor's verdict on its own chain. The device check (`src/audit/anchorCheck.ts`) reads the rows and
 * nothing else, because that verdict is the thing it exists not to need.
 */
export type AuditTrailExport = { walletId: string; verified: ChainVerification; rows: TrailRow[] };


export type Limits = {
  dailyCapUsd: number;
  /** The contract's own tally of today's spend. */
  spentTodayUsd: number;
  /** The stricter of two remainders: the contract's, and the cap less the executor's own tally. */
  remainingUsd: number;
  revoked: boolean;
  /**
   * Whether there is a permission at all. `false` is a wallet that never granted one, which is not
   * the same as revoked. Optional: an executor that predates the field cannot answer.
   */
  granted?: boolean;
  /** Optional: an executor that predates the field cannot answer, and absent is not expired. */
  expiresAt?: number;
};

/** What `/limits` can draw without two figures that cannot both be right. See `limitsView`. */
export type LimitsView = {
  /** What is left today, by whichever tally is stricter. */
  left: number;
  /** The spend that leaves `left`: the bar's basis, so the bar and the figure cannot disagree. */
  spent: number;
  /** `spent / cap`, 0 to 1. */
  fraction: number;
  /** Whether the contract's tally and the executor's agree, to the cent. */
  agree: boolean;
};

/** A cent either way is rounding between two sources, not a disagreement. */
const CENT = 0.01;

/**
 * The limit, drawn from one basis.
 *
 * `/limits` sends `remainingUsd` as the stricter of the contract's remainder and the cap less the
 * executor's own tally, and `spentTodayUsd` from the contract alone (`server/src/routes/index.ts`). The
 * screen printed both, so the moment the tallies drifted it said "$908.05 spent" and "$1,855.95" left
 * under a $2,810 cap — $46 that belonged to neither. The figure that governs the next trade is the
 * stricter one, so `left` is that, the bar is the spend it implies, and `agree` says whether the two
 * sources would have told the same story. Where they would not, the screen says so rather than print a
 * spend that does not add up.
 *
 * Only a live permission is compared. A revoked, expired or never-granted one has nothing left for a
 * reason of its own, and what the contract says was spent is the only figure worth drawing. `ended` is
 * the caller's, so expiry is decided by the one helper every screen decides it with.
 */
export function limitsView(limits: Limits, ended: boolean): LimitsView {
  const cap = Math.max(0, limits.dailyCapUsd);
  if (limits.granted === false || limits.revoked || ended || cap === 0) {
    const spent = Math.max(0, limits.spentTodayUsd);
    return { left: 0, spent, fraction: cap > 0 ? Math.min(1, spent / cap) : 0, agree: true };
  }
  const left = Math.min(cap, Math.max(0, limits.remainingUsd));
  const spent = cap - left;
  return { left, spent, fraction: spent / cap, agree: Math.abs(limits.spentTodayUsd + left - cap) < CENT };
}

export type DelegationParams = {
  contract: string;
  delegate: string;
  venues: string[];
  token: string;
  tokens?: { symbol: string; address: string }[];
};

/* ─────────────────────────────────────────────────────────────── the system */

export type HealthDependency = {
  name: string;
  status: string;
  ms?: number;
  detail?: string;
  critical?: boolean;
};

export type Health = {
  ok: boolean;
  status: string;
  /** The commit this executor runs (FEATURES.md #53, compared with the app's own in `src/version.ts`). */
  version?: string;
  chain: string;
  delegation: string;
  uptimeSec: number;
  dependencies: HealthDependency[];
  db?: string;
  /**
   * Every upstream host the HTTP lane has seen, with its consecutive failures and when a breaker closes
   * (`server/src/http/get.ts`). Absent from an executor older than the field — which is not a claim that
   * none is open, only that it did not say.
   */
  breakers?: { host: string; failures: number; openUntil: number; open?: boolean }[];
  publicSurface?: { paths: string[] };
  /** Whether a language model can write the agents' replies. Absent from an executor older than the field. */
  voice?: { configured: boolean };
};

export type CatchupEntry = {
  action: string;
  detail: string;
  kind?: string;
  at: string;
  signature?: string | null;
};

export type Catchup = {
  since: string | null;
  entries: CatchupEntry[];
  counts: Record<string, number>;
  isFirstVisit?: boolean;
};

/* ─────────────────────────────────────────────────────────────────── market */

/**
 * The same asset priced two ways. Field names are the server's, checked against a live response.
 *
 * `compared: false` means only one source answered, which is NOT a disagreement — an outage tells
 * you nothing about the other source's number, and rendering it as a discrepancy sends someone
 * looking for a problem in the wrong place.
 */
export type CrossCheck = {
  symbol: string;
  /**
   * The independent price, and which feed gave it: CoinGecko for crypto, and for a wrapped xStock the issuer's own
   * mark for the same token on Solana times the wrapper's multiplier. Null when it could not be reached. Never zero —
   * zero is a price.
   */
  reference: number | null;
  referenceSource: 'coingecko' | 'xstocks' | null;
  /** CoinGecko specifically; null for an asset it does not price. Equal to `reference` when that is where it came from. */
  coingecko: number | null;
  /** Derived from the X Layer pools a fill would actually touch. Null when they could not be quoted. */
  pool: number | null;
  agree: boolean;
  compared: boolean;
  /** How far apart, as a percentage. Absent when only one side answered. */
  spreadPct?: number | null;
  note: string;
};

export type TradableToken = { symbol: string; address: string; decimals: number };

/** The body `POST /swap` takes: the pair, the amount as typed, and the tolerance (PLAN.md 3.9). */
export type SwapBody = { from: string; to: string; amount: string; slippagePct?: number };

/** What a swap came back as: what arrived and where it settled, or why nothing moved. */
export type SwapOutcome =
  | {
      status: 'filled';
      from: string;
      to: string;
      sold: number;
      received: number | null;
      usd: number;
      venue: string | null;
      measured?: boolean;
      txHash: string;
    }
  | { status: 'blocked'; reason: string; detail: string }
  | { status: 'failed'; error: string };

/* ──────────────────────────────────────────────────────────── strategy runs */

/**
 * One run of one strategy, including the ones that did nothing.
 *
 * `blocked` and `skipped` are the interesting statuses. A list of fills is a highlight reel; a run
 * that refused, with the reason it refused, is what shows the limits working.
 *
 * Every numeric is nullable because a run that never reached a fill has no price and no size, and
 * zero would be a different claim.
 */
/** The regulator's own classification of a listed company. */
export type SectorClassification = {
  /** The SEC's wording for the SIC code — e.g. "Semiconductors & Related Devices". */
  sector: string;
  /** The four-digit Standard Industrial Classification code it came from. */
  sic: string;
};

export type StrategyRunRow = {
  id: string;
  strategyId: string;
  kind: string;
  label: string;
  symbol: string;
  status: 'pending' | 'filled' | 'failed' | 'blocked' | 'skipped';
  usd: number | null;
  units: number | null;
  price: number | null;
  signature: string | null;
  error: string | null;
  at: string;
  finishedAt: string | null;
  /** Which way the run traded and where it filled, as `/runs` sends them; null for a run that never reached a venue. */
  side?: 'buy' | 'sell' | null;
  venue?: string | null;
};

/**
 * How many records an export holds, counted the way the executor builds the file.
 *
 * `/export` counted lines less one, which is wrong for all three files (`server/src/audit/log.ts`,
 * `/pnl/disposals.csv`): the trail's JSON is pretty-printed, so every field was a row; the trail's CSV
 * ends in a `# chain_verified=…` line and the disposals CSV in a totals row, each counted as a record, so
 * an empty trail came back "2 rows"; and a CSV cell quotes any line break it holds, which a line count
 * splits in two. A data record starts with a value — a sequence number, a date — so the header, the
 * footer and the totals row are the ones that do not count. `undefined` when the file does not read as
 * what it says it is, which is not the same as empty.
 */
export function exportRecords(body: string, format: 'csv' | 'json'): number | undefined {
  if (format === 'json') {
    let parsed: unknown;
    try {
      parsed = JSON.parse(body);
    } catch {
      return undefined;
    }
    if (Array.isArray(parsed)) return parsed.length;
    // The trail answers `{ walletId, verified, rows }`.
    const rows = parsed !== null && typeof parsed === 'object' ? (parsed as { rows?: unknown }).rows : undefined;
    return Array.isArray(rows) ? rows.length : undefined;
  }
  return csvRecords(body)
    .slice(1)
    .filter((cells) => {
      const first = cells[0] ?? '';
      return first !== '' && !first.startsWith('#');
    }).length;
}

/** RFC 4180, as far as the executor writes it: commas, quoted cells, doubled quotes, line breaks inside quotes. */
function csvRecords(body: string): string[][] {
  const records: string[][] = [];
  let cells: string[] = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < body.length; i++) {
    const ch = body[i]!;
    if (quoted) {
      if (ch !== '"') cell += ch;
      else if (body[i + 1] === '"') {
        cell += '"';
        i++;
      } else quoted = false;
    } else if (ch === '"') {
      quoted = true;
    } else if (ch === ',') {
      cells.push(cell);
      cell = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && body[i + 1] === '\n') i++;
      cells.push(cell);
      records.push(cells);
      cells = [];
      cell = '';
    } else {
      cell += ch;
    }
  }
  if (cell !== '' || cells.length > 0) {
    cells.push(cell);
    records.push(cells);
  }
  return records;
}

/**
 * One sale, with its cost basis.
 *
 * `basisKnown: false` means no cost was recorded for it, and the executor books that sale's gain as
 * zero (`server/src/positions/index.ts`): the true figure is proceeds less a cost nobody knows, so it
 * could be a gain or a loss. That zero is not a measurement, and a screen shows it as unknown.
 */
export type Disposal = {
  id: string;
  symbol: string;
  at: string;
  units: number;
  proceeds: number;
  cost: number;
  realised: number;
  basisKnown: boolean;
};

/**
 * A proposal as it was shown, plus what became of it.
 *
 * `payload` is stored at the time and rendered as stored. Re-pricing it against today's market
 * would rewrite what was actually put in front of someone, which is the one thing a record of
 * decisions must not do.
 */
export type ProposalRow = {
  id: string;
  agent: string;
  payload: Record<string, unknown>;
  /** Null only while it is still open and unexpired. */
  decision: 'approve' | 'skip' | 'expired' | null;
  decidedAt: string | null;
  expiresAt: string;
  at: string;
};

/**
 * What a strategy would have done over a past window.
 *
 * `feed`, `source` and `disclaimer` come from the server and are rendered, not dropped. A backtest
 * without the window it ran over and where the prices came from is a sales pitch.
 */
export type StrategyBacktest = {
  lookback: string;
  ret: number;
  maxDd: number;
  sharpe: number;
  trades: number;
  equity: number[];
  feed: 'live';
  source: string;
  disclaimer: string;
};

/**
 * What the executor has done, counted. Public — it names no wallet.
 *
 * `failuresByCause` and `fillsByVenue` are the two worth rendering and the two easiest to miss. A
 * failure rate says something is wrong and nothing about what; the causes are bucketed server-side
 * from the stored error text into the things an operator would act on differently — a price that
 * moved is the market, a revoked permission is the user, a venue that could not fill is us.
 *
 * `fillsByVenue` counts where trades actually settled, from the venue each filled run recorded — closes
 * and flattens included. It is the claim the venue integration rests on, as a number.
 */
export type AgentsStopped = { stopped: boolean; since: number | null };

/** Oldest first. `reason` says why each value was read: the 15-minute interval, or a fill, close or withdrawal. */
export type PortfolioHistory = {
  range: '1D' | '1W' | '1M' | 'ALL';
  chain: string;
  everyMinutes?: number;
  points: { at: number; totalUsd: number; reason: 'interval' | 'fill' | 'close' | 'withdrawal' }[];
};

export type Metrics = {
  runs: Record<string, number>;
  /** Fills that did not happen because something broke, as a fraction of attempts. */
  runFailureRate: number;
  /** Last seven days, bucketed by cause. */
  failuresByCause: Record<string, number>;
  fillsByVenue: Record<string, number>;
  /**
   * How far each venue's fills landed from the market price at the moment the run decided to trade.
   *
   * `fillsByVenue` counts WHERE trades settled. This says how WELL — implementation shortfall against
   * the arrival price, which is venue-neutral: it is not any venue's own quote.
   *
   * `basis` matters as much as the numbers: on a fork the price is the live market while the fill
   * executes against a pinned block, so the figure carries drift as well as execution quality. Null
   * when the executor could not compute it at all.
   */
  fillQuality: {
    venues: {
      venue: string;
      /** `crypto` or `equity`: equities are reported beside crypto, not averaged in with it. */
      assetClass?: string;
      fills: number;
      /** How many of `fills` were sales, scored by the USDC they paid. */
      sells?: number;
      meanBps: number;
      worstBps: number;
      bestBps: number;
    }[];
    measured: number;
    unmeasurable: number;
    basis: 'same-chain' | 'forked';
  } | null;
  strategies: Record<string, number>;
  alertsEnabled: number;
  alertsFiredTotal: number;
  spentTodayUsd: number;
  uptimeSec: number;
};

/**
 * When a company last reported and when it is projected to next.
 *
 * `nextAt` is a PROJECTION and `errorDays` is how wrong it could reasonably be — both derived from
 * the company's own filing cadence. Rendering the projection beside the observed dates without that
 * distinction would be handing someone a date to trade on.
 */
export type EarningsCalendar = {
  symbol: string;
  cik: number;
  /** Observed report dates, newest first, UTC ms. */
  reported: number[];
  nextAt: number | null;
  gapDays: number[];
  medianGapDays: number | null;
  errorDays: number;
};

/** A price this deployment actually recorded, as opposed to one a feed would give now. */
export type ObservedHistory = {
  symbol: string;
  points: { at: number; usd: number }[];
  observedSince: number | null;
  note: string;
};

/** What flattening would sell, before it sells it. */
export type FlattenPreview = {
  legs: { symbol: string; units: number; usd: number }[];
  totalUsd: number;
  dustBelowUsd: number;
};

/** One wrapped xStock, priced by a live Uniswap v3 probe rather than a feed. */
export type StockRow = {
  symbol: string;
  name: string;
  address: string;
  price: number | null;
  venues: string[];
  feed: 'live' | 'unavailable';
};

/**
 * One tokenized equity in the xStocks catalog, with both prices that exist for it.
 *
 * `price` is what one wrapped token costs in the X Layer Uniswap v3 pools — what a buy actually pays. `underlyingPrice`
 * is what the issuer's feed marks the listed share at. They are near each other and not equal, and
 * the gap is the spread the pool charges, so the screen shows which is which rather than picking one.
 *
 * `price: null` with `feed: 'unavailable'` is a row the catalog renders, not one it drops.
 */
export type XStockRow = {
  symbol: string;
  name: string;
  /** The listed share it tracks (`TSLA` for TSLAx), for filings and market hours. */
  ticker: string;
  /** The ERC-4626 wrapper on X Layer — what trades, what a wallet holds. */
  address: string;
  decimals: number;
  sector: string;
  price: number | null;
  underlyingPrice: number | null;
  /** Null is "not reported". Zero is "did not move". The screen must not render them the same. */
  change24hPct: number | null;
  liquidityUsd: number | null;
  underlyingAt: string | null;
  feed: 'live' | 'unavailable';
};

export type XStockCatalog = {
  rows: XStockRow[];
  /** The sectors present, in the order the filter should offer them. The server derives these. */
  sectors: string[];
  unpriced: number;
};

/**
 * One pool of a Uniswap v3 route, in order. Routes are sequential, not split: the whole order passes
 * through every hop, so `percent` is 100 on each. `USDC → TSLAx` is one hop; `USDC → USDG → NVDAx` is two.
 */
export type RouteHop = {
  /** A readable name for the hop: `Uniswap v3 USDC→USDG 0.01%`. */
  label: string;
  /** How much of the order this hop carries. Always 100 on a sequential path; null when the venue did not say. */
  percent: number | null;
  /** The venue: `Uniswap v3`. */
  venue: string;
  /** The token going into this pool. */
  from: string;
  /** The token coming out of it. */
  to: string;
  /** The pool's fee tier, as a percent: 0.05 for the 500 tier, 0.01 for 100. */
  feePct: number;
};

/**
 * What an xStock order costs, read off the Uniswap v3 quote that would fill it.
 *
 * Every number is the venue's, for the size actually asked. A figure the venue did not report
 * arrives as null and is rendered as "not reported" — never as a zero, which on this screen would
 * read as a trade that costs nothing.
 */
export type XStockQuote = {
  symbol: string;
  side: 'buy' | 'sell';
  usd: number;
  /** What is paid, in that token's own units. */
  pay: number;
  payToken: string;
  /** What the venue expects to deliver. */
  receive: number;
  receiveToken: string;
  /** The least it may deliver and still fill — the number the swap is submitted with. */
  minimumReceive: number;
  /** The venue's measured impact at this size, as a percent. */
  priceImpactPct: number | null;
  priceImpactUsd: number | null;
  /** The tolerance the quote was taken at — the one requested (default 30 bps). */
  slippageBps: number;
  /** The worst that tolerance allows, in USD. */
  slippageWorstUsd: number;
  hops: RouteHop[];
  /**
   * Always null on X Layer: xorr routes straight to Uniswap's router and nothing is taken beyond each pool's own
   * fee tier (listed per hop). Kept so a screen can say "no platform fee" rather than assume it.
   */
  platformFeeUsd: number | null;
  /** The quoter's gas estimate for the swap, in gas units. Null when it gave none — not zero. */
  estimatedGas: number | null;
  /** What this order works out to per token, once impact is in it. */
  effectivePrice: number;
  /** The pool mark for one token, to read `effectivePrice` against. */
  markPrice: number;
};

/** One push kind, its explanation, and whether it is on. Labels come from the server. */
export type NotificationPref = {
  kind: string;
  label: string;
  detail: string;
  enabled: boolean;
};

/**
 * One repository, because these are all the same kind of read: state the executor already holds,
 * fetched to be looked at rather than acted on. Splitting them per-domain would give ten interfaces
 * with one method each.
 */
export const system = {
  /* trust */
  verifyReport: (owner?: string) =>
    api.get<VerifyReport>(`/verify${owner ? `?owner=${encodeURIComponent(owner)}` : ''}`),
  auditChain: () => api.get<ChainVerification>('/activity/verify'),
  /* Every venue asked the same question, refusals included. */
  routeCompare: (inSymbol: string, outSymbol: string, amount: number) =>
    api.get<RouteComparison>(
      `/route/compare?in=${encodeURIComponent(inSymbol)}&out=${encodeURIComponent(outSymbol)}&amount=${amount}`,
    ),
  /* What X Layer holds about this trail, and whether we still agree with it. */
  auditAnchor: () => api.get<AnchorReport>('/audit/anchor'),
  /*
   * The trail itself, for re-hashing on the device (FEATURES.md #12). The JSON export, because every row's hash commits
   * to its `wallet_id` and `payload`, and the CSV carries neither.
   */
  auditTrail: () => api.get<AuditTrailExport>('/activity/export?format=json'),
  anchorNow: () =>
    api.post<
      | { anchored: true; txHash: string; head: string; entryCount: number }
      | { anchored: false; reason: string; detail: string }
    >('/audit/anchor', {}),
  /*
   * There is deliberately no `agentKeys()` here.
   *
   * `/agent/*` is the operator surface and authenticates with an agent key, not a user's Privy
   * token — "Operator only, and the operator cannot trade". A screen was built against it and 401'd
   * for every session, which is what a client method for a route this app cannot authenticate to
   * will always produce.
   */
  limits: () => api.get<Limits>('/limits'),
  delegationParams: () => api.get<DelegationParams>('/delegation/params'),

  /* the system */
  health: () => api.get<Health>('/health'),
  catchup: () => api.get<Catchup>('/catchup'),
  markCaughtUp: () => api.post<{ ok: boolean }>('/catchup/seen', {}),

  /* market */
  crosscheck: (symbol: string) =>
    api.get<CrossCheck>(`/market/crosscheck?symbol=${encodeURIComponent(symbol)}`),
  tradable: () => api.get<TradableToken[]>('/market/tradable'),

  /* the strategy book */
  /**
   * The measured strategy book. Public on the executor, so this answers for a signed-out visitor too.
   *
   * `sort` names a measured column, never a rank we assigned, and the executor seats the unmeasured last
   * rather than sorting them as though a missing Sharpe were a zero.
   */
  strategyBook: (opts: { tier?: StrategyTier; trusted?: boolean; sort?: BookSort; limit?: number } = {}) => {
    const q = new URLSearchParams();
    if (opts.tier) q.set('tier', opts.tier);
    if (opts.trusted) q.set('trusted', 'true');
    if (opts.sort) q.set('sort', opts.sort);
    if (opts.limit) q.set('limit', String(opts.limit));
    const qs = q.toString();
    return api.get<StrategyBook>(`/strategies/catalog${qs ? `?${qs}` : ''}`);
  },
  /** One strategy in full: its curve, its distribution, its trades and the evidence behind its tier. */
  strategyDetail: (slug: string) =>
    api.get<StrategyDetail>(`/strategies/catalog/${encodeURIComponent(slug)}`),
  /** What a strategy can follow here, settleable or not — where nothing settles, a portfolio is watched over these. */
  watchable: () => api.get<TradableToken[]>('/market/watchable'),
  /**
   * The order this wallet's owner put their watchlist in, and saving it.
   *
   * A preference applied to `watchable`, never a copy of it — `markets/watchOrder.ts` holds both
   * halves of that rule: a saved symbol the executor no longer offers keeps its place rather than
   * being forgotten, and a newly watchable one appears rather than being hidden.
   */
  watchOrder: () => api.get<string[]>('/watchlist/order'),
  saveWatchOrder: (symbols: string[]) =>
    api.put<{ symbols: string[] }>('/watchlist/order', { symbols }),
  /**
   * One swap, placed now (PLAN.md 3.9). A refusal (409) or a failure (502, 503) carries the executor's own
   * sentence in its body, so it is returned for the screen to show rather than thrown as a status code.
   *
   * Keyed (FEATURES.md #29): the swap Confirm sends again after a timeout is the same swap, not a second one.
   */
  swap: async (body: SwapBody, write: Keyed): Promise<SwapOutcome> => {
    try {
      return await api.post<SwapOutcome>('/swap', body, write);
    } catch (e) {
      if (e instanceof ApiError && e.body && typeof e.body === 'object' && 'status' in e.body) {
        return e.body as SwapOutcome;
      }
      throw e;
    }
  },

  /* strategies */
  runs: (limit = 100) => api.get<StrategyRunRow[]>(`/runs?limit=${limit}`),
  disposals: () => api.get<Disposal[]>('/disposals'),
  metrics: () => api.get<Metrics>('/metrics'),
  earnings: (symbol: string) =>
    api.get<EarningsCalendar>(`/market/earnings?symbol=${encodeURIComponent(symbol)}`),
  observed: (symbol: string, hours = 720) =>
    api.get<ObservedHistory>(
      `/market/stocks/history?symbol=${encodeURIComponent(symbol)}&hours=${hours}`,
    ),
  flattenPreview: () => api.get<FlattenPreview>('/panic/preview'),
  stocks: () => api.get<StockRow[]>('/market/stocks'),
  /** The tokenized-equity catalog: every wrapped xStock, its sector, and what it costs (PLAN.md §8.4). */
  xstocks: () => api.get<XStockCatalog>('/market/xstocks'),
  /** What one xStock order costs, before it is placed: impact, tolerance and route, from Uniswap v3. */
  xstockQuote: (params: { symbol: string; side: 'buy' | 'sell'; usd: number; slippageBps?: number }) =>
    api.get<XStockQuote>(
      `/market/xstocks/quote?symbol=${encodeURIComponent(params.symbol)}&side=${params.side}&usd=${params.usd}` +
        (params.slippageBps === undefined ? '' : `&slippageBps=${params.slippageBps}`),
    ),
  symbols: () => api.get<string[]>('/market/symbols'),
  backtestStrategy: (body: {
    kind: 'dca' | 'grid';
    symbol: string;
    lookback: '30d' | '90d' | '6m' | '1y';
    params: Record<string, number>;
  }) => api.post<StrategyBacktest>('/strategies/backtest', body),
  proposals: () => api.get<ProposalRow[]>('/proposals'),
  notificationPrefs: () => api.get<NotificationPref[]>('/notifications/prefs'),
  /** The stop-all the executor enforces on every run, proposal and order (PLAN.md 2.14). */
  agentsStopped: () => api.get<AgentsStopped>('/agents/stopped'),
  stopAgents: () => api.post<AgentsStopped>('/agents/stop', {}),
  resumeAgents: () => api.post<AgentsStopped>('/agents/resume', {}),
  /** What the wallet was worth over time, from snapshots read on the chain (PLAN.md 2.10). */
  portfolioHistory: (range: '1D' | '1W' | '1M' | 'ALL') =>
    api.get<PortfolioHistory>(`/portfolio/history?range=${range}`),
  /**
   * What the SEC says each company does, for the allocation donut.
   *
   * A symbol maps to `null` when the regulator has no classification on record for it, or when the record could not be
   * read. Both mean "this build cannot say", and the chart draws that as Unclassified rather than guessing.
   */
  classification: (symbols: string[]) =>
    api.get<Record<string, SectorClassification | null>>(
      `/market/classification?symbols=${encodeURIComponent(symbols.join(','))}`,
    ),
  // POST: the executor registers GET and POST on this path, and the PATCH that was sent here 404'd, so a
  // toggle looked saved and was not (PLAN.md 2.12).
  setNotificationPref: (kind: string, enabled: boolean) =>
    api.post<{ ok: boolean; kind: string; enabled: boolean }>('/notifications/prefs', { kind, enabled }),
} as const;
