/**
 * `GET /panic/preview` answers inside the app's read deadline, whatever its upstreams do (`http/patience.ts`).
 *
 * It priced every holding with the scheduler's patience and gave no answer inside sixty seconds in the endpoint QA run
 * against the hosted fork executor at 8c05266. These drive the real route, holdings read and price lookup, with the node
 * and the price feed replaced by fakes that answer or never do, and the bounds shortened so a test can wait them out.
 */
import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

process.env.XORR_CHAIN ??= 'base-sepolia';

const h = vi.hoisted(() => ({ multicall: vi.fn(), getCode: vi.fn(), getJson: vi.fn(), staleValue: vi.fn() }));

vi.mock('../db/index.js', () => ({ one: vi.fn(), query: vi.fn(async () => []), tx: vi.fn(), pool: { query: vi.fn() } }));
vi.mock('../evm/client.js', () => ({
  publicClient: { multicall: h.multicall, getCode: h.getCode },
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

const { currentWallet } = await import('./wallet-context.js');
const { panic } = await import('./panic.js');
const { errorResponse } = await import('../http/errors.js');
const { setScreenPatienceForTests } = await import('../http/patience.js');
const { clearReadableTokenCache } = await import('../evm/balances.js');

const app = new Hono();
// Signed in, as the auth middleware would have decided it.
app.use('*', async (c, next) => {
  (c as unknown as { set: (k: string, v: unknown) => void }).set('user', { userId: 'did:privy:owner' });
  await next();
});
app.onError(errorResponse);
app.route('/', panic);

const OWNER = '0x95A0b368588713011a15f4b1041423f31B08e615';
const WETH = '0x4200000000000000000000000000000000000006';
const never = () => new Promise<never>(() => {});

/** A node that answers at once: 1 WETH held, and no other token with code on this chain. */
function holdingOneWeth() {
  h.getCode.mockImplementation(async ({ address }: { address: string }) =>
    address.toLowerCase() === WETH ? '0x6080604052' : '0x',
  );
  h.multicall.mockResolvedValue([{ status: 'success', result: 10n ** 18n }]);
}

async function preview() {
  const started = Date.now();
  const res = await app.request('/panic/preview');
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
  setScreenPatienceForTests({ chainReadMs: 400, priceMs: 100 });
  vi.mocked(currentWallet).mockResolvedValue({ id: 'wallet-1', address: OWNER } as never);
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => {
  setScreenPatienceForTests();
  vi.restoreAllMocks();
});

describe('GET /panic/preview, bounded', () => {
  it('lists what would be sold when every upstream answers', async () => {
    holdingOneWeth();
    h.getJson.mockResolvedValue({ weth: { usd: 2_500 } });
    h.staleValue.mockReturnValue(undefined);

    const r = await preview();
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ legs: [{ symbol: 'WETH', units: 1, usd: 2_500 }], totalUsd: 2_500, skipped: [] });
  });

  it('a node that never answers is chain_read_failed, naming the holdings, at the bound', async () => {
    h.getCode.mockImplementation(never);

    const r = await preview();
    expect(r.status).toBe(502);
    expect(r.body).toMatchObject({
      error: 'chain_read_failed',
      message: 'Could not read your holdings from the chain just now.',
    });
    expect(r.ms).toBeLessThan(2_000);
  });

  it('a node that refuses is chain_read_failed too, where it was a 500 carrying the node’s own words', async () => {
    holdingOneWeth();
    h.multicall.mockRejectedValue(new Error('HTTP request failed. Status: 503 URL: http://127.0.0.1:8545'));

    const r = await preview();
    expect(r.status).toBe(502);
    expect(r.body).toMatchObject({ error: 'chain_read_failed' });
    expect(JSON.stringify(r.body)).not.toContain('127.0.0.1');
  });

  it('a price feed that never answers, with no earlier price, is warming inside the bound — never a leg worth $0', async () => {
    holdingOneWeth();
    h.getJson.mockImplementation(never);
    h.staleValue.mockReturnValue(undefined);

    const r = await preview();
    expect(r.status).toBe(503);
    expect(r.retryAfter).toBe('5');
    expect(r.body).toMatchObject({ error: 'warming' });
    expect(r.ms).toBeLessThan(2_000);
  });
});
