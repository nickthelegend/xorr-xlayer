/**
 * `GET /wallet/balance` answers inside the app's read deadline, whatever its upstreams do (`http/patience.ts`).
 *
 * In the endpoint QA run against the hosted fork executor at 8c05266 it gave no answer inside sixty seconds; the app
 * gives up at forty-five. These drive the real route, balance read and price lookup, with the node, the price feed and
 * the Aave reserve replaced by fakes that answer or never do, and the bounds shortened so a test can wait them out.
 */
import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

process.env.XORR_CHAIN ??= 'base-sepolia';

const h = vi.hoisted(() => ({
  multicall: vi.fn(),
  readContract: vi.fn(),
  getCode: vi.fn(),
  getJson: vi.fn(),
  staleValue: vi.fn(),
  poolHere: vi.fn(),
  usdcReserve: vi.fn(),
}));

vi.mock('../db/index.js', () => ({ one: vi.fn(), query: vi.fn(), tx: vi.fn(), pool: { query: vi.fn() } }));
vi.mock('../evm/client.js', () => ({
  publicClient: { multicall: h.multicall, readContract: h.readContract, getCode: h.getCode },
  walletClient: {},
  delegateAccount: { address: '0xC38f38f45463f77bD823FebE16b15714Eb98c8A5' },
  KEY_DIRECTORY: '/nonexistent',
}));
vi.mock('../auth/privy.js', () => ({
  UnauthorizedError: class extends Error {
    readonly status = 401;
  },
  verifyToken: vi.fn(),
  freshWallets: vi.fn(),
}));
vi.mock('./wallet-context.js', () => ({
  currentWallet: vi.fn(),
  requireWallet: vi.fn(),
  NoWalletError: class extends Error {},
}));
vi.mock('../http/get.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../http/get.js')>()),
  getJson: h.getJson,
  staleValue: h.staleValue,
}));
vi.mock('../market/yield.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../market/yield.js')>()),
  aavePoolIsDeployedHere: h.poolHere,
  usdcReserve: h.usdcReserve,
}));

const { currentWallet } = await import('./wallet-context.js');
const { routes } = await import('./index.js');
const { errorResponse } = await import('../http/errors.js');
const { setScreenPatienceForTests } = await import('../http/patience.js');
const { clearReadableTokenCache } = await import('../evm/balances.js');

const app = new Hono();
app.onError(errorResponse);
app.route('/', routes);

const OWNER = '0x95A0b368588713011a15f4b1041423f31B08e615';
const DELEGATE = '0xC38f38f45463f77bD823FebE16b15714Eb98c8A5';
const WETH = '0x4200000000000000000000000000000000000006';
const usdc = (n: number) => BigInt(Math.round(n * 1e6));
const never = () => new Promise<never>(() => {});
/** What the feed says WETH is worth. */
const PRICES = { weth: { usd: 2_500 } };

/** A node that answers at once: 1 WETH held, $100 of USDC, and a live $1,600 permission with $1,450 left today. */
function answeringNode() {
  h.getCode.mockImplementation(async ({ address }: { address: string }) =>
    address.toLowerCase() === WETH ? '0x6080604052' : '0x',
  );
  h.multicall.mockImplementation(async ({ allowFailure, contracts }: { allowFailure: boolean; contracts: unknown[] }) =>
    allowFailure
      ? contracts.map(() => ({ status: 'success', result: 10n ** 18n }))
      : [[DELEGATE, usdc(1_600), BigInt(Math.floor(Date.now() / 1000) + 86_400), false], usdc(1_450), usdc(150)],
  );
  h.readContract.mockResolvedValue(usdc(100));
  h.poolHere.mockResolvedValue(false);
}

async function balance() {
  const started = Date.now();
  const res = await app.request('/wallet/balance');
  return {
    status: res.status,
    retryAfter: res.headers.get('retry-after'),
    body: (await res.json()) as Record<string, unknown>,
    ms: Date.now() - started,
  };
}

beforeEach(() => {
  for (const f of Object.values(h)) f.mockReset();
  clearReadableTokenCache();
  setScreenPatienceForTests({ chainReadMs: 400, priceMs: 100, aaveMs: 100 });
  vi.mocked(currentWallet).mockResolvedValue({ id: 'wallet-1', address: OWNER } as never);
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => {
  setScreenPatienceForTests();
  vi.restoreAllMocks();
});

describe('GET /wallet/balance, bounded', () => {
  it('answers with the balance when every upstream answers', async () => {
    answeringNode();
    h.getJson.mockResolvedValue(PRICES);
    h.staleValue.mockReturnValue(undefined);

    const r = await balance();
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({
      usd: 2_600,
      cashUsd: 100,
      holdings: [{ symbol: 'WETH', units: 1, usd: 2_500 }],
      suppliedUsd: 0,
      dailyCapUsd: 1_600,
      remainingTodayUsd: 1_450,
    });
  });

  it('a node that never answers is chain_read_failed — a 502 the app retries — at the bound', async () => {
    answeringNode();
    h.multicall.mockImplementation(never);

    const r = await balance();
    expect(r.status).toBe(502);
    expect(r.body).toMatchObject({ error: 'chain_read_failed' });
    expect(r.ms).toBeLessThan(2_000);
  });

  it('a price feed that never answers, with no earlier price, is warming — a 503 with retry-after, never a $0 holding', async () => {
    answeringNode();
    h.getJson.mockImplementation(never);
    h.staleValue.mockReturnValue(undefined);

    const r = await balance();
    expect(r.status).toBe(503);
    expect(r.retryAfter).toBe('5');
    expect(r.body).toMatchObject({
      error: 'warming',
      detail: 'The price of WETH is still being fetched; try again in a moment.',
    });
    expect(r.ms).toBeLessThan(2_000);
  });

  it('a price feed that never answers, with a price from minutes ago, answers with that price inside the bound', async () => {
    answeringNode();
    h.getJson.mockImplementation(never);
    h.staleValue.mockImplementation((_url: string, maxAgeMs: number) => (maxAgeMs > 30_000 ? PRICES : undefined));

    const r = await balance();
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ usd: 2_600, holdings: [{ symbol: 'WETH', units: 1, usd: 2_500 }] });
    expect(r.ms).toBeLessThan(2_000);
  });

  it('an Aave reserve that never answers is nothing supplied, and the rest of the balance still answers in time', async () => {
    answeringNode();
    h.getJson.mockResolvedValue(PRICES);
    h.staleValue.mockReturnValue(undefined);
    h.poolHere.mockResolvedValue(true);
    h.usdcReserve.mockImplementation(never);

    const r = await balance();
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ usd: 2_600, suppliedUsd: 0 });
    expect(r.ms).toBeLessThan(2_000);
  });
});
