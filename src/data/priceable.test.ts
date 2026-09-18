/**
 * A price alert on a symbol nothing can price must be refused before the request, not after it.
 *
 * The server refuses it and says so well — "nothing prices NOTATOKEN, so this alert could never
 * fire" — but only after a round trip, to learn something the client already knows. And the form
 * uppercased what the user typed, which is rule 3 in `venues/oneinch.ts`: the tokenized equities
 * carry a lowercase suffix, and `NVDAc` becoming `NVDAC` is where three production bugs started.
 */
import { describe, expect, it } from 'vitest';
import { resolvePriceable } from './tradable';

const known = new Set([
  'BTC',
  'ETH',
  'WETH',
  'USDC',
  'CBBTC',
  'XAUT',
  'NVDAc',
  'TSLAc',
  // The xStocks, priced by the Jupiter route that would fill them (`server/src/market/feeds.ts`).
  'NVDAx',
  'TSLAx',
]);

describe('resolvePriceable', () => {
  it('accepts a symbol the price sources know', () => {
    expect(resolvePriceable('WETH', known)).toBe('WETH');
    // Priceable but NOT tradable on Base — an alert on it is perfectly reasonable, and checking
    // `isTradable` here would have refused it.
    expect(resolvePriceable('BTC', known)).toBe('BTC');
  });

  it('returns the canonical spelling rather than an uppercased one', () => {
    expect(resolvePriceable('nvdac', known)).toBe('NVDAc');
    expect(resolvePriceable('NVDAC', known)).toBe('NVDAc');
    expect(resolvePriceable('weth', known)).toBe('WETH');
  });

  it('accepts a tokenized equity on Solana', () => {
    /*
     * The executor prices these through Jupiter, and the field used to refuse them: the client's
     * list asked `/market/symbols` and `/market/stocks` and never `/market/xstocks`, so an alert on
     * NVDAx was rejected with "nothing prices it" while the executor was pricing it all day.
     */
    expect(resolvePriceable('NVDAx', known)).toBe('NVDAx');
    expect(resolvePriceable('nvdax', known)).toBe('NVDAx');
  });

  it('keeps the two spellings of the same company apart', () => {
    // NVIDIA on two chains, under two registries, priced by two venues.
    expect(resolvePriceable('NVDAx', known)).toBe('NVDAx');
    expect(resolvePriceable('NVDAc', known)).toBe('NVDAc');
  });

  it('refuses a symbol nothing prices', () => {
    expect(resolvePriceable('NOTATOKEN', known)).toBeUndefined();
    expect(resolvePriceable("WETH'; DROP TABLE alerts;--", known)).toBeUndefined();
  });

  it('refuses an empty symbol', () => {
    expect(resolvePriceable('   ', known)).toBeUndefined();
  });

  it('stays permissive while the list is unknown, and lets the server answer', () => {
    // An empty or failed fetch must not refuse every alert in the app.
    expect(resolvePriceable('WETH', undefined)).toBe('WETH');
    expect(resolvePriceable('ANYTHING', undefined)).toBe('ANYTHING');
  });
});
