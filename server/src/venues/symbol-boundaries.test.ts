/**
 * Every public entry point, every registered symbol, three casings.
 *
 * `symbols.test.ts` proves the REGISTRY resolves case-insensitively. It did not stop three shipped
 * bugs in one week, because each was at a boundary that never asked the registry: `/price/:symbol`
 * uppercased its parameter, `crosscheck` uppercased in its fallback, and `quote`/`buildSwap` did raw
 * `TOKENS[...]` lookups on whatever the caller passed.
 *
 * So this tests the boundaries rather than the registry, and it tests them the way they actually
 * fail: a lowercase `c` normalised away by something upstream.
 */
process.env.ONEINCH_API_KEY ??= 'test-key';
process.env.XORR_CHAIN ??= 'base-sepolia';

import { describe, expect, it } from 'vitest';

const { canonicalSymbol, TOKENS } = await import('./oneinch.js');
const { isStock, stockKey, STOCKS } = await import('./stocks.js');

/** The three ways a symbol arrives: as written, shouted, and whispered. */
const casings = (s: string) => [s, s.toUpperCase(), s.toLowerCase()];

describe('the venue boundary resolves every registered symbol, however it is cased', () => {
  it('canonicalSymbol round-trips all of them', () => {
    for (const key of Object.keys(TOKENS)) {
      for (const cased of casings(key)) {
        expect(canonicalSymbol(cased), `${cased} did not resolve to ${key}`).toBe(key);
        // The property every raw `TOKENS[...]` lookup depends on.
        expect(canonicalSymbol(cased) in TOKENS).toBe(true);
      }
    }
  });

  it('the equities are the ones that break, so they are named explicitly', () => {
    // Every one of these has a lowercase suffix that uppercasing destroys.
    for (const key of Object.keys(STOCKS)) {
      expect(key).toMatch(/c$/);
      expect(canonicalSymbol(key.toUpperCase())).toBe(key);
      expect(isStock(key.toUpperCase())).toBe(true);
      expect(stockKey(key.toLowerCase())).toBe(key);
    }
  });

  it('an unknown symbol comes back unchanged, so the error names what was asked for', () => {
    // Never silently mapped onto something tradable.
    expect(canonicalSymbol('NOTATOKEN')).toBe('NOTATOKEN');
    expect(canonicalSymbol('NOTATOKEN') in TOKENS).toBe(false);
    expect(isStock('NOTATOKEN')).toBe(false);
  });

  it('crypto still normalises upward, which is what it always did', () => {
    expect(canonicalSymbol('weth')).toBe('WETH');
    expect(canonicalSymbol(' usdc ')).toBe('USDC');
  });
});

describe('no boundary may uppercase a caller symbol', () => {
  /**
   * A textual guard, deliberately.
   *
   * The rule — crypto is uppercase, equities carry a lowercase `c`, and no boundary may uppercase a
   * caller's symbol — is only obvious at the moment someone types `.toUpperCase()`. Catching it
   * then is cheaper than catching it in production for the fourth time.
   *
   * `COINGECKO_IDS` is all-caps crypto with no equities in it, so the market routes that key into
   * it are exempt and say so at their call site.
   */
  it('the venue and executor modules do not uppercase symbols', async () => {
    const fs = await import('node:fs');
    const path = await import('node:path');
    const files = [
      'venues/oneinch.ts',
      'executor/run.ts',
      'market/crosscheck.ts',
      'market/prices.ts',
    ];
    const offenders: string[] = [];
    for (const f of files) {
      const src = fs.readFileSync(path.resolve(import.meta.dirname, '..', f), 'utf8');
      src.split('\n').forEach((line, i) => {
        if (!line.includes('.toUpperCase()')) return;
        // The canonical resolvers legitimately uppercase to build their lookup key.
        if (/CANONICAL|stockKey|const want|\.map\(\(k\)/.test(line)) return;
        // `venuesFrom` title-cases PROTOCOL names for display — "BASE_UNISWAP_V3" to "Uniswap V3".
        // Not a symbol, and the one place uppercasing is the point.
        if (/\^V\\d\$/.test(line)) return;
        if (line.trim().startsWith('*') || line.trim().startsWith('//')) return;
        offenders.push(`${f}:${i + 1} ${line.trim()}`);
      });
    }
    expect(offenders, `uppercasing a symbol at a boundary:\n${offenders.join('\n')}`).toEqual([]);
  });
});
