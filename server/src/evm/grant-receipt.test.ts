/**
 * A hash is recorded for what its transaction did, not for having succeeded (PLAN.md 4.8).
 *
 * `/delegation/record` took any successful transaction and recorded whatever policy the wallet
 * held. These are the logs a `grant`, a `revoke` and an `approve` leave, encoded against the
 * contract's own event signatures; `fork/` proofs send the transactions themselves.
 */
import { describe, expect, it, vi } from 'vitest';
import { encodeAbiParameters, encodeEventTopics, erc20Abi, getAddress, type Address, type Hex, type Log } from 'viem';

vi.mock('./client.js', () => ({
  publicClient: {},
  walletClient: {},
  delegateAccount: { address: '0xC38f38f45463f77bD823FebE16b15714Eb98c8A5' },
}));

const { DELEGATION_ABI, grantInLogs, revokeInLogs } = await import('./delegation.js');

const CONTRACT = getAddress('0x6c5528fd8e74a047a85bab413856a9239e73540e');
const IMPOSTOR = getAddress('0x1111111111111111111111111111111111111111');
const USDC = getAddress('0x833589fcd6edb6e08f4c7c32d4f71b54bda02913');
const OWNER = getAddress('0x95a0b368588713011a15f4b1041423f31b08e615');
const SOMEONE_ELSE = getAddress('0x2222222222222222222222222222222222222222');
const DELEGATE = getAddress('0xc38f38f45463f77bd823febe16b15714eb98c8a5');
const OLD_KEY = getAddress('0xe992fe7a1b2c3d4e5f60718293a4b5c6d7e8f901');
const EXPIRY = 1_790_000_000n;

let logIndex = 0;
function log(address: Address, topics: unknown[], data: Hex): Log {
  return {
    address,
    topics: topics as [Hex, ...Hex[]],
    data,
    blockHash: `0x${'ab'.repeat(32)}`,
    blockNumber: 1n,
    logIndex: logIndex++,
    transactionHash: `0x${'cd'.repeat(32)}`,
    transactionIndex: 0,
    removed: false,
  };
}

function granted(from: Address, owner: Address, delegate: Address, capUsd: number, expiresAt = EXPIRY): Log {
  return log(
    from,
    encodeEventTopics({ abi: DELEGATION_ABI, eventName: 'Granted', args: { owner, delegate } }),
    encodeAbiParameters([{ type: 'uint256' }, { type: 'uint64' }], [BigInt(capUsd) * 1_000_000n, expiresAt]),
  );
}

function revoked(from: Address, owner: Address, delegate: Address): Log {
  return log(from, encodeEventTopics({ abi: DELEGATION_ABI, eventName: 'Revoked', args: { owner, delegate } }), '0x');
}

function approval(owner: Address, spender: Address): Log {
  return log(
    USDC,
    encodeEventTopics({ abi: erc20Abi, eventName: 'Approval', args: { owner, spender } }),
    encodeAbiParameters([{ type: 'uint256' }], [42_000_000_000n]),
  );
}

const expected = { contract: CONTRACT, owner: OWNER, delegate: DELEGATE };

describe('a grant, read from its own transaction', () => {
  it('takes the cap and the expiry from the event', () => {
    expect(grantInLogs([approval(OWNER, CONTRACT), granted(CONTRACT, OWNER, DELEGATE, 1_400)], expected)).toEqual({
      ok: true,
      grant: { owner: OWNER, delegate: DELEGATE, dailyCapUsd: 1_400, expiresAt: 1_790_000_000_000 },
    });
  });

  it('refuses a transaction that granted nothing, however successful', () => {
    const refusal = grantInLogs([approval(OWNER, CONTRACT)], expected);
    expect(refusal).toMatchObject({ ok: false, error: 'no_grant_event' });
    expect(refusal.ok ? '' : refusal.message).toMatch(/did not grant/);
    expect(grantInLogs([], expected)).toMatchObject({ ok: false, error: 'no_grant_event' });
  });

  it('refuses the same event emitted by any other contract', () => {
    expect(grantInLogs([granted(IMPOSTOR, OWNER, DELEGATE, 1_400)], expected)).toMatchObject({
      ok: false,
      error: 'no_grant_event',
    });
  });

  it("refuses another wallet's grant", () => {
    const refusal = grantInLogs([granted(CONTRACT, SOMEONE_ELSE, DELEGATE, 1_400)], expected);
    expect(refusal).toMatchObject({ ok: false, error: 'grant_owner_mismatch' });
    expect(refusal.ok ? '' : refusal.message).toMatch(/different wallet/);
  });

  it('refuses a grant to a key this executor does not sign with', () => {
    const refusal = grantInLogs([granted(CONTRACT, OWNER, OLD_KEY, 1_400)], expected);
    expect(refusal).toMatchObject({ ok: false, error: 'grant_delegate_mismatch' });
    expect(refusal.ok ? '' : refusal.message).toMatch(/does not sign with/);
  });

  it('matches addresses whatever their case', () => {
    const lower = {
      contract: CONTRACT.toLowerCase() as Address,
      owner: OWNER.toLowerCase() as Address,
      delegate: DELEGATE.toLowerCase() as Address,
    };
    expect(grantInLogs([granted(CONTRACT, OWNER, DELEGATE, 1_400)], lower)).toMatchObject({ ok: true });
  });

  it('keeps the last of this wallet’s grants in one transaction, because a grant replaces the one before', () => {
    const logs = [
      granted(CONTRACT, OWNER, DELEGATE, 400),
      granted(CONTRACT, SOMEONE_ELSE, DELEGATE, 9_000, EXPIRY + 120n),
      granted(CONTRACT, OWNER, DELEGATE, 1_400, EXPIRY + 60n),
    ];
    expect(grantInLogs(logs, expected)).toEqual({
      ok: true,
      grant: { owner: OWNER, delegate: DELEGATE, dailyCapUsd: 1_400, expiresAt: 1_790_000_060_000 },
    });
  });
});

describe('a revoke, read from its own transaction', () => {
  it("accepts this wallet's revoke, emitted by the delegation", () => {
    expect(revokeInLogs([revoked(CONTRACT, OWNER, DELEGATE)], expected)).toEqual({ ok: true });
  });

  it('refuses a transaction that revoked nothing — an approval, or a grant', () => {
    expect(revokeInLogs([approval(OWNER, CONTRACT)], expected)).toMatchObject({ ok: false, error: 'no_revoke_event' });
    expect(revokeInLogs([granted(CONTRACT, OWNER, DELEGATE, 1_400)], expected)).toMatchObject({
      ok: false,
      error: 'no_revoke_event',
    });
  });

  it('refuses the same event emitted by any other contract', () => {
    expect(revokeInLogs([revoked(IMPOSTOR, OWNER, DELEGATE)], expected)).toMatchObject({
      ok: false,
      error: 'no_revoke_event',
    });
  });

  it("refuses another wallet's revoke", () => {
    expect(revokeInLogs([revoked(CONTRACT, SOMEONE_ELSE, DELEGATE)], expected)).toMatchObject({
      ok: false,
      error: 'revoke_owner_mismatch',
    });
  });
});
