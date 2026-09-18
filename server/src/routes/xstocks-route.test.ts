/**
 * GET /market/xstocks, through the route.
 *
 * `venues/xstocks-catalog.test.ts` pins how a row is built. This pins the envelope around it: the
 * sectors the filter is offered, the count of what could not be priced, and — the part that would
 * silently break the screen — that a catalog nothing would price is still a 200 with every row in
 * it, not an error and not a short list.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';

const h = vi.hoisted(() => ({
  getJson: vi.fn(),
  staleValue: vi.fn(),
  xStockQuote: vi.fn(),
  requireUser: vi.fn(),
}));

vi.mock('../http/get.js', () => ({ getJson: h.getJson, staleValue: h.staleValue }));
// The catalog is public; the quote beside it is not. Authentication itself is `auth`'s to prove.
vi.mock('../auth/middleware.js', () => ({ requireUser: h.requireUser, WrongPrincipalError: class extends Error {} }));
vi.mock('../venues/xstocks-quote.js', async (orig) => ({
  ...(await orig<typeof import('../venues/xstocks-quote.js')>()),
  xStockQuote: h.xStockQuote,
}));

const NVDAX = 'Xsc9qvGR1efVDFGLrVsmkzv3qi45LTBjeUKSPmx9qEh';
const SPYX = 'XsoCS1TfEyfFhfvj8EtZ528L3CaKBDBRqRapnBbDF2W';

async function call(path = '/market/xstocks'): Promise<{ status: number; body: any }> {
  const { xstockRoutes } = await import('./xstocks.js');
  const app = new Hono().route('/', xstockRoutes);
  const res = await app.request(path);
  return { status: res.status, body: await res.json() };
}

beforeEach(() => {
  vi.resetModules();
  h.getJson.mockReset();
  h.staleValue.mockReset().mockReturnValue(undefined);
  h.requireUser.mockReset();
  h.xStockQuote.mockReset().mockResolvedValue({ symbol: 'NVDAx', side: 'buy', usd: 250 });
});

describe('with prices', () => {
  beforeEach(() => {
    h.getJson.mockResolvedValue({
      [NVDAX]: { usdPrice: 215.92, priceChange24h: 1.08, stockData: { price: 215.68 } },
      [SPYX]: { usdPrice: 759.95, priceChange24h: 0.31 },
    });
  });

  it('returns every catalogued mint, priced or not', async () => {
    const { status, body } = await call();
    const { XSTOCKS } = await import('../venues/xstocks.js');

    expect(status).toBe(200);
    expect(body.rows).toHaveLength(Object.keys(XSTOCKS).length);
    expect(body.rows.find((r: any) => r.symbol === 'NVDAx').price).toBeCloseTo(215.92, 2);
  });

  it('counts what it could not price', async () => {
    const { body } = await call();
    const { XSTOCKS } = await import('../venues/xstocks.js');

    // Two of eleven answered, so nine did not, and the screen is told rather than made to count.
    expect(body.unpriced).toBe(Object.keys(XSTOCKS).length - 2);
    expect(body.rows.filter((r: any) => r.feed === 'unavailable')).toHaveLength(body.unpriced);
  });

  it('publishes the sectors the filter offers, the ETF bucket last', async () => {
    const { body } = await call();

    expect(body.sectors).toContain('Technology');
    expect(body.sectors.at(-1)).toBe('Index funds');
    // Derived from the tokens: no sector is offered that nothing is filed under.
    const used = new Set(body.rows.map((r: any) => r.sector));
    for (const s of body.sectors) expect(used.has(s)).toBe(true);
  });
});

describe('with no prices at all', () => {
  it('is still a full catalog and still a 200', async () => {
    h.getJson.mockRejectedValue(new Error('ENOTFOUND lite-api.jup.ag'));

    const { status, body } = await call();
    const { XSTOCKS } = await import('../venues/xstocks.js');

    /*
     * The screen renders this. An error here would put a retry button where the answer belongs —
     * and the answer, on a cluster whose mints this feed does not know, is that these exist and
     * cannot be priced. That is information, not a failure.
     */
    expect(status).toBe(200);
    expect(body.rows).toHaveLength(Object.keys(XSTOCKS).length);
    expect(body.unpriced).toBe(body.rows.length);
    expect(body.rows.every((r: any) => r.price === null)).toBe(true);
    // The facts about each listing are not market data and survive the outage.
    expect(body.rows.every((r: any) => r.name && r.sector && r.address)).toBe(true);
  });
});

describe('the order breakdown', () => {
  it('asks for the size and side given, at the executor’s default tolerance', async () => {
    const { status } = await call('/market/xstocks/quote?symbol=NVDAx&side=sell&usd=250');
    const { DEFAULT_SLIPPAGE_BPS } = await import('../venues/xstocks-quote.js');

    expect(status).toBe(200);
    expect(h.xStockQuote).toHaveBeenCalledWith({
      symbol: 'NVDAx',
      side: 'sell',
      usd: 250,
      slippageBps: DEFAULT_SLIPPAGE_BPS,
    });
  });

  it('is behind a session, unlike the catalog', async () => {
    // A catalogue entry is a public fact about a listed asset. This is one person’s order at one
    // size, and it costs an upstream request per call.
    await call('/market/xstocks/quote?symbol=NVDAx&side=buy&usd=250');
    expect(h.requireUser).toHaveBeenCalled();
  });

  it('refuses a tolerance outside the bounds rather than clamping it', async () => {
    // Clamped, a ticket that asked for 0.1% would be quoted at 3% and show a floor nobody agreed
    // to — and the person reading it has no way to tell.
    const { status, body } = await call('/market/xstocks/quote?symbol=NVDAx&side=buy&usd=250&slippageBps=900');

    expect(status).toBe(400);
    expect(body.error).toBe('invalid_slippage');
    expect(h.xStockQuote).not.toHaveBeenCalled();
  });

  it.each([
    ['?symbol=NVDAx&side=sideways&usd=250', 'invalid_side'],
    ['?symbol=NVDAx&side=buy&usd=0', 'invalid_amount'],
    ['?symbol=NVDAx&side=buy&usd=abc', 'invalid_amount'],
  ])('refuses %s', async (qs, error) => {
    const { status, body } = await call(`/market/xstocks/quote${qs}`);
    expect(status).toBe(400);
    expect(body.error).toBe(error);
  });

  it('answers a pair nobody will price as no quote, not as a breakdown of zeroes', async () => {
    const { UnpricedError } = await import('../venues/jupiter.js');
    h.xStockQuote.mockRejectedValue(new UnpricedError('No Jupiter quote for USDC -> NVDAx: 429'));

    const { status, body } = await call('/market/xstocks/quote?symbol=NVDAx&side=buy&usd=250');

    // Zeroes on this screen read as a free trade. The ticket renders this as "nobody would price
    // it", which is a different sentence from "something broke".
    expect(status).toBe(502);
    expect(body.error).toBe('no_quote');
    expect(body.detail).toMatch(/429/);
  });
});
