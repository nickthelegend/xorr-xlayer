/**
 * Resuming a permission: what to sign, decided by what the chain already holds (PLAN.md 4.7).
 *
 * "Resume agents" signed `grant(cap, 86_400_000)` — the cap this device's store held, which is
 * 1,600 unless the grant screen had been used on this device, for twenty-four hours whatever the
 * user had chosen — and approved every token again. So a $400 permission for a week came back as
 * $1,600 for a day, the one change a resume must never make by itself, behind as many as eleven
 * wallet prompts for allowances nothing had touched: stopping the agents revokes the delegation
 * and leaves the approvals exactly where they were.
 *
 * A resume now grants what was granted last. The cap is the chain's — a revoked or expired policy
 * still holds it. The length is the previous grant's: its expiry less the time of the block that
 * carried it, which `/delegation/record` reads off the transaction's `Granted` event, because the
 * chain keeps the expiry and not the start. Where that start is not on record nothing is guessed —
 * a length made up here is a default by another name — and the user chooses again. And only the
 * approvals that are no longer enough are asked for.
 *
 * Pure, so the decision is tested without a wallet and proven against a fork's real reads.
 */
import { parseUnits, type Address } from 'viem';

/** The settlement token's decimals. The cap is dollars on screen and USDC units on chain. */
const USDC_DECIMALS = 6;
const DAY_MS = 86_400_000;

/**
 * Days of the cap a grant approves the settlement token for.
 *
 * `useGrantDelegation` approves `cap * 30`. Named here so the approval a plan counts as enough and
 * the approval a grant signs are one number, not two that agree by coincidence.
 */
export const SETTLEMENT_APPROVAL_DAYS = 30;

/**
 * An allowance at least this large is unlimited for any real token: no supply comes near 2^254.
 *
 * The bar for the tokens the bot only ever SELLS, which a grant approves for max uint256 because
 * the amount an exit will need is whatever was bought — so anything short of unlimited is a stop
 * that can fail when it fires. Not `=== max uint256`: a token that spends an unlimited allowance
 * down is still unlimited for every purpose, and a wallet prompt to restore the last few units
 * would be noise.
 *
 * 2^254, not 2^255. The fork tooling approves exactly 2^255 (`fork-grant.ts`), and WETH counts any
 * allowance short of max uint256 down with every sale, so a bar at 2^255 asked the Railway fork's
 * wallet to approve WETH again after its first sell. Half of that is still more than any token will
 * ever move. `server/src/evm/allowances.ts` calls an allowance unlimited from the same bar.
 */
export const EFFECTIVELY_UNLIMITED = 1n << 254n;

/** The permission as `/delegation` reports it: the chain's cap and expiry, and when it was granted. */
export type ChainPermission = {
  dailyCapUsd: number;
  /** Unix ms. */
  expiresAt: number;
  /** Unix ms, from the block that carried the grant in force. Null or absent when it is not on record. */
  grantedAt?: number | null;
};

/** `/delegation/params`: the contract a grant goes to, the token the cap counts, every token it approves. */
export type GrantParams = {
  contract: string;
  token: string;
  tokens?: { symbol: string; address: string }[];
};

/** `/approvals`: what the owner lets `spender` pull. `allowance` is a uint256 string, null where unread. */
export type OwnerAllowances = {
  spender: string;
  tokens: { address: string; allowance: string | null }[];
};

/** What a grant takes from a plan: the tokens to approve. Absent, a grant approves every one. */
export type GrantOptions = { approvals?: readonly Address[] };

/**
 * `resume` signs the chain's cap for the previous length, approving only `approvals`. `choose`
 * signs nothing: there is no permission on chain, or no record of how long the last one ran.
 */
export type ResumePlan =
  | { kind: 'resume'; dailyCapUsd: number; durationMs: number; approvals: Address[] }
  | { kind: 'choose'; reason: 'no_permission' | 'duration_unknown' };

const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

/** How long the grant in force ran from the moment it was made. Undefined when that is not on record. */
export function previousDurationMs(permission: ChainPermission): number | undefined {
  const { grantedAt, expiresAt } = permission;
  if (grantedAt == null || !Number.isFinite(grantedAt) || !Number.isFinite(expiresAt)) return undefined;
  return expiresAt > grantedAt ? expiresAt - grantedAt : undefined;
}

/**
 * How many caps a grant from `start` lasting `durationMs` can spend: one per UTC day it touches.
 *
 * The contract resets the cap at midnight UTC, so a twenty-four-hour grant made at 18:00 spends on
 * two days, not one.
 */
export function capDays(start: number, durationMs: number): number {
  return Math.floor((start + durationMs - 1) / DAY_MS) - Math.floor(start / DAY_MS) + 1;
}

/**
 * The tokens a grant still has to approve, out of every token it would.
 *
 * The settlement token is enough when it covers every cap the grant can spend, up to the thirty
 * days a grant approves: beyond that a fresh approval could not do better, so asking for one would
 * change nothing. The bot spends it down, so after some trading it is short of the full thirty and
 * usually still plenty. Every other token is enough while it is unlimited.
 *
 * A token whose allowance could not be read — or that `/approvals` did not list — is asked for. A
 * signature that turns out to be unneeded costs a tap; a permission that cannot pull what it trades
 * costs a trade, or an exit.
 */
export function approvalsNeeded(input: {
  dailyCapUsd: number;
  durationMs: number;
  now: number;
  params: GrantParams;
  allowances: OwnerAllowances;
}): Address[] {
  const { params, allowances } = input;
  // The list a grant approves, with the same fallback when the executor sends no `tokens`.
  const approvable = params.tokens?.length ? params.tokens : [{ symbol: 'USDC', address: params.token }];
  // An allowance to some other contract is not an allowance to the one being granted.
  const held = new Map(
    same(allowances.spender, params.contract)
      ? allowances.tokens.map((t) => [t.address.toLowerCase(), t.allowance] as const)
      : [],
  );
  const cap = parseUnits(input.dailyCapUsd.toFixed(USDC_DECIMALS), USDC_DECIMALS);
  const days = BigInt(Math.min(SETTLEMENT_APPROVAL_DAYS, capDays(input.now, input.durationMs)));
  return approvable
    .filter((t) => {
      const allowance = uint(held.get(t.address.toLowerCase()));
      if (allowance === undefined) return true;
      return allowance < (same(t.address, params.token) ? cap * days : EFFECTIVELY_UNLIMITED);
    })
    .map((t) => t.address as Address);
}

/** A uint256 from its decimal string; undefined for anything that is not one. */
function uint(raw: string | null | undefined): bigint | undefined {
  return raw != null && /^\d+$/.test(raw) ? BigInt(raw) : undefined;
}

/** What "Resume" signs: the chain's cap, for as long as the last grant ran, with only the missing approvals. */
export function planResume(input: {
  permission: ChainPermission | null;
  params: GrantParams;
  allowances: OwnerAllowances;
  now: number;
}): ResumePlan {
  const { permission } = input;
  if (!permission || !(permission.dailyCapUsd > 0)) return { kind: 'choose', reason: 'no_permission' };
  const durationMs = previousDurationMs(permission);
  if (durationMs === undefined) return { kind: 'choose', reason: 'duration_unknown' };
  return {
    kind: 'resume',
    dailyCapUsd: permission.dailyCapUsd,
    durationMs,
    approvals: approvalsNeeded({
      dailyCapUsd: permission.dailyCapUsd,
      durationMs,
      now: input.now,
      params: input.params,
      allowances: input.allowances,
    }),
  };
}
