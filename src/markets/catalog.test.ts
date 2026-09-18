/**
 * The catalog's rules, away from the screen that draws them.
 *
 * The one that matters most is the filter: an unpriced row must survive its own sector. A feed
 * outage would otherwise look like a catalog that had emptied, and "nothing is listed here" is a
 * very different claim from "we cannot price what is listed here".
 */
import { describe, expect, it } from 'vitest';
import {
  ALL_SECTORS,
  bySector,
  isTradable,
  secondaryLine,
  sectorOptions,
  unpricedCount,
  unpricedNote,
} from './catalog';
import type { XStockRow } from '@/data/system';

function row(over: Partial<XStockRow> & Pick<XStockRow, 'symbol' | 'sector'>): XStockRow {
  return {
    name: `${over.symbol} xStock`,
    ticker: over.symbol.replace(/x$/, ''),
    address: `0x${'0'.repeat(40)}`,
    decimals: 18,
    price: 100,
    underlyingPrice: null,
    change24hPct: null,
    liquidityUsd: null,
    underlyingAt: null,
    feed: 'live',
    ...over,
  };
}

const NVDA = row({ symbol: 'NVDAx', sector: 'Technology', price: 215.92, underlyingPrice: 215.68 });
const AAPL = row({ symbol: 'AAPLx', sector: 'Technology', price: null, feed: 'unavailable' });
const TSLA = row({ symbol: 'TSLAx', sector: 'Consumer Discretionary', price: 363.19 });
const SPY = row({ symbol: 'SPYx', sector: 'Index funds', price: 759.95 });
const ALL = [NVDA, AAPL, TSLA, SPY];

describe('the sector filter', () => {
  it('offers All ahead of the sectors the server derived', () => {
    expect(sectorOptions(['Technology', 'Index funds'])).toEqual([
      ALL_SECTORS,
      'Technology',
      'Index funds',
    ]);
  });

  it('shows everything under All', () => {
    expect(bySector(ALL, ALL_SECTORS)).toHaveLength(4);
  });

  it('keeps an unpriced row inside its own sector', () => {
    // AAPLx has no price and is still an Apple share tokenized on X Layer. Hiding it here would
    // make a feed outage look like a shorter catalog.
    const tech = bySector(ALL, 'Technology');
    expect(tech.map((r) => r.symbol)).toEqual(['NVDAx', 'AAPLx']);
  });

  it('drops rows from other sectors', () => {
    expect(bySector(ALL, 'Index funds').map((r) => r.symbol)).toEqual(['SPYx']);
  });

  it('answers a sector nothing is listed under with an empty list, not everything', () => {
    expect(bySector(ALL, 'Energy')).toEqual([]);
  });
});

describe('what the screen says about missing prices', () => {
  it('says nothing when every row has one', () => {
    expect(unpricedNote([NVDA, TSLA])).toBeNull();
  });

  it('counts them when some do not', () => {
    expect(unpricedCount(ALL)).toBe(1);
    expect(unpricedNote(ALL)).toBe('1 of these have no price right now.');
  });

  it('says it plainly when none do', () => {
    // Not "4 of these": a reader would have to compare the count against the length of the list to
    // learn the thing that actually matters, which is that nothing here can be bought.
    const none = ALL.map((r) => ({ ...r, price: null, feed: 'unavailable' as const }));
    expect(unpricedNote(none)).toBe('No prices right now. These can’t be bought until one arrives.');
  });
});

describe('the line under the symbol', () => {
  const fmt = (n: number) => `$${n.toFixed(2)}`;

  it('names the issuer mark when the row carries one', () => {
    // The mark and the pool price are different quantities, and the row shows both. This line is
    // what stops the smaller number from reading as a second opinion on the same thing.
    expect(secondaryLine(NVDA, fmt)).toBe('Technology · share $215.68');
  });

  it('falls back to the sector alone when it does not', () => {
    expect(secondaryLine(TSLA, fmt)).toBe('Consumer Discretionary');
    expect(secondaryLine(AAPL, fmt)).toBe('Technology');
  });
});

describe('whether a row leads anywhere', () => {
  it('a priced row does', () => {
    expect(isTradable(NVDA)).toBe(true);
  });

  it('an unpriced one does not', () => {
    // It is still worth listing — the asset exists and cannot be priced here — but an order ticket
    // opened on it would have no number to put in front of someone before they commit money.
    expect(isTradable(AAPL)).toBe(false);
  });

  it('nor does a row the feed called live without sending a price', () => {
    expect(isTradable(row({ symbol: 'X', sector: 'Technology', price: null }))).toBe(false);
  });
});
