/**
 * Finding a market by typing roughly what it is called.
 *
 * Search matched a substring, so "nvidia" found nothing — the symbol is `NVDAx` — and "aple" found
 * nothing at all. The cases here are split between "it is forgiving enough to be useful" and "it is
 * still strict enough to be safe", and the second half matters more: what someone does with a
 * search result here is spend money on it.
 */
import { describe, expect, it } from 'vitest';
import { fuzzyMatches, fuzzyRank, fuzzyScore } from './fuzzy';

const CATALOG = [
  { symbol: 'NVDAx', name: 'NVIDIA Corporation xStock' },
  { symbol: 'TSLAx', name: 'Tesla Inc. xStock' },
  { symbol: 'AAPLx', name: 'Apple Inc. xStock' },
  { symbol: 'MSFTx', name: 'Microsoft Corporation xStock' },
  { symbol: 'AMZNx', name: 'Amazon.com Inc. xStock' },
  { symbol: 'SPYx', name: 'SPDR S&P 500 ETF Trust xStock' },
  { symbol: 'WETH', name: 'Wrapped Ether' },
];

const symbolsFor = (q: string) => fuzzyRank(CATALOG, q).map((i) => i.symbol);

describe('typing the ticker', () => {
  it('finds it', () => {
    expect(symbolsFor('nvdax')[0]).toBe('NVDAx');
  });

  it('finds it from a prefix', () => {
    expect(symbolsFor('tsl')[0]).toBe('TSLAx');
  });

  it('does not care about case', () => {
    expect(symbolsFor('NVDA')[0]).toBe('NVDAx');
    expect(symbolsFor('nvda')[0]).toBe('NVDAx');
  });

  it('ignores surrounding space', () => {
    expect(symbolsFor('  aapl  ')[0]).toBe('AAPLx');
  });
});

describe('typing the company', () => {
  it('finds the token by the name nobody puts on a ticker', () => {
    // The whole point: "nvidia" is what a person knows, `NVDAx` is what the chain calls it.
    expect(symbolsFor('nvidia')[0]).toBe('NVDAx');
    expect(symbolsFor('tesla')[0]).toBe('TSLAx');
    expect(symbolsFor('apple')[0]).toBe('AAPLx');
    expect(symbolsFor('microsoft')[0]).toBe('MSFTx');
  });

  it('survives a dropped letter', () => {
    // "aple" is a subsequence of "Apple Inc. xStock".
    expect(symbolsFor('aple')[0]).toBe('AAPLx');
    expect(symbolsFor('microsft')[0]).toBe('MSFTx');
  });

  it('matches across a word boundary', () => {
    expect(fuzzyMatches('amazoncom', { symbol: 'AMZNx', name: 'Amazon.com Inc. xStock' })).toBe(true);
  });
});

describe('what must not match', () => {
  it('refuses a query with a character the candidate does not have', () => {
    /*
     * The safety half. This is subsequence matching, NOT edit distance: "NVDA" and "NVDX" are one
     * character apart and are different assets, and a matcher that treats a wrong character as
     * nearly right will eventually offer somebody the wrong stock.
     */
    expect(fuzzyScore('nvdz', 'NVIDIA Corporation xStock').score).toBe(0);
    expect(symbolsFor('nvdz')).toEqual([]);
  });

  it('refuses characters in the wrong order', () => {
    // "alset" has the letters of "Tesla" and is not a way of typing it.
    expect(fuzzyScore('alset', 'Tesla Inc.').score).toBe(0);
  });

  it('refuses a query longer than anything it could match', () => {
    expect(symbolsFor('nvidiacorporationxstockandthensome')).toEqual([]);
  });

  it('returns nothing rather than everything when nothing matches', () => {
    // The failure that turns a search into a list: falling back to "show them all".
    expect(symbolsFor('zzzzz')).toEqual([]);
  });
});

describe('the order results come back in', () => {
  it('puts a match at the start ahead of one in the middle', () => {
    const ranked = fuzzyRank(
      [
        { symbol: 'XSP', name: 'Something Spy-like' },
        { symbol: 'SPYx', name: 'SPDR S&P 500 ETF Trust xStock' },
      ],
      'sp',
    );
    expect(ranked[0]!.symbol).toBe('SPYx');
  });

  it('prefers the shorter of two equally good matches', () => {
    const ranked = fuzzyRank(
      [
        { symbol: 'NVDAx-LONG-NAME-TOKEN', name: 'NVIDIA Corporation xStock Extended' },
        { symbol: 'NVDAx', name: 'NVIDIA Corporation xStock' },
      ],
      'nvdax',
    );
    expect(ranked[0]!.symbol).toBe('NVDAx');
  });

  it('prefers contiguous letters over scattered ones within a word', () => {
    // Like for like: both candidates match inside one word, so only contiguity separates them.
    const tight = fuzzyScore('nvd', 'xnvdax').score;
    const loose = fuzzyScore('nvd', 'xnavadax').score;
    expect(tight).toBeGreaterThan(loose);
  });

  it('treats initials as a strong match, which is how people type', () => {
    /*
     * A deliberate consequence of scoring word boundaries highly: "sp5" finds "SPDR S&P 500" and
     * "jpm" would find "JPMorgan Chase". It also means an acronym can outrank a contiguous match
     * inside one word, which is the right trade — someone typing initials means them.
     */
    const initials = fuzzyScore('sse', 'SPDR S&P ETF').score;
    expect(initials).toBeGreaterThan(0);
    expect(initials).toBeGreaterThan(fuzzyScore('sse', 'xxsseyy').score);
  });

  it('keeps the catalogue order between equally good matches', () => {
    // Stable: equally-good results must not reshuffle on every keystroke.
    const items = [
      { symbol: 'AAA', name: 'Alpha' },
      { symbol: 'AAB', name: 'Alpha' },
    ];
    expect(fuzzyRank(items, 'alpha').map((i) => i.symbol)).toEqual(['AAA', 'AAB']);
  });
});

describe('before anyone types', () => {
  it('returns everything unchanged', () => {
    // A search that empties the moment it opens looks broken; the screen shows a starting list.
    expect(fuzzyRank(CATALOG, '')).toHaveLength(CATALOG.length);
    expect(fuzzyRank(CATALOG, '   ')).toHaveLength(CATALOG.length);
    expect(fuzzyMatches('', CATALOG[0]!)).toBe(true);
  });

  it('does not mutate the list it was given', () => {
    const items = [...CATALOG];
    fuzzyRank(items, 'nvidia');
    expect(items).toEqual(CATALOG);
  });
});

describe('the positions it reports', () => {
  it('names where each character landed, for highlighting', () => {
    expect(fuzzyScore('nvd', 'NVDAx').positions).toEqual([0, 1, 2]);
  });

  it('reports none when nothing matched', () => {
    expect(fuzzyScore('zzz', 'NVDAx').positions).toEqual([]);
  });
});
