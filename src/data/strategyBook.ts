/**
 * The measured strategy book, as the app reads it.
 *
 * 313 rules replayed over two years of hourly candles on a nine-symbol portfolio, split in half: the first
 * half is what each rule was shaped against, the second is data it had never seen. The app headlines the
 * unseen half — a rule that only works on the half it was fitted to should look like one.
 *
 * Every optional field here is optional on purpose. A strategy that took no trades has no win rate and no
 * profit factor, and the executor sends nothing rather than a zero; the screens draw a dash. A zero would
 * assert a result that was never measured, which is the one thing this app does not do.
 */

/** What the numbers were measured over. Shown on screen, because a return without it has no units. */
export type BookWindow = {
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

export type StrategyTier = 'verified' | 'measured' | 'archive';

export type StrategyRow = {
  slug: string;
  tier: StrategyTier;
  /** Enough unseen trades for the return to carry a usable confidence interval. */
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
  spark: number[];
};

export type BookCounts = {
  total: number;
  verified: number;
  measured: number;
  archive: number;
  trusted: number;
  traded: number;
};

export type StrategyBook = { window: BookWindow; counts: BookCounts; rows: StrategyRow[] };

/** One half's measurement. `trades: 0` arrives with almost nothing else, and that is the honest shape. */
export type HalfSummary = {
  half: 'known' | 'unseen';
  trades: number;
  wins?: number;
  returnPct: number | null;
  maxDrawdownPct?: number | null;
  sharpe?: number | null;
  winRate?: number | null;
  expectancyR?: number | null;
  profitFactor?: number | null;
  feesUsd?: number | null;
  finalEquity?: number | null;
};

/** The four-way gauntlet: out-of-sample, a parameter sweep, doubled cost, and a second universe. */
export type Evidence = {
  btcKnown: Record<string, number> | null;
  btcUnseen: Record<string, number> | null;
  portfolioKnown: Record<string, number> | null;
  portfolioUnseen: Record<string, number> | null;
  /** "5/5" — of five parameter settings, how many stayed positive. */
  sensitivityPassed: string | null;
  sensitivityDetail: number[] | null;
  doubleCostExpectancyR: number | null;
  doubleCostReturnPct: number | null;
  crossAsset: Record<string, number> | null;
  survives: boolean | null;
  failedOn: string[] | null;
};

export type BookTrade = {
  symbol: string;
  side: string;
  openedAt: string | null;
  closedAt: string | null;
  entry: number | null;
  exit: number | null;
  bars: number | null;
  /** The account's own result for the trade: gross less every cost, entry fee included. */
  pnlUsd: number | null;
  grossUsd: number | null;
  feesUsd: number | null;
  pnlPct: number | null;
  r: number | null;
  runupR: number | null;
  drawdownR: number | null;
  reason: string | null;
};

export type SideSplit = {
  trades: number;
  netPnlUsd: number;
  winRate: number | null;
  profitFactor: number | null;
};

/** Gross, costs and net — three numbers that add to the fourth, by construction. */
export type ProfitStructure = {
  grossProfitUsd: number;
  grossLossUsd: number;
  commissionUsd: number;
  netPnlUsd: number;
};

export type StrategyDetail = {
  slug: string;
  doc: string;
  tier: StrategyTier;
  trusted: boolean;
  trustedMinTrades: number;
  evidence: Evidence | null;
  window: BookWindow;
  unseen: HalfSummary;
  known: HalfSummary;
  equityCurve: number[];
  knownEquityCurve: number[];
  distribution: { from: number; to: number; count: number }[];
  sides: { long?: SideSplit; short?: SideSplit };
  structure: ProfitStructure | null;
  extremes: { bestTradePct: number | null; worstTradePct: number | null; avgBarsInTrade: number | null } | null;
  tradesShown: number;
  tradesTotal: number;
  trades: BookTrade[];
};

export type BookSort = 'return' | 'sharpe' | 'trades' | 'drawdown' | 'winRate';

/** What each tier claims, in the words the screen uses. Nothing here is a grade we invented. */
export const TIER_MEANS: Record<StrategyTier, string> = {
  verified: 'Passed all four: unseen data, a parameter sweep, doubled cost, and a second universe.',
  measured: 'Measured positive on data it had never seen — without the full four-way evidence behind it.',
  archive: 'Measured, and it did not hold up. Kept so the book is the whole book.',
};

/**
 * Whether the gauntlet measured anything at all.
 *
 * A strategy the gauntlet never saw trade still comes back with a full set of numbers — every one of them the zero the
 * engine starts from: "Commission doubled +0.00%", "Held up on ETH 0.0000 R", "0/5 stayed positive", and a verdict
 * built from them ("a small change to its settings broke it, and the edge disappears at double the cost"). None of that
 * was measured; there was nothing to measure. Only a trade makes the four tests mean something, so a strategy with none,
 * on either half, on BTC or across the portfolio, reports none of them.
 */
export function gauntletTraded(evidence: Evidence | null | undefined): boolean {
  if (!evidence) return false;
  const legs = [evidence.btcKnown, evidence.btcUnseen, evidence.portfolioKnown, evidence.portfolioUnseen];
  return legs.some((leg) => Number(leg?.trades ?? 0) > 0);
}
