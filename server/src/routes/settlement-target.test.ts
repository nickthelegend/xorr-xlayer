/**
 * A strategy cannot buy the token it pays with.
 *
 * The app's recurring-buy sheet listed WETH, CBBTC and **USDC**, and `POST /strategies` accepted
 * all three: USDC is a token this executor knows, so the schema check passed, and it is not an
 * equity, so the settleability check passed too. "Buy $50 of USDC, weekly" was therefore created,
 * scheduled, and would have failed on every run until someone noticed — 1inch refuses a swap whose
 * source and destination match, verbatim:
 *
 *   {"error":"Bad Request","description":"src and dst should be different","statusCode":400}
 *
 * Found by opening the sheet on a simulator and tapping USDC. The affordance is gone from the app,
 * but the executor is what has to hold the line: a guard only the client enforces is not a guard.
 *
 * The symbol comparison mirrors the route's, through `canonicalSymbol`, because the equities are
 * spelled `NVDAc` and an uppercase compare here would be a second, subtly different definition of
 * "the same symbol" — which is how two checks drift apart until one of them means nothing.
 */
import { describe, expect, it } from 'vitest';

// The venue module refuses to load unconfigured, and ESM hoists imports above assignments — so
// the registry is pulled in dynamically, after the environment it checks for exists. Same shape
// as symbols.test.ts, for the same reason.
process.env.ONEINCH_API_KEY ??= 'test-key';
process.env.XORR_CHAIN ??= 'base-sepolia';
const { SETTLEMENT_SYMBOL, TOKENS, canonicalSymbol } = await import('../venues/oneinch.js');

/**
 * The rule under test, kept in step with `POST /strategies`.
 *
 * The `kind` half matters as much as the symbol. A first version refused every USDC strategy and
 * would have broken `yield-rotation`, the tier that sweeps idle USDC into Aave and is correctly
 * `symbol: 'USDC'` — it supplies to a pool, it does not swap USDC for USDC.
 */
const BUYS_ITS_SYMBOL: readonly string[] = ['dca', 'grid', 'momentum', 'event-driven'];
function refusesAsTarget(symbol: string, kind = 'dca'): boolean {
  return BUYS_ITS_SYMBOL.includes(kind) && canonicalSymbol(symbol) === SETTLEMENT_SYMBOL;
}

describe('the settlement token is not a buy target', () => {
  it('refuses the exact strategy the recurring-buy sheet used to offer', () => {
    expect(refusesAsTarget('USDC')).toBe(true);
  });

  it('refuses it however it was spelled on the way in', () => {
    expect(refusesAsTarget('usdc')).toBe(true);
    expect(refusesAsTarget('Usdc')).toBe(true);
  });

  it('still allows everything a buy can actually route into', () => {
    for (const symbol of ['WETH', 'CBBTC', 'NVDAc', 'AAPLc']) {
      expect(refusesAsTarget(symbol)).toBe(false);
    }
  });

  it('leaves the tier that legitimately works in USDC alone', () => {
    // Sweeping idle cash into Aave is a supply, not a swap. Refusing it would delete a whole tier.
    expect(refusesAsTarget('USDC', 'yield-rotation')).toBe(false);
    // And the kinds that do buy their symbol are still refused.
    for (const kind of ['dca', 'grid', 'momentum', 'event-driven']) {
      expect(refusesAsTarget('USDC', kind)).toBe(true);
    }
  });

  it('names a token the executor actually knows, so the guard cannot be dead code', () => {
    // If SETTLEMENT_SYMBOL is ever renamed out of TOKENS, the guard silently stops matching
    // anything and USDC becomes creatable again with no test failing anywhere else.
    expect(TOKENS[SETTLEMENT_SYMBOL]).toBeDefined();
  });
});
