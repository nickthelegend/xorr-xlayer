/**
 * A logo lookup has two ways of coming back empty, and they are not the same thing.
 *
 * "Both registries were asked and neither has one" is a fact about the instrument — true of every
 * commodity, index and pre-IPO name in the list, and true tomorrow as well. "CoinGecko rate-limited
 * us" is a fact about the next thirty seconds.
 *
 * The first version cached both as `{url: null}`, so a single 429 during the first market load
 * marked Bitcoin as having no logo for the life of the process. These pin the distinction, because
 * the two look identical at the call site and only the cache can tell them apart.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';

process.env.XORR_CHAIN ??= 'xlayer-testnet';

const getJson = vi.fn();
vi.mock('../http/get.js', () => ({
  getJson: (url: string, ttl?: number, timeout?: number, headers?: unknown, opts?: unknown) =>
    getJson(url, ttl, timeout, headers, opts),
  staleValue: () => undefined,
  UpstreamUnavailable: class extends Error {},
}));

const { logoFor, logosFor, resetLogoCache, warmLogos } = await import('./logos.js');

const issuer = (url: string) => url.includes('api.xstocks.fi');
const coingecko = (url: string) => url.includes('coingecko.com');

beforeEach(() => {
  getJson.mockReset();
  resetLogoCache();
});

describe('a decided answer', () => {
  it('takes the issuer\'s logo for a wrapped xStock', async () => {
    getJson.mockImplementation(async (url: string) =>
      issuer(url) ? { logo: 'https://xstocks-metadata.backed.fi/logos/tokens/TSLAx.png' } : [],
    );
    expect(await logoFor('TSLAx')).toEqual({
      url: 'https://xstocks-metadata.backed.fi/logos/tokens/TSLAx.png',
      source: 'xstocks',
    });
  });

  it('falls through to CoinGecko for a symbol priced by a feed', async () => {
    getJson.mockImplementation(async (url: string) => {
      if (issuer(url)) throw new Error('404 not an xStock');
      return [{ id: 'bitcoin', image: 'https://coin-images.coingecko.com/1/bitcoin.png' }];
    });
    expect(await logoFor('BTC')).toEqual({
      url: 'https://coin-images.coingecko.com/1/bitcoin.png',
      source: 'coingecko',
    });
  });

  it('answers null for an instrument no registry issues, and never asks again', async () => {
    // SPX is an index. There is no token and no coin, so nothing is asked of any upstream.
    expect(await logoFor('SPX')).toEqual({ url: null, source: null });
    expect(getJson).not.toHaveBeenCalled();

    await logoFor('SPX');
    expect(getJson).not.toHaveBeenCalled();
  });

  it('caches a resolved logo rather than re-asking', async () => {
    getJson.mockImplementation(async (url: string) =>
      issuer(url) ? { logo: 'https://xstocks-metadata.backed.fi/logos/tokens/TSLAx.png' } : [],
    );
    await logoFor('TSLAx');
    const calls = getJson.mock.calls.length;
    await logoFor('TSLAx');
    expect(getJson.mock.calls.length).toBe(calls);
  });
});

describe('an upstream that would not answer', () => {
  it('is not cached as "this symbol has no logo"', async () => {
    getJson.mockImplementation(async (url: string) => {
      if (issuer(url)) throw new Error('404 not an xStock');
      throw new Error('429 after 1 attempts');
    });
    expect(await logoFor('BTC')).toBeUndefined();

    // The rate limit lifts; the next ask resolves rather than returning a cached null.
    getJson.mockImplementation(async (url: string) => {
      if (issuer(url)) throw new Error('404 not an xStock');
      return [{ id: 'bitcoin', image: 'https://coin-images.coingecko.com/1/bitcoin.png' }];
    });
    expect(await logoFor('BTC')).toEqual({
      url: 'https://coin-images.coingecko.com/1/bitcoin.png',
      source: 'coingecko',
    });
  });

  it('leaves the symbol absent from the batch, rather than present and null', async () => {
    getJson.mockImplementation(async (url: string) => {
      if (issuer(url)) return { logo: 'https://xstocks-metadata.backed.fi/logos/tokens/TSLAx.png' };
      throw new Error('429 after 1 attempts');
    });
    const out = await logosFor(['TSLAx', 'BTC', 'SPX']);
    // Present and resolved, present and honestly null, and absent because we could not ask.
    expect(out.TSLAx?.source).toBe('xstocks');
    expect(out.SPX).toEqual({ url: null, source: null });
    expect('BTC' in out).toBe(false);
  });
});

describe('what it costs', () => {
  it('asks CoinGecko once for the whole batch, not once per symbol', async () => {
    getJson.mockImplementation(async (url: string) => {
      if (issuer(url)) throw new Error('404 not an xStock');
      return [
        { id: 'bitcoin', image: 'b.png' },
        { id: 'solana', image: 's.png' },
        { id: 'ripple', image: 'x.png' },
      ];
    });
    await logosFor(['BTC', 'SOL', 'XRP']);
    const cg = getJson.mock.calls.filter((c) => coingecko(String(c[0])));
    expect(cg.length).toBe(1);
  });

  it('never spends a price’s retry budget on a logo', async () => {
    // The ladder is five attempts with exponential backoff — about twenty-five seconds, in a host
    // lane a price is queued behind. A logo gets one attempt and the gradient.
    getJson.mockImplementation(async (url: string) =>
      issuer(url) ? { logo: 'https://xstocks-metadata.backed.fi/logos/tokens/TSLAx.png' } : [],
    );
    await logosFor(['TSLAx', 'BTC']);
    for (const call of getJson.mock.calls) expect(call[4]).toEqual({ attempts: 1 });
  });
});

describe('warming at boot (E106)', () => {
  it('asks again after a rate limit, and the next ask for BTC is answered from what it fetched', async () => {
    let asked = 0;
    getJson.mockImplementation(async (url: string) => {
      if (issuer(url)) throw new Error('404 not an xStock');
      asked += 1;
      if (asked === 1) throw new Error('429 after 1 attempts');
      return [{ id: 'bitcoin', image: 'https://coin-images.coingecko.com/1/bitcoin.png' }];
    });

    expect(await warmLogos(3, 0)).toBe(true);
    expect(asked).toBe(2);

    expect(await logoFor('BTC')).toEqual({
      url: 'https://coin-images.coingecko.com/1/bitcoin.png',
      source: 'coingecko',
    });
    // Answered from the warm batch: nothing more was asked of CoinGecko.
    expect(asked).toBe(2);
  });

  it('stops after its attempts, each a single try, rather than asking forever', async () => {
    getJson.mockImplementation(async () => {
      throw new Error('429 after 1 attempts');
    });

    expect(await warmLogos(3, 0)).toBe(false);
    const calls = getJson.mock.calls.filter((c) => coingecko(String(c[0])));
    expect(calls).toHaveLength(3);
    for (const call of calls) expect(call[4]).toEqual({ attempts: 1 });
  });
});
