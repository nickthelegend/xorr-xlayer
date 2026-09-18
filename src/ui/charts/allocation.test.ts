import { describe, expect, it } from 'vitest';
import { allocationBySector, sliceArcs, UNCLASSIFIED, type Holding } from './allocation';

const h = (symbol: string, valueUsd: number, sector?: string | null): Holding => ({ symbol, valueUsd, sector });

describe('allocationBySector — the shares add up to what is actually held', () => {
  it('groups holdings by sector and shares them out of the total', () => {
    const { slices, totalUsd } = allocationBySector([
      h('NVDAx', 600, 'Technology'),
      h('MSFTx', 200, 'Technology'),
      h('TSLAx', 200, 'Consumer Discretionary'),
    ]);
    expect(totalUsd).toBe(1000);
    expect(slices.map((s) => [s.sector, s.valueUsd, s.share])).toEqual([
      ['Technology', 800, 0.8],
      ['Consumer Discretionary', 200, 0.2],
    ]);
  });

  it('shares always total one when anything is held', () => {
    const { slices } = allocationBySector([
      h('A', 1 / 3, 'One'),
      h('B', 1 / 3, 'Two'),
      h('C', 1 / 3, 'Three'),
    ]);
    const sum = slices.reduce((t, s) => t + s.share, 0);
    expect(sum).toBeCloseTo(1, 12);
  });

  it('names the holdings in each slice, largest first', () => {
    const { slices } = allocationBySector([h('MSFTx', 200, 'Tech'), h('NVDAx', 600, 'Tech')]);
    expect(slices[0]!.symbols).toEqual(['NVDAx', 'MSFTx']);
  });
});

describe('the unclassified bucket', () => {
  /*
   * The failure this guards is invisible: drop the unknown holdings and the remaining slices renormalise, so a
   * portfolio that is half unclassified draws as though the classified half were the whole thing — and still adds to
   * 100%. The chart would look perfectly correct and be wrong by half.
   */
  it('keeps unclassified holdings in the total rather than renormalising around them', () => {
    const { slices, totalUsd } = allocationBySector([h('NVDAx', 500, 'Technology'), h('WHATx', 500, null)]);
    expect(totalUsd).toBe(1000);
    expect(slices.find((s) => s.sector === 'Technology')!.share).toBe(0.5);
    expect(slices.find((s) => s.unclassified)!.share).toBe(0.5);
  });

  it('treats null, undefined and blank alike — none of them is a sector', () => {
    const { slices } = allocationBySector([h('A', 10, null), h('B', 10, undefined), h('C', 10, '   ')]);
    expect(slices).toHaveLength(1);
    expect(slices[0]!.sector).toBe(UNCLASSIFIED);
    expect(slices[0]!.symbols).toHaveLength(3);
  });

  /* It is the absence of an answer, not a category competing for rank. Second place would read as a sector. */
  it('sorts last even when it is the biggest', () => {
    const { slices } = allocationBySector([h('A', 900, null), h('B', 100, 'Technology')]);
    expect(slices.map((s) => s.sector)).toEqual(['Technology', UNCLASSIFIED]);
  });

  it('never guesses a sector from the ticker', () => {
    const { slices } = allocationBySector([h('NVDAx', 100, null)]);
    expect(slices[0]!.sector).toBe(UNCLASSIFIED);
    expect(slices[0]!.unclassified).toBe(true);
  });
});

describe('what does not count', () => {
  /* A zero-width slice carries a legend entry for something invisible, which reads as a bug rather than as emptiness. */
  it('leaves out holdings worth nothing, less than nothing, or unreadable', () => {
    const { slices, totalUsd } = allocationBySector([
      h('GOOD', 100, 'Technology'),
      h('ZERO', 0, 'Technology'),
      h('NEG', -50, 'Technology'),
      h('NAN', Number.NaN, 'Technology'),
      h('INF', Number.POSITIVE_INFINITY, 'Technology'),
    ]);
    expect(totalUsd).toBe(100);
    expect(slices).toHaveLength(1);
    expect(slices[0]!.symbols).toEqual(['GOOD']);
  });

  it('draws nothing at all for an empty or worthless portfolio', () => {
    expect(allocationBySector([])).toEqual({ slices: [], totalUsd: 0 });
    expect(allocationBySector([h('A', 0, 'Tech')])).toEqual({ slices: [], totalUsd: 0 });
  });
});

describe('ordering is stable', () => {
  /* Two reads of a portfolio that did not change must not move the slices, or their colours, around the ring. */
  it('breaks ties by name so the same portfolio draws the same way twice', () => {
    const once = allocationBySector([h('A', 100, 'Zulu'), h('B', 100, 'Alpha')]);
    const twice = allocationBySector([h('B', 100, 'Alpha'), h('A', 100, 'Zulu')]);
    expect(once.slices.map((s) => s.sector)).toEqual(['Alpha', 'Zulu']);
    expect(twice.slices.map((s) => s.sector)).toEqual(once.slices.map((s) => s.sector));
  });
});

describe('sliceArcs — segments that meet exactly', () => {
  it('runs from nothing to the whole circle with no gaps', () => {
    const { slices } = allocationBySector([h('A', 500, 'One'), h('B', 300, 'Two'), h('C', 200, 'Three')]);
    const arcs = sliceArcs(slices);
    expect(arcs[0]!.start).toBe(0);
    expect(arcs[arcs.length - 1]!.end).toBeCloseTo(1, 12);
    // Each begins exactly where the last ended: accumulating each share separately would leave hairlines between them.
    for (let i = 1; i < arcs.length; i += 1) expect(arcs[i]!.start).toBe(arcs[i - 1]!.end);
  });

  it('has nothing to lay out when there are no slices', () => {
    expect(sliceArcs([])).toEqual([]);
  });
});
