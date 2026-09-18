/**
 * LIVE — the client's tradable list must equal the executor's token registry.
 *
 * If these drift the app offers a Buy the executor cannot settle, which is worse than offering
 * nothing: the user gets a strategy row that silently never fills.
 */
import { describe, expect, it } from 'vitest';
import { TRADABLE } from './tradable';
import { API_BASE } from './apiBase';

describe('tradable set', () => {
  it('is a subset of the executor, never a superset', async () => {
    /*
     * Equality was the wrong assertion, and it hid the bug it was written to catch.
     *
     * `TRADABLE` mirrors the token REGISTRY — the symbols this build knows how to route.
     * `/market/tradable` answers a narrower question: what this DEPLOYMENT can settle. They
     * legitimately differ on the tokenized equities, whose wrappers are real on X Layer mainnet and
     * have no code on its testnet. Demanding equality forced the two to agree by making the server
     * lie, and the app offered a Buy button for assets whose fills revert.
     *
     * The invariant that actually matters is one-directional: the executor may serve FEWER symbols
     * than the client knows, never more. A symbol the client would offer and the server cannot
     * settle is the bug; a symbol the server settles and the client never offers is merely unused.
     */
    const res = await fetch(`${API_BASE}/market/tradable`);
    expect(res.status, 'executor must serve /market/tradable without auth').toBe(200);
    const rows = (await res.json()) as { symbol: string }[];
    const served = rows.map((r) => r.symbol);

    const unknown = served.filter((s) => !(TRADABLE as readonly string[]).includes(s));
    expect(unknown, 'executor serves symbols the client has never heard of').toEqual([]);

    /*
     * The routable crypto is settleable wherever a fill can settle, and nothing is offered where none can (PLAN.md
     * 3.7): the Uniswap v3 router is not deployed on the X Layer testnet, so a listed symbol there was a Buy that
     * could only fail. What a strategy can follow is served on every chain, and always includes them.
     */
    const { chain } = (await (await fetch(`${API_BASE}/health`)).json()) as { chain?: string };
    if (chain === 'xlayer' || chain === 'xlayer-fork') {
      for (const core of ['USDC', 'XBTC', 'WOKB']) {
        expect(served, `${core} must be settleable on ${chain}`).toContain(core);
      }
    } else {
      expect(served, `nothing settles on ${chain}, so nothing is offered`).toEqual([]);
    }
    const watchable = await fetch(`${API_BASE}/market/watchable`);
    expect(watchable.status, 'executor must serve /market/watchable without auth').toBe(200);
    const followed = ((await watchable.json()) as { symbol: string }[]).map((r) => r.symbol);
    for (const core of ['USDC', 'XBTC', 'WOKB']) {
      expect(followed, `${core} can be followed on ${chain}`).toContain(core);
    }
  }, 30_000);

  it('every tradable symbol is priced by one feed or the other', async () => {
    // Crypto is priced by CoinGecko; the tokenized equities have no listing there and are priced
    // off the Uniswap v3 pools that would fill them. Either way a tradable symbol must have a number,
    // or the app has a Buy button it cannot put a price on.
    const [quotes, stocks] = await Promise.all([
      fetch(`${API_BASE}/market/quotes?symbols=${TRADABLE.join(',')}`).then(
        (r) => r.json() as Promise<Record<string, { price: number }>>,
      ),
      fetch(`${API_BASE}/market/stocks`).then(
        (r) => r.json() as Promise<{ symbol: string; price: number | null }[]>,
      ),
    ]);
    const stockPrice = new Map(stocks.map((s) => [s.symbol, s.price]));

    for (const sym of TRADABLE) {
      const price = quotes[sym]?.price ?? stockPrice.get(sym) ?? undefined;
      expect(price, `${sym} is tradable but has no price`).toBeDefined();
      expect(price!).toBeGreaterThan(0);
    }
  }, 60_000);
});

describe('market symbols map to what they settle as', () => {
  it('BTC settles as XBTC and OKB as WOKB — the market is real either way', async () => {
    const { isTradable, settlementSymbol } = await import('./tradable');
    expect(settlementSymbol('BTC')).toBe('XBTC');
    expect(settlementSymbol('OKB')).toBe('WOKB');
    // "BTC is not tradable" would be true in the most useless way while the app buys XBTC.
    expect(isTradable('BTC')).toBe(true);
    expect(isTradable('OKB')).toBe(true);
  });

  it('still refuses a market with no instrument on this chain', async () => {
    const { isTradable } = await import('./tradable');
    // ETH and WETH: WETH is held on X Layer, but no pool holds real liquidity against a stablecoin.
    for (const sym of ['XAUT', 'OPENAI', 'SOL', 'ETH', 'WETH', 'NVDAc']) {
      expect(isTradable(sym), `${sym} should not be tradable on X Layer`).toBe(false);
    }
  });
});
