/**
 * Tier 4 on X Layer — idle cash to Aave v3, earning on USDT0 (PLAN.md P2.14, D15).
 *
 * One leg per run: USDT0 already in the wallet is supplied directly; otherwise idle USDC is swapped to USDT0 through
 * Uniswap while USDT0 out-earns USDC, and the next run supplies it. On a chain with no lending pool the run is refused
 * saying so. The reserve reads, the pool check, the chain and the wallet's cash are stood in for.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { decodeFunctionData, parseAbi } from 'viem';

const POOL = '0xE3F3Caefdd7180F884c01E57f65Df979Af84f116';
const USDT0 = '0x779Ded0c9e1022225f8E0630b35a9b54bE713736';
const A_USDT0 = '0xF356ae412dB5df43BD3a10746f7ad4e1C4De4297';

const h = vi.hoisted(() => ({
  pool: '0xE3F3Caefdd7180F884c01E57f65Df979Af84f116' as string | null,
  readContract: vi.fn(),
}));

vi.mock('../../evm/chains.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../evm/chains.js')>()),
  get AAVE_V3_POOL() {
    return h.pool;
  },
}));
vi.mock('../../evm/client.js', () => ({
  publicClient: { readContract: h.readContract },
  delegateAccount: { address: '0xC38f38f45463f77bD823FebE16b15714Eb98c8A5' },
}));
vi.mock('../../evm/balances.js', () => ({ cashUsd: vi.fn(), holdings: vi.fn() }));
vi.mock('../../market/yield.js', () => ({
  aavePoolIsDeployedHere: vi.fn(),
  usdt0Reserve: vi.fn(),
  usdcReserve: vi.fn(),
  noLendingPoolHere: () => 'There is no lending pool on X Layer Testnet, so idle cash cannot be put to work here. Nothing moved.',
}));

const { cashUsd } = await import('../../evm/balances.js');
const yieldReads = await import('../../market/yield.js');
const { planYieldRotation, PlanRefused, PLANNERS } = await import('./index.js');

const OWNER = '0x95A0b368588713011a15f4b1041423f31B08e615' as const;
const SUPPLY = parseAbi(['function supply(address asset, uint256 amount, address onBehalfOf, uint16 referralCode)']);
const USDT0_RESERVE = { symbol: 'USDT0', apy: 0.0348, aToken: A_USDT0, asset: USDT0, pool: POOL, decimals: 6 };
const USDC_RESERVE = {
  symbol: 'USDC',
  apy: 0.00000428,
  aToken: '0x7Da9B238CBd6A227ff054704Ec5cF7e700f03414',
  asset: '0xB6CEceAB302E2E4948951eE7843FC24E92933061',
  pool: POOL,
  decimals: 6,
};

const plan = (over: { budgetUsd?: number; params?: Record<string, unknown> } = {}) =>
  planYieldRotation({ owner: OWNER, budgetUsd: over.budgetUsd ?? 500, params: over.params ?? {}, symbol: 'USDC' });

/** The owner's USDT0 balance, raw. */
const holdsUsdt0 = (raw: bigint) => h.readContract.mockResolvedValue(raw);

beforeEach(() => {
  vi.clearAllMocks();
  h.pool = POOL;
  h.readContract.mockReset();
  vi.mocked(yieldReads.aavePoolIsDeployedHere).mockResolvedValue(true);
  vi.mocked(yieldReads.usdt0Reserve).mockResolvedValue(USDT0_RESERVE as never);
  vi.mocked(yieldReads.usdcReserve).mockResolvedValue(USDC_RESERVE as never);
  vi.mocked(cashUsd).mockReset();
});

describe('tier 4 — idle cash to yield on X Layer', () => {
  it('is the planner for yield-rotation', () => {
    expect(PLANNERS['yield-rotation']).toBe(planYieldRotation);
  });

  describe('a. USDT0 idle in the wallet', () => {
    it('is supplied directly: spends USDT0, supplies it on the owner’s behalf, and holds the aToken to 99.99%', async () => {
      holdsUsdt0(120_500_000n); // 120.5 USDT0
      const i = await plan();

      expect(i).toMatchObject({ inSymbol: 'USDT0', outSymbol: 'aUSDT0', amountIn: 120.5, usd: 120.5 });
      expect(i!.direct).toMatchObject({ venue: POOL, unitPriceUsd: 1, tokenOut: A_USDT0, minOut: 120_487_950n });
      // The calldata's amount is exactly what `spend()` pulls: usdToUnits(usd), in USDT0's 6 decimals.
      const { args } = decodeFunctionData({ abi: SUPPLY, data: i!.direct!.data });
      expect(args).toEqual([USDT0, 120_500_000n, OWNER, 0]);
      expect(i!.because).toContain('3.48% a year on USDT0 from Aave v3 on X Layer');
      // The owner's own USDT0 balance was read; USDC was not needed.
      expect(h.readContract).toHaveBeenCalledWith(expect.objectContaining({ address: USDT0, functionName: 'balanceOf', args: [OWNER] }));
      expect(cashUsd).not.toHaveBeenCalled();
    });

    it('is held to the run’s budget, never to more than the wallet holds', async () => {
      holdsUsdt0(900_000_000n);
      const i = await plan({ budgetUsd: 300 });
      expect(i!.usd).toBe(300);
      expect(decodeFunctionData({ abi: SUPPLY, data: i!.direct!.data }).args[1]).toBe(300_000_000n);
    });

    it('supplies every unit when the whole balance fits, with no rounding past it', async () => {
      holdsUsdt0(33_333_333n);
      const i = await plan();
      expect(decodeFunctionData({ abi: SUPPLY, data: i!.direct!.data }).args[1]).toBe(33_333_333n);
      expect(i!.usd).toBe(33.333333);
    });
  });

  describe('b. idle USDC, when USDT0 earns more', () => {
    it('swaps USDC beyond the buffer to USDT0 through a normal swap leg, and says the next run supplies it', async () => {
      holdsUsdt0(0n);
      vi.mocked(cashUsd).mockResolvedValue(200);
      const i = await plan({ params: { keepCashUsd: 50 } });

      expect(i).toEqual({
        inSymbol: 'USDC',
        outSymbol: 'USDT0',
        amountIn: 150,
        amountInRaw: 150_000_000n,
        usd: 150,
        because:
          'Aave v3 on X Layer pays 3.48% a year on USDT0 and 0.00% on USDC, so this idle USDC is swapped to USDT0 first; the next run supplies it.',
      });
      expect(i).not.toHaveProperty('direct');
    });

    it('USDT0 dust below the minimum is left, and the idle USDC is what moves', async () => {
      holdsUsdt0(3_000_000n); // $3 of USDT0, under the $25 minimum
      vi.mocked(cashUsd).mockResolvedValue(125);
      expect(await plan()).toMatchObject({ inSymbol: 'USDC', outSymbol: 'USDT0', usd: 100 });
    });

    it('does nothing while USDC earns as much as USDT0', async () => {
      holdsUsdt0(0n);
      vi.mocked(cashUsd).mockResolvedValue(1_000);
      vi.mocked(yieldReads.usdcReserve).mockResolvedValue({ ...USDC_RESERVE, apy: 0.05 } as never);
      expect(await plan()).toBeNull();
    });

    it('leaves the buffer: nothing moves when the cash beyond it is under the minimum', async () => {
      holdsUsdt0(0n);
      vi.mocked(cashUsd).mockResolvedValue(40);
      expect(await plan()).toBeNull();
      expect(yieldReads.usdcReserve).not.toHaveBeenCalled();
    });

    it('is held to the run’s budget', async () => {
      holdsUsdt0(0n);
      vi.mocked(cashUsd).mockResolvedValue(5_000);
      expect(await plan({ budgetUsd: 80 })).toMatchObject({ usd: 80, amountInRaw: 80_000_000n });
    });
  });

  describe('where there is no lending pool', () => {
    it('refuses in plain words on a chain with none, asking nothing of the chain', async () => {
      h.pool = null;
      const refused = await plan().catch((e: unknown) => e);
      expect(refused).toBeInstanceOf(PlanRefused);
      expect(refused).toMatchObject({ reason: 'no_lending_pool', message: expect.stringContaining('no lending pool') });
      expect(yieldReads.usdt0Reserve).not.toHaveBeenCalled();
      expect(h.readContract).not.toHaveBeenCalled();
    });

    it('refuses the same way where the configured pool has no code', async () => {
      vi.mocked(yieldReads.aavePoolIsDeployedHere).mockResolvedValue(false);
      await expect(plan()).rejects.toMatchObject({ reason: 'no_lending_pool' });
    });
  });

  it('moves nothing when the reserve cannot be read', async () => {
    vi.mocked(yieldReads.usdt0Reserve).mockRejectedValue(new Error('Aave v3 on X Layer has no USDT0 reserve'));
    await expect(plan()).rejects.toThrow('no USDT0 reserve');
    expect(h.readContract).not.toHaveBeenCalled();
  });
});
