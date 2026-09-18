/**
 * An alert that can never fire must not be creatable.
 *
 * `config` was `.default({})` and nothing checked it, so `POST /alerts` accepted a price alert
 * with no level. `evaluate` then reports it `unevaluable` on every sweep, forever — correct for a
 * row that already exists, wrong to let anyone create. The user gets an entry in their list that
 * will never go off, and finds out by waiting for the thing it was meant to warn about.
 *
 * And the same alert twice is not two alerts: resubmitting an identical one created a second row
 * that fires alongside the first, notifies twice, and has to be deleted twice.
 *
 * The validation mirrors `verdictFor` deliberately. A second, looser definition of "valid" is how
 * the two drift apart until the check means nothing.
 */
import { describe, expect, it } from 'vitest';
import { unevaluableReason } from './alerts.js';

/*
 * The REAL function, imported — this file used to carry a copy of it, annotated "kept in step with
 * `unevaluableReason` in the route".
 *
 * It was not kept in step, and that is the whole hazard: a test that reimplements what it tests
 * passes forever while the thing it stands for changes underneath. The route grew a symbol check
 * and this file never knew, so a price alert on a symbol nothing can price stayed creatable with
 * five green tests sitting over it.
 */
type Body = { kind: 'price' | 'agent' | 'risk'; symbol?: string; config: Record<string, unknown> };
const check = (b: Body) => unevaluableReason({ name: 'n', detail: '', ...b } as never);

describe('a price alert needs something to compare against', () => {
  it('rejects the empty config the API used to accept', () => {
    // Exactly the request that created a dead alert on the deployed executor.
    expect(check({ kind: 'price', symbol: 'WETH', config: {} })).toContain('above');
  });
  it('rejects a level with no symbol', () => {
    expect(check({ kind: 'price', config: { above: 95 } })).toContain('symbol');
  });
  it('accepts either side of the level', () => {
    expect(check({ kind: 'price', symbol: 'WETH', config: { above: 95 } })).toBeUndefined();
    expect(check({ kind: 'price', symbol: 'WETH', config: { below: 95 } })).toBeUndefined();
    // Zero is a real level, not a missing one.
    expect(check({ kind: 'price', symbol: 'WETH', config: { below: 0 } })).toBeUndefined();
  });
});

describe('the other two kinds carry their own requirement', () => {
  it('an agent alert needs blockedRuns', () => {
    expect(check({ kind: 'agent', config: {} })).toContain('blockedRuns');
    expect(check({ kind: 'agent', config: { blockedRuns: 3 } })).toBeUndefined();
  });
  it('a risk alert needs one of its three triggers', () => {
    expect(check({ kind: 'risk', config: {} })).toContain('capRemainingUsd');
    expect(check({ kind: 'risk', config: { capRemainingUsd: 100 } })).toBeUndefined();
    expect(check({ kind: 'risk', config: { expiresWithinHours: 24 } })).toBeUndefined();
    expect(check({ kind: 'risk', config: { revoked: true } })).toBeUndefined();
    // `revoked: false` is not a trigger — it is the normal state of every wallet.
    expect(check({ kind: 'risk', config: { revoked: false } })).toContain('capRemainingUsd');
  });
});

/*
 * The gap the copy hid. `priceOf` — which is what the evaluator calls — prices an equity through
 * the venue that would fill it and everything else through the feed table; a symbol in neither
 * can never produce a comparison, so the alert can never fire.
 */
describe('a price alert needs a symbol something can price', () => {
  const price = (symbol: string | undefined, config: Record<string, unknown> = { above: 100 }) =>
    check({ kind: 'price', symbol, config });

  it('accepts the symbols the feed table knows', () => {
    for (const s of ['WETH', 'CBBTC', 'BTC']) expect(price(s)).toBeUndefined();
  });

  it('accepts a tokenized equity', () => {
    expect(price('NVDAc')).toBeUndefined();
    // And keeps the suffix: uppercasing works for every crypto symbol and breaks all eight equities.
    expect(price('nvdac')).toBeUndefined();
  });

  it('refuses a symbol nothing prices, naming it as the caller spelled it', () => {
    const why = price("WETH'; DROP TABLE alerts;--");
    expect(why).toContain('could never fire');
    expect(why).toContain("WETH'; DROP TABLE alerts;--");
  });
});
