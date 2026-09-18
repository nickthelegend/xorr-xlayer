/**
 * What the Jupiter client does when nobody will price a pair.
 *
 * It used to answer anyway, from a table of remembered share prices, in the shape of a real quote —
 * a `priceImpactPct` nobody measured and a route plan naming a pool never consulted. That mattered
 * beyond the display: `executor/place.ts` hands the quote straight to `swap()`, and the venue vault
 * settles a real on-chain transfer at whatever price it is given. So an unreachable API did not stop
 * trading, it traded at an invented number.
 *
 * These cases pin the two halves of the replacement: a real answer is passed through untouched, and
 * no answer raises `UnpricedError` rather than producing one.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const NVDAX = 'Xsc9qvGR1efVDFGLrVsmkzv3qi45LTBjeUKSPmx9qEh';
const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

/** A quote as Jupiter's v1 API actually shapes one. */
const REAL_QUOTE = {
  inputMint: USDC,
  inAmount: '1000000000',
  outputMint: NVDAX,
  outAmount: '463125000',
  otherAmountThreshold: '460809375',
  swapMode: 'ExactIn',
  slippageBps: 50,
  priceImpactPct: '0.0013',
  routePlan: [{ swapInfo: { label: 'Whirlpool', inAmount: '1000000000', outAmount: '463125000' } }],
};

const fetchMock = vi.fn();

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
  // Every case here is about the quote leg alone; nothing reaches a validator.
  vi.stubEnv('XORR_CHAIN', 'solana-fork');
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe('a quote that exists', () => {
  it('is returned as the venue sent it', async () => {
    fetchMock.mockResolvedValue({ ok: true, json: async () => REAL_QUOTE });
    const { quote } = await import('./jupiter.js');

    const q = await quote({ inSymbolOrMint: 'USDC', outSymbolOrMint: NVDAX, amountUnits: 1_000_000_000 });

    // Field for field: the breakdown the order ticket shows is read off this object, so a client
    // that reshaped it would be showing its own arithmetic as the venue's.
    expect(q.outAmount).toBe('463125000');
    expect(q.priceImpactPct).toBe('0.0013');
    expect(q.slippageBps).toBe(50);
    expect(q.routePlan?.[0]?.swapInfo.label).toBe('Whirlpool');
  });
});

describe('a quote that does not', () => {
  it('raises rather than inventing a price', async () => {
    fetchMock.mockRejectedValue(new Error('getaddrinfo ENOTFOUND api.jup.ag'));
    const { quote, UnpricedError } = await import('./jupiter.js');

    await expect(
      quote({ inSymbolOrMint: 'USDC', outSymbolOrMint: NVDAX, amountUnits: 1_000_000_000 }),
    ).rejects.toBeInstanceOf(UnpricedError);
  });

  it('says which pair it could not price, and why', async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 429, text: async () => 'rate limited' });
    const { quote } = await import('./jupiter.js');

    // The pair and the upstream's own words. A caller logging this can tell a missing route from a
    // throttle without reading this file.
    await expect(
      quote({ inSymbolOrMint: 'USDC', outSymbolOrMint: NVDAX, amountUnits: 1_000_000_000 }),
    ).rejects.toThrow(/Xsc9qv.*429|429.*Xsc9qv/s);
  });

  it('treats a response missing outAmount as no quote at all', async () => {
    // A 200 with an error body. The old code took the absence of `outAmount` as a cue to make one up.
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({ error: 'Could not find any route' }) });
    const { quote, UnpricedError } = await import('./jupiter.js');

    await expect(
      quote({ inSymbolOrMint: 'USDC', outSymbolOrMint: NVDAX, amountUnits: 1_000_000_000 }),
    ).rejects.toBeInstanceOf(UnpricedError);
  });
});
