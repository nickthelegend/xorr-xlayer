/**
 * The drawer must not manufacture reassurance. Two properties carry that:
 *
 *   an unread field is `null`, not a zero, a `false` or an omission — "nobody can pause this" and
 *   "we could not find out who can" are opposite facts about a security;
 *   an attestation always carries its age, and is marked stale past a day, so a week-old
 *   observation cannot be presented as the current state of the reserves.
 *
 * The contract reads are stood in for by a fake reader answering with the values X Layer mainnet
 * returned for NVDAx on 2026-09-19 (roles, supplies, multiplier, proxy admin slots).
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { getAddress } from 'viem';

const QUERY = vi.hoisted(() => {
  // A unit test needs no chain, and the repo-root `.env` may name one this executor no longer knows.
  process.env.XORR_CHAIN = 'xlayer-testnet';
  return vi.fn(async (..._args: unknown[]) => [] as unknown[]);
});
vi.mock('../db/index.js', () => ({ query: QUERY }));
// A test must never reach the network: the default reader is only built when no reader is passed.
vi.mock('../evm/client.js', () => ({ publicClient: {} }));

const BACKING = vi.hoisted(() => ({ backingFor: vi.fn(), backingHistory: vi.fn(async () => []) }));
vi.mock('./proof-of-reserves.js', () => BACKING);

const { backingDetail } = await import('./backing-detail.js');
type Reader = NonNullable<Parameters<typeof backingDetail>[1]>;

const WRAPPER = '0xa8ddb5cd96b5222afe198316e9a57caa642850d5';
const RAW = '0xc845b2894dBddd03858fd2D643B4eF725fE0849d';
const OWNER_SAFE = '0x49754062E35f7591B93cc4F9915965be89643a65';
const PAUSER_SAFE = '0x8768cDA7A463DAe1baA6b2500EFB025ebd7FFC50';
const MINTER = '0x0A934Bc9c64309C9654451f23D8331C2DAD34C2a';
const BURNER = '0x5F7A4c11bde4f218f0025Ef444c369d838ffa2aD';
const SANCTIONS = '0x615Dd3B9445A94334C1579F68115042D77CC7c44';
const RAW_ADMIN = getAddress('0x696c685a02a1fc6e2aacbe26cd6695f4f4a6a085');
const WRAP_ADMIN = getAddress('0x312063009e74142339edc92bcff6cfcfaa958bfa');

const word = (a: string) => `0x${'0'.repeat(24)}${a.slice(2).toLowerCase()}` as `0x${string}`;

/** What mainnet answered, function by function, for each contract. */
const RAW_ANSWERS: Record<string, unknown> = {
  owner: OWNER_SAFE,
  minter: MINTER,
  burner: BURNER,
  pauser: PAUSER_SAFE,
  multiplierUpdater: BURNER,
  sanctionsList: SANCTIONS,
  isPaused: false,
  multiplier: 1001701196801074000n,
  newMultiplier: 1001701196801074000n,
  newMultiplierActivationTime: 0n,
  totalSupply: 45246395498688786785496n,
};
const WRAP_ANSWERS: Record<string, unknown> = {
  owner: OWNER_SAFE,
  pauser: PAUSER_SAFE,
  isPaused: false,
  totalSupply: 2644554585933690912170n,
  totalAssets: 2649053493735546883787n,
};

function reader(over: { raw?: Record<string, unknown>; wrap?: Record<string, unknown>; fail?: boolean } = {}): Reader {
  const raw = { ...RAW_ANSWERS, ...over.raw };
  const wrap = { ...WRAP_ANSWERS, ...over.wrap };
  return {
    multicall: vi.fn(async ({ contracts }) => {
      if (over.fail) throw new Error('rpc down');
      return contracts.map((c: { address: string; functionName: string }) => {
        const table = c.address.toLowerCase() === RAW.toLowerCase() ? raw : wrap;
        const v = table[c.functionName];
        return v === undefined ? { status: 'failure' as const } : { status: 'success' as const, result: v };
      });
    }),
    getStorageAt: vi.fn(async ({ address }) => {
      if (over.fail) throw new Error('rpc down');
      return word(address.toLowerCase() === RAW.toLowerCase() ? RAW_ADMIN : WRAP_ADMIN);
    }),
  } as Reader;
}

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
  BACKING.backingFor.mockResolvedValue({ status: 'unverified', reason: 'x' });
});

describe('the issuer, read off the contracts', () => {
  it('names every role the raw token answers for, and the upgrade admin', async () => {
    const d = (await backingDetail('NVDAx', reader()))!;

    expect(d.issuer).toEqual({
      owner: OWNER_SAFE,
      minter: MINTER,
      burner: BURNER,
      pauser: PAUSER_SAFE,
      multiplierUpdater: BURNER,
      sanctionsList: SANCTIONS,
      upgradeAdmin: RAW_ADMIN,
      canMint: true,
      canPause: true,
      paused: false,
    });
    expect(d.wrapper).toEqual({ owner: OWNER_SAFE, pauser: PAUSER_SAFE, upgradeAdmin: WRAP_ADMIN, paused: false });
  });

  it('carries both supplies, in whole tokens', async () => {
    const d = (await backingDetail('NVDAx', reader()))!;

    expect(d.supply.raw).toBeCloseTo(45246.3955, 3);
    expect(d.supply.wrapped).toBeCloseTo(2644.5546, 3);
    expect(d.supply.wrappedAssets).toBeCloseTo(2649.0535, 3);
  });

  it('reads the multiplier, and states no effective time the contract does not give', async () => {
    const d = (await backingDetail('NVDAx', reader()))!;

    expect(d.multiplier.current).toBeCloseTo(1.0017012, 6);
    expect(d.multiplier.effectiveAt).toBeNull();
    expect(d.multiplier.pending).toBeNull();
    // With no stated effective time there is no honest row to write.
    expect(QUERY.mock.calls.some((c) => String(c[0]).includes('INSERT'))).toBe(false);
  });

  it('reports an announced change as pending, with its time', async () => {
    const at = Math.floor(Date.now() / 1000) + 86_400;
    const d = (await backingDetail(
      'NVDAx',
      reader({ raw: { newMultiplier: 2003402393602148000n, newMultiplierActivationTime: BigInt(at) } }),
    ))!;

    expect(d.multiplier.pending).toEqual({ multiplier: expect.closeTo(2.0034024, 6), effectiveAt: new Date(at * 1000).toISOString() });
    expect(d.multiplier.current).toBeCloseTo(1.0017012, 6);
  });

  it('says a role is not held when it is the zero address — false, not null', async () => {
    const d = (await backingDetail('NVDAx', reader({ raw: { minter: '0x0000000000000000000000000000000000000000' } })))!;
    expect(d.issuer.canMint).toBe(false);
  });

  it('leaves a read that failed null, and the rest intact', async () => {
    const d = (await backingDetail('NVDAx', reader({ raw: { pauser: undefined, isPaused: undefined } })))!;

    expect(d.issuer.pauser).toBeNull();
    expect(d.issuer.canPause).toBeNull();
    expect(d.issuer.paused).toBeNull();
    expect(d.issuer.minter).toBe(MINTER);
  });

  it('reports every contract field as null when the chain cannot be read, never as zero or false', async () => {
    const d = (await backingDetail('NVDAx', reader({ fail: true })))!;

    expect(Object.values(d.issuer).every((v) => v === null)).toBe(true);
    expect(Object.values(d.wrapper).every((v) => v === null)).toBe(true);
    expect(d.supply).toEqual({ raw: null, wrapped: null, wrappedAssets: null });
    expect(d.multiplier.current).toBeNull();
    expect(Object.keys(d.issuer)).toContain('canMint');
  });
});

describe('the attestation', () => {
  it('states its age and does not call a fresh one stale', async () => {
    BACKING.backingFor.mockResolvedValue(freshAttestation(new Date(Date.now() - 600_000).toISOString()));

    const d = (await backingDetail('NVDAx', reader()))!;
    expect(d.reserves.verified).toBe(true);
    if (!d.reserves.verified) return;
    expect(d.reserves.ageSeconds).toBeGreaterThanOrEqual(595);
    expect(d.reserves.ageSeconds).toBeLessThan(700);
    expect(d.reserves.stale).toBe(false);
  });

  it('marks a week-old attestation stale rather than letting it pass for current', async () => {
    const weekOld = new Date(Date.now() - 7 * 24 * 3600 * 1000).toISOString();
    BACKING.backingFor.mockResolvedValue(freshAttestation(weekOld));

    const d = (await backingDetail('NVDAx', reader()))!;
    if (!d.reserves.verified) throw new Error('expected verified');
    expect(d.reserves.stale).toBe(true);
    expect(d.reserves.asOf).toBe(weekOld);
  });

  it('carries an unverified attestation through as a reason, with no ratio', async () => {
    BACKING.backingFor.mockResolvedValue({ status: 'unverified', reason: 'attestor unreachable' });

    const d = (await backingDetail('NVDAx', reader()))!;
    expect(d.reserves.verified).toBe(false);
    expect(JSON.stringify(d.reserves)).not.toMatch(/"ratio"/);
  });
});

describe('the rest', () => {
  it('returns an empty history rather than inventing points', async () => {
    const d = (await backingDetail('NVDAx', reader()))!;
    expect(d.multiplier.history).toEqual([]);
    expect(d.attestationHistory).toEqual([]);
  });

  it('is null for a symbol that is not an xStock', async () => {
    expect(await backingDetail('NOTAREALTOKEN', reader())).toBeNull();
  });

  it('reads the addresses from the registry, not from the caller', async () => {
    const d = (await backingDetail('nvdax', reader()))!;
    expect(d.symbol).toBe('NVDAx');
    expect(d.address).toBe(WRAPPER);
    expect(d.raw).toBe(RAW);
  });
});
