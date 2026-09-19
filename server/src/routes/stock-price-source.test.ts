/**
 * Where a stock's PRICE comes from, as opposed to where a FILL is quoted.
 *
 * On a fork of X Layer the pools are frozen at the block it was taken from, so a price read there never moves. The
 * snapshot behind `/market/stocks` — the hero on every stock screen and every market row — was read that way: NVDAx
 * showed $220.17 while the same deployment's recorded history and its agent had it at $222.52, so the headline
 * disagreed with the chart under it. A price asks the market (`market: true`); a fill still asks the chain it settles
 * on, because that is the liquidity the transaction will touch.
 */
import { describe, expect, it, vi } from 'vitest';

vi.hoisted(() => {
  process.env.XORR_CHAIN = 'xlayer-fork';
  process.env.PRIVY_APP_ID = 'test';
  process.env.PRIVY_APP_SECRET = 'test';
});

const quote = vi.fn(async () => ({ outAmount: 0.0045, venues: ['Uniswap v3'], route: 'Uniswap v3', minimumOut: 0, priceImpactPct: null }));
vi.mock('../venues/uniswap.js', () => ({ quote: (a: unknown) => quote(a), VENUE_NAME: 'Uniswap v3' }));
vi.mock('../db/index.js', () => ({ query: async () => [], one: async () => null, pool: { end: async () => undefined } }));

const { market } = await import('./market.js');

describe('/market/stocks', () => {
  it('prices every stock against the market, never the fork it settles on', async () => {
    const res = await market.request('/market/stocks');
    expect(res.status).toBe(200);
    const rows = (await res.json()) as { symbol: string; price: number | null }[];
    expect(rows.length).toBeGreaterThan(0);
    expect(quote).toHaveBeenCalled();
    for (const call of quote.mock.calls) {
      expect((call[0] as { market?: boolean }).market).toBe(true);
      expect((call[0] as { inSymbol: string }).inSymbol).toBe('USDC');
    }
  });
});
