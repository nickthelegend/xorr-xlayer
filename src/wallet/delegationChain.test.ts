import { describe, expect, it } from 'vitest';
import type { Address, Hex } from 'viem';
import {
  assertGrantDestination,
  confirmStopped,
  contractToStop,
  readPolicy,
  standingOnChain,
  type ChainReader,
} from './delegationChain';

const OWNER = '0x95a0b368588713011a15f4b1041423f31b08e615' as Address;
const LIVE = '0xc32dd8aeed3035d46c7c82a351fc5522c9d463f4' as Address;
const STALE = '0x1111111111111111111111111111111111111111' as Address;
const REVOKED = '0x2222222222222222222222222222222222222222' as Address;
const BROKEN = '0x3333333333333333333333333333333333333333' as Address;
const DELEGATE = '0xc38f00000000000000000000000000000000c8a5' as Address;
const NO_ADDRESS = '0x0000000000000000000000000000000000000000' as Address;

type Contract = {
  code?: Hex;
  policy?: readonly [Address, bigint, bigint, boolean];
  /** Nothing answers at all: the node is down. */
  unreadable?: boolean;
  /** The code answers and `policyOf` does not. */
  policyUnreadable?: boolean;
};

/** The chain as a table of contracts. Reads only: the transaction itself is proven on a fork (tools/prove-stop-without-server.ts). */
function chain(contracts: Record<string, Contract>, receipt: 'success' | 'reverted' = 'success') {
  const reader = {
    getCode: async ({ address }: { address: Address }) => {
      const c = contracts[address.toLowerCase()];
      if (c?.unreadable) throw new Error('rpc unavailable');
      return c?.code;
    },
    readContract: async ({ address }: { address: Address }) => {
      const c = contracts[address.toLowerCase()];
      if (c?.policyUnreadable) throw new Error('rpc unavailable');
      return c?.policy ?? [NO_ADDRESS, 0n, 0n, false];
    },
    waitForTransactionReceipt: async () => ({ status: receipt }),
  };
  return reader as unknown as ChainReader;
}

const live = (revoked = false): Contract => ({ code: '0x6080', policy: [DELEGATE, 1_600_000_000n, 1_999_999_999n, revoked] });

describe('assertGrantDestination', () => {
  it('refuses a contract other than the pinned one, before reading anything', async () => {
    await expect(assertGrantDestination(chain({ [STALE]: live() }), STALE, LIVE)).rejects.toThrow(/different contract/);
  });

  it('refuses an address with no contract, pinned or not', async () => {
    await expect(assertGrantDestination(chain({}), LIVE, undefined)).rejects.toThrow(/no contract/);
    await expect(assertGrantDestination(chain({ [LIVE]: { code: '0x' } }), LIVE, LIVE)).rejects.toThrow(/no contract/);
  });

  it('lets a grant go to the pinned contract when it has code, whatever the address casing', async () => {
    await expect(
      assertGrantDestination(chain({ [LIVE]: live() }), LIVE.toUpperCase().replace('0X', '0x') as Address, LIVE),
    ).resolves.toBeUndefined();
  });
});

describe('readPolicy', () => {
  it('is null where there is no contract, or where this wallet never granted', async () => {
    expect(await readPolicy(chain({}), LIVE, OWNER)).toBeNull();
    expect(await readPolicy(chain({ [LIVE]: { code: '0x6080' } }), LIVE, OWNER)).toBeNull();
  });

  it('reads the policy the contract holds', async () => {
    expect(await readPolicy(chain({ [LIVE]: live(true) }), LIVE, OWNER)).toEqual({
      delegate: DELEGATE,
      dailyCap: 1_600_000_000n,
      expiresAt: 1_999_999_999n,
      revoked: true,
    });
  });
});

describe('contractToStop', () => {
  it('passes over a stale pin with nothing on it and stops where the live policy is', async () => {
    expect(await contractToStop(chain({ [LIVE]: live() }), OWNER, [STALE, LIVE])).toBe(LIVE);
  });

  it('needs no server answer when the pinned contract holds the policy', async () => {
    expect(await contractToStop(chain({ [LIVE]: live() }), OWNER, [LIVE, undefined])).toBe(LIVE);
  });

  it('does not stop a permission that is already revoked', async () => {
    expect(await contractToStop(chain({ [REVOKED]: live(true) }), OWNER, [REVOKED])).toBeUndefined();
  });

  it('passes over a candidate it cannot read when another answers', async () => {
    expect(await contractToStop(chain({ [BROKEN]: { unreadable: true }, [LIVE]: live() }), OWNER, [BROKEN, LIVE])).toBe(LIVE);
  });

  it('says the chain could not be read rather than that there is nothing to stop', async () => {
    await expect(contractToStop(chain({ [BROKEN]: { unreadable: true } }), OWNER, [BROKEN])).rejects.toThrow(/could not be read/);
  });
});

/*
 * Safety with the executor down (FEATURES.md #1). The screen shows a live permission read here, with a stop that works,
 * and keeps everything else unknown — so each answer has to be told apart from the others, a failed read above all.
 */
describe('standingOnChain', () => {
  const NOW = 1_788_912_000_000;

  it('finds a live policy on the contract, with what it holds', async () => {
    expect(await standingOnChain(chain({ [LIVE]: live() }), OWNER, LIVE, NOW)).toEqual({
      kind: 'live',
      contract: LIVE,
      policy: { delegate: DELEGATE, dailyCap: 1_600_000_000n, expiresAt: 1_999_999_999n, revoked: false },
    });
  });

  it('says revoked for a permission already stopped, whatever its clock says', async () => {
    expect((await standingOnChain(chain({ [REVOKED]: live(true) }), OWNER, REVOKED, NOW)).kind).toBe('revoked');
    const stoppedAndLapsed: Contract = { code: '0x6080', policy: [DELEGATE, 1_600_000_000n, 1n, true] };
    expect((await standingOnChain(chain({ [REVOKED]: stoppedAndLapsed }), OWNER, REVOKED, NOW)).kind).toBe('revoked');
  });

  it('says expired from the second the contract refuses on the clock, and live the second before', async () => {
    const lapsing: Contract = { code: '0x6080', policy: [DELEGATE, 1_600_000_000n, BigInt(NOW / 1000), false] };
    expect((await standingOnChain(chain({ [LIVE]: lapsing }), OWNER, LIVE, NOW)).kind).toBe('expired');
    expect((await standingOnChain(chain({ [LIVE]: lapsing }), OWNER, LIVE, NOW - 1000)).kind).toBe('live');
  });

  it('is none with no contract to ask, no code at the address, or no grant there', async () => {
    expect(await standingOnChain(chain({ [LIVE]: live() }), OWNER, undefined, NOW)).toEqual({ kind: 'none' });
    expect(await standingOnChain(chain({}), OWNER, STALE, NOW)).toEqual({ kind: 'none' });
    expect(await standingOnChain(chain({ [LIVE]: { code: '0x6080' } }), OWNER, LIVE, NOW)).toEqual({ kind: 'none' });
  });

  it('is unreadable, never none, when the chain cannot be read', async () => {
    expect(await standingOnChain(chain({ [BROKEN]: { unreadable: true } }), OWNER, BROKEN, NOW)).toEqual({
      kind: 'unreadable',
    });
    expect(
      await standingOnChain(chain({ [LIVE]: { code: '0x6080', policyUnreadable: true } }), OWNER, LIVE, NOW),
    ).toEqual({ kind: 'unreadable' });
  });
});

describe('confirmStopped', () => {
  const tx = '0xabc' as Hex;

  it('passes only when the receipt succeeded and the chain shows the policy revoked', async () => {
    await expect(confirmStopped(chain({ [LIVE]: live(true) }), LIVE, OWNER, tx)).resolves.toBeUndefined();
  });

  it('throws when the transaction reverted', async () => {
    await expect(confirmStopped(chain({ [LIVE]: live(true) }, 'reverted'), LIVE, OWNER, tx)).rejects.toThrow(/reverted/);
  });

  it('throws when it landed but the policy is still live', async () => {
    await expect(confirmStopped(chain({ [LIVE]: live(false) }), LIVE, OWNER, tx)).rejects.toThrow(/does not show/);
  });
});
