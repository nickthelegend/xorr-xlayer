/**
 * An instrument nothing prices must not carry a price.
 *
 * The 27 instruments with no feed — every commodity, index and pre-IPO name — used to carry the
 * design prototype's numbers under a SIMULATED tag: "OPENAI $164.20", "ANTHRP $121.55", "SPACEX
 * $402.70". Prices for companies with no market, plus change figures that fed the top-movers
 * ranking. They were removed from the data rather than hidden in the UI, so no screen can show one.
 *
 * This is what keeps them removed. The file's own header warns that `tools/gen-fixtures.mjs`
 * regenerates it from `ui/mobile-ui/data/markets.json`, and that source still has every one of
 * those numbers — a regeneration would bring them all back without a single other test failing.
 */
import { describe, expect, it } from 'vitest';
import { assetClasses } from './markets';

const instruments = assetClasses.flatMap((c) => c.instruments);
const unfed = instruments.filter((i) => i.feed !== 'live');

describe('no invented prices in the catalog', () => {
  it('still lists the instruments nothing prices — the catalog is not the problem', () => {
    // Guards against "fixing" this by deleting the asset classes the design shows.
    expect(unfed.length).toBeGreaterThan(0);
  });

  it('gives none of them a price', () => {
    const priced = unfed.filter((i) => /\d/.test(i.px)).map((i) => `${i.sym} ${i.px}`);
    expect(priced, `instruments with no feed carry a price: ${priced.join(', ')}`).toEqual([]);
  });

  it('gives none of them a change figure, so no ranking can sort a move nobody made', () => {
    const moved = unfed.filter((i) => i.chg.trim() !== '').map((i) => `${i.sym} ${i.chg}`);
    expect(moved, `instruments with no feed carry a change: ${moved.join(', ')}`).toEqual([]);
  });

  it('keeps what is genuinely catalog on every one of them', () => {
    for (const i of unfed) {
      expect(i.sym, 'an unfed instrument lost its symbol').toBeTruthy();
      expect(i.name, `${i.sym} lost its name`).toBeTruthy();
    }
  });
});
