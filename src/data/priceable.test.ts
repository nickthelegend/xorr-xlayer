/**
 * A price alert on a symbol nothing can price must be refused before the request, not after it.
 *
 * The server refuses it and says so well — "nothing prices NOTATOKEN, so this alert could never
 * fire" — but only after a round trip, to learn something the client already knows. And the form
 * uppercased what the user typed, which is rule 3 in `venues/tokens.ts`: the tokenized equities
 * carry a lowercase suffix, and `NVDAx` becoming `NVDAX` is where three production bugs started.
 */
import { describe, expect, it } from 'vitest';
import { resolvePriceable } from './tradable';

const known = new Set([
  'BTC',
  'ETH',
  'OKB',
  'USDC',
  'XBTC',
  'WOKB',
  'XAUT',
  // The wrapped xStocks, priced by the Uniswap v3 pools that would fill them (`server/src/market/feeds.ts`).
  'NVDAx',
  'TSLAx',
]);

describe('resolvePriceable', () => {
  it('accepts a symbol the price sources know', () => {
    expect(resolvePriceable('XBTC', known)).toBe('XBTC');
    // Priceable but NOT tradable on X Layer — an alert on it is perfectly reasonable, and checking
    // `isTradable` here would have refused it.
    expect(resolvePriceable('ETH', known)).toBe('ETH');
  });

  it('returns the canonical spelling rather than an uppercased one', () => {
    expect(resolvePriceable('nvdax', known)).toBe('NVDAx');
    expect(resolvePriceable('NVDAX', known)).toBe('NVDAx');
    expect(resolvePriceable('xbtc', known)).toBe('XBTC');
  });

  it('accepts a wrapped xStock', () => {
    /*
     * The executor prices these through the Uniswap v3 pools that fill them, and the field once
     * refused them: the client's list never asked `/market/xstocks`, so an alert on NVDAx was
     * rejected with "nothing prices it" while the executor was pricing it all day.
     */
    expect(resolvePriceable('NVDAx', known)).toBe('NVDAx');
    expect(resolvePriceable('tslax', known)).toBe('TSLAx');
  });

  it('does not accept another chain\'s spelling of the same company', () => {
    // `NVDAc` was the Base build's tokenized NVIDIA. Nothing on X Layer prices it.
    expect(resolvePriceable('NVDAc', known)).toBeUndefined();
  });

  it('refuses a symbol nothing prices', () => {
    expect(resolvePriceable('NOTATOKEN', known)).toBeUndefined();
    expect(resolvePriceable("XBTC'; DROP TABLE alerts;--", known)).toBeUndefined();
  });

  it('refuses an empty symbol', () => {
    expect(resolvePriceable('   ', known)).toBeUndefined();
  });

  it('stays permissive while the list is unknown, and lets the server answer', () => {
    // An empty or failed fetch must not refuse every alert in the app.
    expect(resolvePriceable('XBTC', undefined)).toBe('XBTC');
    expect(resolvePriceable('ANYTHING', undefined)).toBe('ANYTHING');
  });
});
