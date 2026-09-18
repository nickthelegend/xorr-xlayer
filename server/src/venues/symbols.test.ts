/**
 * Tokenized equities are `NVDAc` and `TSLAc`, and the routes normalised symbols with
 * `.toUpperCase()`.
 *
 * `NVDAc` became `NVDAC`, which is not a key in `TOKENS`. So `/swap/quote?out=NVDAc` answered
 * **`502 No route for USDC -> NVDAC`** and the order ticket for the entire stocks track could not
 * price a single trade. `/orders` and the panic flatten resolved the same way, so an equity
 * position could not be opened, closed, or flattened either.
 *
 * It survived because every crypto symbol is already all-caps: uppercasing is correct for BTC,
 * ETH, WETH, USDC and CBBTC, which is everything anyone tested by hand.
 */
import { describe, expect, it } from 'vitest';

// The venue module refuses to load unconfigured, and ESM hoists imports above assignments — so
// the registry is pulled in dynamically, after the environment it checks for exists.
process.env.ONEINCH_API_KEY ??= 'test-key';
process.env.XORR_CHAIN ??= 'base-sepolia';
const { canonicalSymbol, TOKENS } = await import('./oneinch.js');

describe('a symbol resolves to the registry spelling, whatever the caller sent', () => {
  it('keeps the lowercase suffix that makes an equity an equity', () => {
    expect(canonicalSymbol('NVDAc')).toBe('NVDAc');
    // What the routes actually sent, and the reason every equity quote failed.
    expect(canonicalSymbol('NVDAC')).toBe('NVDAc');
    expect(canonicalSymbol('nvdac')).toBe('NVDAc');
    expect(canonicalSymbol('TSLAC')).toBe('TSLAc');
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
    expect(canonicalSymbol('CBBTC')).toBe('CBBTC');
  });

  it('an unknown symbol comes back unchanged, for the caller to reject by name', () => {
    // Not silently mapped to something tradable — the error should name what was asked for.
    expect(canonicalSymbol('DOGE')).toBe('DOGE');
    expect(canonicalSymbol('DOGE') in TOKENS).toBe(false);
  });
});
