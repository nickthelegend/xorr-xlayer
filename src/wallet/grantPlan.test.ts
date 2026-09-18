/**
 * Resume grants what was granted last (PLAN.md 4.7).
 *
 * The kill switch's Resume signed the store's cap for twenty-four hours and every approval again.
 * These hold the plan to the chain's cap, the previous grant's length, and only the approvals that
 * are no longer enough — and to asking the user rather than guessing when the length is unknown.
 */
import { describe, expect, it } from 'vitest';
import {
  EFFECTIVELY_UNLIMITED,
  SETTLEMENT_APPROVAL_DAYS,
  approvalsNeeded,
  capDays,
  planResume,
  previousDurationMs,
  type GrantParams,
  type OwnerAllowances,
} from './grantPlan';

const DAY = 86_400_000;
const MAX = (1n << 256n) - 1n;
const CONTRACT = '0x6c5528Fd8E74a047A85bAb413856A9239E73540e';
// X Layer mainnet tokens (`server/src/evm/chains.ts`).
const USDC = '0xB6CEceAB302E2E4948951eE7843FC24E92933061';
const XBTC = '0xb7C00000bcDEeF966b20B3D884B98E64d2b06b4f';
const WOKB = '0xe538905cf8410324e03A5A23C1c177a474D59b2b';

const params: GrantParams = {
  contract: CONTRACT,
  token: USDC,
  tokens: [
    { symbol: 'USDC', address: USDC },
    { symbol: 'XBTC', address: XBTC },
    { symbol: 'WOKB', address: WOKB },
  ],
};

const usdc = (usd: number) => BigInt(usd) * 1_000_000n;

/** What a grant leaves behind: the settlement token at thirty caps, everything else unlimited. */
function freshlyGranted(capUsd: number): OwnerAllowances {
  return {
    spender: CONTRACT,
    tokens: [
      { address: USDC, allowance: (usdc(capUsd) * 30n).toString() },
      { address: XBTC, allowance: MAX.toString() },
      { address: WOKB, allowance: MAX.toString() },
    ],
  };
}

function withAllowance(a: OwnerAllowances, address: string, allowance: string | null): OwnerAllowances {
  return { ...a, tokens: a.tokens.map((t) => (t.address === address ? { ...t, allowance } : t)) };
}

// Noon UTC, 13 September 2026.
const NOON = Date.UTC(2026, 8, 13, 12);

describe('the length of the previous grant', () => {
  it('is its expiry less the block time it was granted at', () => {
    expect(previousDurationMs({ dailyCapUsd: 400, grantedAt: NOON - 2 * DAY, expiresAt: NOON + 5 * DAY })).toBe(
      7 * DAY,
    );
  });

  it('is unknown without a recorded grant time — never a default', () => {
    expect(previousDurationMs({ dailyCapUsd: 400, expiresAt: NOON })).toBeUndefined();
    expect(previousDurationMs({ dailyCapUsd: 400, grantedAt: null, expiresAt: NOON })).toBeUndefined();
  });

  it('is unknown where the record would make it zero or negative', () => {
    expect(previousDurationMs({ dailyCapUsd: 400, grantedAt: NOON, expiresAt: NOON })).toBeUndefined();
    expect(previousDurationMs({ dailyCapUsd: 400, grantedAt: NOON + 1, expiresAt: NOON })).toBeUndefined();
  });
});

describe('the caps a grant can spend', () => {
  it('are one for every UTC day it touches, because the cap resets at midnight UTC', () => {
    expect(capDays(Date.UTC(2026, 8, 13, 18), DAY)).toBe(2);
    expect(capDays(Date.UTC(2026, 8, 13, 0), DAY)).toBe(1);
    expect(capDays(NOON, 3 * DAY)).toBe(4);
    expect(capDays(NOON, 30 * DAY)).toBe(31);
  });
});

describe('the approvals a resume asks for', () => {
  const ask = (allowances: OwnerAllowances, durationMs = 3 * DAY, grantParams = params) =>
    approvalsNeeded({ dailyCapUsd: 400, durationMs, now: NOON, params: grantParams, allowances });

  it('are none right after a grant approved everything', () => {
    expect(ask(freshlyGranted(400))).toEqual([]);
  });

  it('are exactly the one that was taken back', () => {
    expect(ask(withAllowance(freshlyGranted(400), XBTC, '0'))).toEqual([XBTC]);
    expect(ask(withAllowance(freshlyGranted(400), USDC, '0'))).toEqual([USDC]);
  });

  it('skip a settlement allowance the bot has spent from while it covers every cap the grant can spend', () => {
    // Three days from noon touch four UTC days: $1,600 of a $400 cap.
    expect(ask(withAllowance(freshlyGranted(400), USDC, usdc(1_600).toString()))).toEqual([]);
    expect(ask(withAllowance(freshlyGranted(400), USDC, (usdc(1_600) - 1n).toString()))).toEqual([USDC]);
  });

  it('never want more settlement allowance than a grant signs', () => {
    // Thirty days from noon touch thirty-one UTC days; a fresh approval is thirty caps, and it is enough.
    expect(SETTLEMENT_APPROVAL_DAYS).toBe(30);
    expect(ask(freshlyGranted(400), 30 * DAY)).toEqual([]);
  });

  it('count a sold token as enough while it is unlimited, not only at max uint256', () => {
    expect(ask(withAllowance(freshlyGranted(400), XBTC, (MAX - 10n ** 18n).toString()))).toEqual([]);
    // The fork tooling's 2^255, after a sale took one XBTC of it.
    expect(ask(withAllowance(freshlyGranted(400), XBTC, ((1n << 255n) - 10n ** 18n).toString()))).toEqual([]);
    expect(ask(withAllowance(freshlyGranted(400), XBTC, EFFECTIVELY_UNLIMITED.toString()))).toEqual([]);
    expect(ask(withAllowance(freshlyGranted(400), XBTC, (EFFECTIVELY_UNLIMITED - 1n).toString()))).toEqual([
      XBTC,
    ]);
  });

  it('ask for an allowance nobody could read, or one the read did not list', () => {
    expect(ask(withAllowance(freshlyGranted(400), WOKB, null))).toEqual([WOKB]);
    const granted = freshlyGranted(400);
    expect(ask({ ...granted, tokens: granted.tokens.filter((t) => t.address !== XBTC) })).toEqual([XBTC]);
  });

  it('ask for everything when the allowances were read for another contract', () => {
    expect(ask({ ...freshlyGranted(400), spender: XBTC })).toEqual([USDC, XBTC, WOKB]);
  });

  it('match addresses whatever their case', () => {
    const granted = freshlyGranted(400);
    const lower = {
      spender: CONTRACT.toLowerCase(),
      tokens: granted.tokens.map((t) => ({ ...t, address: t.address.toLowerCase() })),
    };
    expect(ask(lower)).toEqual([]);
  });

  it('fall back to the settlement token alone, as a grant does, when no token list is sent', () => {
    expect(ask({ spender: CONTRACT, tokens: [] }, 3 * DAY, { contract: CONTRACT, token: USDC })).toEqual([USDC]);
  });
});

describe('a resume', () => {
  const allowances = freshlyGranted(2_400);

  it("signs the chain's cap for as long as the last grant ran, not the store's cap for a day", () => {
    const plan = planResume({
      permission: { dailyCapUsd: 2_400, grantedAt: NOON - 7 * DAY, expiresAt: NOON },
      params,
      allowances,
      now: NOON + DAY,
    });
    expect(plan).toEqual({ kind: 'resume', dailyCapUsd: 2_400, durationMs: 7 * DAY, approvals: [] });
  });

  it('carries only the approvals that are missing', () => {
    const plan = planResume({
      permission: { dailyCapUsd: 2_400, grantedAt: NOON - DAY, expiresAt: NOON },
      params,
      allowances: withAllowance(allowances, WOKB, '0'),
      now: NOON,
    });
    expect(plan).toEqual({ kind: 'resume', dailyCapUsd: 2_400, durationMs: DAY, approvals: [WOKB] });
  });

  it('asks the user to choose when there is no record of how long the last grant ran', () => {
    const permission = { dailyCapUsd: 2_400, grantedAt: null, expiresAt: NOON };
    expect(planResume({ permission, params, allowances, now: NOON })).toEqual({
      kind: 'choose',
      reason: 'duration_unknown',
    });
  });

  it('asks the user to choose when there is no permission to resume', () => {
    expect(planResume({ permission: null, params, allowances, now: NOON })).toEqual({
      kind: 'choose',
      reason: 'no_permission',
    });
  });
});
