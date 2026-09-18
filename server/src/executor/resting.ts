/**
 * Resting price levels, restated for whatever the issuer has done to the token since.
 *
 * The scaling itself lives in `multiplier-adjust.ts`; this is the part that knows what unit a
 * level is in and whether a multiplier move changes it. A symbol that is not an xStock has no
 * multiplier and needs no adjustment, and saying so explicitly keeps every non-xStock strategy on
 * exactly the path it had before.
 *
 * ## Why a wrapped xStock needs no restatement on X Layer (P2.6)
 *
 * On Solana the position WAS the Token-2022 mint, priced per displayed (scaled) token. A 4:1 split
 * quartered what one displayed token was worth, so a stored $200 entry had to become $50 or every
 * stop on the token fired at once — hence `level * (m_then / m_now)`.
 *
 * On X Layer the executor trades, holds and prices the ERC-4626 WRAPPER (`XSTOCKS[s].address`;
 * `priceOf` quotes USDC → wrapper). One wrapper share is a fixed number of raw shares, and
 * `convertToAssets(1e18)` — the multiplier — is how many displayed raw tokens that is. So a wrapper
 * share is worth `multiplier × price per raw token`. Across a split both move by the same factor in
 * opposite directions; across a reinvested dividend the multiplier grows as the raw price goes
 * ex-dividend. Either way the wrapper's own price is continuous, and so is every level set against
 * it. Expressed in `multiplier-adjust.ts` terms: convert the wrapper level to raw terms
 * (`÷ m_then`), restate it (`× m_then / m_now`), convert back (`× m_now`) — the factor is exactly 1.
 *
 * Applying the Solana factor here would be the bug it once prevented, inverted: after a 2:1 split a
 * 10%-below stop at $180 on a $200 wrapper would move to $90, and a real 50% fall would not trigger
 * it. So wrapper levels pass through at factor 1, and they do not depend on reading the multiplier
 * at all — which also means an RPC blip on the raw token cannot cancel a stop.
 *
 * The factor-1 multiplier returned here is the wrapper's multiplier against itself, which is 1 by
 * definition, not a stand-in for an unread raw multiplier; `adjusted` is false, so the planner never
 * rewrites a stored basis from it.
 */
import { XSTOCKS, xStockKey } from '../venues/xstocks.js';
import type { AdjustedLevels, MultiplierBasis } from './multiplier-adjust.js';

export type { MultiplierBasis };

export async function restingLevels(params: {
  symbol: string;
  levels: Record<string, number>;
  storedBasis?: MultiplierBasis | null;
  levelSetAt: Date;
}): Promise<AdjustedLevels> {
  /*
   * Not an xStock: nothing can rescale it. A wrapped xStock: levels are USD per wrapper share,
   * which no split or reinvested dividend restates (see the header). Both are already current, and
   * returning a factor of 1 rather than a special case keeps the caller's code identical for all.
   * `isWrappedXStock` is computed only to keep that distinction visible where a later unit change
   * (a strategy priced in raw tokens) would have to branch.
   */
  const isWrappedXStock = XSTOCKS[xStockKey(params.symbol) ?? params.symbol] !== undefined;
  return {
    status: 'ok',
    levels: params.levels,
    factor: 1,
    adjusted: false,
    basis: { multiplier: 1, recordedAt: (isWrappedXStock ? params.levelSetAt : new Date(0)).toISOString() },
    currentMultiplier: 1,
  };
}
