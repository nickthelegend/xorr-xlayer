/**
 * The strategy book — 313 rules, measured, with the evidence attached.
 *
 * These come from the research engine that preceded this app (`xorr/backend`), where every registered
 * strategy was replayed over two years of hourly candles on a nine-symbol portfolio, split in half: the
 * first half is the data the rule was shaped against, the second is data it had never seen. The second
 * half is what the app headlines, because a rule that only works on the half it was fitted to should look
 * like one.
 *
 * `backtest/export_catalog.py` in that repo regenerates `data/strategies/`. It writes one small index and
 * one detail file per strategy, so opening a strategy does not mean loading the book.
 *
 * Three things this refuses to do, all of them the same rule the rest of this server follows:
 *
 *   - It does not invent a field. A strategy that took no trades on the unseen half has no win rate and no
 *     profit factor — absent, never zero. A zero asserts a result; an absent key says "not measured".
 *   - It does not headline a number without saying how much weight it carries. Below 30 unseen trades the
 *     return is real and the confidence interval around it is wide, so the row is marked `trusted: false`
 *     — the rule the research repo's own ranking states as "ranked, not trusted".
 *   - It does not promote on opinion. `verified` means the four-way gauntlet passed: out-of-sample, a
 *     parameter sweep, doubled commission, and a second universe. Everything else is `measured` or
 *     `archive`, derived from what was recorded.
 */
import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
/** `server/data/strategies`, from `server/src/strategies`. */
const ROOT = resolve(HERE, '..', '..', 'data', 'strategies');

export type Tier = 'verified' | 'measured' | 'archive';

export type CatalogWindow = {
  bars: number;
  barsUnseen: number;
  interval: string;
  days: number;
  firstBar: string | null;
  lastBar: string | null;
  symbols: string[];
  feeBpsPerSide: number;
  sizingPct: number;
  leverage: number;
  startEquity: number;
};

export type CatalogRow = {
  slug: string;
  tier: Tier;
  trusted: boolean;
  survives: boolean;
  sensitivityPassed: string | null;
  trades: number;
  returnPct: number | null;
  maxDrawdownPct?: number | null;
  sharpe?: number | null;
  winRate?: number | null;
  profitFactor?: number | null;
  expectancyR?: number | null;
  knownReturnPct?: number | null;
  /** A 24-point sketch of the unseen-half curve, for the row. */
  spark: number[];
};

export type CatalogIndex = { window: CatalogWindow; strategies: CatalogRow[] };

let index: Promise<CatalogIndex> | undefined;
const details = new Map<string, Promise<unknown>>();

/** The book's index, read once. 112 KB — small enough to hold, too big to re-read per request. */
export function catalogIndex(): Promise<CatalogIndex> {
  index ??= readFile(join(ROOT, 'index.json'), 'utf8').then((raw) => JSON.parse(raw) as CatalogIndex);
  return index;
}

/** A slug that could name a file here, and nothing that could name a file anywhere else. */
export function isSlug(slug: string): boolean {
  return /^[a-z0-9][a-z0-9_]{0,63}$/.test(slug);
}

/**
 * One strategy in full, or undefined when the book does not have it.
 *
 * Cached per slug: the files never change while the process lives — they are committed data, not state —
 * and a detail file is up to 200 KB of trades.
 */
export function catalogDetail(slug: string): Promise<unknown> | undefined {
  if (!isSlug(slug)) return undefined;
  const hit = details.get(slug);
  if (hit) return hit;
  const run = readFile(join(ROOT, 'detail', `${slug}.json`), 'utf8')
    .then((raw) => JSON.parse(raw) as unknown)
    .catch(() => undefined);
  details.set(slug, run);
  return run;
}

/** How the list may be ordered. Every one of these is a measured column, never a rank we assigned. */
export const SORTS = ['return', 'sharpe', 'trades', 'drawdown', 'winRate'] as const;
export type Sort = (typeof SORTS)[number];

const KEY: Record<Sort, keyof CatalogRow> = {
  return: 'returnPct',
  sharpe: 'sharpe',
  trades: 'trades',
  drawdown: 'maxDrawdownPct',
  winRate: 'winRate',
};

/**
 * The rows a request asked for.
 *
 * Unmeasured sorts last, always. A strategy with no Sharpe is not the worst Sharpe in the book — it has
 * none — and sorting it as if it were zero would seat it in the middle of the list as though it had been
 * measured there.
 */
export function selectRows(
  rows: CatalogRow[],
  opts: { tier?: Tier; trustedOnly?: boolean; sort?: Sort; limit?: number },
): CatalogRow[] {
  let out = rows;
  if (opts.tier) out = out.filter((r) => r.tier === opts.tier);
  if (opts.trustedOnly) out = out.filter((r) => r.trusted);

  const key = KEY[opts.sort ?? 'return'];
  const asc = (opts.sort ?? 'return') === 'drawdown';
  out = [...out].sort((a, b) => {
    const x = a[key] as number | null | undefined;
    const y = b[key] as number | null | undefined;
    const xs = typeof x === 'number' && Number.isFinite(x);
    const ys = typeof y === 'number' && Number.isFinite(y);
    if (!xs && !ys) return a.slug.localeCompare(b.slug);
    if (!xs) return 1;
    if (!ys) return -1;
    return asc ? (x as number) - (y as number) : (y as number) - (x as number);
  });
  return opts.limit && opts.limit > 0 ? out.slice(0, opts.limit) : out;
}

/** What the tab shows above the list: how big the book is, and how much of it is worth trusting. */
export function counts(rows: CatalogRow[]) {
  return {
    total: rows.length,
    verified: rows.filter((r) => r.tier === 'verified').length,
    measured: rows.filter((r) => r.tier === 'measured').length,
    archive: rows.filter((r) => r.tier === 'archive').length,
    trusted: rows.filter((r) => r.trusted).length,
    traded: rows.filter((r) => r.trades > 0).length,
  };
}
