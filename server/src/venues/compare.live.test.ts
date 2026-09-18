/**
 * LIVE — every venue is asked the same question, and every answer is reported.
 *
 * The value of this surface is not that it finds a better price; it is that a refusal is an answer.
 * A comparison that silently omitted the venues that could not serve would read as "1inch is the
 * only venue", which is a different and false claim from "1inch is the only venue that can serve
 * $100 of this pair right now".
 *
 * Run with the executor up: npm run test:live
 */
import { describe, expect, it } from 'vitest';
import { compareVenues } from './compare.js';

const OWNER = '0x95A0b368588713011a15f4b1041423f31B08e615' as const;

describe('every venue is asked, and every answer is reported', () => {
  it('names all three venues whether or not they can serve', async () => {
    const r = await compareVenues({ owner: OWNER, inSymbol: 'USDC', outSymbol: 'WETH', amount: 100 });
    expect(r.quotes.map((q) => q.venue).sort()).toEqual(['1inch', 'aqua', 'swapvm']);
    for (const q of r.quotes) {
      // Either a number or a sentence. Never a venue that is simply absent.
      if (q.served) expect(q.outAmount, `${q.venue} served with no amount`).toBeGreaterThan(0);
      else expect(q.reason.length, `${q.venue} refused with no reason`).toBeGreaterThan(10);
    }
  }, 90_000);

  it('the aggregator answers, and its route names real pools', async () => {
    const r = await compareVenues({ owner: OWNER, inSymbol: 'USDC', outSymbol: 'WETH', amount: 100 });
    const agg = r.quotes.find((q) => q.venue === '1inch');
    expect(agg?.served, 'the aggregator returned no route for USDC→WETH').toBe(true);
    if (!agg?.served) return;
    // $100 of WETH is a small fraction of one. Outside this, the decimals are wrong.
    expect(agg.outAmount).toBeGreaterThan(0.005);
    expect(agg.outAmount).toBeLessThan(1);
    expect(agg.detail).toMatch(/via .+/);
  }, 90_000);

  it('picks the best served venue, and reports no edge when only one served', async () => {
    const r = await compareVenues({ owner: OWNER, inSymbol: 'USDC', outSymbol: 'WETH', amount: 100 });
    const served = r.quotes.filter((q) => q.served);
    expect(r.best).toBe(served.sort((a, b) => (b.served ? b.outAmount : 0) - (a.served ? a.outAmount : 0))[0]?.venue);
    /*
     * "Better than nothing" is not a margin. A single-venue result reported as "0 bps better"
     * reads as a tie when it is an absence of competition.
     */
    if (served.length < 2) expect(r.edgeBps).toBeUndefined();
    else expect(typeof r.edgeBps).toBe('number');
  }, 90_000);

  it('refuses a pair the registry does not know rather than inventing one', async () => {
    await expect(
      compareVenues({ owner: OWNER, inSymbol: 'USDC', outSymbol: 'NOTATOKEN', amount: 100 }),
    ).rejects.toThrow(/registry/i);
  }, 30_000);
});
