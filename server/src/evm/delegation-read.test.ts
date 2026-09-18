/**
 * Reading a permission (PLAN.md 2.4, 2.5).
 *
 * `readPolicy` was three `eth_call`s and the permission screen added the venue list as a second
 * round. Both are now one multicall each — and a failed read must still throw, never come back as
 * "no permission" or "no venues".
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => {
  process.env.DELEGATION_ADDRESS = '0x6c5528Fd8E74a047A85bAb413856A9239E73540e';
  return { multicall: vi.fn() };
});

vi.mock('./client.js', () => ({
  publicClient: { multicall: h.multicall },
  walletClient: {},
  delegateAccount: { address: '0xC38f38f45463f77bD823FebE16b15714Eb98c8A5' },
}));

const { readPolicy, readPolicyAndVenues } = await import('./delegation.js');
const { SETTLEMENT_VENUES } = await import('./chains.js');

const OWNER = '0x95A0b368588713011a15f4b1041423f31B08e615';
const DELEGATE = '0xC38f38f45463f77bD823FebE16b15714Eb98c8A5';
const usd = (n: number) => BigInt(Math.round(n * 1e6));
const called = () => (h.multicall.mock.calls[0]![0] as { contracts: { functionName: string }[] }).contracts;

// A block body: vitest runs a function returned from `beforeEach` as teardown, and `mockReset`
// returns the mock itself — which would call the mock after every test.
beforeEach(() => {
  h.multicall.mockReset();
});

describe('the permission', () => {
  it('is one multicall of policyOf, remainingToday and spentToday', async () => {
    h.multicall.mockResolvedValue([[DELEGATE, usd(1_600), 1_791_000_000n, false], usd(1_450), usd(150)]);
    const policy = await readPolicy(OWNER);
    expect(h.multicall).toHaveBeenCalledTimes(1);
    expect(h.multicall.mock.calls[0]![0]).toMatchObject({ allowFailure: false });
    expect(called().map((c) => c.functionName)).toEqual(['policyOf', 'remainingToday', 'spentToday']);
    expect(policy).toEqual({
      delegate: DELEGATE,
      dailyCapUsd: 1_600,
      expiresAt: 1_791_000_000_000,
      revoked: false,
      remainingTodayUsd: 1_450,
      spentTodayUsd: 150,
    });
  });

  it('is null where nobody was ever granted', async () => {
    h.multicall.mockResolvedValue([['0x0000000000000000000000000000000000000000', 0n, 0n, false], 0n, 0n]);
    expect(await readPolicy(OWNER)).toBeNull();
  });

  it('a failed read throws — it is never "no permission"', async () => {
    h.multicall.mockRejectedValue(new Error('execution reverted'));
    await expect(readPolicy(OWNER)).rejects.toThrow('execution reverted');
  });
});

describe('the permission and its venues', () => {
  it('come back from the same single read', async () => {
    const allowed = SETTLEMENT_VENUES.map((_, i) => i === 0);
    h.multicall.mockResolvedValue([[DELEGATE, usd(2_810), 1_791_000_000n, false], usd(2_810), 0n, ...allowed]);
    const { policy, venues } = await readPolicyAndVenues(OWNER);
    expect(h.multicall).toHaveBeenCalledTimes(1);
    expect(called().map((c) => c.functionName)).toEqual([
      'policyOf',
      'remainingToday',
      'spentToday',
      ...SETTLEMENT_VENUES.map(() => 'isVenueAllowed'),
    ]);
    expect(policy?.dailyCapUsd).toBe(2_810);
    expect(venues).toEqual([SETTLEMENT_VENUES[0]]);
  });

  it('a failed read throws rather than answering with no venues', async () => {
    h.multicall.mockRejectedValue(new Error('timeout'));
    await expect(readPolicyAndVenues(OWNER)).rejects.toThrow('timeout');
  });
});
