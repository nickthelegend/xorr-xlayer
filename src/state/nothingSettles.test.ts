/**
 * Where Home says nothing fills (PLAN.md 4.3): only on the executor's own answer, never on a guess from a read that failed.
 */
import { describe, expect, it } from 'vitest';
import { nothingSettles } from './derived';

const WETH = { symbol: 'WETH' };

describe('nothingSettles', () => {
  it('is true where the executor offers nothing to trade and something to watch', () => {
    expect(nothingSettles([], [WETH])).toBe(true);
  });

  it('is false where something trades, where there is nothing to watch either, and before either read answers', () => {
    expect(nothingSettles([WETH], [WETH])).toBe(false);
    expect(nothingSettles([], [])).toBe(false);
    expect(nothingSettles(undefined, [WETH])).toBe(false);
    expect(nothingSettles(null, [WETH])).toBe(false);
    expect(nothingSettles([], undefined)).toBe(false);
  });
});
