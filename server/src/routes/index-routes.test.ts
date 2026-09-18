/**
 * Routes from `routes/index.ts` (docs/qa/ENDPOINTS.md E096, E150), driven over HTTP with the database, the chain, the
 * price feed and the session stood in for.
 */
import { Hono } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';

process.env.XORR_CHAIN ??= 'base-sepolia';

vi.mock('../db/index.js', () => ({ one: vi.fn(), query: vi.fn(), tx: vi.fn(), pool: { query: vi.fn() } }));
vi.mock('../evm/client.js', () => ({
  publicClient: {},
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
vi.mock('../market/prices.js', () => ({ priceOf: vi.fn() }));
vi.mock('../rules/engine.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../rules/engine.js')>()),
  spentToday: vi.fn(),
}));
vi.mock('../evm/delegation.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../evm/delegation.js')>()),
  readPolicy: vi.fn(),
}));

const { priceOf } = await import('../market/prices.js');
const { spentToday } = await import('../rules/engine.js');
const { readPolicy } = await import('../evm/delegation.js');
const { requireWallet } = await import('./wallet-context.js');
const { routes } = await import('./index.js');
const { errorResponse } = await import('../http/errors.js');

const app = new Hono();
app.onError(errorResponse);
app.route('/', routes);

type Answer = { status: number; body: Record<string, unknown> };

async function call(path: string): Promise<Answer> {
  const res = await app.request(path);
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('GET /limits (E096)', () => {
  const POLICY = {
    delegate: '0xC38f38f45463f77bD823FebE16b15714Eb98c8A5' as const,
    dailyCapUsd: 2_810,
    expiresAt: Date.parse('2026-10-13T00:00:00Z'),
    revoked: false,
  };

  beforeEach(() => {
    vi.mocked(requireWallet).mockResolvedValue({ id: 'wallet-1', address: '0x95A0b368588713011a15f4b1041423f31B08e615' } as never);
  });

  it('reports the stricter tally as spent, takes the remainder from that same figure, and sends both tallies', async () => {
    // The fork on 2026-09-14: the chain had counted $908.05, the executor's own tally $954.05.
    vi.mocked(readPolicy).mockResolvedValue({ ...POLICY, spentTodayUsd: 908.05, remainingTodayUsd: 1_901.95 });
    vi.mocked(spentToday).mockResolvedValue(954.05);

    const r = await call('/limits');
    expect(r).toMatchObject({
      status: 200,
      body: {
        dailyCapUsd: 2_810,
        spentTodayUsd: 954.05,
        chainSpentTodayUsd: 908.05,
        executorSpentTodayUsd: 954.05,
        revoked: false,
        granted: true,
      },
    });
    expect(r.body.remainingUsd).toBeCloseTo(1_855.95, 6);
    // The three numbers on the Limits screen add up.
    expect((r.body.spentTodayUsd as number) + (r.body.remainingUsd as number)).toBeCloseTo(r.body.dailyCapUsd as number, 6);
  });

  it("takes the chain's tally when it is the larger", async () => {
    vi.mocked(readPolicy).mockResolvedValue({ ...POLICY, spentTodayUsd: 120, remainingTodayUsd: 2_690 });
    vi.mocked(spentToday).mockResolvedValue(100);
    expect((await call('/limits')).body).toMatchObject({
      spentTodayUsd: 120,
      remainingUsd: 2_690,
      chainSpentTodayUsd: 120,
      executorSpentTodayUsd: 100,
    });
  });

  it('leaves nothing once the permission has expired, whatever the tallies say', async () => {
    vi.mocked(readPolicy).mockResolvedValue({ ...POLICY, spentTodayUsd: 0, remainingTodayUsd: 0 });
    vi.mocked(spentToday).mockResolvedValue(0);
    expect((await call('/limits')).body).toMatchObject({ dailyCapUsd: 2_810, spentTodayUsd: 0, remainingUsd: 0 });
  });

  it('keeps never granted and revoked as their own answers', async () => {
    vi.mocked(readPolicy).mockResolvedValue(null);
    vi.mocked(spentToday).mockResolvedValue(12);
    expect((await call('/limits')).body).toEqual({
      dailyCapUsd: 0,
      spentTodayUsd: 12,
      chainSpentTodayUsd: null,
      executorSpentTodayUsd: 12,
      remainingUsd: 0,
      revoked: false,
      granted: false,
    });

    vi.mocked(readPolicy).mockResolvedValue({ ...POLICY, revoked: true, spentTodayUsd: 30, remainingTodayUsd: 0 });
    expect((await call('/limits')).body).toMatchObject({ dailyCapUsd: 0, spentTodayUsd: 30, remainingUsd: 0, revoked: true, granted: true });
  });
});

describe('GET /price/:symbol', () => {
  it('answers a symbol nothing prices with a named 404, and asks no feed', async () => {
    const r = await call('/price/NOPE');
    expect(r).toMatchObject({ status: 404, body: { error: 'no_feed', detail: expect.stringContaining('NOPE') } });
    expect(priceOf).not.toHaveBeenCalled();
  });

  it('prices a feed symbol and an equity, under the registry spelling and the source that priced it', async () => {
    vi.mocked(priceOf).mockResolvedValueOnce(64_000);
    expect(await call('/price/BTC')).toMatchObject({ status: 200, body: { symbol: 'BTC', price: 64_000, source: 'coingecko' } });
    vi.mocked(priceOf).mockResolvedValueOnce(181.5);
    expect(await call('/price/nvdac')).toMatchObject({ status: 200, body: { symbol: 'NVDAc', price: 181.5, source: '1inch' } });
  });

  it('keeps a feed that failed a 502, worth retrying, with a code rather than the upstream’s own words', async () => {
    vi.mocked(priceOf).mockRejectedValueOnce(new Error('429 after 5 attempts: https://api.coingecko.com/api/v3/simple/price'));
    const r = await call('/price/ETH');
    expect(r).toMatchObject({ status: 502, body: { error: 'price_unavailable' } });
    expect(JSON.stringify(r.body)).not.toContain('coingecko.com');
  });

  it('waits a screen’s patience, and answers a price still on its way 503 warming with a retry-after (E149)', async () => {
    const { StillFetching } = await import('../http/deadline.js');
    const { screenPatience } = await import('../http/patience.js');
    vi.mocked(priceOf).mockRejectedValueOnce(new StillFetching('the price of BTC'));
    const res = await app.request('/price/BTC');
    expect(res.status).toBe(503);
    expect(res.headers.get('retry-after')).toBe('5');
    expect(await res.json()).toMatchObject({ error: 'warming', detail: expect.stringContaining('BTC') });
    expect(priceOf).toHaveBeenCalledWith('BTC', screenPatience().priceMs);
  });
});
