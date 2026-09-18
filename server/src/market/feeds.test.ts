/**
 * What prices a symbol, held to what actually prices it.
 *
 * `unevaluableReason` refuses a price alert on a symbol nothing can price, so that an alert cannot
 * sit in someone's list and never fire. That check used to keep its own list, and the docblock
 * beside it already warned why: "a second, looser definition of valid here is how the two drift
 * apart and the check stops meaning anything."
 *
 * They then drifted the other way. The executor grew a price for xStocks and the alert route
 * never heard, so `POST /alerts` refused an alert on NVDAx saying nothing could price it — while
 * `venues/xstocks.ts` was pricing it all day. A refusal that is WRONG is worse than the bug it was
 * written to prevent: the original fault was an alert that never fired, and this was an alert the
 * user was not allowed to make, for a reason that was not true.
 *
 * So both read `feedFor`, and these cases hold that one definition to `priceOf` in both directions.
 */
import { describe, expect, it, vi } from 'vitest';

vi.mock('../db/index.js', () => ({ query: vi.fn(), one: vi.fn() }));

const { feedFor, priceable } = await import('./feeds.js');
const { COINGECKO_IDS } = await import('./ids.js');
const { STOCKS } = await import('../venues/stocks.js');
const { XSTOCKS } = await import('../venues/xstocks.js');

describe('which feed answers for a symbol', () => {
  it('sends a wrapped xStock on X Layer to the Uniswap pools that would fill it', () => {
    expect(Object.keys(XSTOCKS).length).toBeGreaterThan(0);
    for (const symbol of Object.keys(XSTOCKS)) expect(feedFor(symbol), symbol).toBe('xstock');
  });

  it('prices every equity in the trade registry the same way — one registry, one feed', () => {
    // `STOCKS` (what trades) and `XSTOCKS` (the catalog) are one list on X Layer. An equity that
    // fell through to the crypto feed would find no id and throw on every sweep.
    expect(Object.keys(STOCKS).sort()).toEqual(Object.keys(XSTOCKS).sort());
    for (const symbol of Object.keys(STOCKS)) expect(feedFor(symbol), symbol).toBe('xstock');
  });

  it('sends everything with a market-data entry to the crypto feed', () => {
    for (const symbol of Object.keys(COINGECKO_IDS)) expect(feedFor(symbol), symbol).toBe('crypto');
  });

  it('does not take another chain\'s spelling of the same company for this one', () => {
    // `NVDAc` was NVIDIA on the Base build. On X Layer it is `NVDAx`, and the old spelling is priced
    // by nothing — not silently answered with the xStock's price.
    expect(feedFor('NVDAx')).toBe('xstock');
    expect(feedFor('NVDAc')).toBeNull();
  });

  it('resolves through canonicalSymbol rather than uppercasing', () => {
    /*
     * Rule 3 in `venues/tokens.ts`, which three separate production bugs came from breaking.
     * Uppercasing turns `TSLAx` into `TSLAX`, a symbol no registry has ever heard of.
     */
    expect(feedFor('tslax')).toBe('xstock');
    expect(feedFor('weth')).toBe('crypto');
    expect(feedFor('  WETH  ')).toBe('crypto');
    expect(feedFor('xbtc')).toBe('crypto');
  });

  it('is case-insensitive about an xStock without losing its spelling', () => {
    expect(feedFor('nvdax')).toBe('xstock');
    expect(feedFor('NVDAX')).toBe('xstock');
  });

  it('answers null for a symbol nothing prices', () => {
    for (const nonsense of ['NOPE', '', "WETH'; DROP TABLE alerts;--", 'DOGECOIN9000']) {
      expect(feedFor(nonsense), nonsense).toBeNull();
      expect(priceable(nonsense), nonsense).toBe(false);
    }
  });
});

describe('the alert route and the price feed agree', () => {
  /** The refusal, asked of the real route module. */
  async function refusalFor(symbol: string): Promise<string | undefined> {
    const { unevaluableReason } = await import('../routes/alerts.js');
    return unevaluableReason({
      kind: 'price',
      symbol,
      name: 'test',
      detail: 'test',
      config: { above: 100 },
    } as never);
  }

  it('accepts every symbol something can price', async () => {
    // An alert refused for a symbol that HAS a feed is a user told a falsehood about their own app.
    for (const symbol of [...Object.keys(XSTOCKS), ...Object.keys(STOCKS), 'WETH', 'BTC']) {
      expect(await refusalFor(symbol), symbol).toBeUndefined();
    }
  });

  it('refuses every symbol nothing can price, and says why', async () => {
    const reason = await refusalFor('NOPE');
    expect(reason).toBe('nothing prices NOPE, so this alert could never fire');
  });

  it('refuses in the user’s own spelling, not the canonical one', async () => {
    // "nothing prices nvda-x" is a sentence someone can match against what they typed.
    expect(await refusalFor('nvda-x')).toContain('nvda-x');
  });

  it('still refuses a price alert with no symbol at all', async () => {
    const { unevaluableReason } = await import('../routes/alerts.js');
    expect(
      unevaluableReason({ kind: 'price', name: 'x', detail: 'x', config: { above: 1 } } as never),
    ).toBe('a price alert needs a symbol');
  });

  it('still refuses a price alert with no level to watch', async () => {
    const { unevaluableReason } = await import('../routes/alerts.js');
    expect(
      unevaluableReason({
        kind: 'price',
        symbol: 'NVDAx',
        name: 'x',
        detail: 'x',
        config: {},
      } as never),
    ).toBe('a price alert needs an `above` or `below` level in config');
  });

  it('every feed the refusal accepts has a branch in priceOf', async () => {
    /*
     * The direction that actually bit. `priceOf` dispatches on `feedFor`, so a feed added to the
     * union without a branch there would be accepted at creation and throw on every sweep — the
     * original never-fires bug, reintroduced from the other end.
     */
    const source = await import('node:fs').then((fs) =>
      fs.readFileSync(new URL('./prices.ts', import.meta.url), 'utf8'),
    );
    for (const feed of ['xstock', 'equity'] as const) {
      expect(source, feed).toContain(`feed === '${feed}'`);
    }
    // `crypto` is the fall-through: it is what the rest of the function does.
    expect(source).toContain('feedFor');
  });
});
