/**
 * `GET /crosschain/quote` and `GET /crosschain/destinations` (PLAN.md 3.16), with the session, the wallet and 1inch
 * stood in for.
 *
 * The route refuses a question it cannot ask before it reads anything, asks for the signed-in wallet, passes 1inch's
 * refusal on as a 502 with the reason, and answers every quote with `submittable: false`.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  USDC: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
  WETH: '0x4200000000000000000000000000000000000006',
}));

vi.mock('../auth/middleware.js', () => ({ requireUser: vi.fn(() => ({ userId: 'user-1' })) }));
vi.mock('./wallet-context.js', () => ({ currentWallet: vi.fn() }));
vi.mock('../evm/chains.js', () => ({ ONEINCH_CHAIN_ID: 8453 }));
vi.mock('../venues/oneinch.js', () => ({
  oneinchApi: vi.fn(),
  TOKENS: { USDC: { address: h.USDC, decimals: 6 }, WETH: { address: h.WETH, decimals: 18 } },
  canonicalSymbol: (s: string) => s.trim().toUpperCase(),
}));

const { requireUser } = await import('../auth/middleware.js');
const { currentWallet } = await import('./wallet-context.js');
const { oneinchApi } = await import('../venues/oneinch.js');
const { crosschainRoutes } = await import('./crosschain.js');

const OWNER = '0x95A0b368588713011a15f4b1041423f31B08e615';

/** Base to Optimism, 100 USDC, as the quoter answered on 2026-09-13 — trimmed to the fields the route reads. */
const OPTIMISM_100_USDC = {
  srcTokenAmount: '100000000',
  dstTokenAmount: '99830687',
  presets: {
    fast: { auctionDuration: 180, startAuctionIn: 17, auctionStartAmount: '99830681', auctionEndAmount: '98832316', costInDstToken: '6385' },
    medium: { auctionDuration: 360, startAuctionIn: 17, auctionStartAmount: '99837066', auctionEndAmount: '98832316', costInDstToken: '6385' },
    slow: { auctionDuration: 600, startAuctionIn: 17, auctionStartAmount: '99837066', auctionEndAmount: '98832316', costInDstToken: '6385' },
  },
  recommendedPreset: 'fast',
  prices: { usd: { srcToken: '0.9999999512187453', dstToken: '1.0009307666878635' } },
};

async function get(path: string) {
  const res = await crosschainRoutes.request(path);
  return { status: res.status, body: (await res.json()) as Record<string, any> };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(currentWallet).mockResolvedValue({ id: 'wallet-1', address: OWNER } as never);
  vi.mocked(oneinchApi).mockResolvedValue(OPTIMISM_100_USDC);
});

describe('GET /crosschain/quote', () => {
  it('answers what would arrive, asked for the signed-in wallet, and that it cannot be submitted', async () => {
    const { status, body } = await get('/crosschain/quote?to=10&token=USDC&amount=100');

    expect(status).toBe(200);
    expect(requireUser).toHaveBeenCalled();
    const asked = new URL(`https://api.1inch.dev${vi.mocked(oneinchApi).mock.calls[0]![0]}`).searchParams;
    expect(asked.get('walletAddress')).toBe(OWNER);
    expect(asked.get('dstChain')).toBe('10');
    expect(asked.get('amount')).toBe('100000000');

    expect(body).toMatchObject({
      token: 'USDC',
      from: { chainId: 8453, name: 'Base', address: h.USDC, amount: 100 },
      to: { chainId: 10, name: 'Optimism', address: '0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85', amount: 99.830687 },
      submittable: false,
      reason: expect.stringContaining('mainnet action'),
    });
    expect(body.presets.map((p: { name: string; auctionSeconds: number }) => [p.name, p.auctionSeconds])).toEqual([
      ['fast', 180],
      ['medium', 360],
      ['slow', 600],
    ]);
    expect(body.presets[0]).toMatchObject({ recommended: true, receiveMost: 99.830681, receiveLeast: 98.832316, costInToken: 0.006385 });
  });

  it.each([
    ['/crosschain/quote?to=56&token=USDC&amount=100', 'unknown_chain'],
    ['/crosschain/quote?token=USDC&amount=100', 'unknown_chain'],
    ['/crosschain/quote?to=10&token=DAI&amount=100', 'unknown_token'],
    ['/crosschain/quote?to=10&amount=100', 'unknown_token'],
    ['/crosschain/quote?to=10&token=USDC&amount=abc', 'invalid_amount'],
    ['/crosschain/quote?to=10&token=USDC&amount=0', 'invalid_amount'],
    ['/crosschain/quote?to=10&token=USDC', 'invalid_amount'],
    ['/crosschain/quote?to=10&token=USDC&amount=0.0000001', 'invalid_amount'],
  ])('%s is a 400 (%s), refused before the wallet is read or 1inch is asked', async (path, error) => {
    const { status, body } = await get(path);
    expect(status).toBe(400);
    expect(body.error).toBe(error);
    expect(body.detail).toEqual(expect.any(String));
    expect(currentWallet).not.toHaveBeenCalled();
    expect(oneinchApi).not.toHaveBeenCalled();
  });

  it('answers 409 for an account with no wallet, and asks 1inch nothing', async () => {
    vi.mocked(currentWallet).mockResolvedValue(undefined);
    const { status, body } = await get('/crosschain/quote?to=10&token=USDC&amount=100');
    expect(status).toBe(409);
    expect(body.error).toBe('no_wallet');
    expect(oneinchApi).not.toHaveBeenCalled();
  });

  it("passes 1inch's refusal on as a 502, with its reason", async () => {
    vi.mocked(oneinchApi).mockRejectedValue(
      new Error(`400  for https://api.1inch.dev/fusion-plus/quoter/v1.0/quote/receive?srcChain=8453&dstChain=1&walletAddress=${OWNER}`),
    );
    const { status, body } = await get('/crosschain/quote?to=1&token=USDC&amount=0.01');
    expect(status).toBe(502);
    expect(body).toEqual({
      error: 'quoter_refused',
      detail: "1inch's Fusion+ quoter would not quote 0.01 USDC from Base to Ethereum. It answered 400.",
    });
  });

  it('says the quoter did not answer when it could not be reached', async () => {
    vi.mocked(oneinchApi).mockRejectedValue(new Error('api.1inch.dev has failed 4 times in a row; not retrying for another 30s.'));
    const { status, body } = await get('/crosschain/quote?to=42161&token=WETH&amount=0.05');
    expect(status).toBe(502);
    expect(body).toEqual({
      error: 'quoter_unavailable',
      detail: "1inch's Fusion+ quoter did not answer for 0.05 WETH from Base to Arbitrum: api.1inch.dev has failed 4 times in a row; not retrying for another 30s.",
    });
  });
});

describe('GET /crosschain/destinations', () => {
  it('lists where a quote can go from Base, with the contract that arrives on each, and asks 1inch nothing', async () => {
    const { status, body } = await get('/crosschain/destinations');
    expect(status).toBe(200);
    expect(requireUser).toHaveBeenCalled();
    expect(body.from).toEqual({ chainId: 8453, name: 'Base' });
    expect(body.tokens).toEqual(['USDC', 'WETH']);
    expect(body.destinations.map((d: { chainId: number; name: string }) => [d.chainId, d.name])).toEqual([
      [42161, 'Arbitrum'],
      [10, 'Optimism'],
      [1, 'Ethereum'],
      [137, 'Polygon'],
    ]);
    expect(body.destinations[0].tokens.USDC).toEqual({ address: '0xaf88d065e77c8cC2239327C5EDb3A432268e5831', decimals: 6 });
    expect(oneinchApi).not.toHaveBeenCalled();
  });
});
