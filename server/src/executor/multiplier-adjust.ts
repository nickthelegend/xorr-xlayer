/**
 * Keeping a resting price level meaning what it meant, across a split (PLAN.md §8.4).
 *
 * Exit levels — an entry price, a trailing peak — are stored in USD per DISPLAYED token. For an
 * xStock that is not a fixed unit: Token-2022's Scaled UI Amount extension is how Backed expresses
 * a split or an auto-reinvested dividend, and when the multiplier moves, the same holding is
 * suddenly a different number of displayed tokens, each worth proportionally less.
 *
 * Left alone that is not a rounding problem, it is a liquidation. A position entered at $200 with a
 * 10% stop, through a 4:1 split, sees a mark of about $50 against a stored entry of $200 — a 75%
 * fall that never happened — and the stop fires at once. Every stop on every holder of that token
 * would trigger on the same block.
 *
 * So a level is stored with the multiplier it was set under, and read back scaled by how the
 * multiplier has moved since:
 *
 *     level_now = level_then * (multiplier_then / multiplier_now)
 *
 * which is exactly the factor by which a displayed token's worth has changed.
 *
 * Where the basis cannot be established the answer is `unsafe`, and an unsafe level must not fire.
 * A stop that cannot be trusted is cancelled and explained; a stop that fires at the wrong level
 * sells someone's position for no reason.
 */
import { query } from '../db/index.js';

/** The multiplier a price level was recorded under. */
export type MultiplierBasis = { multiplier: number; recordedAt: string };

export type BasisResolution =
  | { status: 'known'; basis: MultiplierBasis }
  /** No basis was stored, but our own observations show the multiplier has not moved since. */
  | { status: 'adopted'; basis: MultiplierBasis }
  /** We cannot tell whether a split has happened since the level was set. */
  | { status: 'unsafe'; reason: string };

export type AdjustedLevels =
  | {
      status: 'ok';
      /** Levels restated in today's displayed-price terms. */
      levels: Record<string, number>;
      /** The factor applied. 1 when nothing has moved. */
      factor: number;
      /** True when the multiplier actually changed and levels were restated. */
      adjusted: boolean;
      basis: MultiplierBasis;
      /** The multiplier the returned levels are expressed in — the basis for any rewrite. */
      currentMultiplier: number;
    }
  | { status: 'unsafe'; reason: string };

/**
 * Restate a price level from the multiplier it was set under to today's.
 *
 * A split raises the multiplier and lowers what one displayed token is worth, so the level falls
 * by the same factor and continues to mean the same money.
 */
export function adjustLevel(level: number, basisMultiplier: number, currentMultiplier: number): number {
  if (!(basisMultiplier > 0) || !(currentMultiplier > 0)) {
    throw new Error('A multiplier must be positive to scale a price level.');
  }
  return level * (basisMultiplier / currentMultiplier);
}

/**
 * What multiplier a strategy's levels were set under.
 *
 * A stored basis is taken at its word. Without one we fall back to our own recorded observations
 * (migration 030): if the earliest multiplier we ever saw for this mint is the one in force now,
 * then nothing has moved while we have been watching, and today's value is a safe basis. If our
 * observations begin after the level was set, they cannot rule out a split in the gap, and the
 * honest answer is that we do not know.
 */
export async function resolveBasis(params: {
  storedBasis?: MultiplierBasis | null;
  mint: string;
  levelSetAt: Date;
  currentMultiplier: number;
}): Promise<BasisResolution> {
  const { storedBasis, mint, levelSetAt, currentMultiplier } = params;

  if (storedBasis && storedBasis.multiplier > 0) {
    return { status: 'known', basis: storedBasis };
  }
  if (!(currentMultiplier > 0)) {
    return { status: 'unsafe', reason: 'The token’s current multiplier could not be read.' };
  }

  const rows = await query<{ multiplier: string; observed_at: Date }>(
    `SELECT multiplier, observed_at FROM multiplier_observations
      WHERE mint = $1 ORDER BY observed_at ASC LIMIT 1`,
    [mint],
  ).catch(() => []);

  const earliest = rows[0];
  if (!earliest) {
    return {
      status: 'unsafe',
      reason:
        'This level was set before we recorded any multiplier for this token, so a split since then cannot be ruled out.',
    };
  }
  if (earliest.observed_at.getTime() > levelSetAt.getTime()) {
    return {
      status: 'unsafe',
      reason:
        'Our multiplier history for this token begins after this level was set, so a split in between cannot be ruled out.',
    };
  }
  if (Number(earliest.multiplier) !== currentMultiplier) {
    // We have watched the whole period and the multiplier HAS moved; the earliest value is the basis.
    return {
      status: 'adopted',
      basis: { multiplier: Number(earliest.multiplier), recordedAt: earliest.observed_at.toISOString() },
    };
  }
  return {
    status: 'adopted',
    basis: { multiplier: currentMultiplier, recordedAt: earliest.observed_at.toISOString() },
  };
}

/**
 * Restate a strategy's price levels for today's multiplier, or refuse.
 *
 * `levels` in and out are USD per displayed token. Anything non-finite or non-positive is left
 * untouched — a zero entry price means "not set", and scaling it would invent a level.
 */
export async function adjustLevels(params: {
  levels: Record<string, number>;
  storedBasis?: MultiplierBasis | null;
  mint: string;
  levelSetAt: Date;
  currentMultiplier: number | null;
}): Promise<AdjustedLevels> {
  const { levels, storedBasis, mint, levelSetAt, currentMultiplier } = params;

  if (currentMultiplier === null || !(currentMultiplier > 0)) {
    return {
      status: 'unsafe',
      reason:
        'The token’s scaled-UI multiplier could not be read, so a resting level cannot be trusted to still mean what it did.',
    };
  }

  const resolved = await resolveBasis({ storedBasis, mint, levelSetAt, currentMultiplier });
  if (resolved.status === 'unsafe') return resolved;

  const factor = resolved.basis.multiplier / currentMultiplier;
  if (!Number.isFinite(factor) || factor <= 0) {
    return { status: 'unsafe', reason: 'The multiplier change does not produce a usable adjustment.' };
  }

  const out: Record<string, number> = {};
  for (const [key, value] of Object.entries(levels)) {
    out[key] = Number.isFinite(value) && value > 0 ? value * factor : value;
  }

  return {
    status: 'ok',
    levels: out,
    factor,
    // Floats: a multiplier read twice from the same mint can differ in the last bit.
    adjusted: Math.abs(factor - 1) > 1e-12,
    basis: resolved.basis,
    currentMultiplier,
  };
}

/** The sentence a user should see when a resting level had to be restated. */
export function adjustmentNote(symbol: string, factor: number): string {
  const direction = factor < 1 ? 'split' : 'reverse split';
  return `${symbol} went through a ${direction}, so your resting levels were rescaled by ${factor.toFixed(
    6,
  )} to keep meaning the same money.`;
}
