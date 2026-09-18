/**
 * "Withdraw everything" keeps its order and stops where it should (PLAN.md 4.9).
 *
 * The executor, the wallet and the chain are the calls the sequence is handed, and are stood in for
 * here; the calldata is real, encoded by viem exactly as the executor encodes it. What is pinned is
 * the part that can cost someone money: nothing starts before the step ahead of it has finished, the
 * first failure stops everything after it, and nothing is signed that pays anyone but the owner or the
 * address they chose.
 */
import { describe, expect, it, vi } from 'vitest';
import { encodeFunctionData, erc20Abi, keccak256, maxUint256, parseAbi, toHex, type Address, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { ApiError } from '@/data/apiError';
import type { CloseOutcome, PrepareOutcome, RecordOutcome } from '@/data/withdrawals';
import { AAVE_V3_POOL, sellBlocked, withdrawEverything, type Step, type WithdrawEverythingDeps } from './withdrawEverything';

const account = (seed: string) => privateKeyToAccount(keccak256(toHex(seed))).address;
const OWNER = account('xorr/withdraw-everything/owner');
const COLD = account('xorr/withdraw-everything/cold-storage');
const STRANGER = account('xorr/withdraw-everything/stranger');
const USDC: Address = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const POOL_ABI = parseAbi(['function withdraw(address asset, uint256 amount, address to) returns (uint256)']);
const hash = (n: number) => `0x${n.toString(16).padStart(64, '0')}` as Hex;

const aaveCall = (to: Address = OWNER, amount: bigint = maxUint256) => ({
  to: AAVE_V3_POOL as string,
  data: encodeFunctionData({ abi: POOL_ABI, functionName: 'withdraw', args: [USDC, amount, to] }),
  isMax: amount === maxUint256,
});

const prepared = (to: Address = COLD, signedAmount = 1_420_500_000n): PrepareOutcome => ({
  status: 'prepared',
  call: { to: USDC, data: encodeFunctionData({ abi: erc20Abi, functionName: 'transfer', args: [to, signedAmount] }) },
  token: { symbol: 'USDC', address: USDC, decimals: 6 },
  amount: '1420.5',
  amountRaw: '1420500000',
  destination: { address: COLD, label: 'Cold storage' },
});

const confirmed = (txHash: string, aave: boolean): RecordOutcome => ({
  status: 'confirmed',
  txHash,
  transfers: [],
  aave: aave ? { amount: '125.5', amountRaw: '125500000' } : null,
  duplicate: false,
});

/** Every call, in the order it was made — the order is what is under test. */
function harness(over: (calls: string[]) => Partial<WithdrawEverythingDeps> = () => ({})) {
  const calls: string[] = [];
  let signatures = 0;
  const deps: WithdrawEverythingDeps = {
    owner: OWNER,
    destination: { address: COLD, label: 'Cold storage' },
    sellPreview: vi.fn(async () => {
      calls.push('preview');
      return {
        legs: [
          { symbol: 'WETH', units: 0.5, usd: 1_200 },
          { symbol: 'CBBTC', units: 0.001, usd: 95 },
        ],
        totalUsd: 1_295,
        dustBelowUsd: 1,
        skipped: [],
      };
    }),
    close: vi.fn(async (symbol: string): Promise<CloseOutcome> => {
      calls.push(`close ${symbol}`);
      return { status: 'closed', symbol, units: 0.5, usd: 1_200, measured: true, txHash: hash(1) };
    }),
    aavePosition: vi.fn(async () => {
      calls.push('aave position');
      return { suppliedUsd: 125.5, available: true, pool: AAVE_V3_POOL };
    }),
    aaveWithdrawCall: vi.fn(async () => {
      calls.push('aave calldata');
      return aaveCall();
    }),
    prepareAll: vi.fn(async (to: string, token: string) => {
      calls.push(`prepare ${token} to ${to}`);
      return prepared();
    }),
    sign: vi.fn(async (to: Address) => {
      signatures += 1;
      calls.push(`sign ${to}`);
      return hash(100 + signatures);
    }),
    record: vi.fn(async (txHash: Hex) => {
      calls.push(`record ${txHash}`);
      return confirmed(txHash, txHash === hash(101));
    }),
    ...over(calls),
  };
  return { deps, calls };
}

const statuses = (steps: Step[]) => steps.map((s) => `${s.key}:${s.status}`);
const quietly = () => undefined;

describe('withdraw everything', () => {
  it('sells, then exits Aave, then sends — each only after the one before it has landed', async () => {
    const { deps, calls } = harness();
    const out = await withdrawEverything(deps, quietly);

    expect(out.ok).toBe(true);
    expect(statuses(out.steps)).toEqual(['sell:done', 'aave:done', 'send:done']);
    expect(calls).toEqual([
      'preview',
      'close WETH',
      'close CBBTC',
      'aave position',
      'aave calldata',
      `sign ${AAVE_V3_POOL}`,
      `record ${hash(101)}`,
      `prepare USDC to ${COLD}`,
      `sign ${USDC}`,
      `record ${hash(102)}`,
    ]);
    expect(out.steps[1]!.lines).toEqual([{ tone: 'done', text: 'Withdrew 125.5 USDC from savings', txHash: hash(101) }]);
    expect(out.steps[2]!.lines).toEqual([{ tone: 'done', text: 'Sent 1420.5 USDC to Cold storage', txHash: hash(102) }]);
  });

  it('reports each change as it happens, not only at the end', async () => {
    const { deps } = harness();
    const seen: string[][] = [];
    await withdrawEverything(deps, (steps) => seen.push(statuses(steps)));

    expect(seen[0]).toEqual(['sell:running', 'aave:waiting', 'send:waiting']);
    expect(seen).toContainEqual(['sell:done', 'aave:running', 'send:waiting']);
    expect(seen).toContainEqual(['sell:done', 'aave:done', 'send:running']);
    expect(seen.at(-1)).toEqual(['sell:done', 'aave:done', 'send:done']);
  });

  it('stops at the first sale that fails, says why, and starts nothing after it', async () => {
    const { deps, calls } = harness((calls) => ({
      close: vi.fn(async (symbol: string): Promise<CloseOutcome> => {
        calls.push(`close ${symbol}`);
        return {
          status: 'blocked',
          reason: 'delegation_inactive',
          detail: 'The trading permission is revoked or expired, so the bot cannot sell on your behalf.',
        };
      }),
    }));
    const out = await withdrawEverything(deps, quietly);

    expect(out.ok).toBe(false);
    expect(statuses(out.steps)).toEqual(['sell:failed', 'aave:waiting', 'send:waiting']);
    expect(out.steps[0]!.detail).toContain('The trading permission is revoked or expired');
    expect(calls).toEqual(['preview', 'close WETH']);
    expect(deps.sign).not.toHaveBeenCalled();
  });

  it('stops on a sale the venue could not fill, in the executor’s words', async () => {
    const { deps } = harness(() => ({
      close: vi.fn(async (): Promise<CloseOutcome> => ({ status: 'failed', symbol: 'WETH', error: 'The price moved past your slippage.' })),
    }));
    const out = await withdrawEverything(deps, quietly);
    expect(statuses(out.steps)).toEqual(['sell:failed', 'aave:waiting', 'send:waiting']);
    expect(out.steps[0]!.lines).toEqual([{ tone: 'failed', text: 'WETH was not sold: The price moved past your slippage.' }]);
  });

  it('leaves a position already gone, or worth less than the gas, and carries on', async () => {
    const { deps } = harness(() => ({
      close: vi.fn(
        async (symbol: string): Promise<CloseOutcome> =>
          symbol === 'WETH'
            ? { status: 'blocked', reason: 'not_held', detail: 'No WETH to sell.' }
            : { status: 'blocked', reason: 'dust', detail: 'Worth less than $1 — the gas would cost more than the sale returns.' },
      ),
    }));
    const out = await withdrawEverything(deps, quietly);

    expect(statuses(out.steps)).toEqual(['sell:done', 'aave:done', 'send:done']);
    expect(out.steps[0]!.lines.map((l) => l.tone)).toEqual(['left', 'left']);
  });

  it('with nothing to sell and nothing supplied, still sends the cash', async () => {
    const { deps, calls } = harness((calls) => ({
      sellPreview: vi.fn(async () => {
        calls.push('preview');
        return { legs: [], totalUsd: 0, dustBelowUsd: 1, skipped: ['CBBTC'] };
      }),
      aavePosition: vi.fn(async () => {
        calls.push('aave position');
        return { suppliedUsd: 0, available: true };
      }),
    }));
    const out = await withdrawEverything(deps, quietly);

    expect(out.ok).toBe(true);
    expect(out.steps[0]!.detail).toContain('Nothing to sell.');
    expect(out.steps[0]!.detail).toContain('CBBTC stays');
    expect(calls).toEqual(['preview', 'aave position', `prepare USDC to ${COLD}`, `sign ${USDC}`, `record ${hash(101)}`]);
    expect(deps.close).not.toHaveBeenCalled();
    expect(deps.aaveWithdrawCall).not.toHaveBeenCalled();
  });

  it('refuses to sign an Aave exit that pays anyone but the owner, goes anywhere but the pool, or leaves some behind', async () => {
    for (const call of [aaveCall(STRANGER), { ...aaveCall(), to: STRANGER as string }, aaveCall(OWNER, 1_000_000n)]) {
      const { deps } = harness(() => ({ aaveWithdrawCall: vi.fn(async () => call) }));
      const out = await withdrawEverything(deps, quietly);

      expect(statuses(out.steps)).toEqual(['sell:done', 'aave:failed', 'send:waiting']);
      expect(out.steps[1]!.detail).toMatch(/not signed/);
      expect(deps.sign).not.toHaveBeenCalled();
    }
  });

  it('refuses to sign a transfer to anywhere but the chosen address, or for any other amount', async () => {
    for (const offered of [prepared(STRANGER), prepared(COLD, 1n)]) {
      const { deps, calls } = harness(() => ({ prepareAll: vi.fn(async () => offered) }));
      const out = await withdrawEverything(deps, quietly);

      expect(statuses(out.steps)).toEqual(['sell:done', 'aave:done', 'send:failed']);
      expect(out.steps[2]!.detail).toMatch(/not signed/);
      // The Aave exit was signed; the transfer was not.
      expect(calls.filter((c) => c.startsWith('sign'))).toEqual([`sign ${AAVE_V3_POOL}`]);
    }
  });

  it('stops the send with the executor’s refusal when the address is not usable', async () => {
    const { deps } = harness(() => ({
      prepareAll: vi.fn(
        async (): Promise<PrepareOutcome> => ({
          status: 'blocked',
          reason: 'cooling_off',
          detail: 'Cold storage is still cooling off. Nothing can be sent to it before 2026-09-14 09:30 UTC.',
        }),
      ),
    }));
    const out = await withdrawEverything(deps, quietly);
    expect(statuses(out.steps)).toEqual(['sell:done', 'aave:done', 'send:failed']);
    expect(out.steps[2]!.detail).toBe('Cold storage is still cooling off. Nothing can be sent to it before 2026-09-14 09:30 UTC.');
  });

  it('stops, in words, when the owner cancels a signature', async () => {
    const { deps } = harness(() => ({ sign: vi.fn(async () => Promise.reject(new Error('User rejected the request.'))) }));
    const out = await withdrawEverything(deps, quietly);

    expect(statuses(out.steps)).toEqual(['sell:done', 'aave:failed', 'send:waiting']);
    expect(out.steps[1]!.detail).toBe('You cancelled the signature, so nothing changed.');
    expect(deps.record).not.toHaveBeenCalled();
  });

  it('does not send while the Aave exit is reverted or has not landed', async () => {
    for (const recorded of [
      { status: 'reverted', txHash: hash(101), detail: 'The transaction was mined and reverted, so nothing left the wallet.' },
      { status: 'unknown', detail: 'That transaction is not on this chain, or has not landed yet.' },
    ] as RecordOutcome[]) {
      const { deps } = harness(() => ({ record: vi.fn(async () => recorded) }));
      const out = await withdrawEverything(deps, quietly);

      expect(statuses(out.steps)).toEqual(['sell:done', 'aave:failed', 'send:waiting']);
      expect(out.steps[1]!.detail).toContain('The savings withdrawal did not go through');
      expect(deps.prepareAll).not.toHaveBeenCalled();
    }
  });

  it('says savings on the running card, as the plan does, and never the venue the executor named', async () => {
    const { deps } = harness(() => ({
      aavePosition: vi.fn(async () => ({
        suppliedUsd: 0,
        available: false,
        reason: `Aave v3 is not deployed at ${AAVE_V3_POOL} on this network.`,
      })),
    }));
    const out = await withdrawEverything(deps, quietly);

    expect(out.steps.map((s) => s.title)).toEqual(['Sell every position', 'Take your USDC out of savings', 'Send your USDC']);
    expect(out.steps[1]!.detail).toBe('Nothing to take out: savings aren’t available here.');
    expect(JSON.stringify(out.steps)).not.toMatch(/Aave/);
  });

  it('reads a preview with no dust fields — a wallet the executor has no row for — without falling over', async () => {
    const { deps } = harness(() => ({ sellPreview: vi.fn(async () => ({ legs: [], totalUsd: 0 })) }));
    const out = await withdrawEverything(deps, quietly);

    expect(out.steps[0]).toMatchObject({ status: 'done', detail: 'Nothing to sell.' });
  });

  it('stops on a read that failed, with the executor’s sentence rather than a status code', async () => {
    const { deps } = harness(() => ({
      sellPreview: vi.fn(async () =>
        Promise.reject(
          new ApiError(502, '502 Bad Gateway: {"error":"chain_read_failed"}', {
            error: 'chain_read_failed',
            message: 'Could not read your positions from the chain just now.',
          }),
        ),
      ),
    }));
    const out = await withdrawEverything(deps, quietly);
    expect(statuses(out.steps)).toEqual(['sell:failed', 'aave:waiting', 'send:waiting']);
    expect(out.steps[0]!.detail).toBe('Could not read your positions from the chain just now.');
  });
});

/*
 * `closePosition` reverts on exactly what `spend` reverts on — the wrong caller, a revoked policy, an expired one
 * (contracts/src/XorrDelegation.sol). Selling is said to be impossible before the button, in each of those states,
 * and in no other.
 */
describe('selling needs the bot’s permission', () => {
  const NOW = 1_790_000_000_000;
  const live = { revoked: false, expiresAt: NOW + 3 * 86_400_000, delegateIsCurrent: true };

  it('claims nothing while the permission has not been read', () => {
    expect(sellBlocked(undefined, NOW)).toBeUndefined();
  });

  it('lets a live permission sell — including one from an executor too old to say which key it names', () => {
    expect(sellBlocked(live, NOW)).toBeUndefined();
    expect(sellBlocked({ revoked: false, expiresAt: NOW + 1 }, NOW)).toBeUndefined();
  });

  it('says why, for every state the contract refuses a sale in', () => {
    expect(sellBlocked(null, NOW)).toBe('Selling needs the bot’s permission, and there is none.');
    expect(sellBlocked({ ...live, revoked: true }, NOW)).toBe('Selling needs the bot’s permission, and it is stopped.');
    // `block.timestamp >= expiresAt` reverts, so the deadline itself is already too late.
    expect(sellBlocked({ ...live, expiresAt: NOW }, NOW)).toBe('Selling needs the bot’s permission, and it has ended.');
    expect(sellBlocked({ ...live, delegateIsCurrent: false }, NOW)).toBe(
      'Selling needs the bot’s permission, and it is disconnected.',
    );
  });

  it('names a stop before an expiry, because the stop is what someone did', () => {
    expect(sellBlocked({ ...live, revoked: true, expiresAt: NOW - 1 }, NOW)).toBe(
      'Selling needs the bot’s permission, and it is stopped.',
    );
  });
});
