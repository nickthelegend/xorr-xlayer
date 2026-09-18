/**
 * The backtest, proposal, quote, comparison and decision routes (docs/qa/ENDPOINTS.md E025, E026, E083, E160, E166,
 * E183, E188).
 *
 * A request only the caller can fix is a named 400 or 404 given before any venue, feed or index is asked: never a 502
 * that tells the app to retry an impossible request, and never a 200 carrying a result nobody computed. And an id the
 * app was given is answered as what it names. These drive the real routes with every upstream stood in for.
 */
import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../db/index.js', () => ({ one: vi.fn(), query: vi.fn(), tx: vi.fn() }));
vi.mock('../audit/log.js', () => ({ append: vi.fn(async () => undefined) }));
vi.mock('../backtest/engine.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../backtest/engine.js')>()),
  backtestDca: vi.fn(),
  backtestGrid: vi.fn(),
  backtestMomentum: vi.fn(),
}));
vi.mock('../agents/leaderboard.js', () => ({ leaderboard: vi.fn() }));
vi.mock('../bot/llm.js', () => ({ speak: vi.fn() }));
vi.mock('../bot/tone.js', () => ({ TONE_INSTRUCTIONS: {} }));
vi.mock('../news/feed.js', () => ({ briefing: vi.fn() }));
vi.mock('../bot/propose.js', () => ({ propose: vi.fn() }));
vi.mock('../notifications/push.js', () => ({ send: vi.fn() }));
// The registry and its spelling rule are real; only the venue call is stood in for.
vi.mock('../venues/oneinch.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../venues/oneinch.js')>()),
  quote: vi.fn(),
}));
vi.mock('../evm/gas-price.js', () => ({ gasPrice: vi.fn(), networkCost: vi.fn() }));
vi.mock('../executor/fill-measure.js', () => ({ estimateOutUnits: vi.fn() }));
vi.mock('../venues/compare.js', () => ({ compareVenues: vi.fn() }));
vi.mock('../auth/middleware.js', () => ({
  requireUser: vi.fn(() => ({ userId: 'did:privy:owner' })),
  WrongPrincipalError: class extends Error {},
}));
vi.mock('./wallet-context.js', () => ({
  currentWallet: vi.fn(),
  requireWallet: vi.fn(),
  NoWalletError: class extends Error {},
}));
vi.mock('../executor/order.js', () => ({ armExits: vi.fn(), money: (n: number) => `$${n}`, placeOrder: vi.fn() }));
vi.mock('../evm/delegation.js', () => ({ readPolicy: vi.fn() }));
vi.mock('../graph/decide.js', () => ({ decide: vi.fn() }));
vi.mock('../graph/client.js', () => ({
  health: vi.fn(),
  dailySpendFor: vi.fn(),
  indexDescription: vi.fn(),
  spendsFor: vi.fn(),
  SubgraphUnavailable: class extends Error {},
}));

const { one, tx } = await import('../db/index.js');
const { append } = await import('../audit/log.js');
const { placeOrder } = await import('../executor/order.js');
const engine = await import('../backtest/engine.js');
const { quote } = await import('../venues/oneinch.js');
const { gasPrice, networkCost } = await import('../evm/gas-price.js');
const { setScreenPatienceForTests } = await import('../http/patience.js');
const { compareVenues } = await import('../venues/compare.js');
const { currentWallet } = await import('./wallet-context.js');
const { readPolicy } = await import('../evm/delegation.js');
const { decide } = await import('../graph/decide.js');
const { dailySpendFor, spendsFor, SubgraphUnavailable } = await import('../graph/client.js');
const { extra } = await import('./extra.js');
const { errorResponse } = await import('../http/errors.js');

const app = new Hono();
app.onError(errorResponse);
app.route('/', extra);

const OWNER = '0x95A0b368588713011a15f4b1041423f31B08e615';

type Answer = { status: number; body: Record<string, unknown> };

async function get(path: string): Promise<Answer> {
  const res = await app.request(path);
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

async function post(path: string, body: unknown): Promise<Answer> {
  const res = await app.request(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

/** A refusal as this API writes one: a code a client can branch on, and a sentence for a person. */
function refused(r: Answer, status: number, code: string) {
  expect(r.status, JSON.stringify(r.body)).toBe(status);
  expect(r.body.error).toBe(code);
  expect(r.body.detail).toEqual(expect.stringMatching(/\w+ \w+/));
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(currentWallet).mockResolvedValue({ id: 'wallet-1', address: OWNER } as never);
  vi.mocked(one).mockResolvedValue({ address: OWNER } as never);
});

describe('GET /agents/:id/backtest', () => {
  it('refuses a lookback there is no window for, and replays nothing', async () => {
    const r = await get('/agents/momentum-scout/backtest?lookback=7d');
    refused(r, 400, 'invalid_lookback');
    expect(r.body.detail).toContain('30d, 90d, 6m, 1y');
    expect(engine.backtestMomentum).not.toHaveBeenCalled();
    expect(readPolicy).not.toHaveBeenCalled();
  });

  it('refuses a symbol with no price history as a 404, never as an upstream failure', async () => {
    vi.mocked(readPolicy).mockResolvedValue(null);
    refused(await get('/agents/momentum-scout/backtest?lookback=90d&symbol=NOPE'), 404, 'no_history');
    expect(engine.backtestMomentum).not.toHaveBeenCalled();
  });
});

describe('GET /agents/:id/backtest, with the id the roster gives (E025)', () => {
  const RESULT = {
    lookback: '90d',
    ret: 4.2,
    maxDd: -3.1,
    sharpe: 1.1,
    trades: 3,
    equity: [500, 521],
    feed: 'live',
    source: 'coingecko market_chart, daily closes · 20-day breakout, 8% stop',
    disclaimer: 'Nothing here is a promise.',
  };
  /** This wallet's agent rows name `persona`, whatever id is asked about — or there are none. */
  const rowsName = (persona: string | undefined) =>
    vi.mocked(one).mockImplementation((async (text: string) =>
      /FROM agents/.test(text) ? (persona ? { persona_id: persona } : undefined) : { address: OWNER }) as never);
  const agentLookups = () => vi.mocked(one).mock.calls.filter(([text]) => /FROM agents/.test(String(text)));

  beforeEach(() => {
    vi.mocked(readPolicy).mockResolvedValue(null);
    vi.mocked(engine.backtestMomentum).mockResolvedValue(RESULT as never);
  });

  it("answers a hired agent's row id exactly as its persona answers, looking the row up in this wallet only", async () => {
    rowsName('momentum-scout');
    const ROW = '2d3316bd-8c11-455f-ae10-8975ace4c3de';
    expect(await get(`/agents/${ROW}/backtest?lookback=90d`)).toEqual({ status: 200, body: RESULT });
    expect(agentLookups()).toEqual([[expect.stringContaining('wallet_id = $2'), [ROW, 'wallet-1']]]);

    rowsName('drawdown-guard');
    expect(await get('/agents/ad9c524c-dbdc-4eb2-b853-e056d373a832/backtest?lookback=90d')).toMatchObject({
      status: 422,
      body: { error: 'not_backtestable', agent: 'ad9c524c-dbdc-4eb2-b853-e056d373a832' },
    });
  });

  it('answers a persona id without looking for a row', async () => {
    expect((await get('/agents/momentum-scout/backtest?lookback=30d')).status).toBe(200);
    expect((await get('/agents/earnings-desk/backtest?lookback=30d')).status).toBe(422);
    expect(agentLookups()).toEqual([]);
  });

  it("answers an id that is neither a persona nor one of this wallet's rows as unknown, and replays nothing", async () => {
    rowsName(undefined);
    expect(await get('/agents/nope/backtest?lookback=90d')).toMatchObject({ status: 404, body: { error: 'unknown_agent' } });
    // On every object's prototype, and no persona.
    expect(await get('/agents/constructor/backtest?lookback=90d')).toMatchObject({ status: 404, body: { error: 'unknown_agent' } });
    expect(engine.backtestMomentum).not.toHaveBeenCalled();
  });

  it('does not take a wallet read that failed for no wallet', async () => {
    vi.mocked(currentWallet).mockRejectedValue(new Error('connection terminated'));
    const r = await get('/agents/2d3316bd-8c11-455f-ae10-8975ace4c3de/backtest?lookback=90d');
    expect(r.status).toBeGreaterThanOrEqual(500);
    expect(r.body.error).not.toBe('unknown_agent');
    expect(engine.backtestMomentum).not.toHaveBeenCalled();
  });
});

describe('POST /proposals/:id/decide (E160)', () => {
  /** The decision's transaction, answering whatever it asks from `rows`. */
  const proposals = (rows: (text: string) => unknown[]) => {
    const asked: string[] = [];
    vi.mocked(tx).mockImplementation((async (fn: (client: unknown) => Promise<unknown>) =>
      fn({
        query: async (text: string) => {
          asked.push(text);
          return { rows: rows(text) };
        },
      })) as never);
    return asked;
  };

  it("answers an id that is not this wallet's proposal with a named 404, for skip and approve alike, and places nothing", async () => {
    const asked = proposals(() => []);
    for (const decision of ['skip', 'approve']) {
      expect(await post('/proposals/5b7d2c0e-8f7a-4d7e-9c3b-3b2f1a9d4e11/decide', { decision })).toEqual({
        status: 404,
        body: { error: 'not_found', status: 'gone', message: 'That proposal no longer exists.' },
      });
    }
    // Only ever this wallet's proposals, so another account's id reads exactly like an unknown one.
    expect(asked.length).toBeGreaterThan(0);
    expect(asked.every((text) => /wallet_id = \$2/.test(text))).toBe(true);
    expect(placeOrder).not.toHaveBeenCalled();
    expect(append).not.toHaveBeenCalled();
  });

  it('still answers a proposal that was already decided with what was decided', async () => {
    proposals((text) => (/SELECT decision/.test(text) ? [{ decision: 'skip' }] : []));
    expect(await post('/proposals/p-1/decide', { decision: 'skip' })).toEqual({
      status: 200,
      body: { status: 'skip', message: 'That was already decided.' },
    });
  });
});

describe('GET /swap/quote', () => {
  it('names a slippage outside 0.05–3, an amount that is not one and a token nothing trades — and quotes nothing', async () => {
    refused(await get('/swap/quote?in=USDC&out=WETH&amount=20&slippage=10'), 400, 'invalid_slippage');
    refused(await get('/swap/quote?in=USDC&out=WETH&amount=abc'), 400, 'invalid_amount');
    refused(await get('/swap/quote?in=USDC&out=WETH&amount=0'), 400, 'invalid_amount');
    const nope = await get('/swap/quote?in=NOPE&out=WETH&amount=20');
    refused(nope, 400, 'unknown_token');
    expect(nope.body.detail).toContain('NOPE');
    expect(quote).not.toHaveBeenCalled();
  });

  it('quotes a sound request under the registry spelling', async () => {
    vi.mocked(quote).mockResolvedValue({ inSymbol: 'USDC', outSymbol: 'NVDAc', outAmount: 0.55 } as never);
    vi.mocked(gasPrice).mockResolvedValue({ wei: 2_000_000_000n, source: 'chain' });
    vi.mocked(networkCost).mockRejectedValue(new Error('no gas price'));
    const r = await get('/swap/quote?in=usdc&out=nvdac&amount=100');
    expect(r).toMatchObject({ status: 200, body: { outSymbol: 'NVDAc', gas: null } });
    expect(quote).toHaveBeenCalledWith({ inSymbol: 'USDC', outSymbol: 'NVDAc', amount: 100, slippagePct: undefined });
  });

  describe("inside a screen's patience (E187)", () => {
    const QUOTE = { inSymbol: 'USDC', outSymbol: 'WETH', outAmount: 0.008, estimatedGas: 210_000 };
    const PRICE = { wei: 2_000_000_000n, source: 'chain' as const };
    afterEach(() => setScreenPatienceForTests());

    it('costs the route at the gas price read alongside it, and prices ETH within a price read’s bound', async () => {
      vi.mocked(quote).mockResolvedValue(QUOTE as never);
      vi.mocked(gasPrice).mockResolvedValue(PRICE);
      vi.mocked(networkCost).mockResolvedValue({ priceGwei: 2, source: 'chain', units: 210_000, feeUsd: 1.05 });
      const r = await get('/swap/quote?in=USDC&out=WETH&amount=20&slippage=0.5');
      expect(r).toMatchObject({
        status: 200,
        body: { outAmount: 0.008, gas: { priceGwei: 2, units: 210_000, feeUsd: 1.05, paidBy: 'executor' } },
      });
      expect(networkCost).toHaveBeenCalledWith(210_000, { price: PRICE, priceMs: 4_000 });
    });

    it('answers a quote the aggregator has not given in time as warming, not a hang', async () => {
      setScreenPatienceForTests({ routeMs: 30 });
      vi.mocked(quote).mockReturnValue(new Promise(() => {}) as never);
      vi.mocked(gasPrice).mockResolvedValue(PRICE);
      const res = await app.request('/swap/quote?in=USDC&out=WETH&amount=20&slippage=0.5');
      expect(res.status).toBe(503);
      expect(res.headers.get('retry-after')).toBe('5');
      expect(await res.json()).toMatchObject({ error: 'warming', detail: expect.stringContaining('The quote is still') });
      expect(networkCost).not.toHaveBeenCalled();
    });

    it('answers the quote without its cost when the gas price is late', async () => {
      setScreenPatienceForTests({ chainReadMs: 30 });
      vi.mocked(quote).mockResolvedValue(QUOTE as never);
      vi.mocked(gasPrice).mockReturnValue(new Promise(() => {}) as never);
      const r = await get('/swap/quote?in=USDC&out=WETH&amount=20');
      expect(r).toMatchObject({ status: 200, body: { outAmount: 0.008, gas: null } });
      expect(networkCost).not.toHaveBeenCalled();
    });
  });
});

describe('GET /route/compare', () => {
  it('names a token nothing trades and an amount that is not a number, before any venue is asked', async () => {
    refused(await get('/route/compare?in=NOPE&out=WETH&amount=500'), 400, 'unknown_token');
    refused(await get('/route/compare?in=USDC&out=WETH&amount=abc'), 400, 'invalid_amount');
    refused(await get('/route/compare?in=USDC&out=WETH&amount=Infinity'), 400, 'invalid_amount');
    expect(compareVenues).not.toHaveBeenCalled();
  });
});

describe('GET /graph/activity', () => {
  it('answers an index that did not answer as a named 502, never as a 500', async () => {
    vi.mocked(spendsFor).mockRejectedValue(new SubgraphUnavailable('The Graph is unreachable: 429'));
    vi.mocked(dailySpendFor).mockResolvedValue([]);
    const r = await get('/graph/activity');
    expect(r.status).toBe(502);
    expect(r.body).toMatchObject({ error: 'subgraph_unavailable', message: expect.stringContaining('429') });
  });

  it("answers this wallet's spends and days when the index answers", async () => {
    vi.mocked(spendsFor).mockResolvedValue([]);
    vi.mocked(dailySpendFor).mockResolvedValue([]);
    expect(await get('/graph/activity')).toEqual({ status: 200, body: { spends: [], daily: [] } });
    expect(spendsFor).toHaveBeenCalledWith(OWNER);
  });
});

describe('GET /graph/decision', () => {
  it('refuses a size that is not dollars above zero, and decides nothing', async () => {
    for (const usd of ['abc', '0', '-5', 'Infinity', '']) {
      refused(await get(`/graph/decision?usd=${usd}`), 400, 'invalid_usd');
    }
    expect(decide).not.toHaveBeenCalled();
  });
});

describe('POST /strategies/backtest', () => {
  it('refuses a symbol with no price history as a 404, before fetching anything', async () => {
    const nope = await post('/strategies/backtest', { kind: 'dca', symbol: 'NOPE', lookback: '90d', params: { usd: 50 } });
    refused(nope, 404, 'no_history');
    expect(nope.body.detail).toContain('NOPE');
    // An equity has a route and no feed, so no history either.
    refused(
      await post('/strategies/backtest', {
        kind: 'grid',
        symbol: 'NVDAc',
        params: { lower: 100, upper: 200, steps: 4, usdPerStep: 25 },
      }),
      404,
      'no_history',
    );
    expect(engine.backtestDca).not.toHaveBeenCalled();
    expect(engine.backtestGrid).not.toHaveBeenCalled();
  });

  it('replays under the registry spelling, and keeps a fetch that failed a 502', async () => {
    vi.mocked(engine.backtestDca).mockRejectedValueOnce(new Error('429 after 5 attempts'));
    const r = await post('/strategies/backtest', { kind: 'dca', symbol: 'weth', params: { usd: 50 } });
    expect(r.status).toBe(502);
    expect(r.body.error).toBe('no_history');
    expect(vi.mocked(engine.backtestDca).mock.calls[0]![0]).toMatchObject({ symbol: 'WETH', lookback: '90d' });
  });

  it('refuses a lookback outside the four through its schema', async () => {
    expect(await post('/strategies/backtest', { kind: 'dca', symbol: 'WETH', lookback: '2y' })).toMatchObject({
      status: 400,
      body: { error: 'invalid_request' },
    });
  });
});
