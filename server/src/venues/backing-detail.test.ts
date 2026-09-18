/**
 * The drawer must not manufacture reassurance. Two properties carry that:
 *
 *   an unread field is `null`, not a zero or an omission — "nobody can freeze this" and "we could
 *   not find out who can" are opposite facts about a security;
 *   an attestation always carries its age, and is marked stale past a day, so a week-old
 *   observation cannot be presented as the current state of the reserves.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';

const QUERY = vi.hoisted(() => vi.fn(async () => [] as unknown[]));
vi.mock('../db/index.js', () => ({ query: QUERY }));
vi.mock('../solana/connection.js', () => ({ connection: {} }));

const BACKING = vi.hoisted(() => ({ backingFor: vi.fn(), backingHistory: vi.fn(async () => []) }));
vi.mock('./proof-of-reserves.js', () => BACKING);

const SPL = vi.hoisted(() => ({
  getMint: vi.fn(),
  getTransferHook: vi.fn(),
  getPausableConfig: vi.fn(),
  getPermanentDelegate: vi.fn(),
}));
vi.mock('@solana/spl-token', async (orig) => ({
  ...(await orig<typeof import('@solana/spl-token')>()),
  ...SPL,
}));

const { backingDetail } = await import('./backing-detail.js');
const NVDAX = 'Xsc9qvGR1efVDFGLrVsmkzv3qi45LTBjeUKSPmx9qEh';

const freshAttestation = (asOf: string) => ({
  status: 'verified' as const,
  backing: {
    symbol: 'NVDAx',
    sharesHeld: 186898,
    circulatingSupply: 186692.75,
    ratio: 186898 / 186692.75,
    custodians: [{ provider: 'Alpaca', quantity: 186898, symbol: 'NVDA' }],
    asOf,
  },
});

beforeEach(() => {
  vi.clearAllMocks();
  QUERY.mockResolvedValue([]);
  BACKING.backingHistory.mockResolvedValue([]);
  SPL.getMint.mockRejectedValue(new Error('no chain in this test'));
  SPL.getTransferHook.mockReturnValue(null);
  SPL.getPausableConfig.mockReturnValue(null);
  SPL.getPermanentDelegate.mockReturnValue(null);
});

describe('backing detail', () => {
  it('states the age of an attestation and does not call a fresh one stale', async () => {
    BACKING.backingFor.mockResolvedValue(freshAttestation(new Date(Date.now() - 600_000).toISOString()));

    const d = (await backingDetail('NVDAx'))!;
    expect(d.reserves.verified).toBe(true);
    if (!d.reserves.verified) return;
    expect(d.reserves.ageSeconds).toBeGreaterThanOrEqual(595);
    expect(d.reserves.ageSeconds).toBeLessThan(700);
    expect(d.reserves.stale).toBe(false);
  });

  it('marks a week-old attestation stale rather than letting it pass for current', async () => {
    const weekOld = new Date(Date.now() - 7 * 24 * 3600 * 1000).toISOString();
    BACKING.backingFor.mockResolvedValue(freshAttestation(weekOld));

    const d = (await backingDetail('NVDAx'))!;
    if (!d.reserves.verified) throw new Error('expected verified');
    expect(d.reserves.stale).toBe(true);
    expect(d.reserves.ageSeconds).toBeGreaterThan(6 * 24 * 3600);
    // The timestamp itself is still carried, so the screen can show exactly when.
    expect(d.reserves.asOf).toBe(weekOld);
  });

  it('carries an unverified attestation through as a reason, with no ratio', async () => {
    BACKING.backingFor.mockResolvedValue({ status: 'unverified', reason: 'attestor unreachable' });

    const d = (await backingDetail('NVDAx'))!;
    expect(d.reserves.verified).toBe(false);
    expect(JSON.stringify(d.reserves)).not.toMatch(/"ratio"/);
  });

  it('reports issuer fields as null when the mint cannot be read, never as zero', async () => {
    BACKING.backingFor.mockResolvedValue({ status: 'unverified', reason: 'x' });

    const d = (await backingDetail('NVDAx'))!;
    // Null is "no record". A 0 or an absent key would both read as a fact we did not establish.
    expect(d.issuer.permanentDelegate).toBeNull();
    expect(d.issuer.freezeAuthority).toBeNull();
    expect(d.issuer.pausable).toBeNull();
    expect(d.multiplier.current).toBeNull();
    expect(d.multiplier.effectiveAt).toBeNull();
    expect(Object.keys(d.issuer)).toContain('permanentDelegate');
  });

  it('returns an empty history rather than inventing points', async () => {
    BACKING.backingFor.mockResolvedValue({ status: 'unverified', reason: 'x' });

    const d = (await backingDetail('NVDAx'))!;
    expect(d.multiplier.history).toEqual([]);
    expect(d.attestationHistory).toEqual([]);
  });

  it('is null for a symbol that is not an xStock', async () => {
    expect(await backingDetail('NOTAREALTOKEN')).toBeNull();
  });

  it('reads the mint address from the known xStock, not from the caller', async () => {
    BACKING.backingFor.mockResolvedValue({ status: 'unverified', reason: 'x' });
    const d = (await backingDetail('NVDAx'))!;
    expect(d.mint).toBe(NVDAX);
  });
});
