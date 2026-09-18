/**
 * USDC supplied to Aave, as part of the balance (PLAN.md 2.4).
 *
 * The reserve was read from mainnet before anything asked whether this chain has a pool, so
 * every testnet balance paid a throttled public read to learn the answer was 0.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  getCode: vi.fn(),
  readContract: vi.fn(),
  multicall: vi.fn(),
  poolHere: vi.fn(),
  usdcReserve: vi.fn(),
}));

vi.mock('./client.js', () => ({ publicClient: { getCode: h.getCode, readContract: h.readContract, multicall: h.multicall } }));
vi.mock('../market/yield.js', () => ({ aavePoolIsDeployedHere: h.poolHere, usdcReserve: h.usdcReserve }));
vi.mock('../market/prices.js', () => ({ priceOf: vi.fn() }));
vi.mock('../venues/tokens.js', () => ({
  // X Layer mainnet: wrapped OKB, OKX's wrapped BTC, the NVDAx xStock and Circle's USDC.
  TOKENS: {
    WOKB: { address: '0xe538905cf8410324e03A5A23C1c177a474D59b2b', decimals: 18 },
    XBTC: { address: '0xb7C00000bcDEeF966b20B3D884B98E64d2b06b4f', decimals: 8 },
    NVDAx: { address: '0xa8ddb5cd96b5222afe198316e9a57caa642850d5', decimals: 18 },
    USDC: { address: '0xB6CEceAB302E2E4948951eE7843FC24E92933061', decimals: 6 },
  },
  canonicalSymbol: (raw: string) =>
    ({ XBTC: 'XBTC', WOKB: 'WOKB', USDC: 'USDC', NVDAX: 'NVDAx' })[raw.toUpperCase()] ?? raw,
}));

const { priceOf } = await import('../market/prices.js');
const { StillFetching } = await import('../http/deadline.js');
const { chainUnitsOf, clearReadableTokenCache, suppliedUsd, totalValueUsd } = await import('./balances.js');

const OWNER = '0x95A0b368588713011a15f4b1041423f31B08e615';

beforeEach(() => {
  for (const f of Object.values(h)) f.mockReset();
  clearReadableTokenCache();
});

describe('units held, for holding a ledger to the chain (PLAN.md 2.7)', () => {
  it('asks each token once under its registry name and answers under the spelling it was asked with', async () => {
    h.getCode.mockResolvedValue('0x6080604052');
    h.multicall.mockResolvedValue([0n, 449_116n]);
    const held = await chainUnitsOf(OWNER, ['WOKB', 'xbtc', 'NOPE', 'USDC']);
    expect(h.multicall).toHaveBeenCalledTimes(1);
    expect(held.get('WOKB')).toBe(0);
    // Asked as `xbtc`, answered as `xbtc`: the registry's `XBTC` is how it was looked up.
    expect(held.get('xbtc')).toBe(0.00449116);
    // Not in the registry, and the settlement token: not checked, which is not the same as none held.
    expect(held.get('NOPE')).toBeNull();
    expect(held.get('USDC')).toBeNull();
  });

  it('asks nothing at all when no symbol is in the registry', async () => {
    expect([...(await chainUnitsOf(OWNER, ['CHAINPROBE'])).values()]).toEqual([null]);
    expect(h.getCode).not.toHaveBeenCalled();
    expect(h.multicall).not.toHaveBeenCalled();
  });

  it('a registry address with no contract on this chain holds none; code that cannot be called is not checked', async () => {
    h.getCode.mockImplementation(async ({ address }: { address: string }) =>
      address === '0xe538905cf8410324e03A5A23C1c177a474D59b2b' ? '0x6080604052' : address.startsWith('0xb7C0') ? undefined : '0xef',
    );
    h.multicall.mockResolvedValue([0n]);
    const held = await chainUnitsOf(OWNER, ['WOKB', 'XBTC', 'NVDAx']);
    expect(held.get('WOKB')).toBe(0);
    // Mainnet XBTC on a chain where that address is empty (the testnet): nothing can be held there.
    expect(held.get('XBTC')).toBe(0);
    // An equity whose code halts the EVM when called: present, but not something a balance can be asked of.
    expect(held.get('NVDAx')).toBeNull();
    expect((h.multicall.mock.calls[0]![0] as { contracts: unknown[] }).contracts).toHaveLength(1);
  });

  it('a code lookup that fails throws, and is not remembered as "no contract"', async () => {
    h.getCode.mockRejectedValueOnce(new Error('rpc down')).mockResolvedValue('0x6080604052');
    await expect(chainUnitsOf(OWNER, ['WOKB'])).rejects.toThrow('rpc down');
    h.multicall.mockResolvedValue([10n ** 18n]);
    expect((await chainUnitsOf(OWNER, ['WOKB'])).get('WOKB')).toBe(1);
  });

  it('a balance read that fails throws rather than answering with zeros', async () => {
    h.getCode.mockResolvedValue('0x6080604052');
    h.multicall.mockRejectedValue(new Error('rpc timeout'));
    await expect(chainUnitsOf(OWNER, ['WOKB'])).rejects.toThrow('rpc timeout');
  });
});

describe('the total, for keeping (PLAN.md 2.10)', () => {
  const ok = (result: bigint) => ({ status: 'success', result });
  beforeEach(() => {
    h.readContract.mockResolvedValue(100_000_000n); // $100 of cash
    h.getCode.mockResolvedValue('0x6080604052');
    h.multicall.mockResolvedValue([ok(0n), ok(0n), ok(0n)]); // nothing else held
    vi.mocked(priceOf).mockReset();
  });

  it('a supplied balance Aave did not answer is 0 on a screen, and an error when the value will be kept', async () => {
    h.poolHere.mockRejectedValue(new Error('aave timeout'));
    vi.spyOn(console, 'error').mockImplementation(() => {});
    expect((await totalValueUsd(OWNER)).total).toBe(100);
    await expect(totalValueUsd(OWNER, { strict: true })).rejects.toThrow('aave timeout');
  });

  it('an unpriced holding is $0 on a screen, and an error when the value will be kept', async () => {
    h.poolHere.mockResolvedValue(false);
    h.multicall.mockResolvedValue([ok(10n ** 18n), ok(0n), ok(0n)]); // 1 WOKB
    vi.mocked(priceOf).mockRejectedValue(new Error('No price feed for WOKB'));
    expect((await totalValueUsd(OWNER)).holdings[0]).toMatchObject({ symbol: 'WOKB', units: 1, usd: 0 });
    await expect(totalValueUsd(OWNER, { strict: true })).rejects.toThrow('No price feed for WOKB');
  });
});

describe('supplied USDC', () => {
  it('is 0 on a chain with no pool, without asking mainnet for the reserve', async () => {
    h.poolHere.mockResolvedValue(false);
    expect(await suppliedUsd(OWNER)).toBe(0);
    expect(h.usdcReserve).not.toHaveBeenCalled();
    expect(h.readContract).not.toHaveBeenCalled();
  });

  it('is the aToken balance where there is a pool', async () => {
    h.poolHere.mockResolvedValue(true);
    h.usdcReserve.mockResolvedValue({
      apy: 0.04,
      aToken: '0x4e65fE4DbA92790696d040ac24Aa414708F5c0AB',
      asset: '0xB6CEceAB302E2E4948951eE7843FC24E92933061',
      pool: '0xA238Dd80C259a72e81d7e4664a9801593F98d1c5',
    });
    h.getCode.mockResolvedValue('0x6080604052');
    h.readContract.mockResolvedValue(1_234_560_000n);
    expect(await suppliedUsd(OWNER)).toBe(1234.56);
  });

  it('a pool check that fails is an error, not "nothing supplied"', async () => {
    h.poolHere.mockRejectedValue(new Error('rpc down'));
    await expect(suppliedUsd(OWNER)).rejects.toThrow('rpc down');
  });
});

describe('a screen’s patience (http/patience.ts)', () => {
  const ok = (result: bigint) => ({ status: 'success', result });
  beforeEach(() => {
    h.readContract.mockResolvedValue(100_000_000n); // $100 of cash
    h.getCode.mockResolvedValue('0x6080604052');
    vi.mocked(priceOf).mockReset();
  });

  it('reaches the price lookup, and a price still being fetched is thrown — never counted as $0', async () => {
    h.poolHere.mockResolvedValue(false);
    h.multicall.mockResolvedValue([ok(10n ** 18n), ok(0n), ok(0n)]); // 1 WOKB
    vi.mocked(priceOf).mockRejectedValue(new StillFetching('the price of WOKB'));
    await expect(totalValueUsd(OWNER, { priceDeadlineMs: 4_000 })).rejects.toBeInstanceOf(StillFetching);
    expect(vi.mocked(priceOf)).toHaveBeenCalledWith('WOKB', 4_000);
  });

  it('an Aave reserve that does not answer in time is nothing supplied, as one that fails is — unless the value is kept', async () => {
    h.multicall.mockResolvedValue([ok(0n), ok(0n), ok(0n)]);
    h.poolHere.mockResolvedValue(true);
    h.usdcReserve.mockImplementation(() => new Promise(() => {}));
    vi.spyOn(console, 'error').mockImplementation(() => {});

    const started = Date.now();
    expect((await totalValueUsd(OWNER, { suppliedDeadlineMs: 50 })).total).toBe(100);
    expect(Date.now() - started).toBeLessThan(1_000);
    await expect(totalValueUsd(OWNER, { strict: true, suppliedDeadlineMs: 50 })).rejects.toThrow('no answer in 50ms');
  });
});
