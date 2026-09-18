/**
 * GET /wallet/tokens (PLAN.md 3.10), with the wallet, the chain, 1inch and the price feeds stood in for.
 *
 * On Base the balances are 1inch's; on a fork or a testnet they are the chain's, read the way `/wallet/balance` reads
 * them. Either way the list is priced where a feed answers and null where it does not, largest value first. A read
 * that fails is a 502, never an empty list, which would say the wallet is empty.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { getAddress } from 'viem';

const h = vi.hoisted(() => ({
  chain: 'xlayer',
  getBalance: vi.fn(),
  MAINNET: {
    usdc: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
    nativeEth: '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE',
  },
  SEPOLIA: {
    usdc: '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
    nativeEth: '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE',
  },
  NoWalletError: class extends Error {
    readonly status = 409;
    constructor() {
      super('No wallet for this user. POST /wallet/create first.');
    }
  },
  WrongPrincipalError: class extends Error {},
}));

vi.mock('./wallet-context.js', () => ({ requireWallet: vi.fn(), NoWalletError: h.NoWalletError }));
// `http/errors.ts` reaches the auth stack for this one class; the route itself never authenticates anything.
vi.mock('../auth/middleware.js', () => ({ requireUser: vi.fn(), WrongPrincipalError: h.WrongPrincipalError }));
vi.mock('../evm/chains.js', () => ({
  get CHAIN_KEY() {
    return h.chain;
  },
  get ADDRESSES() {
    return h.chain === 'xlayer-testnet' ? h.SEPOLIA : h.MAINNET;
  },
}));
vi.mock('../evm/client.js', () => ({ publicClient: { getBalance: h.getBalance } }));
vi.mock('../evm/balances.js', () => ({ holdings: vi.fn(), cashUsd: vi.fn() }));
vi.mock('../venues/oneinch.js', () => ({
  TOKENS: {
    ETH: { address: '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE', decimals: 18 },
    WETH: { address: '0x4200000000000000000000000000000000000006', decimals: 18 },
    USDC: { address: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', decimals: 6 },
    CBBTC: { address: '0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf', decimals: 8 },
  },
}));
vi.mock('../venues/balance.js', () => ({ holdingsOnBase: vi.fn() }));
vi.mock('../market/logos.js', () => ({ logosFor: vi.fn() }));
vi.mock('../market/prices.js', () => ({ priceOf: vi.fn() }));

const { requireWallet } = await import('./wallet-context.js');
const { cashUsd, holdings } = await import('../evm/balances.js');
const { holdingsOnBase } = await import('../venues/balance.js');
const { logosFor } = await import('../market/logos.js');
const { priceOf } = await import('../market/prices.js');
const { errorResponse } = await import('../http/errors.js');
const { PRICE_DEADLINE_MS, tokenRoutes } = await import('./tokens.js');

/** Mounted the way `index.ts` mounts every route module: on `/`, under the one error handler. */
const app = new Hono();
app.route('/', tokenRoutes);
app.onError(errorResponse);

/** Stored lowercase, answered checksummed. */
const WALLET = { id: 'wallet-1', address: '0x95a0b368588713011a15f4b1041423f31b08e615' };
const OWNER = getAddress(WALLET.address);
const NATIVE = '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE';
const WETH = '0x4200000000000000000000000000000000000006';
const USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const DEGEN = '0x4ed4E862860beD51a9570b96d89aF5E1B0Efefed';
const AERO = '0x940181a94A35A4569E4529A3CDfB74e38FD98631';

/** Feeds by symbol; a symbol not in the table has none. */
function prices(table: Record<string, number>) {
  vi.mocked(priceOf).mockImplementation(async (symbol: string) => {
    const price = table[symbol];
    if (price === undefined) throw new Error(`No price feed for ${symbol}`);
    return price;
  });
}

async function get(): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await app.request('/wallet/tokens');
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

beforeEach(() => {
  h.chain = 'xlayer';
  vi.clearAllMocks();
  vi.mocked(requireWallet).mockResolvedValue(WALLET as never);
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

describe("on Base, 1inch's word", () => {
  it('lists what 1inch reads, priced where a feed answers, largest value first and the unpriced after', async () => {
    vi.mocked(holdingsOnBase).mockResolvedValue({
      tokens: [
        { symbol: 'DEGEN', name: 'Degen', address: DEGEN, decimals: 18, units: 1140, logo: 'https://tokens.1inch.io/degen.png', feed: null },
        { symbol: 'USDC', name: 'USD Coin', address: USDC, decimals: 6, units: 167.5, logo: 'https://tokens.1inch.io/usdc.png', feed: 'USDC' },
        { symbol: 'AERO', name: 'Aerodrome', address: AERO, decimals: 18, units: 3, logo: null, feed: null },
        { symbol: 'ETH', name: 'Ether', address: NATIVE, decimals: 18, units: 0.5, logo: 'https://tokens.1inch.io/eth.png', native: true, feed: 'ETH' },
      ],
      undescribed: ['0x000000000000000000000000000000000000dEaD'],
    });
    prices({ USDC: 1, ETH: 4_000 });

    const { status, body } = await get();

    expect(status).toBe(200);
    expect(body).toEqual({
      owner: OWNER,
      chain: 'xlayer',
      source: '1inch',
      tokens: [
        { symbol: 'ETH', name: 'Ether', address: NATIVE, decimals: 18, units: 0.5, logo: 'https://tokens.1inch.io/eth.png', native: true, usd: 2_000 },
        { symbol: 'USDC', name: 'USD Coin', address: USDC, decimals: 6, units: 167.5, logo: 'https://tokens.1inch.io/usdc.png', usd: 167.5 },
        { symbol: 'AERO', name: 'Aerodrome', address: AERO, decimals: 18, units: 3, logo: null, usd: null },
        { symbol: 'DEGEN', name: 'Degen', address: DEGEN, decimals: 18, units: 1140, logo: 'https://tokens.1inch.io/degen.png', usd: null },
      ],
      undescribed: ['0x000000000000000000000000000000000000dEaD'],
    });
    expect(holdingsOnBase).toHaveBeenCalledWith(OWNER);
    // A token no feed can be trusted to mean is not priced at all.
    expect(vi.mocked(priceOf).mock.calls.map(([symbol]) => symbol).sort()).toEqual(['ETH', 'USDC']);
    // On Base, nothing is read from the executor's own RPC.
    for (const chainRead of [holdings, cashUsd, h.getBalance, logosFor]) expect(chainRead).not.toHaveBeenCalled();
  });

  it('a feed that fails, answers something that is not a price, or does not answer in time leaves that token unpriced, never $0', async () => {
    vi.mocked(holdingsOnBase).mockResolvedValue({
      tokens: [
        { symbol: 'WETH', address: WETH, decimals: 18, units: 1, logo: null, feed: 'WETH' },
        { symbol: 'USDC', address: USDC, decimals: 6, units: 5, logo: null, feed: 'USDC' },
        { symbol: 'ETH', address: NATIVE, decimals: 18, units: 2, logo: null, native: true, feed: 'ETH' },
      ],
      undescribed: [],
    });
    vi.mocked(priceOf).mockImplementation((symbol: string) =>
      symbol === 'ETH'
        ? Promise.reject(new Error('price deadline for ETH'))
        : symbol === 'USDC'
          ? Promise.resolve(0)
          : new Promise<number>(() => {}),
    );

    vi.useFakeTimers();
    try {
      const pending = app.request('/wallet/tokens');
      await vi.waitFor(() => expect(priceOf).toHaveBeenCalledTimes(3));
      await vi.advanceTimersByTimeAsync(PRICE_DEADLINE_MS);
      const res = await pending;
      expect(res.status).toBe(200);
      const { tokens } = (await res.json()) as { tokens: { symbol: string; usd: number | null }[] };
      expect(tokens.map((t) => [t.symbol, t.usd])).toEqual([
        ['ETH', null],
        ['USDC', null],
        ['WETH', null],
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('a read 1inch cannot answer is a 502 that says so, never an empty list', async () => {
    vi.mocked(holdingsOnBase).mockRejectedValue(
      new Error('api.1inch.dev has failed 4 times in a row; not retrying for another 30s.'),
    );

    const { status, body } = await get();

    expect(status).toBe(502);
    expect(body).toMatchObject({
      error: 'balance_read_failed',
      source: '1inch',
      message: 'Could not read your tokens from 1inch just now.',
    });
    expect(body).not.toHaveProperty('tokens');
    expect(priceOf).not.toHaveBeenCalled();
  });
});

describe("on a fork or a testnet, the chain's word", () => {
  it.each(['xlayer-fork', 'xlayer-testnet', 'localnet'])(
    "on %s, reads the registry, USDC and native ETH at this chain's addresses",
    async (chain) => {
      h.chain = chain;
      const addresses = chain === 'xlayer-testnet' ? h.SEPOLIA : h.MAINNET;
      vi.mocked(holdings).mockResolvedValue([{ symbol: 'WETH', units: 0.25, usd: 1_000, raw: 250_000_000_000_000_000n }]);
      vi.mocked(cashUsd).mockResolvedValue(42.5);
      h.getBalance.mockResolvedValue(2_000_000_000_000_000n);
      // ETH's logo resolved, no registry has one for WETH, and USDC's did not come back inside the deadline.
      vi.mocked(logosFor).mockResolvedValue({
        ETH: { url: 'https://tokens.1inch.io/eth.png', source: '1inch' },
        WETH: { url: null, source: null },
      });
      prices({ ETH: 4_000, WETH: 4_000, USDC: 1 });

      const { status, body } = await get();

      expect(status).toBe(200);
      expect(body).toEqual({
        owner: OWNER,
        chain,
        source: 'chain',
        tokens: [
          { symbol: 'WETH', address: WETH, decimals: 18, units: 0.25, logo: null, usd: 1_000 },
          { symbol: 'USDC', address: addresses.usdc, decimals: 6, units: 42.5, logo: null, usd: 42.5 },
          { symbol: 'ETH', address: addresses.nativeEth, decimals: 18, units: 0.002, logo: 'https://tokens.1inch.io/eth.png', native: true, usd: 8 },
        ],
        undescribed: [],
      });
      expect(holdings).toHaveBeenCalledWith(OWNER);
      expect(cashUsd).toHaveBeenCalledWith(OWNER);
      expect(h.getBalance).toHaveBeenCalledWith({ address: OWNER });
      expect([...vi.mocked(logosFor).mock.calls[0]![0]].sort()).toEqual(['ETH', 'USDC', 'WETH']);
      expect(holdingsOnBase).not.toHaveBeenCalled();
    },
  );

  it('nothing held is an empty list: an answer, not an error', async () => {
    h.chain = 'xlayer-fork';
    vi.mocked(holdings).mockResolvedValue([]);
    vi.mocked(cashUsd).mockResolvedValue(0);
    h.getBalance.mockResolvedValue(0n);
    vi.mocked(logosFor).mockResolvedValue({});

    const { status, body } = await get();

    expect(status).toBe(200);
    expect(body).toMatchObject({ source: 'chain', tokens: [], undescribed: [] });
  });

  it.each([
    ['the registry multicall', () => vi.mocked(holdings).mockRejectedValue(new Error('fetch failed'))],
    ['USDC', () => vi.mocked(cashUsd).mockRejectedValue(new Error('The request took too long to respond.'))],
    ['native ETH', () => h.getBalance.mockRejectedValue(new Error('HTTP request failed.'))],
  ])('a failed read of %s is a 502 saying what could not be read, never an empty list', async (_read, fail) => {
    h.chain = 'xlayer-fork';
    vi.mocked(holdings).mockResolvedValue([]);
    vi.mocked(cashUsd).mockResolvedValue(10);
    h.getBalance.mockResolvedValue(10n ** 18n);
    fail();

    const { status, body } = await get();

    expect(status).toBe(502);
    expect(body).toMatchObject({
      error: 'chain_read_failed',
      message: 'Could not read your tokens from the chain just now.',
    });
    expect(body).not.toHaveProperty('tokens');
    expect(logosFor).not.toHaveBeenCalled();
    expect(priceOf).not.toHaveBeenCalled();
  });
});

describe('whose wallet', () => {
  it('a signed-in account with no wallet yet is a 409, and nothing is read', async () => {
    vi.mocked(requireWallet).mockRejectedValue(new h.NoWalletError());

    const { status, body } = await get();

    expect(status).toBe(409);
    expect(body).toMatchObject({ error: 'no_wallet' });
    expect(holdingsOnBase).not.toHaveBeenCalled();
    expect(holdings).not.toHaveBeenCalled();
  });
});
