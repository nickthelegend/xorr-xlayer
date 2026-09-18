/**
 * Tokenized equities carry a lowercase suffix — `NVDAc` on the Base build, `NVDAx` for the wrapped
 * xStocks on X Layer — and the routes normalised symbols with `.toUpperCase()`.
 *
 * On Base, `NVDAc` became `NVDAC`, which is not a key in `TOKENS`. So `/swap/quote?out=NVDAc`
 * answered **`502 No route for USDC -> NVDAC`** and the order ticket for the entire stocks track
 * could not price a single trade. `/orders` and the panic flatten resolved the same way, so an equity
 * position could not be opened, closed, or flattened either. `NVDAx` → `NVDAX` is the same bug.
 *
 * It survived because every crypto symbol is already all-caps: uppercasing is correct for USDC,
 * XBTC, WOKB and USDG, which is everything anyone tests by hand.
 */
import { describe, expect, it } from 'vitest';
import { canonicalSymbol, TOKENS } from './tokens.js';

describe('a symbol resolves to the registry spelling, whatever the caller sent', () => {
  it('keeps the lowercase suffix that makes an equity an equity', () => {
    expect(canonicalSymbol('NVDAx')).toBe('NVDAx');
    // What the routes actually sent, and the reason every equity quote failed.
    expect(canonicalSymbol('NVDAX')).toBe('NVDAx');
    expect(canonicalSymbol('nvdax')).toBe('NVDAx');
    expect(canonicalSymbol('TSLAX')).toBe('TSLAx');
    expect(canonicalSymbol('googlx')).toBe('GOOGLx');
  });

  it('every registered symbol survives the round trip that broke them', () => {
    for (const key of Object.keys(TOKENS)) {
      expect(canonicalSymbol(key), `${key} did not resolve to itself`).toBe(key);
      expect(canonicalSymbol(key.toUpperCase()), `${key} lost its casing`).toBe(key);
      expect(canonicalSymbol(key.toLowerCase()), `${key} lost its casing`).toBe(key);
      // The property the routes depend on: a resolved symbol is a key.
      expect(canonicalSymbol(key.toUpperCase()) in TOKENS).toBe(true);
    }
  });

  it('crypto still normalises the way it always did', () => {
    expect(canonicalSymbol('weth')).toBe('WETH');
    expect(canonicalSymbol(' usdc ')).toBe('USDC');
    expect(canonicalSymbol('xbtc')).toBe('XBTC');
    expect(canonicalSymbol('Wokb')).toBe('WOKB');
    expect(canonicalSymbol('usdt0')).toBe('USDT0');
  });

  it('an unknown symbol comes back unchanged, for the caller to reject by name', () => {
    // Not silently mapped to something tradable — the error should name what was asked for.
    expect(canonicalSymbol('DOGE')).toBe('DOGE');
    expect(canonicalSymbol('DOGE') in TOKENS).toBe(false);
    // The Base build's spellings are not quietly mapped onto X Layer's.
    expect(canonicalSymbol('NVDAc')).toBe('NVDAc');
    expect(canonicalSymbol('NVDAc') in TOKENS).toBe(false);
    expect(canonicalSymbol('CBBTC') in TOKENS).toBe(false);
  });
});
