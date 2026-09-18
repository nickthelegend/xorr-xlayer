/**
 * The upcoming corporate action for a tokenized equity, read off the mint.
 *
 * Backed's xStocks are Token-2022 mints carrying the Scaled UI Amount extension. A split or a
 * dividend is expressed there as a NEW MULTIPLIER with the timestamp it starts applying, and until
 * that moment arrives the mint carries both numbers at once. So the chain holds the schedule, and
 * there is nothing to look up anywhere else — no vendor calendar, no API key, and no table of dates
 * somebody typed in.
 *
 * That last point is why this module exists. The first version of the agent shipped a literal list
 * of invented dividend dates and a `ca-tsla-split-sample` split, which is precisely the thing this
 * product refuses to do. The extension makes the honest version cheaper than the dishonest one.
 *
 * ## What it cannot tell you
 *
 * The extension records that the multiplier changes, not why. A forward split and a dividend
 * credited as extra units both raise it, and nothing in the account data distinguishes them. So
 * this reports the change and its size and refuses to name it: calling a dividend a split on an
 * asset screen would be an invention of exactly the kind the on-chain read was chosen to avoid.
 */
import { readMintScale } from '../solana/balances.js';
import { XSTOCKS, xStockKey } from '../venues/xstocks.js';
import { underlyingTicker } from './edgar.js';

export type PendingAction = {
  /** The multiplier in force once `effectiveAtMs` passes. */
  nextMultiplier: number;
  effectiveAtMs: number;
  /**
   * How much a holding is about to be restated by: `next / current`.
   *
   * 2 on a two-for-one, 0.5 on a one-for-two. It is the number a holder's units get multiplied by
   * and their per-unit price divided by, which is the whole of what changes.
   */
  ratio: number;
  direction: 'increase' | 'decrease';
};

export type CorporateActionNotice =
  | {
      /** The mint answered and has a change queued. */
      status: 'scheduled';
      symbol: string;
      multiplier: number;
      pending: PendingAction;
    }
  | {
      /** The mint answered and has nothing queued. A real answer, not a missing one. */
      status: 'none';
      symbol: string;
      multiplier: number;
      pending: null;
    }
  | {
      /**
       * Nothing could be read: not a Token-2022 equity, or the cluster did not answer.
       *
       * Distinct from `none` on purpose. "No split is coming" and "we could not find out" are
       * different claims, and a screen that shows the first when it means the second is telling
       * the user something nobody checked.
       */
      status: 'unavailable';
      symbol: string;
      multiplier: null;
      pending: null;
      reason: 'not_tokenized' | 'unreadable';
    };

/**
 * The notice for one symbol.
 *
 * Accepts either spelling of a tokenized equity — `NVDAx` as the mint is registered, or `NVDAc` as
 * the Base listing is — because the asset screen is opened with whichever the market list gave it,
 * and a corporate action belongs to the company rather than to one of its listings.
 */
export async function corporateAction(symbol: string): Promise<CorporateActionNotice> {
  const key = xStockKey(symbol) ?? xStockKey(`${underlyingTicker(symbol)}x`);
  const token = key ? XSTOCKS[key] : undefined;
  if (!token) {
    return { status: 'unavailable', symbol, multiplier: null, pending: null, reason: 'not_tokenized' };
  }

  const scale = await readMintScale(token.address).catch(() => null);
  if (!scale) {
    return {
      status: 'unavailable',
      symbol: token.symbol,
      multiplier: null,
      pending: null,
      reason: 'unreadable',
    };
  }

  const { pending } = scale;
  if (!pending) {
    return { status: 'none', symbol: token.symbol, multiplier: scale.multiplier, pending: null };
  }

  /*
   * The ratio is against the multiplier in force, not against 1.
   *
   * A mint that has already split once sits at 2, and a second two-for-one takes it to 4. Reading
   * `nextMultiplier` as the ratio would announce that one as a four-for-one.
   */
  const current = scale.multiplier > 0 ? scale.multiplier : 1;
  const ratio = pending.nextMultiplier / current;

  return {
    status: 'scheduled',
    symbol: token.symbol,
    multiplier: scale.multiplier,
    pending: {
      nextMultiplier: pending.nextMultiplier,
      effectiveAtMs: pending.effectiveAtMs,
      ratio,
      direction: ratio >= 1 ? 'increase' : 'decrease',
    },
  };
}
