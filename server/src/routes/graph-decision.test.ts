/**
 * `GET /graph/decision` answers inside the app's read deadline, whatever the indexes and the price feed do.
 *
 * In the endpoint QA run against the hosted fork executor at 8c05266 it gave no answer inside sixty seconds. It priced
 * the size first with no deadline — on a deployment whose index is for another contract, so the price was never used —
 * then asked the delegation index three questions in a row, and the Aqua index with no deadline at all. These drive the
 * real route, decision, subgraph clients and price lookup, with both gateways and the price feed replaced by fakes that
 * answer late or never, and every bound shortened so a test can wait it out.
 */
import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const DELEGATION = '0x6c5528Fd8E74a047A85bAb413856A9239E73540e';
// Read at import by the two subgraph clients.
process.env.SUBGRAPH_URL = 'https://gateway.thegraph.test/xorr';
process.env.AQUA_SUBGRAPH_URL = 'https://gateway.thegraph.test/aqua';
process.env.SUBGRAPH_DELEGATION_ADDRESS = DELEGATION.toLowerCase();
process.env.DELEGATION_ADDRESS = DELEGATION;
process.env.AQUA_BOOK_ADDRESS = '0x74e1283711106a5844eb20760c7cb6405933c54f';

const h = vi.hoisted(() => ({ getJson: vi.fn(), staleValue: vi.fn() }));

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
vi.mock('../venues/oneinch.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../venues/oneinch.js')>()),
  quote: vi.fn(),
}));
vi.mock('../evm/gas-price.js', () => ({ networkCost: vi.fn() }));
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
vi.mock('../evm/client.js', () => ({
  publicClient: {},
  walletClient: {},
  delegateAccount: { address: '0xC38f38f45463f77bD823FebE16b15714Eb98c8A5' },
}));
vi.mock('../http/get.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../http/get.js')>()),
  getJson: h.getJson,
  staleValue: h.staleValue,
}));

const { currentWallet } = await import('./wallet-context.js');
const { extra } = await import('./extra.js');
const { errorResponse } = await import('../http/errors.js');
const { setScreenPatienceForTests } = await import('../http/patience.js');
const { setSubgraphTimeoutForTests } = await import('../graph/client.js');
const { setAquaTimeoutForTests } = await import('../graph/aqua.js');

const app = new Hono();
app.onError(errorResponse);
app.route('/', extra);

const OWNER = '0x95A0b368588713011a15f4b1041423f31B08e615';
const never = () => new Promise<never>(() => {});

type Answer = { afterMs: number; data: unknown } | 'never';
type Question = 'policy' | 'daily' | 'spends' | 'books';
/** Which questions reached a gateway, in the order they were asked. */
const asked: Question[] = [];

/**
 * Both gateways, answering each question after `afterMs` or not at all. Either way they answer the abort signal, as a
 * real fetch does, so a client's own deadline is what ends a question that never gets an answer.
 */
function gateways(answers: Record<Question, Answer>) {
  vi.stubGlobal('fetch', (url: string, init: { body: string; signal: AbortSignal }) => {
    const { query } = JSON.parse(init.body) as { query: string };
    const question: Question = String(url).endsWith('/aqua')
      ? 'books'
      : /dailySpends/.test(query)
        ? 'daily'
        : /spends\(/.test(query)
          ? 'spends'
          : 'policy';
    asked.push(question);
    const answer = answers[question];
    return new Promise<Response>((resolve, reject) => {
      const timer =
        answer === 'never'
          ? undefined
          : setTimeout(() => resolve(new Response(JSON.stringify({ data: answer.data }))), answer.afterMs);
      init.signal.addEventListener('abort', () => {
        clearTimeout(timer);
        reject(init.signal.reason);
      });
    });
  });
}

const soon = (data: unknown): Answer => ({ afterMs: 5, data });
const livePolicy = () => ({
  policy: {
    id: OWNER.toLowerCase(),
    owner: OWNER.toLowerCase(),
    delegate: '0xc38f38f45463f77bd823febe16b15714eb98c8a5',
    dailyCap: '1600000000',
    expiresAt: String(Math.floor(Date.now() / 1000) + 86_400),
    revoked: false,
    totalSpent: '0',
  },
});
const NO_SPEND = { dailySpends: [] };
const NO_FLOW = { spends: [] };
const NO_BOOKS = { strategies: [] };

async function decision() {
  const started = Date.now();
  const res = await app.request('/graph/decision?usd=100');
  return { status: res.status, body: (await res.json()) as Record<string, unknown>, ms: Date.now() - started };
}

beforeEach(() => {
  h.getJson.mockReset();
  h.getJson.mockImplementation(never);
  h.staleValue.mockReset();
  h.staleValue.mockReturnValue(undefined);
  asked.length = 0;
  process.env.DELEGATION_ADDRESS = DELEGATION;
  setScreenPatienceForTests({ priceMs: 100 });
  setSubgraphTimeoutForTests(200);
  setAquaTimeoutForTests(200);
  vi.mocked(currentWallet).mockResolvedValue({ id: 'wallet-1', address: OWNER } as never);
});
afterEach(() => {
  vi.unstubAllGlobals();
  setScreenPatienceForTests();
  setSubgraphTimeoutForTests(5_000);
  setAquaTimeoutForTests(5_000);
});

describe('GET /graph/decision, bounded', () => {
  it('asks the delegation index its three questions at once, so a slow index costs one wait rather than three', async () => {
    h.getJson.mockResolvedValue({ weth: { usd: 2_500 } });
    setSubgraphTimeoutForTests(5_000);
    gateways({
      policy: { afterMs: 300, data: livePolicy() },
      daily: { afterMs: 300, data: NO_SPEND },
      spends: { afterMs: 300, data: NO_FLOW },
      books: soon(NO_BOOKS),
    });

    const r = await decision();
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({
      act: true,
      sizeUsd: 100,
      route: { venue: '1inch', why: 'No open Aqua book is deep enough for this size.' },
    });
    // Asked one after another, the three took at least 900 ms before the venue index was even asked.
    expect(asked.slice(0, 3).sort()).toEqual(['daily', 'policy', 'spends']);
    expect(r.ms).toBeLessThan(800);
  });

  it('an index that never answers is subgraph_unavailable — a named 502 — at its deadline', async () => {
    gateways({ policy: 'never', daily: 'never', spends: 'never', books: 'never' });

    const r = await decision();
    expect(r.status).toBe(502);
    expect(r.body).toEqual({ error: 'subgraph_unavailable', message: 'The Graph is unreachable: no answer in 200ms' });
    expect(r.ms).toBeLessThan(1_500);
  });

  it('is never held by a price it will not use: an index for another contract answers at once, and prices nothing', async () => {
    // The hosted fork executor's case: its index follows the Sepolia contract, not the one it spends through.
    process.env.DELEGATION_ADDRESS = '0xc32dd8aeed3035d46c7c82a351fc5522c9d463f4';
    gateways({ policy: 'never', daily: 'never', spends: 'never', books: 'never' });

    const r = await decision();
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ act: false, reason: 'index_is_for_another_deployment' });
    expect(h.getJson).not.toHaveBeenCalled();
    expect(asked).toEqual([]);
    expect(r.ms).toBeLessThan(500);
  });

  it('a price that does not come in time routes to the aggregator and says why, inside the bound', async () => {
    gateways({ policy: soon(livePolicy()), daily: soon(NO_SPEND), spends: soon(NO_FLOW), books: soon(NO_BOOKS) });

    const r = await decision();
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({
      act: true,
      route: {
        venue: '1inch',
        why: 'Could not price this size in the token it buys, so no Aqua book was checked for depth.',
      },
    });
    expect(asked).not.toContain('books');
    expect(r.ms).toBeLessThan(1_500);
  });

  it('an Aqua index that never answers routes to the aggregator at its deadline, and says so', async () => {
    h.getJson.mockResolvedValue({ weth: { usd: 2_500 } });
    gateways({ policy: soon(livePolicy()), daily: soon(NO_SPEND), spends: soon(NO_FLOW), books: 'never' });

    const r = await decision();
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({
      act: true,
      route: { venue: '1inch', why: 'Could not read the Aqua index (The Aqua index is unreachable: no answer in 200ms).' },
    });
    expect(r.ms).toBeLessThan(1_500);
  });

  it('a decision that stops at the permission is not failed by the reads it no longer needs', async () => {
    gateways({ policy: soon({ policy: null }), daily: 'never', spends: 'never', books: 'never' });

    const r = await decision();
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ act: false, reason: 'no_policy_onchain' });
  });
});
