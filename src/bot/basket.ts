/**
 * The target basket, and how far it has drifted, as the app talks about it.
 *
 * Drift is in percentage POINTS of the basket: a sleeve targeted at 40% sitting at 46% has drifted
 * 6, whatever the basket is worth. That is the unit the band is expressed in, so "act at 5%" means
 * the same thing on a $200 basket and a $20,000 one, and the screen must not quietly re-express it
 * as a percentage OF the target — which would make the same sleeve read as 15% out.
 */
import { MINUS } from '@/format';

export type Sleeve = {
  symbol: string;
  targetPct: number;
  units: number;
  /** Null when nothing could price it. Not zero — see `unpricedNote`. */
  usd: number | null;
  actualPct: number | null;
  driftPct: number | null;
};

export type BasketState =
  | { configured: false; targets: Record<string, number>; bandPct: number; cadence: string; enabled: boolean }
  | {
      configured: true;
      targets: Record<string, number>;
      bandPct: number;
      cadence: string;
      enabled: boolean;
      sleeves: Sleeve[];
      totalUsd: number;
      unpriced: string[];
    };

export type BasketRun = {
  id: string;
  periodKey: string;
  status: 'pending' | 'filled' | 'failed' | 'skipped';
  symbol: string | null;
  side: 'buy' | 'sell' | null;
  usd: number | null;
  driftPct: number | null;
  detail: string;
  signature: string | null;
  at: string;
};

/** `+6.0` / `−6.0`, with a real minus sign. Zero carries no sign at all. */
export function driftText(driftPct: number): string {
  const body = Math.abs(driftPct).toFixed(1);
  if (Math.abs(driftPct) < 0.05) return body;
  return driftPct > 0 ? `+${body}` : `${MINUS}${body}`;
}

/** A weight as the screen shows it: one decimal, because a basket is set in whole points. */
export function weightText(pct: number): string {
  return `${pct.toFixed(1)}%`;
}

/** Is this sleeve past the band, and therefore the one the next run would act on? */
export function outOfBand(sleeve: Sleeve, bandPct: number): boolean {
  return sleeve.driftPct !== null && Math.abs(sleeve.driftPct) >= bandPct;
}

/**
 * The sleeve the next rebalance would trade, or null.
 *
 * Mirrors the planner: the largest absolute drift, and only if it is past the band. Shown so the
 * screen can say what is about to happen rather than leaving someone to compare eight rows — and
 * it is deliberately the same rule, not an approximation of it.
 */
export function nextLeg(sleeves: Sleeve[], bandPct: number): Sleeve | null {
  let worst: Sleeve | null = null;
  for (const s of sleeves) {
    if (s.driftPct === null) continue;
    if (!worst || Math.abs(s.driftPct) > Math.abs(worst.driftPct ?? 0)) worst = s;
  }
  return worst && outOfBand(worst, bandPct) ? worst : null;
}

/**
 * What the next rebalance will do, in one sentence.
 *
 * Composed here rather than in the screen so the wording is testable and so the screen layer holds
 * no number formatting — `qa/audit.test.ts` enforces the second part, and it is right to: a
 * `toFixed` in a screen is a number nobody can write a test around.
 *
 * The three cases are genuinely different answers, not one answer with blanks. Unpriced means the
 * weights are unknowable; in-band means it looked and chose not to act; a leg means it will trade.
 */
export function nextRebalanceSentence(
  sleeves: Sleeve[],
  bandPct: number,
  unpriced: string[],
): string {
  if (unpriced.length > 0) return 'Nothing will be rebalanced until every sleeve can be priced.';

  const leg = nextLeg(sleeves, bandPct);
  if (!leg || leg.driftPct === null) {
    return `Every sleeve is inside the ${bandPct}-point band, so the next run will not trade.`;
  }

  const side = leg.driftPct > 0 ? 'sell' : 'buy';
  const points = Math.abs(leg.driftPct).toFixed(1);
  return `Next rebalance: ${side} ${leg.symbol}, which is ${points} points off its ${leg.targetPct}% target.`;
}

/**
 * What to say when a sleeve could not be priced, or null when they all could.
 *
 * This is the sentence that keeps the screen honest. An unpriceable sleeve is not worth zero, so
 * none of the percentages on the screen mean anything while one is missing — and the basket will
 * not be rebalanced either, for the same reason.
 */
export function unpricedNote(unpriced: string[]): string | null {
  if (unpriced.length === 0) return null;
  const names = unpriced.join(', ');
  const isAre = unpriced.length === 1 ? 'is' : 'are';
  return `${names} ${isAre} unpriced right now, so the weights below cannot be worked out and nothing will be rebalanced until ${unpriced.length === 1 ? 'it' : 'they'} can be.`;
}
