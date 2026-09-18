/**
 * Cross-chain quotes (PLAN.md 3.16), with 1inch stood in for.
 *
 * `fusion-plus.live.test.ts` proves the quoter answers and that every registry address is the token it claims to be.
 * This proves what the module refuses before asking; what it asks — both tokens by address, the amount in base units,
 * the wallet, and no estimate, so no quote id an order could be built from; and what it makes of an answer and of a
 * refusal.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getAddress } from 'viem';
import type { CrosschainAsk } from './fusion-plus.js';

const h = vi.hoisted(() => ({
  USDC: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
  WETH: '0x4200000000000000000000000000000000000006',
}));

vi.mock('../evm/chains.js', () => ({ ONEINCH_CHAIN_ID: 8453 }));
// The registry, and the one way onto 1inch. What `oneinchApi` is handed is the assertion; what it answers is set per case.
vi.mock('./oneinch.js', () => ({
  oneinchApi: vi.fn(),
  TOKENS: {
    ETH: { address: '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE', decimals: 18 },
    USDC: { address: h.USDC, decimals: 6 },
    WETH: { address: h.WETH, decimals: 18 },
    CBBTC: { address: '0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf', decimals: 8 },
  },
  canonicalSymbol: (s: string) => s.trim().toUpperCase(),
}));

const { oneinchApi } = await import('./oneinch.js');
const { CROSSCHAIN_TOKENS, DESTINATIONS, SOURCE, UnusableQuote, crosschainQuote, quoteFailure, readAsk } = await import(
  './fusion-plus.js'
);

const WALLET = '0x364d7Bbc139541e0e37450D527ae154B5C292581';
const ARBITRUM_USDC = '0xaf88d065e77c8cC2239327C5EDb3A432268e5831';
const POLYGON_WETH = '0x7ceB23fD6bC0adD59E62ac25578270cFf1b9f619';

/** An ask the module accepted, for the cases about what happens after. */
function ask(to: string, token: string, amount: string): CrosschainAsk {
  const a = readAsk({ to, token, amount });
  if ('error' in a) throw new Error(`the fixture was refused: ${a.detail}`);
  return a;
}

/** Base to Arbitrum, 100 USDC, as the quoter answered on 2026-09-13 — the fields read here, and some it ignores. */
const ARBITRUM_100_USDC = {
  quoteId: null,
  srcTokenAmount: '100000000',
  dstTokenAmount: '99900370',
  presets: {
    fast: {
      auctionDuration: 180,
      startAuctionIn: 17,
      initialRateBump: 101041,
      auctionStartAmount: '99900377',
      startAmount: '99900377',
      auctionEndAmount: '98901070',
      exclusiveResolver: null,
      costInDstToken: '29629',
      points: [{ delay: 120, coefficient: 81891 }],
      allowPartialFills: false,
    },
    medium: {
      auctionDuration: 360,
      startAuctionIn: 17,
      auctionStartAmount: '99929998',
      auctionEndAmount: '98901070',
      costInDstToken: '29629',
    },
    slow: {
      auctionDuration: 600,
      startAuctionIn: 17,
      auctionStartAmount: '99929998',
      auctionEndAmount: '98901070',
      costInDstToken: '29629',
    },
  },
  recommendedPreset: 'fast',
  prices: { usd: { srcToken: '1.0000001617654992', dstToken: '0.9999248247991329' } },
  priceImpactPercent: 0.07,
};

/** The URL of the question 1inch was asked. */
const asked = () => new URL(`https://api.1inch.dev${vi.mocked(oneinchApi).mock.calls[0]![0]}`);

beforeEach(() => {
  vi.mocked(oneinchApi).mockReset().mockResolvedValue(ARBITRUM_100_USDC);
});

describe('the registry', () => {
  it('lists the four destinations the live test verifies, each with USDC and WETH at checksummed addresses', () => {
    expect(DESTINATIONS.map((d) => [d.chainId, d.name])).toEqual([
      [42161, 'Arbitrum'],
      [10, 'Optimism'],
      [1, 'Ethereum'],
      [137, 'Polygon'],
    ]);
    for (const d of DESTINATIONS) {
      for (const token of CROSSCHAIN_TOKENS) {
        const t = d.tokens[token];
        // Checksummed, so a mistyped character in a mixed-case address fails here instead of quoting another contract.
        expect(getAddress(t.address), `${d.name} ${token}`).toBe(t.address);
        expect(t.decimals, `${d.name} ${token}`).toBe(token === 'USDC' ? 6 : 18);
      }
    }
  });

  it('starts every quote on Base, and never lists Base as a destination', () => {
    expect(SOURCE).toEqual({ chainId: 8453, name: 'Base' });
    expect(DESTINATIONS.some((d) => d.chainId === SOURCE.chainId)).toBe(false);
  });
});

describe('what is refused before 1inch is asked', () => {
  it.each([
    [{ token: 'USDC', amount: '100' }, 'Name the destination chain: Arbitrum (42161), Optimism (10), Ethereum (1) or Polygon (137).'],
    [{ to: '56', token: 'USDC', amount: '100' }, 'Chain 56 is not a destination here. A quote goes from Base to Arbitrum (42161), Optimism (10), Ethereum (1) or Polygon (137).'],
    [{ to: '8453', token: 'USDC', amount: '100' }, 'Chain 8453 is not a destination here. A quote goes from Base to Arbitrum (42161), Optimism (10), Ethereum (1) or Polygon (137).'],
  ])('a chain it does not list: %o', (query, detail) => {
    expect(readAsk(query)).toEqual({ error: 'unknown_chain', detail });
  });

  it.each([
    [{ to: '10', amount: '100' }, 'Name the token: USDC or WETH.'],
    [{ to: '10', token: 'DAI', amount: '100' }, 'DAI is not quoted across chains here, only USDC and WETH.'],
    // Native ETH is not WETH here: the quote names a token contract on both chains.
    [{ to: '10', token: 'ETH', amount: '1' }, 'ETH is not quoted across chains here, only USDC and WETH.'],
  ])('a token it does not quote: %o', (query, detail) => {
    expect(readAsk(query)).toEqual({ error: 'unknown_token', detail });
  });

  it.each(['abc', '-5', '1e3', '0x10', '.5', '5.', '1,000'])('%s is not an amount', (amount) => {
    expect(readAsk({ to: '10', token: 'USDC', amount })).toEqual({
      error: 'invalid_amount',
      detail: `${amount} is not an amount. Send a plain decimal, like 100 or 0.5.`,
    });
  });

  it('no amount, and nothing above zero', () => {
    expect(readAsk({ to: '10', token: 'USDC' })).toMatchObject({ error: 'invalid_amount', detail: 'Name an amount: a decimal above zero, like 100.' });
    expect(readAsk({ to: '10', token: 'USDC', amount: '  ' })).toMatchObject({ error: 'invalid_amount' });
    for (const amount of ['0', '0.000']) {
      expect(readAsk({ to: '10', token: 'USDC', amount })).toEqual({ error: 'invalid_amount', detail: 'The amount must be above zero.' });
    }
  });

  it('a decimal finer than the token holds is refused, not rounded into a different amount', () => {
    expect(readAsk({ to: '10', token: 'USDC', amount: '0.0000001' })).toEqual({
      error: 'invalid_amount',
      detail: 'USDC has 6 decimal places, and 0.0000001 has more.',
    });
    expect(ask('10', 'WETH', '0.0000001').raw).toBe(100_000_000_000n);
  });
});

describe('what the quoter is asked', () => {
  it('both tokens by address, the amount in base units, the wallet, and no estimate', async () => {
    await crosschainQuote(ask('42161', 'USDC', '100'), WALLET);

    expect(oneinchApi).toHaveBeenCalledTimes(1);
    const url = asked();
    expect(url.pathname).toBe('/fusion-plus/quoter/v1.0/quote/receive');
    expect(Object.fromEntries(url.searchParams)).toEqual({
      srcChain: '8453',
      dstChain: '42161',
      srcTokenAddress: h.USDC,
      dstTokenAddress: ARBITRUM_USDC,
      amount: '100000000',
      walletAddress: WALLET,
      enableEstimate: 'false',
    });
  });

  it('parses the typed decimal exactly — 0.1 WETH is 10^17 wei, not the float of it — and reads the token however it was spelled', async () => {
    const a = ask(' 137 ', 'weth', '0.1');
    expect(a).toMatchObject({ token: 'WETH', amount: '0.1', raw: 100_000_000_000_000_000n });
    await crosschainQuote(a, WALLET).catch(() => undefined);
    expect(asked().searchParams.get('amount')).toBe('100000000000000000');
    expect(asked().searchParams.get('srcTokenAddress')).toBe(h.WETH);
    expect(asked().searchParams.get('dstTokenAddress')).toBe(POLYGON_WETH);
  });
});

describe('what the answer becomes', () => {
  it('amounts in units, the three presets in order with the recommended one marked, and the cost in dollars at 1inch’s price', async () => {
    const q = await crosschainQuote(ask('42161', 'USDC', '100'), WALLET);
    const costUsd = expect.closeTo(0.029629 * 0.9999248247991329, 12);

    expect(q).toEqual({
      token: 'USDC',
      from: { chainId: 8453, name: 'Base', address: h.USDC, amount: 100 },
      to: { chainId: 42161, name: 'Arbitrum', address: ARBITRUM_USDC, amount: 99.90037 },
      presets: [
        { name: 'fast', recommended: true, startsInSeconds: 17, auctionSeconds: 180, receiveMost: 99.900377, receiveLeast: 98.90107, costInToken: 0.029629, costUsd },
        { name: 'medium', recommended: false, startsInSeconds: 17, auctionSeconds: 360, receiveMost: 99.929998, receiveLeast: 98.90107, costInToken: 0.029629, costUsd },
        { name: 'slow', recommended: false, startsInSeconds: 17, auctionSeconds: 600, receiveMost: 99.929998, receiveLeast: 98.90107, costInToken: 0.029629, costUsd },
      ],
      submittable: false,
      reason: expect.stringContaining('mainnet action'),
    });
  });

  it('a cost 1inch sent no price for is unpriced in dollars — null, not free', async () => {
    vi.mocked(oneinchApi).mockResolvedValue({ ...ARBITRUM_100_USDC, prices: undefined });
    const q = await crosschainQuote(ask('42161', 'USDC', '100'), WALLET);
    expect(q.presets.map((p) => [p.costInToken, p.costUsd])).toEqual([
      [0.029629, null],
      [0.029629, null],
      [0.029629, null],
    ]);
  });

  it('leaves out a preset the quoter did not send', async () => {
    vi.mocked(oneinchApi).mockResolvedValue({ ...ARBITRUM_100_USDC, presets: { ...ARBITRUM_100_USDC.presets, slow: null } });
    const q = await crosschainQuote(ask('42161', 'USDC', '100'), WALLET);
    expect(q.presets.map((p) => p.name)).toEqual(['fast', 'medium']);
  });

  it('refuses an answer it cannot read rather than inventing the missing part', async () => {
    const a = ask('42161', 'USDC', '100');

    vi.mocked(oneinchApi).mockResolvedValueOnce({ ...ARBITRUM_100_USDC, presets: {} });
    const noPresets = await crosschainQuote(a, WALLET).catch((e: unknown) => e);
    expect(noPresets).toBeInstanceOf(UnusableQuote);
    expect(quoteFailure(noPresets, a)).toEqual({
      error: 'quote_unusable',
      detail: "1inch's quote for 100 USDC from Base to Arbitrum came back without any auction presets.",
    });

    vi.mocked(oneinchApi).mockResolvedValueOnce({ ...ARBITRUM_100_USDC, dstTokenAmount: undefined });
    await expect(crosschainQuote(a, WALLET)).rejects.toThrow('came back without the destination amount.');

    vi.mocked(oneinchApi).mockResolvedValueOnce({
      ...ARBITRUM_100_USDC,
      presets: { fast: { ...ARBITRUM_100_USDC.presets.fast, auctionEndAmount: '98.9' } },
    });
    await expect(crosschainQuote(a, WALLET)).rejects.toThrow("came back without the fast preset's closing amount.");
  });
});

describe('a failed quote, in words', () => {
  const dust = () => ask('1', 'USDC', '0.01');
  const URL_ASKED =
    'https://api.1inch.dev/fusion-plus/quoter/v1.0/quote/receive?srcChain=8453&dstChain=1&amount=10000' +
    `&walletAddress=${WALLET}&enableEstimate=false`;

  it("a 4xx is 1inch refusing: named with the question and 1inch's status, without the URL", () => {
    // HTTP/2 carries no reason phrase, so this is the message `oneinchApi` threw for a dust amount on 2026-09-13.
    const refused = quoteFailure(new Error(`400  for ${URL_ASKED}`), dust());
    expect(refused).toEqual({
      error: 'quoter_refused',
      detail: "1inch's Fusion+ quoter would not quote 0.01 USDC from Base to Ethereum. It answered 400.",
    });
    expect(refused.detail).not.toContain(WALLET);

    expect(quoteFailure(new Error(`422 Unprocessable Entity for ${URL_ASKED}`), dust()).detail).toBe(
      "1inch's Fusion+ quoter would not quote 0.01 USDC from Base to Ethereum. It answered 422 Unprocessable Entity.",
    );
  });

  it.each([
    [`503 after 5 attempts: ${URL_ASKED}`, '503 after 5 attempts'],
    [`429 after 5 attempts: ${URL_ASKED}`, '429 after 5 attempts'],
    ['This operation was aborted', 'This operation was aborted'],
    ['api.1inch.dev has failed 4 times in a row; not retrying for another 30s.', 'api.1inch.dev has failed 4 times in a row; not retrying for another 30s'],
  ])('%s is no answer, not a refusal', (thrown, said) => {
    expect(quoteFailure(new Error(thrown), dust())).toEqual({
      error: 'quoter_unavailable',
      detail: `1inch's Fusion+ quoter did not answer for 0.01 USDC from Base to Ethereum: ${said}.`,
    });
  });
});
