/**
 * When a company next reports, from the regulator rather than from a vendor.
 *
 * Tier 7 positions around scheduled events and must be flat before the print, which needs a real
 * calendar. Every commercial earnings-calendar API wants a key this project does not have, and
 * inventing dates is the one thing the whole product refuses to do.
 *
 * SEC EDGAR answers it: free, no account, no key, and it is the authoritative record rather than
 * somebody's copy of it. A company announcing results files an **8-K with Item 2.02** ("Results of
 * Operations and Financial Condition") on the day it reports, so the filing history IS the past
 * earnings calendar, exactly dated.
 *
 * ## What this can and cannot know
 *
 * It knows every date a company HAS reported. It does not know the next one — EDGAR holds filings,
 * not schedules. So the next date is PROJECTED from the observed cadence, and every projection says
 * so, carries the filings it was derived from, and carries how far apart those filings actually
 * ran. A caller that treats a projection like a confirmed date is making a mistake this module
 * cannot prevent, but it can refuse to hide it.
 *
 * ## Two things the raw data will do to you
 *
 * **Not every Item 2.02 is an earnings print.** Tesla files one for quarterly deliveries as well,
 * so its raw gaps read `[20, 71, 20, 64, 26, 72]` and a median of those projects a date six weeks
 * wrong. Filings closer together than `SAME_QUARTER_DAYS` are one quarter's worth and only the
 * later survives; TSLA's gaps then read `[91, 84, 98, 91, 92]` like everyone else's.
 *
 * **Not every filer is quarterly.** A median outside the quarterly band is not a cadence, it is a
 * pattern this module does not understand, and the honest response is to project nothing.
 *
 * Verified against all eight tokenized equities: every one maps to a CIK from the SEC's own ticker
 * file and every one resolves to a 90–91 day median after deduplication.
 */
import { getJson } from '../http/get.js';

/**
 * SEC asks automated clients to identify themselves and will refuse traffic that does not. This is
 * a real address so a human at the SEC could actually reach someone about it, which is the point of
 * the requirement.
 */
const UA = { 'User-Agent': process.env.SEC_USER_AGENT ?? 'xorr (niveshgajengi@gmail.com)' };

/** Two Item 2.02 filings closer than this belong to the same quarter — deliveries, then results. */
const SAME_QUARTER_DAYS = 60;

/** A quarterly cadence, generously bounded. Outside it, this module does not claim to understand. */
const MIN_QUARTER_DAYS = 80;
const MAX_QUARTER_DAYS = 100;

/** How many past prints to reason from. Enough to see a cadence, recent enough to still describe it. */
const HISTORY = 8;

const DAY_MS = 86_400_000;

/** The regulator's own ticker→CIK file. Cached hard: it changes when companies list, not hourly. */
const TICKERS_URL = 'https://www.sec.gov/files/company_tickers.json';
const TICKERS_TTL_MS = 24 * 3_600_000;
const FILINGS_TTL_MS = 6 * 3_600_000;

export type EarningsCalendar = {
  symbol: string;
  cik: number;
  /** Past report dates, newest first, in UTC milliseconds. Observed, not derived. */
  reported: number[];
  /** The projected next report, or null when the cadence is not one this module recognises. */
  nextAt: number | null;
  /**
   * Days between consecutive reports, newest gap first. The caller's evidence for how much to
   * trust `nextAt` — and the input to the margin a projection deserves.
   */
  gapDays: number[];
  /** The median gap, which is what `nextAt` was projected with. */
  medianGapDays: number | null;
  /**
   * How wrong the projection could reasonably be, in days: the widest observed gap either side of
   * the median. Derived from the company's own filing record rather than a number anyone picked.
   */
  errorDays: number;
};

/**
 * `NVDAc` → `NVDA`, and `NVDAx` → `NVDA`. The lowercase suffix marks the tokenized form, not a
 * different company: `c` is the Base listing, `x` is the Solana one, and EDGAR files under neither.
 *
 * Lowercase only, deliberately. Real tickers are uppercase, so `SPY` survives and `SPYx` reduces;
 * matching an uppercase `X` would turn a company whose ticker genuinely ends in one into a company
 * that does not exist.
 */
export function underlyingTicker(symbol: string): string {
  return /[cx]$/.test(symbol) ? symbol.slice(0, -1).toUpperCase() : symbol.toUpperCase();
}

type TickerRow = { cik_str: number; ticker: string; title: string };

export async function cikFor(symbol: string): Promise<number | null> {
  const want = underlyingTicker(symbol);
  const rows = await getJson<Record<string, TickerRow>>(TICKERS_URL, TICKERS_TTL_MS, 20_000, UA);
  for (const row of Object.values(rows)) if (row.ticker === want) return row.cik_str;
  return null;
}

type Submissions = {
  /** The SEC's own industrial classification for the filer. Present on an operating company; absent on some trusts. */
  sic?: string;
  sicDescription?: string;
  filings: { recent: { form: string[]; filingDate: string[]; items?: string[] } };
};

/** What the regulator says a company does. */
export type SecClassification = {
  /** The four-digit Standard Industrial Classification code, as the SEC records it. */
  sic: string;
  /** The SEC's own wording for that code — e.g. "Semiconductors & Related Devices". */
  description: string;
};

/**
 * What sector a tokenized equity's underlying company is in, according to the SEC.
 *
 * The regulator, not a vendor and not us. Every alternative was worse: a commercial sector API wants a key this project
 * does not have, and a mapping typed out by hand is a developer's opinion about a company dressed as data — which is the
 * one thing this product refuses to do everywhere else and must not start doing on a chart.
 *
 * It costs no extra request. `reportDates` already fetches and caches this exact document per CIK for the earnings
 * calendar; `sicDescription` is sitting at the top of it, and has been the whole time.
 *
 * **Null is a real answer**, and callers must keep it as one. A filer with no SIC on record — some trusts, including
 * index ETFs, genuinely have none — is unclassified, and unclassified is a thing the donut draws and labels rather than
 * something it guesses its way out of.
 */
export async function classificationFor(symbol: string): Promise<SecClassification | null> {
  const cik = await cikFor(symbol);
  if (cik === null) return null;
  const url = `https://data.sec.gov/submissions/CIK${String(cik).padStart(10, '0')}.json`;
  const data = await getJson<Submissions>(url, FILINGS_TTL_MS, 20_000, UA).catch(() => null);
  const sic = data?.sic?.trim();
  const description = data?.sicDescription?.trim();
  if (!sic || !description) return null;
  return { sic, description };
}

const median = (xs: number[]): number => {
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m]! : Math.round((s[m - 1]! + s[m]!) / 2);
};

/**
 * The dates a company actually announced results, newest first.
 *
 * Deduplicated by `SAME_QUARTER_DAYS`, because a single quarter can carry more than one Item 2.02
 * and counting both turns a quarterly cadence into a fortnightly one.
 */
export async function reportDates(cik: number): Promise<number[]> {
  const url = `https://data.sec.gov/submissions/CIK${String(cik).padStart(10, '0')}.json`;
  const data = await getJson<Submissions>(url, FILINGS_TTL_MS, 20_000, UA);
  const { form, filingDate, items = [] } = data.filings.recent;

  const all: number[] = [];
  for (let i = 0; i < form.length; i += 1) {
    if (form[i] !== '8-K') continue;
    if (!(items[i] ?? '').includes('2.02')) continue;
    const t = Date.parse(`${filingDate[i]}T00:00:00Z`);
    if (Number.isFinite(t)) all.push(t);
  }
  all.sort((a, b) => b - a);

  const kept: number[] = [];
  for (const t of all) {
    if (kept.length === 0 || (kept[kept.length - 1]! - t) / DAY_MS >= SAME_QUARTER_DAYS) kept.push(t);
    if (kept.length === HISTORY) break;
  }
  return kept;
}

/**
 * The calendar for one symbol.
 *
 * `nextAt` is null whenever this module cannot honestly project: too little history, or a cadence
 * that is not quarterly. Null is a real answer here — tier 7 stands down on it rather than guessing,
 * which is the correct behaviour for a strategy whose whole promise is about a date.
 */
export async function earningsCalendar(symbol: string): Promise<EarningsCalendar | null> {
  const cik = await cikFor(symbol);
  if (cik === null) return null;

  const reported = await reportDates(cik);
  if (reported.length < 3) {
    return { symbol, cik, reported, nextAt: null, gapDays: [], medianGapDays: null, errorDays: 0 };
  }

  const gapDays = reported.slice(0, -1).map((t, i) => Math.round((t - reported[i + 1]!) / DAY_MS));
  const med = median(gapDays);
  const quarterly = med >= MIN_QUARTER_DAYS && med <= MAX_QUARTER_DAYS;

  // The widest miss the company's own record would have produced, either side of the median.
  const errorDays = Math.max(...gapDays.map((g) => Math.abs(g - med)));

  return {
    symbol,
    cik,
    reported,
    gapDays,
    medianGapDays: med,
    errorDays,
    nextAt: quarterly ? reported[0]! + med * DAY_MS : null,
  };
}
