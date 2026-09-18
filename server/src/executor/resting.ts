/**
 * Resting price levels, restated for whatever the issuer has done to the token since.
 *
 * The scaling itself lives in `multiplier-adjust.ts`; this is the part that knows where a
 * multiplier comes from. A symbol that is not an xStock has no multiplier and needs no adjustment,
 * and saying so explicitly keeps every non-xStock strategy on exactly the path it had before.
 */
import { XSTOCKS, xStockKey } from '../venues/xstocks.js';
import { readMintScale } from '../solana/balances.js';
import { adjustLevels, type AdjustedLevels, type MultiplierBasis } from './multiplier-adjust.js';

export type { MultiplierBasis };

export async function restingLevels(params: {
  symbol: string;
  levels: Record<string, number>;
  storedBasis?: MultiplierBasis | null;
  levelSetAt: Date;
}): Promise<AdjustedLevels> {
  const token = XSTOCKS[xStockKey(params.symbol) ?? params.symbol];

  /*
   * Not an xStock: nothing can rescale it, so the stored levels are already current. Returning a
   * factor of 1 rather than a special case keeps the caller's code identical for both.
   */
  if (!token) {
    return {
      status: 'ok',
      levels: params.levels,
      factor: 1,
      adjusted: false,
      basis: { multiplier: 1, recordedAt: new Date(0).toISOString() },
      currentMultiplier: 1,
    };
  }

  let currentMultiplier: number | null = null;
  try {
    currentMultiplier = (await readMintScale(token.address)).multiplier;
  } catch {
    // Left null: `adjustLevels` turns an unreadable multiplier into `unsafe`, which does not fire.
    currentMultiplier = null;
  }

  return adjustLevels({
    levels: params.levels,
    storedBasis: params.storedBasis,
    mint: token.address,
    levelSetAt: params.levelSetAt,
    currentMultiplier,
  });
}
