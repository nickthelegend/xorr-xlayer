/**
 * What a chart keeps while one series gives way to the next (FEATURES.md #83). The hook is these transitions and a
 * `useState`; pinning the transitions is what keeps a refresh from ever turning into a fade, and a switch into a jump.
 */
import { describe, expect, it } from 'vitest';
import { initialLayers, nextLayers, sameItems } from './useSeriesLayers';

const same = (a: number[], b: number[]) => sameItems(a, b);

describe('the layers a range switch crossfades between', () => {
  it('start with the series in front and nothing behind it', () => {
    expect(initialLayers('ETH:1D', [1, 2])).toEqual({ key: 'ETH:1D', front: 0, slots: [[1, 2], null], generation: 0 });
  });

  it('do not change when the same series comes back as a new array', () => {
    const layers = initialLayers('ETH:1D', [1, 2]);
    expect(nextLayers(layers, 'ETH:1D', [1, 2], same)).toBe(layers);
  });

  it('update the same question in place, without a fade', () => {
    const next = nextLayers(initialLayers('ETH:1D', [1, 2]), 'ETH:1D', [1, 3], same);
    expect(next).toEqual({ key: 'ETH:1D', front: 0, slots: [[1, 3], null], generation: 0 });
  });

  it('put a new key in the other slot and keep the leaving series where it was, to fade', () => {
    const next = nextLayers(initialLayers('ETH:1D', [1, 2]), 'ETH:1W', [5, 6], same);
    expect(next).toEqual({ key: 'ETH:1W', front: 1, slots: [[1, 2], [5, 6]], generation: 1 });
  });

  it('trade back on the next switch, letting go of the series from two switches ago', () => {
    const week = nextLayers(initialLayers('ETH:1D', [1, 2]), 'ETH:1W', [5, 6], same);
    const month = nextLayers(week, 'ETH:1M', [7, 8], same);
    expect(month).toEqual({ key: 'ETH:1M', front: 0, slots: [[7, 8], [5, 6]], generation: 2 });
  });

  it('update a front series in the second slot in place as well', () => {
    const week = nextLayers(initialLayers('ETH:1D', [1, 2]), 'ETH:1W', [5, 6], same);
    expect(nextLayers(week, 'ETH:1W', [5, 9], same).slots).toEqual([[1, 2], [5, 9]]);
  });
});

describe('sameItems', () => {
  it('compares by value, or by the rule given', () => {
    expect(sameItems([1, 2], [1, 2])).toBe(true);
    expect(sameItems([1, 2], [1, 2, 3])).toBe(false);
    expect(sameItems([1, 2], [2, 1])).toBe(false);
    expect(sameItems([{ a: 1 }], [{ a: 1 }])).toBe(false);
    expect(sameItems([{ a: 1 }], [{ a: 1 }], (x, y) => x.a === y.a)).toBe(true);
  });
});
