/**
 * The three urgency constants are right about how much a trade can WAIT and know nothing about the
 * pool it is going through.
 *
 * A 0.3% ceiling is generous on WETH/USDC and impossible on a thin pair where a $60 order moves the
 * price 0.8% by itself — and the failure is `ReturnAmountIsNotEnough`, the router refusing at a
 * price its own quote had already predicted.
 */
process.env.ONEINCH_API_KEY ??= 'test-key';
process.env.XORR_CHAIN ??= 'base-sepolia';

import { describe, expect, it } from 'vitest';

const { slippageFor, SLIPPAGE } = await import('./oneinch.js');

describe('the ceiling is the floor, not the answer', () => {
  it('leaves a deep pool alone', () => {
    // Impact well under the constant: the constant already covers it.
    expect(slippageFor(SLIPPAGE.scheduled, 0.02)).toBe(SLIPPAGE.scheduled);
    expect(slippageFor(SLIPPAGE.stop, 0.3)).toBe(SLIPPAGE.stop);
  });

  it('widens for a thin pool, by what the quote actually predicted', () => {
    // 0.8% impact against a 0.3% ceiling is the exact shape that reverted.
    const s = slippageFor(SLIPPAGE.scheduled, 0.8);
    expect(s).toBeGreaterThan(0.8);
    expect(s).toBe(1.2); // 0.8 × 1.5, rounded up to 2dp
  });

  it('rounds to two decimals, because the venue rejects more', () => {
    /*
     * `0.35 * 1.5` is `0.5292344803237518` in binary floating point, and 1inch answers a slippage
     * with sixteen decimals with `400 Bad Request` — so the adaptive tolerance broke every fill it
     * touched. Rounded UP, since rounding a tolerance down refuses trades the widening was
     * calculated to allow.
     */
    expect(slippageFor(0.3, 0.35)).toBe(0.53);
    expect(String(slippageFor(0.3, 0.35))).not.toContain('0.529');
    for (const impact of [0.11, 0.37, 0.79, 1.234, 1.999]) {
      const s = slippageFor(0.3, impact);
      expect(String(s).split('.')[1]?.length ?? 0, `${s} has too many decimals`).toBeLessThanOrEqual(2);
    }
  });

  it('refuses to widen without limit', () => {
    /*
     * A quote predicting 5% impact is saying the size is wrong for the pool. Accepting it is
     * paying for your own market impact; the trade should fail and say why.
     */
    expect(slippageFor(SLIPPAGE.scheduled, 5)).toBe(3);
    expect(slippageFor(SLIPPAGE.panic, 40)).toBe(3);
  });

  it('falls back to the constant when there is no impact figure', () => {
    // No quote, an un-measurable pair, or an Aqua fill — the behaviour that existed before.
    expect(slippageFor(SLIPPAGE.scheduled, null)).toBe(SLIPPAGE.scheduled);
    expect(slippageFor(SLIPPAGE.stop, Number.NaN)).toBe(SLIPPAGE.stop);
    // Negative impact means the fill beats the mid. Not a reason to loosen anything.
    expect(slippageFor(SLIPPAGE.scheduled, -0.5)).toBe(SLIPPAGE.scheduled);
  });

  it('never tightens below the urgency the trade was given', () => {
    // A stop must keep its extra room even in a pool with no measurable impact.
    expect(slippageFor(SLIPPAGE.stop, 0.001)).toBe(SLIPPAGE.stop);
    expect(slippageFor(SLIPPAGE.panic, 0.001)).toBe(SLIPPAGE.panic);
  });
});
