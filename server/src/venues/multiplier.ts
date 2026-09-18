/**
 * The corporate-action multiplier of an xStock on X Layer, read off the chain (PLAN.md P2.6).
 *
 * Each xStock on X Layer is two contracts. The raw token is Backed's rebasing ERC-20
 * (`BackedAutoFeeTokenImplementation`, source verified on OKLink behind every raw proxy): balances
 * are internal shares times a `multiplier`, and a split or an auto-reinvested dividend is the issuer
 * moving that multiplier. The ERC-4626 wrapper is what the app trades and holds; one wrapper share
 * is a fixed number of raw shares, so `wrapper.convertToAssets(1e18)` IS the raw multiplier
 * (read on chain 2026-09-19: SPYx 1.005714560286254 on both, TSLAx 1.0 on both).
 *
 * ## The schedule is on chain, as it was on Solana
 *
 * The raw token carries the issuer's NEXT multiplier and when it applies, exactly as Token-2022's
 * Scaled UI extension did: `updateMultiplierValue(new, old, activationTime)` with a future
 * `activationTime` stores `newMultiplier` + `newMultiplierActivationTime` and emits
 * `MultiplierScheduled`; until then `multiplier()` / `getCurrentMultiplier()` keep returning
 * `lastMultiplier`. An update with no future time applies at once and leaves the activation time 0.
 * So "pending" below is `newMultiplierActivationTime > now` and nothing else — no calendar, no guess.
 * (The contract only accepts an activation before the start of its next fee period, so a schedule
 * is visible at most one `periodLength` — a week on the tokens read — ahead.)
 *
 * ## Unreadable is not "1"
 *
 * `readMultiplier` throws rather than returning a default. A multiplier of 1 is a real value — the
 * one an unsplit token has — and returning it for a token that did not answer would tell every
 * caller that nothing has happened, which nobody checked.
 */
import { formatUnits, type Address } from 'viem';
import { query } from '../db/index.js';
import { XSTOCKS, xStockKey, type XStockToken } from './xstocks.js';

const ONE = 10n ** 18n;

/**
 * The wrapper and the raw token must agree to within this share of the value.
 *
 * ERC-4626 rounds `convertToAssets` down, so a last-wei difference is arithmetic. Anything larger
 * means the wrapper is not the fixed claim on raw shares this module assumes, and a number built
 * on that assumption is not one to act on.
 */
const AGREE_WITHIN = 1_000_000_000n; // 1 part in 1e9

const WRAPPER_ABI = [
  {
    type: 'function',
    name: 'convertToAssets',
    stateMutability: 'view',
    inputs: [{ name: 'shares', type: 'uint256' }],
    outputs: [{ type: 'uint256' }],
  },
] as const;

/** The parts of `BackedAutoFeeTokenImplementation` this reads, as verified on OKLink. */
const RAW_ABI = [
  {
    type: 'function',
    name: 'getCurrentMultiplier',
    stateMutability: 'view',
    inputs: [],
    outputs: [
      { name: 'currentMultiplier', type: 'uint256' },
      { name: 'periodsPassed', type: 'uint256' },
      { name: 'currentMultiplierNonce', type: 'uint256' },
    ],
  },
  { type: 'function', name: 'newMultiplier', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] },
  {
    type: 'function',
    name: 'newMultiplierActivationTime',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ type: 'uint256' }],
  },
] as const;

export type PendingMultiplier = {
  /** The multiplier in force once `effectiveAtMs` passes. */
  multiplier: number;
  /** The same, exact, as the decimal string the chain's 1e18 fixed point spells. */
  exact: string;
  effectiveAtMs: number;
  effectiveAt: string;
};

export type MultiplierReading = {
  symbol: string;
  /** The ERC-4626 wrapper — the address observations are keyed on (`multiplier_observations.mint`). */
  wrapper: Address;
  raw: Address;
  decimals: number;
  /** The multiplier in force now, as a number (`convertToAssets(1e18) / 1e18`). */
  multiplier: number;
  /** The same, exact — what gets stored, so a NUMERIC column never holds a float's rounding. */
  exact: string;
  /** What the issuer has scheduled. Null means the raw token answered and has nothing scheduled. */
  pending: PendingMultiplier | null;
};

export class MultiplierUnreadable extends Error {
  constructor(
    readonly symbol: string,
    detail: string,
  ) {
    super(`${symbol}: multiplier unreadable — ${detail}`);
    this.name = 'MultiplierUnreadable';
  }
}

function tokenFor(symbolOrToken: string | XStockToken): XStockToken | undefined {
  if (typeof symbolOrToken !== 'string') return symbolOrToken;
  return XSTOCKS[xStockKey(symbolOrToken) ?? symbolOrToken];
}

/**
 * The multiplier an xStock is at, and anything its issuer has scheduled.
 *
 * One multicall, so the current value and the schedule come from the same block. Throws
 * `MultiplierUnreadable` when the symbol is not an xStock, when either contract does not answer,
 * or when the two disagree.
 */
export async function readMultiplier(
  symbolOrToken: string | XStockToken,
  now: number = Date.now(),
): Promise<MultiplierReading> {
  const token = tokenFor(symbolOrToken);
  const label = typeof symbolOrToken === 'string' ? symbolOrToken : symbolOrToken.symbol;
  if (!token) throw new MultiplierUnreadable(label, 'not an xStock this executor knows');

  // Imported here, as `stocks.ts` does, so importing this module never loads the delegate key.
  const { publicClient } = await import('../evm/client.js');
  const { pastTheThrottle } = await import('../evm/throttle.js');

  let results;
  try {
    results = await pastTheThrottle(() =>
      publicClient.multicall({
        allowFailure: true,
        contracts: [
          { address: token.address, abi: WRAPPER_ABI, functionName: 'convertToAssets', args: [ONE] },
          { address: token.raw, abi: RAW_ABI, functionName: 'getCurrentMultiplier' },
          { address: token.raw, abi: RAW_ABI, functionName: 'newMultiplier' },
          { address: token.raw, abi: RAW_ABI, functionName: 'newMultiplierActivationTime' },
        ],
      }),
    );
  } catch (e) {
    throw new MultiplierUnreadable(token.symbol, e instanceof Error ? e.message : String(e));
  }

  const [wrapped, current, next, activation] = results;
  if (wrapped?.status !== 'success' || !(wrapped.result > 0n)) {
    throw new MultiplierUnreadable(token.symbol, 'the wrapper did not answer convertToAssets');
  }
  if (current?.status !== 'success' || next?.status !== 'success' || activation?.status !== 'success') {
    throw new MultiplierUnreadable(token.symbol, 'the raw token did not answer its multiplier reads');
  }

  const wrapperWei = wrapped.result;
  const rawWei = current.result[0];
  const gap = wrapperWei > rawWei ? wrapperWei - rawWei : rawWei - wrapperWei;
  if (gap * AGREE_WITHIN > wrapperWei) {
    throw new MultiplierUnreadable(
      token.symbol,
      `the wrapper (${formatUnits(wrapperWei, 18)}) and the raw token (${formatUnits(rawWei, 18)}) disagree`,
    );
  }

  /*
   * Pending only while the activation time is still ahead. Past it, the contract already returns
   * the new value as current (and the wrapper with it), so there is nothing left to announce.
   */
  const activationMs = Number(activation.result) * 1000;
  const pending: PendingMultiplier | null =
    activationMs > now && next.result > 0n && next.result !== rawWei
      ? {
          multiplier: Number(formatUnits(next.result, 18)),
          exact: formatUnits(next.result, 18),
          effectiveAtMs: activationMs,
          effectiveAt: new Date(activationMs).toISOString(),
        }
      : null;

  return {
    symbol: token.symbol,
    wrapper: token.address,
    raw: token.raw,
    decimals: token.decimals,
    multiplier: Number(formatUnits(wrapperWei, 18)),
    exact: formatUnits(wrapperWei, 18),
    pending,
  };
}

/** `readMultiplier`, with an unreadable token as null for callers that only branch on it. */
export async function readMultiplierOrNull(
  symbolOrToken: string | XStockToken,
  now: number = Date.now(),
): Promise<MultiplierReading | null> {
  return readMultiplier(symbolOrToken, now).catch(() => null);
}

export type RecordOutcome = 'recorded' | 'unchanged' | 'failed';

/**
 * Write a reading down when it differs from the last one we hold for this token.
 *
 * The table accumulates CHANGES, not polls: a row is added only when the multiplier differs from
 * the latest row for the same wrapper, so `observed_at` on a row is when we first saw that value.
 * `effective_at` is the same moment — the chain does not say when an already-applied multiplier
 * took effect, and the first time we saw it is the latest it can have been, not a date to present
 * as the issuer's.
 */
export async function recordMultiplierObservation(
  reading: MultiplierReading,
  observedAt: Date = new Date(),
): Promise<RecordOutcome> {
  try {
    const rows = await query(
      `INSERT INTO multiplier_observations
         (mint, symbol, multiplier, decimals, new_multiplier, new_multiplier_at, effective_at, observed_at)
       SELECT $1, $2, $3::numeric, $4, $5::numeric, $6::timestamptz, $7::timestamptz, $7::timestamptz
        WHERE NOT EXISTS (
          SELECT 1 FROM (
            SELECT multiplier FROM multiplier_observations
             WHERE mint = $1 ORDER BY observed_at DESC, id DESC LIMIT 1
          ) latest
          WHERE latest.multiplier = $3::numeric
        )
       ON CONFLICT (mint, multiplier, effective_at) DO NOTHING
       RETURNING id`,
      [
        reading.wrapper,
        reading.symbol,
        reading.exact,
        reading.decimals,
        reading.pending?.exact ?? null,
        reading.pending?.effectiveAt ?? null,
        observedAt.toISOString(),
      ],
    );
    return rows.length > 0 ? 'recorded' : 'unchanged';
  } catch {
    return 'failed';
  }
}

export type MultiplierObservation = { multiplier: number; effectiveAt: string; observedAt: string };

/**
 * The most recent recorded values for a wrapper, newest first.
 *
 * Throws when the table cannot be read: an empty array is a real answer ("we have recorded
 * nothing"), and a failed query must not be mistaken for it.
 */
export async function recentObservations(mint: string, limit = 2): Promise<MultiplierObservation[]> {
  const rows = await query<{ multiplier: string; effective_at: Date; observed_at: Date }>(
    `SELECT multiplier, effective_at, observed_at FROM multiplier_observations
      WHERE mint = $1 ORDER BY observed_at DESC, id DESC LIMIT $2`,
    [mint, limit],
  );
  return rows.map((r) => ({
    multiplier: Number(r.multiplier),
    effectiveAt: new Date(r.effective_at).toISOString(),
    observedAt: new Date(r.observed_at).toISOString(),
  }));
}
