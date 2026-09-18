/**
 * What a Base wallet holds, from 1inch's Balance and Token APIs (PLAN.md 3.10), with the API stood in for.
 *
 * The Balance API answers for every token on 1inch's list, zeros included, keyed by lowercase address. The Token API
 * answers keyed the same way and leaves out what it does not know. Both shapes are the ones `balance.live.test.ts`
 * reads from the real API. These tests pin what is kept, what it is called, what it may be priced as, and that no
 * failure comes back as an empty wallet.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getAddress } from 'viem';

vi.mock('./oneinch.js', () => ({
  oneinchApi: vi.fn(),
  TOKENS: {
    ETH: { address: '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE', decimals: 18 },
    WETH: { address: '0x4200000000000000000000000000000000000006', decimals: 18 },
    USDC: { address: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', decimals: 6 },
    CBBTC: { address: '0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf', decimals: 8 },
    NVDAc: { address: '0xb20000000000000000000078ee7ce2fE4908108C', decimals: 8 },
  },
}));
vi.mock('../evm/chains.js', () => ({ ONEINCH_CHAIN_ID: 8453 }));

const { oneinchApi } = await import('./oneinch.js');
const { holdingsOnBase, oneinchBalances, resetTokenInfo, tokenInfo } = await import('./balance.js');

const OWNER = '0x95A0b368588713011a15f4b1041423f31B08e615';
const NATIVE = '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee';
const WETH = '0x4200000000000000000000000000000000000006';
const USDC = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913';
const CBBTC = '0xcbb7c0000ab88b473b1f5afd9ef808440eed33bf';
const NVDAC = '0xb20000000000000000000078ee7ce2fe4908108c';
/** Off the registry: a token with a feed of its own, one without, and two whose tickers imitate one. */
const LINK = '0x88fb150bdc53a65fe94dea0c9ba0a6daf8c6e196';
const DEGEN = '0x4ed4e862860bed51a9570b96d89af5e1b0efefed';
const LOOKALIKE = '0x1111111111111111111111111111111111111111';
const LOWERCASE_WETH = '0x2222222222222222222222222222222222222222';

/** A description in the Token API's own shape, less the fields nothing reads. */
function described(address: string, symbol: string, decimals: number, name?: string) {
  return {
    chainId: 8453,
    address,
    symbol,
    decimals,
    ...(name ? { name } : {}),
    logoURI: `https://tokens.1inch.io/${address}.png`,
    providers: ['1inch'],
    tags: ['tokens'],
    eip2612: false,
    rating: 5,
  };
}

/**
 * 1inch, stood in for. The Balance API answers `balances`; the Token API describes whatever `known` has of the
 * addresses asked, and leaves the rest out, as the real one does.
 */
function oneinch(balances: unknown, known: Record<string, unknown> = {}) {
  vi.mocked(oneinchApi).mockImplementation((async (path: string) => {
    if (path.startsWith('/balance/v1.2/8453/balances/')) return balances;
    const asked = new URLSearchParams(path.split('?')[1]).get('addresses')?.split(',') ?? [];
    return Object.fromEntries(asked.filter((a) => a in known).map((a) => [a, known[a]]));
  }) as never);
}

/** The addresses each Token API request asked about, in order. */
function tokenRequests(): string[][] {
  return vi
    .mocked(oneinchApi)
    .mock.calls.map(([path]) => path)
    .filter((path) => path.startsWith('/token/v1.2/8453/custom?'))
    .map((path) => new URLSearchParams(path.split('?')[1]).get('addresses')!.split(','));
}

beforeEach(() => {
  vi.mocked(oneinchApi).mockReset();
  resetTokenInfo();
});

describe('what a wallet holds on Base', () => {
  it("keeps every non-zero balance on 1inch's list, called and sized as the Token API describes it", async () => {
    oneinch(
      { [NATIVE]: '1500000000000000000', [WETH]: '0', [USDC]: '167551481', [DEGEN]: '1140094381000000000000', [CBBTC]: '0' },
      {
        [NATIVE]: described(NATIVE, 'ETH', 18, 'Ether'),
        [USDC]: described(USDC, 'USDC', 6, 'USD Coin'),
        [DEGEN]: described(DEGEN, 'DEGEN', 18, 'Degen'),
      },
    );

    expect(await holdingsOnBase(OWNER)).toEqual({
      tokens: [
        {
          symbol: 'ETH',
          name: 'Ether',
          address: getAddress(NATIVE),
          decimals: 18,
          units: 1.5,
          logo: `https://tokens.1inch.io/${NATIVE}.png`,
          native: true,
          feed: 'ETH',
        },
        {
          symbol: 'USDC',
          name: 'USD Coin',
          address: getAddress(USDC),
          decimals: 6,
          units: 167.551481,
          logo: `https://tokens.1inch.io/${USDC}.png`,
          feed: 'USDC',
        },
        {
          symbol: 'DEGEN',
          name: 'Degen',
          address: getAddress(DEGEN),
          decimals: 18,
          units: 1140.094381,
          logo: `https://tokens.1inch.io/${DEGEN}.png`,
          feed: null,
        },
      ],
      undescribed: [],
    });
    // Only what is held is described: the zeros cost nothing.
    expect(tokenRequests()).toEqual([[DEGEN, NATIVE, USDC].sort()]);
    // A balance is cached briefly, never for as long as a description: a list refreshed after a trade shows the trade.
    const [path, ttlMs] = vi.mocked(oneinchApi).mock.calls[0]!;
    expect(path).toBe(`/balance/v1.2/8453/balances/${OWNER}`);
    expect(ttlMs).toBeLessThanOrEqual(15_000);
  });

  it("a token the registry names keeps the registry's spelling and is priced as it, while 1inch still names it", async () => {
    oneinch(
      { [CBBTC]: '449116', [NVDAC]: '250000000' },
      {
        [CBBTC]: described(CBBTC, 'cbBTC', 8, 'Coinbase Wrapped BTC'),
        [NVDAC]: described(NVDAC, 'NVDAc', 8, 'NVIDIA Corporation'),
      },
    );
    const { tokens } = await holdingsOnBase(OWNER);
    expect(tokens.map(({ symbol, name, units, feed }) => ({ symbol, name, units, feed }))).toEqual([
      { symbol: 'CBBTC', name: 'Coinbase Wrapped BTC', units: 0.00449116, feed: 'CBBTC' },
      { symbol: 'NVDAc', name: 'NVIDIA Corporation', units: 2.5, feed: 'NVDAc' },
    ]);
  });

  it("anything else is priced only when its symbol is exactly a feed's: never an equity by ticker, never uppercased", async () => {
    oneinch(
      {
        [LINK]: '2000000000000000000',
        [LOOKALIKE]: '1000000000000000000',
        [LOWERCASE_WETH]: '1000000000000000000',
        [DEGEN]: '1',
      },
      {
        [LINK]: described(LINK, 'LINK', 18, 'ChainLink Token'),
        // Case-folds to the registry's equity, and is not it: an equity is an address, not a name.
        [LOOKALIKE]: described(LOOKALIKE, 'NVDAC', 18),
        [LOWERCASE_WETH]: described(LOWERCASE_WETH, 'weth', 18),
        // A name every object has on its prototype, which no feed is keyed by.
        [DEGEN]: described(DEGEN, 'constructor', 18),
      },
    );
    const feeds = Object.fromEntries((await holdingsOnBase(OWNER)).tokens.map((t) => [t.symbol, t.feed]));
    expect(feeds).toEqual({ LINK: 'LINK', NVDAC: null, weth: null, constructor: null });
  });

  it("a token 1inch will not describe: the registry's is listed from the registry, anything else is said rather than dropped", async () => {
    oneinch(
      { [WETH]: '2000000000000000000', [DEGEN]: '5', [LINK]: '7' },
      // DEGEN goes undescribed; LINK is described with decimals that are not a number of decimals.
      { [LINK]: { ...described(LINK, 'LINK', 18), decimals: '18' } },
    );
    expect(await holdingsOnBase(OWNER)).toEqual({
      tokens: [{ symbol: 'WETH', address: getAddress(WETH), decimals: 18, units: 2, logo: null, feed: 'WETH' }],
      undescribed: [getAddress(DEGEN), getAddress(LINK)],
    });
  });

  it('an empty wallet is an empty list, and the Token API is asked nothing', async () => {
    oneinch({ [NATIVE]: '0', [USDC]: '0', [WETH]: '0' });
    expect(await holdingsOnBase(OWNER)).toEqual({ tokens: [], undescribed: [] });
    expect(oneinchApi).toHaveBeenCalledTimes(1);
  });
});

describe('a read that fails is not an empty wallet', () => {
  it.each([
    ['a list', []],
    ['nothing', null],
    ['the map wrapped in another object', { balances: { [USDC]: '1' } }],
    ['a number where the digits go', { [USDC]: 12 }],
    ['a negative balance', { [USDC]: '-1' }],
  ])('a Balance API answer that is %s throws', async (_what, body) => {
    oneinch(body);
    await expect(oneinchBalances(OWNER)).rejects.toThrow(/1inch Balance API/);
  });

  it('a Token API answer that is not a map throws', async () => {
    vi.mocked(oneinchApi).mockImplementation((async (path: string) =>
      path.startsWith('/balance/') ? { [USDC]: '1' } : []) as never);
    await expect(holdingsOnBase(OWNER)).rejects.toThrow(/1inch Token API/);
  });

  it('either API failing fails the whole read', async () => {
    vi.mocked(oneinchApi).mockRejectedValueOnce(new Error('api.1inch.dev has failed 4 times in a row'));
    await expect(holdingsOnBase(OWNER)).rejects.toThrow('failed 4 times in a row');

    vi.mocked(oneinchApi)
      .mockImplementationOnce((async () => ({ [USDC]: '1' })) as never)
      .mockRejectedValueOnce(new Error('503 after 5 attempts'));
    await expect(holdingsOnBase(OWNER)).rejects.toThrow('503 after 5 attempts');
  });
});

describe('descriptions', () => {
  it('are asked for once: only what 1inch has not yet described is asked again', async () => {
    oneinch({}, {
      [USDC]: described(USDC, 'USDC', 6),
      [WETH]: described(WETH, 'WETH', 18),
      [CBBTC]: described(CBBTC, 'cbBTC', 8),
    });
    await tokenInfo([USDC, WETH]);
    // A checksummed address is the same token.
    await tokenInfo([getAddress(USDC), WETH, CBBTC]);
    await tokenInfo([USDC]);
    expect(tokenRequests()).toEqual([[WETH, USDC].sort(), [CBBTC]]);
  });

  it('an address 1inch left out is asked about again, not remembered as nothing', async () => {
    oneinch({}, {});
    expect((await tokenInfo([DEGEN])).size).toBe(0);
    await tokenInfo([DEGEN]);
    expect(tokenRequests()).toEqual([[DEGEN], [DEGEN]]);
  });

  it("a wallet holding more than one request's worth is described in batches", async () => {
    const many = Array.from({ length: 250 }, (_, i) => `0x${(i + 1).toString(16).padStart(40, '0')}`);
    oneinch({}, Object.fromEntries(many.map((a) => [a, described(a, `T${a.slice(-3)}`, 18)])));
    expect((await tokenInfo(many)).size).toBe(250);
    const batches = tokenRequests();
    expect(batches.length).toBeGreaterThan(1);
    expect(Math.max(...batches.map((b) => b.length))).toBeLessThanOrEqual(100);
    expect(batches.flat().sort()).toEqual([...many].sort());
  });
});
