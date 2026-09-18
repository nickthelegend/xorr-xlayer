/**
 * The proof-of-reserves badge endpoint, driven over HTTP.
 *
 * The case that matters is the refusal: when the attestor cannot be read, the route must answer
 * 200 with `verified: false` and a reason, and must not put a ratio on the wire at all. A client
 * that receives a number renders a number, so the number has to be absent rather than caveated.
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


vi.mock('../venues/proof-of-reserves.js', () => ({ backingFor: vi.fn() }));
const { backingFor } = await import('../venues/proof-of-reserves.js');

const VERIFIED = {
  status: 'verified' as const,
  backing: {
    symbol: 'NVDAx',
    sharesHeld: 186898,
    circulatingSupply: 186692.75074178688,
    ratio: 186898 / 186692.75074178688,
    custodians: [{ provider: 'Alpaca', quantity: 186898, symbol: 'NVDA' }],
    asOf: '2026-09-17T07:02:05.244Z',
  },
};

describe('GET /xstocks/:symbol/backing', () => {
  beforeEach(() => vi.clearAllMocks());

  it('reports the measured ratio and who is holding the shares', async () => {
    vi.mocked(backingFor).mockResolvedValue(VERIFIED);

    const res = await app.request('/xstocks/NVDAx/backing');
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;

    expect(body.verified).toBe(true);
    expect(body.fullyBacked).toBe(true);
    expect(body.ratio).toBeCloseTo(1.0010993, 6);
    expect(body.sharesHeld).toBe(186898);
    expect(body.custodians).toEqual([{ provider: 'Alpaca', quantity: 186898, symbol: 'NVDA' }]);
    expect(body.asOf).toBe('2026-09-17T07:02:05.244Z');
  });

  it('answers 200 with no ratio at all when the attestation cannot be read', async () => {
    vi.mocked(backingFor).mockResolvedValue({
      status: 'unverified',
      reason: 'Could not reach the xStocks proof-of-reserves attestation: fetch failed',
    });

    const res = await app.request('/xstocks/NVDAx/backing');
    // Not an error: the request was fine, the asset's backing is simply unread.
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;

    expect(body.verified).toBe(false);
    expect(body.reason).toMatch(/Could not reach/);
    // The whole point — nothing a client could render as a backing figure.
    expect(body).not.toHaveProperty('ratio');
    expect(body).not.toHaveProperty('fullyBacked');
    expect(body).not.toHaveProperty('sharesHeld');
  });

  it('marks a shortfall as not fully backed rather than rounding it away', async () => {
    vi.mocked(backingFor).mockResolvedValue({
      status: 'verified',
      backing: { ...VERIFIED.backing, sharesHeld: 180000, ratio: 180000 / 186692.75074178688 },
    });

    const body = (await (await app.request('/xstocks/NVDAx/backing')).json()) as Record<string, unknown>;
    expect(body.verified).toBe(true);
    expect(body.fullyBacked).toBe(false);
    expect(body.ratio as number).toBeLessThan(1);
  });

  it('asks the attestor for the symbol in the path', async () => {
    vi.mocked(backingFor).mockResolvedValue({ status: 'unverified', reason: 'nope' });
    await app.request('/xstocks/TSLAx/backing');
    expect(backingFor).toHaveBeenCalledWith('TSLAx');
  });
});
