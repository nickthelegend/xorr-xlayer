/**
 * profitClose.ts — what a close actually realised, and whether that can be said at all.
 *
 * Closing a position said "Sold 0.0412 WETH for $104.20" and stopped there. The one thing the person wants to know —
 * *did I make anything* — was left for them to work out against a cost basis they cannot see.
 *
 * ## The arithmetic is two recorded numbers, and nothing else
 *
 * Proceeds come from the executor's answer to this close. The cost comes from the position's own average entry, which
 * `Position.entry` documents as being from real fills. Realised is the difference. Nothing is estimated and nothing is
 * projected: the `unrealised × fraction` figure the screen shows *before* a close is a forecast against a live mark, and
 * it is deliberately not what is reported afterwards.
 *
 * ## When it refuses to say
 *
 * A moment that celebrates is worth nothing unless it is capable of staying silent, so there are four ways this stays
 * silent and each names itself:
 *
 *   **Replayed.** The executor recognised the idempotency key and handed back an earlier attempt's result. Nothing was
 *   sold by this tap, and a gain announced for a sale that did not happen twice is the sentence that makes someone
 *   believe they sold twice.
 *
 *   **No basis.** An entry price of zero or missing is not a cost of nothing — it is a cost nobody recorded. Treating
 *   it as zero would turn every proceed into pure profit, which is the most flattering possible lie.
 *
 *   **Incomplete basis.** The executor already tells us when a symbol's cost basis has gaps (`basisIncomplete`). A
 *   number derived from an admittedly partial basis is a number with an unknown error bar, and this is not the surface
 *   to put one on.
 *
 *   **Nothing sold.** Zero units closed realises nothing, whatever the proceeds field says.
 */

/** Everything needed to say what a close realised. Every field comes from a recorded answer. */
export type CloseOutcome = {
  /** What the executor said came back, in USD. */
  proceedsUsd: number;
  /** How many units it sold. */
  units: number;
  /** The position's average cost per unit, from real fills. Undefined where none was recorded. */
  entryPrice: number | undefined;
  /** The executor's own warning that this symbol's cost basis has gaps. */
  basisIncomplete?: boolean;
  /** This answer belonged to an earlier attempt: nothing was sold by this tap. */
  replayed?: boolean;
};

export type ProfitClose =
  | { kind: 'profit'; realisedUsd: number; pct: number }
  | { kind: 'loss'; realisedUsd: number; pct: number }
  /** Measured, and it came out level. Not a win, and the moment does not pretend otherwise. */
  | { kind: 'flat'; realisedUsd: number }
  | { kind: 'unmeasured'; why: 'replayed' | 'no-basis' | 'incomplete-basis' | 'nothing-sold' };

/**
 * Below this, a realised figure is level rather than a gain or a loss.
 *
 * The same rule `pnlTone` keeps: judged at the precision the figure is printed to, so a close that rounds to $0.00 is
 * never coloured as a win. A cent of profit dressed as a moment is a moment nobody believes twice.
 */
const FLAT_BELOW_USD = 0.005;

function usable(n: number | undefined): n is number {
  return typeof n === 'number' && Number.isFinite(n);
}

/**
 * What a close realised, or why that cannot be said.
 *
 * The refusals are checked before the arithmetic, in the order that matters: a replayed close is not measured at all,
 * whatever basis exists for it.
 */
export function profitClose(outcome: CloseOutcome): ProfitClose {
  if (outcome.replayed) return { kind: 'unmeasured', why: 'replayed' };
  if (!usable(outcome.units) || outcome.units <= 0) return { kind: 'unmeasured', why: 'nothing-sold' };
  if (outcome.basisIncomplete) return { kind: 'unmeasured', why: 'incomplete-basis' };
  // Zero is not a cost of nothing; it is a cost nobody recorded, and treating it as free makes every sale a profit.
  if (!usable(outcome.entryPrice) || outcome.entryPrice <= 0) return { kind: 'unmeasured', why: 'no-basis' };
  if (!usable(outcome.proceedsUsd)) return { kind: 'unmeasured', why: 'no-basis' };

  const cost = outcome.units * outcome.entryPrice;
  if (!Number.isFinite(cost) || cost <= 0) return { kind: 'unmeasured', why: 'no-basis' };

  const realisedUsd = outcome.proceedsUsd - cost;
  if (Math.abs(realisedUsd) < FLAT_BELOW_USD) return { kind: 'flat', realisedUsd };
  const pct = (realisedUsd / cost) * 100;
  return realisedUsd > 0 ? { kind: 'profit', realisedUsd, pct } : { kind: 'loss', realisedUsd, pct };
}

/** Why a close could not be measured, in words. Each says what is missing rather than that something went wrong. */
export const UNMEASURED_REASON: Readonly<Record<Extract<ProfitClose, { kind: 'unmeasured' }>['why'], string>> = {
  replayed: 'This answer was from an earlier attempt, so nothing was sold just now.',
  'no-basis': 'What these units originally cost was not recorded, so the gain on them can’t be worked out.',
  'incomplete-basis': 'The cost basis for this holding has gaps, so the gain on this sale can’t be stated exactly.',
  'nothing-sold': 'No units were sold.',
};
