/**
 * The distinction this module exists to preserve: "we checked an allow-list and this wallet is on
 * it" and "there is no allow-list" are different statements, and only one of them is an approval.
 *
 * So `not-configured` must never collapse into `pass`, and an unread gate must never collapse into
 * either. Telling someone they are cleared to buy a restricted security on the strength of an RPC
 * call that failed is the outcome worth writing tests against.
 */
import { describe, expect, it, vi } from 'vitest';
import { PublicKey } from '@solana/web3.js';
import { AccountState, TOKEN_2022_PROGRAM_ID } from '@solana/spl-token';
import { checkEligibility } from './eligibility.js';

const NVDAX = 'Xsc9qvGR1efVDFGLrVsmkzv3qi45LTBjeUKSPmx9qEh';
const WALLET = '7v91N7iZEdMoQg6zJ5pA9oG3eF1n3hXyZ1W2v3u4t5s6';
const ISSUER = new PublicKey('5aMNNLQJwAEeoemTEMkv5NVjqKwvvefRYCQ5Z67HFvEq');

type Opts = {
  paused?: boolean;
  hookProgram?: PublicKey;
  defaultFrozen?: boolean;
  accountFrozen?: boolean;
  accountMissing?: boolean;
  mintThrows?: boolean;
};

/** Stub the spl-token readers rather than hand-encode TLV: the logic under test is the verdict. */
function stub(o: Opts = {}) {
  vi.doMock('@solana/spl-token', async (orig) => {
    const actual = await orig<typeof import('@solana/spl-token')>();
    return {
      ...actual,
      getMint: vi.fn(async () => {
        if (o.mintThrows) throw new Error('RPC down');
        return { decimals: 8, tlvData: Buffer.alloc(0) };
      }),
      getPausableConfig: () => ({ authority: ISSUER, paused: o.paused ?? false }),
      getTransferHook: () => ({ authority: ISSUER, programId: o.hookProgram ?? PublicKey.default }),
      getDefaultAccountState: () => ({
        state: o.defaultFrozen ? AccountState.Frozen : AccountState.Initialized,
      }),
      getPermanentDelegate: () => ({ delegate: ISSUER }),
      getAccount: vi.fn(async () => {
        if (o.accountMissing) throw new actual.TokenAccountNotFoundError();
        return { isFrozen: o.accountFrozen ?? false };
      }),
    };
  });
}

async function run(o: Opts = {}, conn: unknown = { getAccountInfo: async () => null }) {
  vi.resetModules();
  stub(o);
  vi.doMock('./connection.js', () => ({ connection: {} }));
  vi.doMock('./balances.js', async (orig) => ({
    ...(await orig<typeof import('./balances.js')>()),
    tokenProgramForMint: () => TOKEN_2022_PROGRAM_ID,
  }));
  const { checkEligibility: fn } = await import('./eligibility.js');
  return fn(WALLET, NVDAX, conn as never);
}

describe('xStock transfer eligibility', () => {
  it('does not claim an allow-list check when no hook program is configured', async () => {
    const e = await run({ accountMissing: true });

    expect(e.eligible).toBe(true);
    const hook = e.checks.find((c) => c.id === 'transfer-hook')!;
    // The mint reserves the extension but points it at the zero address.
    expect(hook.status).toBe('not-configured');
    expect(hook.status).not.toBe('pass');
    expect(e.summary).toMatch(/no allow-list was consulted/i);
    // It must not read as an approval anyone granted.
    expect(e.summary).not.toMatch(/approved|on the allow-list|cleared by the issuer/i);
  });

  it('blocks while the issuer has the token paused', async () => {
    const e = await run({ paused: true, accountMissing: true });

    expect(e.eligible).toBe(false);
    expect(e.indeterminate).toBe(false);
    expect(e.checks.find((c) => c.id === 'mint-paused')!.status).toBe('blocked');
    expect(e.summary).toMatch(/paused all transfers/i);
  });

  it('blocks a wallet whose token account the issuer has frozen', async () => {
    const e = await run({ accountFrozen: true });

    expect(e.eligible).toBe(false);
    expect(e.checks.find((c) => c.id === 'account-frozen')!.status).toBe('blocked');
    expect(e.summary).toMatch(/frozen/i);
  });

  it('blocks a first-time buyer when new accounts are born frozen', async () => {
    const e = await run({ defaultFrozen: true, accountMissing: true });

    expect(e.eligible).toBe(false);
    expect(e.checks.find((c) => c.id === 'default-account-state')!.status).toBe('blocked');
    expect(e.summary).toMatch(/created frozen|thaw/i);
  });

  it('treats a mint it cannot read as indeterminate, not as eligible', async () => {
    const e = await run({ mintThrows: true });

    expect(e.eligible).toBe(false);
    expect(e.indeterminate).toBe(true);
    expect(e.checks.every((c) => c.status === 'unknown')).toBe(true);
    expect(e.summary).toMatch(/Could not confirm eligibility/);
  });

  it('will not vouch for a wallet against a live hook it cannot evaluate', async () => {
    const hookProgram = new PublicKey('11111111111111111111111111111112');
    const e = await run(
      { hookProgram, accountMissing: true },
      {
        getAccountInfo: async (pk: PublicKey) =>
          pk.equals(hookProgram)
            ? { executable: true, data: Buffer.alloc(0) }
            : { executable: false, data: Buffer.alloc(8) },
      },
    );

    // A live hook decides per-transfer; assuming it admits this wallet would be the fabrication.
    expect(e.checks.find((c) => c.id === 'transfer-hook')!.status).toBe('unknown');
    expect(e.eligible).toBe(false);
    expect(e.indeterminate).toBe(true);
  });

  it('blocks when the mint points at a hook program that is not deployed', async () => {
    const hookProgram = new PublicKey('11111111111111111111111111111112');
    const e = await run({ hookProgram, accountMissing: true }, { getAccountInfo: async () => null });

    const hook = e.checks.find((c) => c.id === 'transfer-hook')!;
    expect(hook.status).toBe('blocked');
    expect(hook.detail).toMatch(/not deployed/);
    expect(e.eligible).toBe(false);
  });

  it('discloses the permanent delegate, which can seize from any account', async () => {
    const e = await run({ accountMissing: true });
    expect(e.permanentDelegate).toBe(ISSUER.toBase58());
  });
});
