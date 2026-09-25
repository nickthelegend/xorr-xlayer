/**
 * GET /wallet/tokens (PLAN.md 3.10), with the wallet, the chain and the price feeds stood in for.
 *
 * On every X Layer network the balances are the chain's, read the way `/wallet/balance` reads them, beside native OKB and
 * USDC at this chain's own addresses. The list is priced where a feed answers and null where it does not, largest value
 * first. A read that fails is a 502, never an empty list, which would say the wallet is empty.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { getAddress } from 'viem';

const h = vi.hoisted(() => ({
  chain: 'xlayer',
  getBalance: vi.fn(),
  MAINNET: {
    usdc: '0xB6CEceAB302E2E4948951eE7843FC24E92933061',
    nativeToken: '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE',
  },
  TESTNET: {
    usdc: '0xDec90b78111Ba2fc6FC6d84d8B9ec159A2d4b9B3',
    nativeToken: '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE',
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
    return h.chain === 'xlayer-testnet' || h.chain === 'localnet' ? h.TESTNET : h.MAINNET;
  },
}));
vi.mock('../evm/client.js', () => ({ publicClient: { getBalance: h.getBalance } }));
vi.mock('../evm/balances.js', () => ({ heldUnits: vi.fn(), cashUsd: vi.fn() }));
vi.mock('../venues/tokens.js', () => ({
  // The registry, at X Layer mainnet's addresses.
  TOKENS: {
    USDC: { address: '0xB6CEceAB302E2E4948951eE7843FC24E92933061', decimals: 6 },
    WETH: { address: '0x5A77f1443D16ee5761d310e38b62f77f726bC71c', decimals: 18 },
    WOKB: { address: '0xe538905cf8410324e03A5A23C1c177a474D59b2b', decimals: 18 },
  },
}));
vi.mock('../market/logos.js', () => ({ logosFor: vi.fn() }));
vi.mock('../market/prices.js', () => ({ priceOf: vi.fn() }));

const { requireWallet } = await import('./wallet-context.js');
const { cashUsd, heldUnits } = await import('../evm/balances.js');
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
const WETH = '0x5A77f1443D16ee5761d310e38b62f77f726bC71c';
/** A stand-in: whatever URL the logo registry answered with. */
const OKB_LOGO = 'https://logos.example/okb.png';

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

describe("on every X Layer network, the chain's word", () => {
  it.each(['xlayer', 'xlayer-fork', 'xlayer-testnet', 'localnet'])(
    "on %s, reads the registry, USDC and native OKB at this chain's addresses",
    async (chain) => {
      h.chain = chain;
      const addresses = chain === 'xlayer-testnet' || chain === 'localnet' ? h.TESTNET : h.MAINNET;
      vi.mocked(heldUnits).mockResolvedValue([{ symbol: 'WETH', units: 0.25, raw: 250_000_000_000_000_000n }]);
      vi.mocked(cashUsd).mockResolvedValue(42.5);
      h.getBalance.mockResolvedValue(2_000_000_000_000_000n);
      // OKB's logo resolved, no registry has one for WETH, and USDC's did not come back inside the deadline.
      vi.mocked(logosFor).mockResolvedValue({
        OKB: { url: OKB_LOGO, source: 'okx' },
        WETH: { url: null, source: null },
      } as never);
      // Native OKB is priced as its wrapped twin, WOKB.
      prices({ WOKB: 50, WETH: 4_000, USDC: 1 });

      const { status, body } = await get();

      expect(status).toBe(200);
      expect(body).toEqual({
        owner: OWNER,
        chain,
        source: 'chain',
        tokens: [
          { symbol: 'WETH', address: WETH, decimals: 18, units: 0.25, logo: null, usd: 1_000 },
          { symbol: 'USDC', address: addresses.usdc, decimals: 6, units: 42.5, logo: null, usd: 42.5 },
          { symbol: 'OKB', address: addresses.nativeToken, decimals: 18, units: 0.002, logo: OKB_LOGO, native: true, usd: 0.1 },
        ],
        undescribed: [],
      });
      expect(heldUnits).toHaveBeenCalledWith(OWNER);
      expect(cashUsd).toHaveBeenCalledWith(OWNER);
      expect(h.getBalance).toHaveBeenCalledWith({ address: OWNER });
      expect([...vi.mocked(logosFor).mock.calls[0]![0]].sort()).toEqual(['OKB', 'USDC', 'WETH']);
    },
  );

  it('a feed that fails, answers something that is not a price, or does not answer in time leaves that token unpriced, never $0', async () => {
    vi.mocked(heldUnits).mockResolvedValue([{ symbol: 'WETH', units: 1, raw: 10n ** 18n }]);
    vi.mocked(cashUsd).mockResolvedValue(5);
    h.getBalance.mockResolvedValue(2n * 10n ** 18n);
    vi.mocked(logosFor).mockResolvedValue({});
    vi.mocked(priceOf).mockImplementation((symbol: string) =>
      symbol === 'WOKB'
        ? Promise.reject(new Error('price deadline for WOKB'))
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
        ['OKB', null],
        ['USDC', null],
        ['WETH', null],
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('nothing held is an empty list: an answer, not an error', async () => {
    h.chain = 'xlayer-fork';
    vi.mocked(heldUnits).mockResolvedValue([]);
    vi.mocked(cashUsd).mockResolvedValue(0);
    h.getBalance.mockResolvedValue(0n);
    vi.mocked(logosFor).mockResolvedValue({});

    const { status, body } = await get();

    expect(status).toBe(200);
    expect(body).toMatchObject({ source: 'chain', tokens: [], undescribed: [] });
  });

  it.each([
    ['the registry multicall', () => vi.mocked(heldUnits).mockRejectedValue(new Error('fetch failed'))],
    ['USDC', () => vi.mocked(cashUsd).mockRejectedValue(new Error('The request took too long to respond.'))],
    ['native OKB', () => h.getBalance.mockRejectedValue(new Error('HTTP request failed.'))],
  ])('a failed read of %s is a 502 saying what could not be read, never an empty list', async (_read, fail) => {
    h.chain = 'xlayer-fork';
    vi.mocked(heldUnits).mockResolvedValue([]);
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
    expect(heldUnits).not.toHaveBeenCalled();
  });
});
