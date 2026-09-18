/**
 * The Aave reserve reads, and the pool check in front of them (PLAN.md 2.4, P2.14).
 *
 * Both executors' logs showed `/wallet/balance` waiting out a public endpoint's throttle back-off
 * on this read — 1.2 s, 2.4 s, 3.6 s — so each reserve is kept for a minute. These drive the real
 * module on a fork of X Layer, with the chain client replaced; the last block reloads it as the
 * testnet, which has no lending pool.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ readContract: vi.fn(), getCode: vi.fn(), referenceRead: vi.fn() }));

vi.mock('viem', async (importOriginal) => ({
  ...(await importOriginal<typeof import('viem')>()),
  createPublicClient: () => ({ readContract: h.referenceRead }),
}));
vi.mock('../evm/client.js', () => ({ publicClient: { getCode: h.getCode, readContract: h.readContract } }));

process.env.XORR_CHAIN = 'xlayer-fork';
const { reserveOf, usdt0Reserve, usdcReserve, clearReserveCache, aavePoolIsDeployedHere, supplyYield } = await import(
  './yield.js'
);

const RAY = 10n ** 27n;
const POOL = '0xE3F3Caefdd7180F884c01E57f65Df979Af84f116';
const USDT0 = '0x779Ded0c9e1022225f8E0630b35a9b54bE713736';
const USDC = '0xB6CEceAB302E2E4948951eE7843FC24E92933061';
const A_USDT0 = '0xF356ae412dB5df43BD3a10746f7ad4e1C4De4297';
const A_USDC = '0x7Da9B238CBd6A227ff054704Ec5cF7e700f03414';

/** The struct X Layer's pool returns, with the fields that matter set per asset. */
const struct = (over: Partial<Record<string, unknown>> = {}) => ({
  configuration: 0n,
  liquidityIndex: RAY,
  currentLiquidityRate: (RAY * 34n) / 1000n,
  variableBorrowIndex: RAY,
  currentVariableBorrowRate: 0n,
  currentStableBorrowRate: 0n,
  lastUpdateTimestamp: 1_789_759_603,
  id: 0,
  aTokenAddress: A_USDT0,
  stableDebtTokenAddress: '0x0000000000000000000000000000000000000000',
  variableDebtTokenAddress: '0x04837866D0cb0cd2D8F60fBCa83B4a24b3a7c8ac',
  interestRateStrategyAddress: '0x3eFfeBDD435217A8B485dfaEFDecf766F2a3c05B',
  accruedToTreasury: 0n,
  unbacked: 0n,
  isolationModeTotalDebt: 0n,
  ...over,
});
/** Answers per asset, as the pool would: USDT0 at ~3.46%, USDC at almost nothing. */
const pool = async ({ args }: { args: readonly [string] }) =>
  args[0] === USDT0
    ? struct()
    : struct({ id: 10, aTokenAddress: A_USDC, currentLiquidityRate: 4_283_132_022_133_579_952_975n });

beforeEach(() => {
  vi.useRealTimers();
  clearReserveCache();
  h.readContract.mockReset();
  h.getCode.mockReset();
  h.referenceRead.mockReset();
});

describe('a reserve', () => {
  it('is read once a minute, however many screens ask', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-09-19T09:00:00Z'));
    h.readContract.mockImplementation(pool);

    const [a, b] = await Promise.all([usdt0Reserve(), usdt0Reserve()]);
    expect(a.aToken).toBe(A_USDT0);
    expect(b).toBe(a);
    vi.setSystemTime(new Date('2026-09-19T09:00:59Z'));
    await usdt0Reserve();
    expect(h.readContract).toHaveBeenCalledTimes(1);

    vi.setSystemTime(new Date('2026-09-19T09:01:01Z'));
    await usdt0Reserve();
    expect(h.readContract).toHaveBeenCalledTimes(2);
  });

  it('is kept per asset: USDC is its own read, of its own reserve', async () => {
    h.readContract.mockImplementation(pool);
    const usdt0 = await usdt0Reserve();
    const usdc = await usdcReserve();
    expect(usdt0).toMatchObject({ symbol: 'USDT0', asset: USDT0, aToken: A_USDT0, pool: POOL, decimals: 6 });
    expect(usdc).toMatchObject({ symbol: 'USDC', asset: USDC, aToken: A_USDC, pool: POOL });
    expect(h.readContract.mock.calls.map((c) => [c[0].address, c[0].args[0]])).toEqual([
      [POOL, USDT0],
      [POOL, USDC],
    ]);
    // Read from the fork's own state, not a reference client.
    expect(h.referenceRead).not.toHaveBeenCalled();
  });

  it('turns currentLiquidityRate into a compounded APY, and a real reserve paying almost nothing is not an error', async () => {
    h.readContract.mockImplementation(pool);
    const usdt0 = await usdt0Reserve();
    // 3.4% linear, compounded per second.
    expect(usdt0.apy).toBeCloseTo(Math.exp(0.034) - 1, 6);
    const usdc = await usdcReserve();
    expect(usdc.apy).toBeGreaterThanOrEqual(0);
    expect(usdc.apy).toBeLessThan(0.0001);
  });

  it('refuses a zeroed struct — an asset the pool does not list — instead of quoting it as 0%', async () => {
    h.readContract.mockResolvedValue(struct({ lastUpdateTimestamp: 0, aTokenAddress: '0x0000000000000000000000000000000000000000' }));
    await expect(reserveOf('USDT0')).rejects.toThrow('no USDT0 reserve');
  });

  it('is read now when the caller asks for no cache', async () => {
    h.readContract.mockImplementation(pool);
    await usdt0Reserve();
    await usdt0Reserve(0);
    expect(h.readContract).toHaveBeenCalledTimes(2);
  });

  it('is not kept when the read failed', async () => {
    h.readContract.mockRejectedValueOnce(new Error('execution reverted')).mockImplementation(pool);
    await expect(usdt0Reserve()).rejects.toThrow('execution reverted');
    await expect(usdt0Reserve()).resolves.toMatchObject({ aToken: A_USDT0 });
    expect(h.readContract).toHaveBeenCalledTimes(2);
  });
});

describe('the published rate', () => {
  it('is USDT0’s, names Aave v3 on X Layer and its pool, and carries USDC’s beside it', async () => {
    h.readContract.mockImplementation(pool);
    h.getCode.mockResolvedValue('0x6080604052');
    const y = await supplyYield();
    expect(y).toMatchObject({ symbol: 'USDT0', feed: 'live', availableHere: true });
    expect(y.source).toBe(`Aave v3 Pool ${POOL} on X Layer`);
    expect(y.estimatedApy).toBeCloseTo(Math.exp(0.034) - 1, 6);
    expect(y.reserves.map((r) => [r.symbol, r.aToken])).toEqual([
      ['USDT0', A_USDT0],
      ['USDC', A_USDC],
    ]);
    expect(y.note).toContain('USDT0');
  });
});

describe('whether this chain has a pool', () => {
  it('a check that failed is not remembered as "no pool"', async () => {
    h.getCode.mockRejectedValueOnce(new Error('rpc down')).mockResolvedValue('0x6080604052');
    await expect(aavePoolIsDeployedHere()).rejects.toThrow('rpc down');
    await expect(aavePoolIsDeployedHere()).resolves.toBe(true);
    // Remembered once known, and asked of the X Layer pool.
    await aavePoolIsDeployedHere();
    expect(h.getCode).toHaveBeenCalledTimes(2);
    expect(h.getCode).toHaveBeenCalledWith({ address: POOL });
  });
});

describe('the grant, where mainnet state is', () => {
  it('allowlists the X Layer pool and approves USDT0, so a supply can pull it', async () => {
    const chains = await import('../evm/chains.js');
    expect(chains.AAVE_V3_POOL).toBe(POOL);
    expect(chains.SETTLEMENT_VENUES).toContain(POOL);
    expect(chains.APPROVABLE_TOKENS).toContainEqual({ symbol: 'USDT0', address: USDT0 });
  });
});

describe('on the testnet', () => {
  it('there is no pool, without asking; the rate is mainnet’s, read for reference and said to be', async () => {
    vi.resetModules();
    process.env.XORR_CHAIN = 'xlayer-testnet';
    try {
      const testnet = await import('./yield.js');
      const chains = await import('../evm/chains.js');
      expect(chains.AAVE_V3_POOL).toBeNull();
      expect(chains.SETTLEMENT_VENUES).not.toContain(POOL);
      expect(chains.APPROVABLE_TOKENS.map((t) => t.symbol)).not.toContain('USDT0');

      expect(await testnet.aavePoolIsDeployedHere()).toBe(false);
      expect(h.getCode).not.toHaveBeenCalled();

      h.referenceRead.mockImplementation(pool);
      const y = await testnet.supplyYield();
      expect(y.availableHere).toBe(false);
      expect(y.note).toMatch(/no lending pool/);
      // Mainnet's pool, through the reference client — not this chain's.
      expect(h.referenceRead).toHaveBeenCalled();
      expect(h.readContract).not.toHaveBeenCalled();
    } finally {
      process.env.XORR_CHAIN = 'xlayer-fork';
    }
  });
});
