/**
 * What an xStock has paid its holders, derived from the multiplier (PLAN.md §8.4).
 *
 * Backed pays a dividend by auto-reinvesting it: the raw balance never moves, the Scaled UI
 * multiplier does, and every holder's displayed position grows by the same proportion. That makes
 * the multiplier the only dividend record this project has that nobody had to invent — no
 * calendar, no feed, no guess.
 *
 * ## Why a split cannot be counted as yield
 *
 * A split moves the multiplier too, and in the same direction. Counting it as income would report
 * a 4:1 split as 300% yield — a number that is arithmetically derived from real data and complete
 * nonsense, because a split hands the holder nothing. The two are distinguished by what they do to
 * value, which shows up in the SIZE of the step: a reinvested dividend accrues in fractions of a
 * percent, while a split is a discrete jump of tens of percent or more.
 *
 * That threshold is a judgement, so it is stated (`SPLIT_STEP`) rather than buried, and a step
 * above it is not silently dropped: it is returned as a listed corporate action with its factor
 * and date, excluded from the yield and said to be excluded. A reader can disagree with where the
 * line sits and still see everything that was set aside.
 *
 * ## Why an unmeasured period is not a zero
 *
 * Yield needs two observations to be a difference between. With fewer, there is no measurement —
 * and `0.00%` is a measurement, one that says the token paid nothing. So a window without enough
 * observations reports `unmeasured` with the reason, and the screen draws no line at all.
 */
import { query } from '../db/index.js';

/**
 * A single step above this is treated as a corporate action rather than income.
 *
 * Reinvested dividends move the multiplier by fractions of a percent; the smallest real split is
 * a 3:2, which is +50%. Ten percent sits far from both, so a misclassification would need a
 * dividend an order of magnitude larger than any equity pays, or a split smaller than any listed
 * company has done.
 */
export const SPLIT_STEP = 0.10;

export type MultiplierStep = {
  from: number;
  to: number;
  /** to / from. Above 1 is growth. */
  factor: number;
  at: string;
};

export type YieldWindow =
  | {
      status: 'measured';
      symbol: string;
      /** Growth from reinvested dividends over the window, as a fraction. 0.004 is 0.4%. */
      yieldFraction: number;
      /** The same annualised, or null where the window is too short to annualise honestly. */
      annualisedFraction: number | null;
      observations: number;
      from: string;
      to: string;
      days: number;
      /** Steps set aside as corporate actions, with the reason they were. */
      excluded: (MultiplierStep & { reason: string })[];
    }
  | { status: 'unmeasured'; symbol: string; reason: string };

/**
 * A window shorter than this is not annualised.
 *
 * Scaling four days of accrual up to a year multiplies both the signal and every bit of noise by
 * ninety, and prints a confident double-digit percentage out of a rounding difference.
 */
const MIN_DAYS_TO_ANNUALISE = 30;

export function stepsFrom(points: readonly { multiplier: number; at: string }[]): MultiplierStep[] {
  const steps: MultiplierStep[] = [];
  for (let i = 1; i < points.length; i++) {
    const from = points[i - 1]!.multiplier;
    const to = points[i]!.multiplier;
    if (!(from > 0) || !(to > 0)) continue;
    steps.push({ from, to, factor: to / from, at: points[i]!.at });
  }
  return steps;
}

/**
 * Compound the steps that look like income, and set aside the ones that look like a split.
 */
export function accrualFrom(steps: readonly MultiplierStep[]): {
  yieldFraction: number;
  excluded: (MultiplierStep & { reason: string })[];
} {
  let compounded = 1;
  const excluded: (MultiplierStep & { reason: string })[] = [];

  for (const step of steps) {
    const change = Math.abs(step.factor - 1);
    if (change >= SPLIT_STEP) {
      excluded.push({
        ...step,
        reason:
          step.factor > 1
            ? `A ${step.factor.toFixed(4)}x step is a split, not income: it hands a holder more tokens, each worth proportionally less.`
            : `A ${step.factor.toFixed(4)}x step is a reverse split, not a loss of income.`,
      });
      continue;
    }
    compounded *= step.factor;
  }

  return { yieldFraction: compounded - 1, excluded };
}

/**
 * What a token has paid, over the observations we hold for it.
 */
export async function dividendYield(params: {
  symbol: string;
  mint: string;
  sinceDays?: number;
}): Promise<YieldWindow> {
  const { symbol, mint, sinceDays = 365 } = params;

  const rows = await query<{ multiplier: string; observed_at: Date }>(
    `SELECT multiplier, observed_at FROM multiplier_observations
      WHERE mint = $1 AND observed_at >= now() - ($2 || ' days')::interval
      ORDER BY observed_at ASC`,
    [mint, String(sinceDays)],
  ).catch(() => []);

  const points = rows.map((r) => ({ multiplier: Number(r.multiplier), at: r.observed_at.toISOString() }));

  if (points.length < 2) {
    return {
      status: 'unmeasured',
      symbol,
      reason:
        points.length === 0
          ? 'No multiplier has been recorded for this token yet, so nothing can be measured.'
          : 'Only one multiplier reading is on record. A yield is the difference between two, so there is nothing to measure yet.',
    };
  }

  const from = points[0]!.at;
  const to = points[points.length - 1]!.at;
  const days = (Date.parse(to) - Date.parse(from)) / 86_400_000;
  const { yieldFraction, excluded } = accrualFrom(stepsFrom(points));

  return {
    status: 'measured',
    symbol,
    yieldFraction,
    annualisedFraction:
      days >= MIN_DAYS_TO_ANNUALISE ? (1 + yieldFraction) ** (365 / days) - 1 : null,
    observations: points.length,
    from,
    to,
    days,
    excluded,
  };
}
