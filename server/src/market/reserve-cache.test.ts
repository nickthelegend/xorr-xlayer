/**
 * The Aave reserve read, and the pool check in front of it (PLAN.md 2.4).
 *
 * Both executors' logs showed `/wallet/balance` waiting out the public endpoint's throttle back-off
 * on this read — 1.2 s, 2.4 s, 3.6 s — so the reserve is kept for a minute. These drive the real
 * module with the mainnet client and the local chain client replaced.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ readContract: vi.fn(), getCode: vi.fn() }));

vi.mock('viem', async (importOriginal) => ({
  ...(await importOriginal<typeof import('viem')>()),
  createPublicClient: () => ({ readContract: h.readContract }),
}));
vi.mock('../evm/client.js', () => ({ publicClient: { getCode: h.getCode } }));

const { usdcReserve, clearReserveCache, aavePoolIsDeployedHere } = await import('./yield.js');

const RAY = 10n ** 27n;
const reserve = {
  configuration: 0n,
  liquidityIndex: RAY,
  currentLiquidityRate: (RAY * 4n) / 100n,
  variableBorrowIndex: RAY,
  currentVariableBorrowRate: 0n,
  currentStableBorrowRate: 0n,
  lastUpdateTimestamp: 1_791_000_000,
  id: 4,
  aTokenAddress: '0x4e65fE4DbA92790696d040ac24Aa414708F5c0AB',
  stableDebtTokenAddress: '0x0000000000000000000000000000000000000001',
  variableDebtTokenAddress: '0x0000000000000000000000000000000000000002',
  interestRateStrategyAddress: '0x0000000000000000000000000000000000000003',
  accruedToTreasury: 0n,
  unbacked: 0n,
  isolationModeTotalDebt: 0n,
};

beforeEach(() => {
  vi.useRealTimers();
  clearReserveCache();
  h.readContract.mockReset();
  h.getCode.mockReset();
});

describe('the reserve', () => {
  it('is read once a minute, however many screens ask', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-09-13T09:00:00Z'));
    h.readContract.mockResolvedValue(reserve);

    const [a, b] = await Promise.all([usdcReserve(), usdcReserve()]);
    expect(a.aToken).toBe(reserve.aTokenAddress);
    expect(b).toBe(a);
    vi.setSystemTime(new Date('2026-09-13T09:00:59Z'));
    await usdcReserve();
    expect(h.readContract).toHaveBeenCalledTimes(1);

    vi.setSystemTime(new Date('2026-09-13T09:01:01Z'));
    await usdcReserve();
    expect(h.readContract).toHaveBeenCalledTimes(2);
  });

  it('is read now when the caller asks for no cache', async () => {
    h.readContract.mockResolvedValue(reserve);
    await usdcReserve();
    await usdcReserve(0);
    expect(h.readContract).toHaveBeenCalledTimes(2);
  });

  it('is not kept when the read failed', async () => {
    h.readContract.mockRejectedValueOnce(new Error('execution reverted')).mockResolvedValue(reserve);
    await expect(usdcReserve()).rejects.toThrow('execution reverted');
    await expect(usdcReserve()).resolves.toMatchObject({ aToken: reserve.aTokenAddress });
    expect(h.readContract).toHaveBeenCalledTimes(2);
  });
});

describe('whether this chain has a pool', () => {
  it('a check that failed is not remembered as "no pool"', async () => {
    h.getCode.mockRejectedValueOnce(new Error('rpc down')).mockResolvedValue('0x6080604052');
    await expect(aavePoolIsDeployedHere()).rejects.toThrow('rpc down');
    await expect(aavePoolIsDeployedHere()).resolves.toBe(true);
    // Remembered once known.
    await aavePoolIsDeployedHere();
    expect(h.getCode).toHaveBeenCalledTimes(2);
  });
});
