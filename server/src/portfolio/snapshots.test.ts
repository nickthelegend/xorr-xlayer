/**
 * Portfolio history (PLAN.md 2.10): what is kept, when, and what is refused.
 *
 * These drive the real snapshot module with the database and the chain read replaced by recorders.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  statements: [] as { text: string; params: unknown[] }[],
  due: [] as { id: string; address: string }[],
}));

vi.mock('../db/index.js', () => ({
  query: vi.fn(async (text: string, params: unknown[] = []) => {
    h.statements.push({ text, params });
    return /FROM wallets w/.test(text) ? h.due : [];
  }),
}));
vi.mock('../evm/balances.js', () => ({ totalValueUsd: vi.fn() }));
vi.mock('../http/request-id.js', () => ({ log: { warn: vi.fn(), error: vi.fn(), info: vi.fn() } }));

const { totalValueUsd } = await import('../evm/balances.js');
const { clearSnapshotAttempts, historySince, snapshotSweep, snapshotWallet, thinPoints, SNAPSHOT_EVERY_MS } =
  await import('./snapshots.js');

const WALLET = { id: 'wallet-1', address: '0x95A0b368588713011a15f4b1041423f31B08e615' };
const value = {
  cash: 24_999.97,
  holdings: [
    { symbol: 'WETH', units: 0.002, usd: 5.04, raw: 2_000_000_000_000_000n },
    { symbol: 'cbBTC', units: 0.0001, usd: 6.01, raw: 10_000n },
  ],
  supplied: 100,
  total: 25_111.02,
};
const inserts = () => h.statements.filter((s) => /INSERT INTO portfolio_snapshots/.test(s.text));

beforeEach(() => {
  h.statements.length = 0;
  h.due = [];
  clearSnapshotAttempts();
  vi.mocked(totalValueUsd).mockReset();
});

describe('a snapshot', () => {
  it('keeps the value read from the chain, strictly, with why it was taken', async () => {
    vi.mocked(totalValueUsd).mockResolvedValue(value);
    expect(await snapshotWallet(WALLET, 'fill')).toBe(true);
    expect(vi.mocked(totalValueUsd)).toHaveBeenCalledWith(WALLET.address, { strict: true });
    expect(inserts()[0]!.params).toEqual(['wallet-1', 25_111.02, 24_999.97, 11.05, 100, 'fill']);
  });

  it('keeps nothing when the value cannot be read in full — a gap, never a made-up dip', async () => {
    vi.mocked(totalValueUsd).mockRejectedValue(new Error('No price feed for NVDAc'));
    expect(await snapshotWallet(WALLET, 'interval')).toBe(false);
    expect(inserts()).toHaveLength(0);
  });
});

describe('the sweep', () => {
  it('asks only for wallets that are due, on this chain, with real addresses', async () => {
    await snapshotSweep();
    const select = h.statements[0]!.text;
    expect(select).toMatch(/w\.address ~ '\^0x\[0-9a-fA-F\]\{40\}\$'/);
    expect(select).toMatch(/ps\.at > now\(\) - interval '15 minutes'/);
    expect(select.match(/chain = current_setting\('xorr\.chain_key'\)/g)).toHaveLength(3);
  });

  it('snapshots each due wallet, and does not re-read one that failed until the interval has passed', async () => {
    h.due = [WALLET, { id: 'wallet-2', address: '0x0EAc22965EB9DbCFBfDAE5c89899EF4C089e3c16' }];
    vi.mocked(totalValueUsd).mockImplementation(async (address) => {
      if (address === WALLET.address) return value;
      throw new Error('rpc timeout');
    });
    const t0 = Date.parse('2026-09-13T09:00:00Z');
    expect(await snapshotSweep(t0)).toEqual({ recorded: 1, failed: 1 });

    // The failing wallet is still due by the database's measure — it has no snapshot — but is not re-read yet.
    h.due = [{ id: 'wallet-2', address: '0x0EAc22965EB9DbCFBfDAE5c89899EF4C089e3c16' }];
    expect(await snapshotSweep(t0 + 30_000)).toEqual({ recorded: 0, failed: 0 });
    expect(await snapshotSweep(t0 + SNAPSHOT_EVERY_MS)).toEqual({ recorded: 0, failed: 1 });
  });
});

describe('a history', () => {
  it('knows its ranges and refuses anything else', () => {
    const now = Date.parse('2026-09-13T09:00:00Z');
    expect(historySince('1D', now)?.toISOString()).toBe('2026-09-12T09:00:00.000Z');
    expect(historySince('1W', now)?.toISOString()).toBe('2026-09-06T09:00:00.000Z');
    expect(historySince('1M', now)?.toISOString()).toBe('2026-08-14T09:00:00.000Z');
    expect(historySince('ALL', now)).toBeNull();
    expect(historySince('5Y', now)).toBeUndefined();
    expect(historySince('constructor', now)).toBeUndefined();
  });

  it('thins interval points, keeping every event and the latest value, and inventing none', () => {
    const points = Array.from({ length: 1_000 }, (_, i) => ({
      at: i,
      totalUsd: 100 + i,
      reason: (i === 10 || i === 700 ? 'close' : 'interval') as 'close' | 'interval',
    }));
    const thin = thinPoints(points, 50);
    expect(thin).toHaveLength(50);
    expect(thin.filter((p) => p.reason === 'close').map((p) => p.at)).toEqual([10, 700]);
    expect(thin.at(-1)).toEqual(points.at(-1));
    // Oldest first, and every point one that was actually stored.
    expect(thin.map((p) => p.at)).toEqual([...thin.map((p) => p.at)].sort((a, b) => a - b));
    for (const p of thin) expect(p).toBe(points[p.at]);
  });

  it('returns a short history untouched', () => {
    const points = [{ at: 1, totalUsd: 10, reason: 'interval' as const }];
    expect(thinPoints(points, 50)).toBe(points);
  });
});
