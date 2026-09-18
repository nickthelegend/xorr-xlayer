/**
 * A comparison answers inside its caller's patience (docs/qa/ENDPOINTS.md E165).
 *
 * Its legs ran one after another with no bound: against the hosted fork one ask took 46 s and another gave no answer
 * inside 90. Each leg is stood in for here, so what is under test is the bound: the venues that answered are reported as
 * they answered, and one that did not is reported as late, on time.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../evm/client.js', () => ({
  publicClient: { getGasPrice: vi.fn(), estimateContractGas: vi.fn() },
  delegateAccount: { address: '0x0000000000000000000000000000000000000001' },
}));
vi.mock('./oneinch.js', () => ({
  quote: vi.fn(),
  buildSwap: vi.fn(),
  TOKENS: {
    USDC: { address: '0x0000000000000000000000000000000000000a01', decimals: 6 },
    WETH: { address: '0x0000000000000000000000000000000000000a02', decimals: 18 },
  },
  SLIPPAGE: { scheduled: 0.5 },
}));
vi.mock('./aqua.js', () => ({ buildAquaFill: vi.fn() }));
vi.mock('./swapvm.js', () => ({ buildSwapVmFill: vi.fn(), openPrograms: vi.fn() }));
vi.mock('../market/prices.js', () => ({ priceOf: vi.fn() }));
vi.mock('../evm/delegation.js', () => ({ DELEGATION_ABI: [], DELEGATION_ADDRESS: '0x0000000000000000000000000000000000000002' }));
vi.mock('../evm/measure-route.js', () => ({ deliveredOnChain: vi.fn(), PRICES_DRIFT: false }));
vi.mock('../executor/failure.js', () => ({ humanFailure: (s: string) => s }));

const { compareVenues } = await import('./compare.js');
const { quote, buildSwap } = await import('./oneinch.js');
const { buildAquaFill } = await import('./aqua.js');
const { buildSwapVmFill, openPrograms } = await import('./swapvm.js');
const { priceOf } = await import('../market/prices.js');
const { publicClient } = await import('../evm/client.js');

const TRADE = { owner: '0x95A0b368588713011a15f4b1041423f31B08e615', inSymbol: 'USDC', outSymbol: 'WETH', amount: 500 } as const;
const QUICK = { withinMs: 80, priceMs: 20 };
const never = () => new Promise<never>(() => {});

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(quote).mockResolvedValue({ outAmount: 0.2, venues: ['UNISWAP_V3'] } as never);
  vi.mocked(buildSwap).mockResolvedValue({ to: '0x0000000000000000000000000000000000000b01', data: '0x', minOut: 1n } as never);
  vi.mocked(buildAquaFill).mockResolvedValue(undefined as never);
  vi.mocked(buildSwapVmFill).mockResolvedValue(undefined as never);
  vi.mocked(openPrograms).mockResolvedValue([]);
  vi.mocked(publicClient.getGasPrice).mockResolvedValue(1_000_000_000n);
  vi.mocked(publicClient.estimateContractGas).mockResolvedValue(200_000n);
  vi.mocked(priceOf).mockResolvedValue(2_500);
});

describe('compareVenues with a caller’s patience', () => {
  it('reports an aggregator that has not answered as late, and answers on time', async () => {
    vi.mocked(quote).mockImplementation(never);
    const started = Date.now();
    const r = await compareVenues({ ...TRADE, patience: QUICK });

    expect(Date.now() - started).toBeLessThan(1_000);
    expect(r.quotes.map((q) => q.venue)).toEqual(['aqua', 'swapvm', '1inch']);
    expect(r.quotes[2]).toEqual({ venue: '1inch', served: false, reason: 'The aggregator did not answer in time.' });
    expect(r.quotes[1]).toEqual({
      venue: 'swapvm',
      served: false,
      reason: 'Needs a reference price, and the aggregator did not answer in time.',
    });
    expect(r.best).toBeUndefined();
  });

  it('keeps the venues that answered when a book does not', async () => {
    vi.mocked(buildAquaFill).mockImplementation(never);
    const r = await compareVenues({ ...TRADE, patience: QUICK });

    expect(r.quotes[0]).toEqual({ venue: 'aqua', served: false, reason: 'The maker books did not answer in time.' });
    const agg = r.quotes[2]!;
    expect(agg).toMatchObject({ venue: '1inch', served: true, outAmount: 0.2 });
    // 200,000 gas at 1 gwei is 0.0002 ETH, $0.50 at $2,500.
    expect(agg.served && agg.gasUsd).toBeCloseTo(0.5, 6);
    expect(agg.served && agg.netUsd).toBeCloseTo(0.2 * 2_500 - 0.5, 6);
    expect(r.best).toBe('1inch');
  });

  it('reads prices with the caller’s patience, and a late one leaves the cost unknown rather than the comparison waiting', async () => {
    vi.mocked(priceOf).mockRejectedValue(new Error('still fetching'));
    const r = await compareVenues({ ...TRADE, patience: { withinMs: 1_000, priceMs: 20 } });

    expect(vi.mocked(priceOf).mock.calls.every(([, deadline]) => deadline === 20)).toBe(true);
    const agg = r.quotes[2]!;
    expect(agg.served).toBe(true);
    expect(agg.served && agg.gasUsd).toBeUndefined();
    expect(agg.served && agg.netUsd).toBeUndefined();
    expect(r.bestNet).toBeUndefined();
  });

  it('asks for the price of ETH once, not once for every venue it costs', async () => {
    await compareVenues({ ...TRADE, patience: QUICK });
    expect(vi.mocked(priceOf).mock.calls.filter(([symbol]) => symbol === 'ETH')).toHaveLength(1);
  });

  it('without a patience, waits for every leg as it always did', async () => {
    vi.mocked(buildAquaFill).mockImplementation(
      () => new Promise((resolve) => setTimeout(() => resolve(undefined as never), 120)),
    );
    const r = await compareVenues({ ...TRADE });
    expect(r.quotes[0]).toEqual({ venue: 'aqua', served: false, reason: 'No maker book is deep enough for this size right now.' });
  });
});
