/**
 * The breakdown's rules, away from the screen.
 *
 * The one that matters is that a figure the venue did not report never renders as a zero. On a
 * screen someone reads before committing money, "0.00%" is a measurement — it says the cost was
 * looked at and found to be nothing — and using it for "we could not find out" is the same class of
 * lie as a placeholder price.
 */
import { describe, expect, it } from 'vitest';
import {
  NOT_REPORTED,
  breakdownRows,
  impactPct,
  routeLabel,
  slippagePct,
  worstCase,
} from './breakdown';
import type { XStockQuote } from '@/data/system';

const fmt = {
  money: (n: number) => `$${n.toFixed(2)}`,
  quantity: (n: number) => n.toFixed(4),
  price: (n: number) => `$${n.toFixed(2)}`,
};

/** A real buy, with the numbers a live Jupiter quote for $250 of NVDAx actually returned. */
const BUY: XStockQuote = {
  symbol: 'NVDAx',
  side: 'buy',
  usd: 250,
  pay: 250,
  payToken: 'USDC',
  receive: 1.15343,
  receiveToken: 'NVDAx',
  minimumReceive: 1.147663,
  priceImpactPct: 0.05634,
  priceImpactUsd: 0.1408,
  slippageBps: 50,
  slippageWorstUsd: 1.2505,
  hops: [{ label: 'Whirlpool', percent: 100 }],
  platformFeeUsd: null,
  effectivePrice: 216.7448,
  markPrice: 216.8341,
};

const row = (q: XStockQuote, label: string) => breakdownRows(q, fmt).find((r) => r.label === label)!;

describe('a cost the venue reported', () => {
  it('reads as a percentage to two places', () => {
    expect(impactPct(0.05634)).toBe('0.06%');
    expect(impactPct(1.5)).toBe('1.50%');
  });

  it('is never rounded down to nothing', () => {
    // A real cost of five thousandths of a percent. "0.00%" would say it was measured at zero.
    expect(impactPct(0.005)).toBe('<0.01%');
    expect(impactPct(0.0000001)).toBe('<0.01%');
  });

  it('keeps a true zero as a zero', () => {
    // The venue DID measure it and it was nothing. That is a different fact from the two above.
    expect(impactPct(0)).toBe('0.00%');
  });
});

describe('a cost the venue did not report', () => {
  it('says so rather than showing a number', () => {
    expect(impactPct(null)).toBe(NOT_REPORTED);
  });

  it('carries no money note either, since there is nothing to convert', () => {
    const q = { ...BUY, priceImpactPct: null, priceImpactUsd: null };
    expect(row(q, 'Price impact').value).toBe(NOT_REPORTED);
    expect(row(q, 'Price impact').note).toBeNull();
  });
});

describe('the tolerance', () => {
  it('is shown as the percentage a reader thinks in', () => {
    expect(slippagePct(50)).toBe('0.50%');
    expect(slippagePct(5)).toBe('0.05%');
    expect(slippagePct(300)).toBe('3.00%');
  });

  it('is always paired with what it costs in money', () => {
    // "0.5%" is arithmetic homework. The note is the same fact already answered.
    expect(row(BUY, 'Max slippage')).toMatchObject({
      value: '0.50%',
      note: 'at worst $1.25 less',
    });
  });
});

describe('the route', () => {
  it('names a single pool without a share', () => {
    // "Whirlpool 100%" invites the reader to go looking for the other 99%.
    expect(routeLabel([{ label: 'Whirlpool', percent: 100 }])).toBe('Whirlpool');
  });

  it('names each share of a split', () => {
    expect(
      routeLabel([
        { label: 'Whirlpool', percent: 60 },
        { label: 'Raydium CLMM', percent: 40 },
      ]),
    ).toBe('Whirlpool 60% + Raydium CLMM 40%');
  });

  it('drops the share a venue did not give', () => {
    expect(
      routeLabel([
        { label: 'Whirlpool', percent: null },
        { label: 'Meteora DLMM', percent: 40 },
      ]),
    ).toBe('Whirlpool + Meteora DLMM 40%');
  });

  it('admits to no route rather than showing an empty line', () => {
    expect(routeLabel([])).toBe(NOT_REPORTED);
  });
});

describe('the venue fee', () => {
  it('says None in a word when the aggregator takes nothing', () => {
    // Leaving the line off reads identically to a line nobody checked.
    expect(row(BUY, 'Venue fee')).toMatchObject({ value: 'None', cost: false });
  });

  it('shows it as a cost when it takes something', () => {
    expect(row({ ...BUY, platformFeeUsd: 0.5 }, 'Venue fee')).toMatchObject({
      value: '$0.50',
      cost: true,
    });
  });
});

describe('the whole breakdown', () => {
  it('reads in the order someone decides in', () => {
    expect(breakdownRows(BUY, fmt).map((r) => r.label)).toEqual([
      'You pay',
      'Expected',
      'Price impact',
      'Max slippage',
      'Venue fee',
      'Route',
      'Minimum received',
    ]);
  });

  it('marks the three lines that are costs', () => {
    const costs = breakdownRows(BUY, fmt).filter((r) => r.cost).map((r) => r.label);
    // The venue fee is None here, so it is a reading rather than a cost.
    expect(costs).toEqual(['Price impact', 'Max slippage']);
  });

  it('puts the effective price against the mark, so the gap is visible', () => {
    expect(row(BUY, 'Expected').note).toBe('$216.74 each · mark $216.83');
  });

  it('works the same on a sell, in the tokens that side is denominated in', () => {
    const sell: XStockQuote = {
      ...BUY,
      side: 'sell',
      pay: 1.150997,
      payToken: 'NVDAx',
      receive: 249.303604,
      receiveToken: 'USDC',
      minimumReceive: 248.057086,
      priceImpactPct: 0.1014,
      priceImpactUsd: 0.2536,
      slippageWorstUsd: 1.2465,
      effectivePrice: 216.598,
    };
    expect(row(sell, 'You pay').value).toBe('1.1510 NVDAx');
    expect(row(sell, 'Minimum received').value).toBe('248.0571 USDC');
  });
});

describe('the sentence above the rows', () => {
  it('is the floor, not the expectation', () => {
    // Impact and tolerance are both costs and they compound. What someone is guaranteed is the one
    // number worth putting in a sentence before they commit money.
    expect(worstCase(BUY, fmt)).toBe('At worst you get 1.1477 NVDAx.');
  });
});
