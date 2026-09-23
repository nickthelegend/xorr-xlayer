/**
 * The executor — PLAN.md 12.6 / 12.7 / 12.8.
 *
 * "A DCA retry that double-buys, or a double-approve that double-fills, is how a trading bot
 * loses real money quietly. Test it adversarially before any real capital touches it."
 *
 * The safety comes from the database, not from care:
 *   - strategy_runs.period_key is UNIQUE. Claiming a run is an INSERT. A second attempt in the
 *     same period violates the constraint and is refused. There is no window between "check" and
 *     "act" for a retry to slip through, because the check IS the write.
 *   - The spend is recorded in the SAME transaction that records the run.
 */
import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { one, query, tx } from '../db/index.js';
import { append } from '../audit/log.js';
import { log } from '../http/request-id.js';
import { evaluate, recordSpend } from '../rules/engine.js';
import { closeAsDelegate, readPolicy, spendAsDelegate, usdToUnits, waitForTx } from '../evm/delegation.js';
import { erc20Abi, formatUnits } from 'viem';
import { publicClient } from '../evm/client.js';
import { gasStatus } from '../evm/gas.js';
import { explorerTx, ADDRESSES } from '../evm/chains.js';
import { slippageFor, SLIPPAGE, SETTLEMENT_SYMBOL, TOKENS } from '../venues/tokens.js';
import { buildSwap, quote } from '../venues/uniswap.js';
import type { Address } from 'viem';
import { periodKey, advance, type Cadence } from './schedule.js';
import { humanFailure, isTransient } from './failure.js';
import { rawBalanceOf, measuredDelta, estimateOutUnits, proceedsSince, usdcRawOf } from './fill-measure.js';
import { applyFill } from '../positions/index.js';
import { DELEGATION_ADDRESS } from '../evm/delegation.js';
import { priceOf } from '../market/prices.js';
import { send } from '../notifications/push.js';
import { PLANNERS, PlanRefused, observationFor, type TradeIntent } from './kinds/index.js';
import { chooseSettlement, type SettlementVenue } from './settle.js';
import { claimedSellUnits } from './stack.js';
import { canonicalSymbol, TOKENS as VENUE_TOKENS } from '../venues/tokens.js';
import { agentForKind } from '../agents/attribution.js';
import { isStock } from '../venues/stocks.js';
import { snapshotWallet } from '../portfolio/snapshots.js';
import { THIS_CHAIN } from '../db/chain-scope.js';

/** The address that holds the tokens when the router is called: the delegation contract. */
const DELEGATION_FROM = DELEGATION_ADDRESS;

export type RunOutcome =
  | { status: 'filled'; runId: string; signature: string; units: number; price: number }
  /** Watch mode: what the strategy WOULD have done. No capital moved. PLAN.md 9.12. */
  | { status: 'watch'; runId: string; units: number; price: number }
  | { status: 'blocked'; runId: string; reason: string; detail: string }
  /**
   * `error` is the sentence a person reads; `raw` is the one an engineer needs.
   *
   * They were the same string, and it was the raw one — so a policy granted to a different
   * delegate reached the screen as `reverted with the following signature: 0x1db3b859 … Unable to
   * decode`, while the activity row for the very same event said "That agent is not the one you
   * gave permission to." Two accounts of one failure, and the user met the useless one first.
   */
  | { status: 'failed'; runId: string; error: string; raw: string }
  | { status: 'skipped'; reason: 'already_ran_this_period' | 'nothing_to_do' | 'awaiting_approval' };

export type StrategyRow = {
  id: string;
  wallet_id: string;
  /** The user's own wallet address — the `owner` in the delegation policy. */
  owner_address?: string;
  kind: string;
  state: string;
  label: string;
  symbol: string;
  params: { usd?: number };
  cadence: Cadence | null;
  next_run_at: Date | null;
  daily_allocation_usd: string;
  /** When the row was written. `GET /strategies` publishes it as `createdAt`. */
  created_at: Date;
  /** Consecutive transient failures, reset when a run reaches an answer. Migration 014. */
  retry_attempts?: number;
  /** The hired agent that runs this strategy, when one does — its limits apply (PLAN.md 2.15). */
  agent_id?: string | null;
  /**
   * The state a pause was taken out of, so a resume returns to it. Migration 031.
   *
   * Null on any row that is not paused, and on a row paused before the column existed —
   * `executor/resume.ts` says why null reads as `live`.
   */
  paused_from?: string | null;
};

/**
 * Claim the period. Returns null when this period has already been claimed — which is exactly
 * what makes a retry, a restart, or two schedulers racing all safe.
 */
async function claimRun(
  client: PoolClient,
  strategyId: string,
  key: string,
): Promise<string | null> {
  const res = await client.query<{ id: string }>(
    `INSERT INTO strategy_runs (id, strategy_id, period_key, status)
     VALUES ($1,$2,$3,'pending')
     ON CONFLICT (period_key) DO NOTHING
     RETURNING id`,
    [randomUUID(), strategyId, key],
  );
  return res.rows[0]?.id ?? null;
}

/** A thrown value, as the sentence it carried. */
const messageOf = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/**
 * How long a strategy waits before its next attempt after `attempt` consecutive transient failures:
 * one minute, doubling, capped at thirty. PLAN.md 1.6.
 */
export function retryDelayMs(attempt: number): number {
  return Math.min(30 * 60_000, 60_000 * 2 ** Math.max(0, attempt - 1));
}

/**
 * A run reached an answer — filled, found nothing to do, was blocked, or failed for good — so the
 * schedule moves to the next period and any retry streak is over.
 *
 * Blocked and failed runs never moved `next_run_at` (PLAN.md 1.6). A strategy stopped by a spent cap
 * or an expired permission stayed due, the scheduler re-selected it on every tick, and twenty such
 * strategies filled the tick's `LIMIT 20` and starved every other strategy.
 */
async function settleSchedule(
  client: Pick<PoolClient, 'query'>,
  strategy: StrategyRow,
  at: Date,
): Promise<void> {
  if (strategy.cadence) {
    await client.query(`UPDATE strategies SET next_run_at = $2, retry_attempts = 0 WHERE id = $1`, [
      strategy.id,
      advance(at, strategy.cadence),
    ]);
  } else {
    await client.query(`UPDATE strategies SET retry_attempts = 0 WHERE id = $1`, [strategy.id]);
  }
}

/**
 * Strategy kinds the executor can actually run.
 *
 * Adding a tier to `src/strategies/ladder.ts` is not enough — it needs a branch here, and this set
 * is what stops a half-built tier from silently behaving like a recurring buy.
 */
export const EXECUTABLE_KINDS = new Set(Object.keys(PLANNERS));

/**
 * Kinds whose size is decided by looking, not by configuration.
 *
 * A stop-loss closes what is held; a rebalance trades the drift. Neither has a meaningful "amount"
 * before the planner runs, and forcing one on them made the spend rules reject the only strategies
 * that exclusively reduce risk.
 */
export const SELF_SIZING_KINDS = new Set(['exit-rules', 'rebalance']);

/**
 * Kinds that can only ever REDUCE exposure.
 *
 * Not the same set as the self-sizing one, and the difference is the whole point: a rebalance
 * sizes itself and may buy, so the daily cap must still govern it. `exit-rules` can only sell —
 * take profit, stop loss, trailing stop — so a spending limit has no business refusing it.
 *
 * Deliberately a set rather than a check on the planned intent, because this gate runs BEFORE the
 * planner. A kind that might do either is judged after planning, by `isCloseIntent`, where the
 * answer is actually known.
 */
export const CLOSE_ONLY_KINDS = new Set(['exit-rules']);

/**
 * Kinds that can BOTH open and close, and whose closing side must not be capped.
 *
 * Momentum opens on a breakout and closes on its own stop. Treating the whole kind as close-only
 * would exempt its entries from the daily cap, which is the opposite of safe; treating it as
 * cap-bound would let a spent cap silence a stop, which is the failure `CLOSE_ONLY_KINDS` exists
 * to prevent. So the decision is made per INTENT — see `reducesRiskOnly` — rather than per kind.
 */
export const DUAL_SIDED_KINDS = new Set(['momentum', 'event-driven']);

/**
 * Tiers that buy only when someone says yes (PLAN.md 1.10): momentum (6) and event-driven (7), whose
 * entries are judgment calls rather than a schedule. The server's copy of `requiresApprovalByDefault`
 * in `src/strategies/ladder.ts`, which returns true from tier 6 up.
 */
export const APPROVAL_FIRST_KINDS: ReadonlySet<string> = new Set(['momentum', 'event-driven']);

/**
 * Will this run only ever reduce exposure?
 *
 * The cap gate gets asked before the planner has looked, so it cannot read the intent. For a kind
 * that is always a close the answer is the kind itself. For a dual-sided one it is in the
 * strategy's own state: momentum holding a position is going to check its stop, and momentum
 * holding nothing is going to look for a breakout. The same field `planMomentumBoth` branches on,
 * read one step earlier.
 *
 * Getting this wrong in either direction is expensive — exempt an entry from the cap and the limit
 * means nothing; cap a stop and a spent allowance silences it.
 */
export function reducesRiskOnly(kind: string, params: Record<string, unknown>): boolean {
  if (CLOSE_ONLY_KINDS.has(kind)) return true;
  if (!DUAL_SIDED_KINDS.has(kind)) return false;
  /*
   * Two dual-sided kinds, two names for "this already holds something".
   *
   * Momentum records the price it entered at, because its exit is a level. Event-driven records the
   * event it opened for, because its exit is a date. Either being set means the next run can only
   * close, and a close must never be capped — the flatten is the whole promise of tier 7.
   */
  return Number(params.openEntryPrice ?? 0) > 0 || Number(params.openedForEventAt ?? 0) > 0;
}

/**
 * How many runs are on chain right now.
 *
 * Shutdown waits on this. A SIGTERM in the middle of a fill used to leave the `strategy_runs` row
 * claimed and never finished — and because the period key is unique, that period can never be
 * retried, so the strategy silently skips a day and the row sits `pending` forever. A deploy
 * should not cost a user their scheduled buy.
 */
let inFlight = 0;
export function inFlightRuns(): number {
  return inFlight;
}

export async function runStrategy(
  strategy: StrategyRow,
  at: Date = new Date(),
): Promise<RunOutcome> {
  inFlight += 1;
  try {
    return await runStrategyInner(strategy, at);
  } finally {
    inFlight -= 1;
  }
}

async function runStrategyInner(
  strategy: StrategyRow,
  at: Date = new Date(),
): Promise<RunOutcome> {
  const cadence = (strategy.cadence ?? 'daily') as Cadence;
  const key = periodKey(strategy.id, cadence, at);

  // ── 1. Claim the period, atomically. ──
  const runId = await tx(async (client) => claimRun(client, strategy.id, key));
  if (!runId) {
    /*
     * This period already has a run. If that run has finished and the schedule still says due, move
     * the schedule on (PLAN.md 1.6).
     *
     * A period claimed by a run that ended before `settleSchedule` existed — or by a manual trigger
     * ahead of the schedule — otherwise left the strategy due: re-selected and skipped on every tick
     * until the period rolled over, holding one of the tick's twenty places the whole time. A run
     * still `pending` is left alone; it settles its own schedule when it finishes, and moving it here
     * would cancel a retry it might be about to schedule.
     */
    if (strategy.cadence && strategy.next_run_at && new Date(strategy.next_run_at) <= at) {
      const existing = await one<{ status: string }>(`SELECT status FROM strategy_runs WHERE period_key = $1`, [
        key,
      ]).catch(() => undefined);
      if (existing && existing.status !== 'pending') {
        await query(`UPDATE strategies SET next_run_at = $2 WHERE id = $1 AND next_run_at <= $3`, [
          strategy.id,
          advance(at, strategy.cadence),
          at,
        ]).catch(() => undefined);
      }
    }
    return { status: 'skipped', reason: 'already_ran_this_period' };
  }

  const usd = Number(strategy.params.usd ?? strategy.daily_allocation_usd ?? 0);
  /*
   * What this ONE strategy may spend per day.
   *
   * Distinct from `usd`, which is the size of a single run: a strategy can legitimately run twice
   * in a day (a manual trigger alongside the schedule), and the allocation is what bounds the sum.
   * Zero means unbounded by this rule and bounded only by the delegation, which is the right
   * default for a self-sizing kind that has no configured amount.
   */
  const allocationUsd = Number(strategy.daily_allocation_usd ?? 0);
  const walletId = strategy.wallet_id;

  // ── Watch mode — PLAN.md 9.12 / §3.3, the trust ramp. ──
  // The strategy runs against LIVE prices and posts the trade it WOULD have made, without
  // touching the delegation. Every number it produces is labelled simulated, so a watch run can
  // never be mistaken for a fill.
  if (strategy.state === 'watch') {
    try {
      return await watchRun({ runId, walletId, strategy, usd, at });
    } catch (e) {
      return failRun({ runId, walletId, strategy, error: messageOf(e), sent: false, at });
    }
  }

  // ── 2. Limits, enforced here and not in the client. ──
  /*
   * The permission, as the CHAIN records it.
   *
   * This used to read the `delegations` table. A row is written when the app records a grant, so a
   * user who granted from another device — or before that write existed — had no row and every run
   * was blocked for a permission that was live on chain. Failing closed is the right direction to
   * be wrong in, but it is still wrong: the chain is the authority everywhere else in this file.
   */
  /*
   * Everything between the claim and the send answers to a catch (PLAN.md 1.6).
   *
   * These reads — the wallet, the permission from the chain, the rules — ran after the period was
   * claimed but outside any `try`. An RPC timeout in `readPolicy` escaped `runStrategy` entirely:
   * the run row stayed `pending`, the period was consumed with nothing in the trail, and the
   * scheduler's loop stopped for every strategy after this one.
   */
  let ownerAddress: Address;
  let chainPolicy: NonNullable<Awaited<ReturnType<typeof readPolicy>>>;
  // The stop the user set on the executor (PLAN.md 2.14), read with the address.
  let agentsStopped = false;
  try {
    const wallet = await one<{ address: string; agents_stopped?: boolean }>(
      `SELECT address, agents_stopped FROM wallets WHERE id = $1`,
      [walletId],
    );
    agentsStopped = wallet?.agents_stopped === true;
    const found = wallet?.address as Address | undefined;
    if (!found) {
      return await finishBlocked(runId, walletId, strategy, 'no_wallet', 'This wallet has no address on file.');
    }
    ownerAddress = found;

    const policy = await readPolicy(ownerAddress);
    if (!policy) {
      return await finishBlocked(runId, walletId, strategy, 'no_delegation', 'No trading permission has been granted.');
    }
    chainPolicy = policy;
  } catch (e) {
    return failRun({ runId, walletId, strategy, error: messageOf(e), sent: false, at });
  }

  /*
   * Some kinds size themselves.
   *
   * A recurring buy has a configured amount, so the spend rules apply to it directly. A stop-loss
   * does not: it closes whatever is held, and the size is only known once the planner has looked.
   * Running the spend rules against its configured 0 rejected it as "the amount must be above
   * zero" — the safety rail firing on the one strategy that only ever REDUCES risk.
   *
   * So for self-sizing kinds the amount checks are deferred to the planner, and the checks that
   * are about permission rather than size — expiry, revocation — still run for everything.
   */
  const selfSizing = SELF_SIZING_KINDS.has(strategy.kind);

  let verdict: Awaited<ReturnType<typeof evaluate>>;
  try {
    verdict = await evaluate({
      walletId,
      usd: selfSizing ? Math.max(usd, 0.01) : usd,
      dailyCapUsd: chainPolicy.dailyCapUsd,
      delegationExpiresAt: new Date(chainPolicy.expiresAt),
      delegationRevoked: chainPolicy.revoked,
      killed: agentsStopped,
      /*
       * A kind that can only close is exempt from the cap, here and on chain.
       *
       * This gate runs BEFORE the planner, so it judges a placeholder size — and for `exit-rules`
       * that meant a wallet which had spent its daily cap got `daily_cap` back for a take-profit,
       * a stop-loss and a trailing stop alike. The one strategy that exists to reduce risk was the
       * one a spending limit could switch off, and the failure was intermittent because it depended
       * on how much the account had already traded that day.
       *
       * The strategy-level allowance below already reasons this way for a close, and
       * `closePosition` on chain never touches the cap either. This is the third place that had to
       * agree and did not.
       */
      reducesRiskOnly: reducesRiskOnly(strategy.kind, (strategy.params ?? {}) as Record<string, unknown>),
    });
  } catch (e) {
    return failRun({ runId, walletId, strategy, error: messageOf(e), sent: false, at });
  }

  if (!verdict.allowed) {
    return finishBlocked(runId, walletId, strategy, verdict.reason, verdict.detail);
  }

  /*
   * What KIND of strategy is this?
   *
   * Every strategy used to execute as a USDC->symbol buy regardless of what it said it was, so a
   * rebalance or a stop-loss would have quietly bought instead. A kind with no branch must stop
   * here, loudly, rather than do something plausible and wrong with the user's money.
   */
  if (!EXECUTABLE_KINDS.has(strategy.kind)) {
    return finishBlocked(
      runId,
      walletId,
      strategy,
      'kind_not_executable',
      `Nothing here knows how to run a "${strategy.kind}" strategy yet, so it was not run.`,
    );
  }

  // ── 3. Execute on chain. ──
  /**
   * Has anything been broadcast yet?
   *
   * Declared outside the try so the catch can read it. It is the difference between a run that can
   * be safely retried and one that must never be: everything before the write is a read, a quote or
   * a simulation, and none of that leaves a trace on chain.
   */
  let sent = false;

  try {
    const owner = ownerAddress;

    /*
     * No index is asked first (The Graph is not part of the X Layer build, PLAN.md D4): the contract's own checks below
     * are the authority on whether a run may spend, as they always were.
     */

    /*
     * Can the bot pay for the transaction at all?
     *
     * The delegate funds its own gas, and when that wallet runs dry every strategy fails inside
     * the venue call. The user is then told "the venue rejected the order", which sends them to
     * look at the market — for a problem that is entirely ours and has nothing to do with their
     * trade. It is the most predictable outage this system has, and it was invisible.
     *
     * Checked before anything is signed, so the run is blocked with the true reason and the day's
     * allowance is not consumed by an attempt that could never land.
     */
    const gas = await gasStatus().catch(() => null);
    if (gas && !gas.enough) {
      return finishBlocked(
        runId,
        walletId,
        strategy,
        'agent_out_of_gas',
        `The agent's wallet is down to ${gas.eth.toFixed(4)} ETH and cannot pay for a transaction. Your funds are untouched and nothing was placed.`,
      );
    }

    // Then the contract itself, as the final authority.
    const policy = await readPolicy(owner);
    if (!policy) {
      return finishBlocked(runId, walletId, strategy, 'no_delegation', 'No trading permission is granted on-chain.');
    }
    if (policy.revoked) {
      return finishBlocked(
        runId,
        walletId,
        strategy,
        'delegation_revoked_onchain',
        'The permission was revoked on-chain, so I did not place this.',
      );
    }
    // The daily cap limits SPENDING. A close does not spend, and a cap that can block a stop is a
    // cap that can stop a stop — so this check does not apply to a self-sizing, risk-reducing kind.
    if (!selfSizing && usd > policy.remainingTodayUsd) {
      return finishBlocked(
        runId,
        walletId,
        strategy,
        'onchain_daily_cap',
        `The contract allows ${policy.remainingTodayUsd.toFixed(2)} more today, and this asks for ${usd.toFixed(2)}.`,
      );
    }

    /*
     * What does THIS kind want to do?
     *
     * The planner decides the trade; every gate above decided whether a trade is allowed at all.
     * Keeping the two apart is what stops a new tier from arriving with its own copy of the safety
     * logic and getting it subtly wrong.
     */
    /*
     * Observe before deciding.
     *
     * A grid needs to know which rung it was on; a trailing stop needs the high-water mark updated
     * on the runs where it does NOT fire, which is most of them. Both are facts about the world
     * that the planner should be handed rather than go and fetch, so the observation happens here
     * and is persisted immediately — a peak that moved and was not written down is a peak the next
     * run will not trail from.
     */
    let params = strategy.params as Record<string, unknown>;
    /*
     * `levelSetAt` lets a resting level be restated across a split. Without a recorded basis the
     * strategy's own creation time is the earliest moment its levels could have been set, which is
     * what decides whether our multiplier history covers the whole period.
     */
    const levelSetAt = strategy.created_at;
    const observed = await observationFor(strategy.kind, {
      owner,
      budgetUsd: usd,
      params,
      symbol: strategy.symbol,
      levelSetAt,
    }).catch(() => null);
    if (observed) {
      await query(`UPDATE strategies SET params = params || $2::jsonb WHERE id = $1`, [
        strategy.id,
        JSON.stringify(observed),
      ]);
      params = { ...params, ...observed };
    }

    /*
     * What the rest of the stack has already committed to selling on this symbol.
     *
     * Read once, here, so the planner stays a function of what it is given. Only a close-capable
     * kind can be affected by it, but it is read for every kind rather than branching: a planner
     * that gains a sell leg later must not have to remember to ask.
     */
    const claimed = await claimedSellUnits(walletId, strategy.symbol, strategy.id).catch(() => 0);

    let intent: TradeIntent | null;
    try {
      intent = await PLANNERS[strategy.kind]!({
        owner,
        budgetUsd: usd,
        params,
        symbol: strategy.symbol,
        claimedSellUnits: claimed,
        levelSetAt,
      });
    } catch (e) {
      // A strategy that cannot run on this chain says why, as a blocked run — not as a failed trade.
      if (e instanceof PlanRefused) return await finishBlocked(runId, walletId, strategy, e.reason, e.message);
      throw e;
    }

    // "Nothing to do" is the right answer most of the time for a rebalance that has not drifted or
    // a stop that has not been hit. It is not a failure and must not read as one.
    if (!intent) {
      // The observation above has already been written, so a run that only looked still leaves a
      // record of what it saw — which is the difference between a grid warming up and one broken.
      if (observed && observed.lastLevel !== undefined) {
        return finishNoop(
          runId,
          walletId,
          strategy,
          `Took the first reading: ${strategy.symbol} is on rung ${observed.lastLevel} of your range. Trades start on the next crossing.`,
        );
      }
      if (observed && observed.peakPrice !== undefined) {
        return finishNoop(
          runId,
          walletId,
          strategy,
          `${strategy.symbol} made a new high of ${Number(observed.peakPrice).toFixed(2)}. Your trailing stop moved up with it.`,
        );
      }
      return finishNoop(
        runId,
        walletId,
        strategy,
        'Checked, and there was nothing to do this run.',
      );
    }

    /*
     * The hired agent's own limits (PLAN.md 2.15).
     *
     * `agents.risk_limits` was stored, shown on the Risk screen and enforced nowhere, so an agent limited to
     * $50 a trade placed whatever its planner sized. Checked here with the other gates — before a trade is
     * proposed or placed — and never against a close, which only reduces risk.
     */
    if (strategy.agent_id && !isCloseIntent(intent)) {
      const refusal = await agentLimitRefusal(strategy.agent_id, intent.usd);
      if (refusal) return await finishBlocked(runId, walletId, strategy, refusal.reason, refusal.detail);
    }

    /*
     * Tiers 6 and 7 ask first (PLAN.md 1.10).
     *
     * The ladder says so (`requiresApprovalByDefault`), and the momentum planner's own docblock says
     * so — and nothing on the server enforced it: a live momentum strategy bought its breakout with
     * nobody asked. An entry now becomes a proposal the user approves or skips, and approving places
     * the same trade through `placeOrder`. `params.autoExecute: true` is the explicit opt-out.
     *
     * A close never waits. A stop that needs a yes at the moment it fires is a stop that does not.
     */
    if (APPROVAL_FIRST_KINDS.has(strategy.kind) && !isCloseIntent(intent) && params.autoExecute !== true) {
      return await proposeInstead({ runId, walletId, strategy, intent, at });
    }

    /*
     * Some legs are not swaps.
     *
     * Supplying to a lending pool has no route to quote and no market price to look up: the
     * planner already built the calldata, and the receipt is 1:1 with what went in. Asking 1inch
     * to price "aUSDC" would 400 on a symbol it has never heard of, and `priceOf` would throw
     * before the trade got anywhere near the chain.
     */
    /*
     * The strategy's own daily allowance.
     *
     * The delegation caps the DAY across everything; nothing capped one strategy inside it. So a
     * rebalance that decided to move $1,800 could consume the whole cap and every DCA scheduled
     * after it would be blocked — by a limit the user set for the account, spent by a strategy
     * they had allocated $200 to. The account-level cap was doing the sub-cap's job and doing it
     * to whichever strategy happened to run first.
     *
     * Summed from `strategy_runs`, not a counter: derived from the rows that record what actually
     * happened, so there is nothing to keep in sync and nothing to drift.
     *
     * A close does not count, for the same reason it does not touch the on-chain cap — an
     * allowance is a limit on putting capital at risk, and a limit that blocks an exit traps you.
     */
    if (!isCloseIntent(intent) && allocationUsd > 0) {
      const spentRows = await query<{ spent: string | null }>(
        `SELECT COALESCE(SUM(usd), 0) AS spent
           FROM strategy_runs
          WHERE strategy_id = $1 AND status = 'filled' AND finished_at >= date_trunc('day', now() AT TIME ZONE 'UTC')`,
        [strategy.id],
      );
      const spentToday = Number(spentRows[0]?.spent ?? 0);
      const left = allocationUsd - spentToday;
      if (intent.usd > left + 0.005) {
        return finishBlocked(
          runId,
          walletId,
          strategy,
          'strategy_daily_allocation',
          `${strategy.label} is allocated $${allocationUsd.toLocaleString('en-US')} a day and has used $${spentToday.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}. This asks for $${intent.usd.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}.`,
        );
      }
    }

    const price = intent.direct
      ? intent.direct.unitPriceUsd
      : await priceOf(intent.outSymbol === 'USDC' ? intent.inSymbol : intent.outSymbol);
    // How many units of the ASSET this leg moves — bought on a buy, sold on a close.
    const units = intent.outSymbol === 'USDC' ? intent.amountIn : intent.usd / price;

    // Real 1inch calldata. The delegation contract pulls the input and forwards this to the router
    // inside one transaction, so the user's funds are never parked anywhere in between — and the
    // bought token is delivered straight to the user's own wallet, never to the contract.
    //
    // A direct leg skips this entirely: the delegation forwards the planner's calldata to the
    // venue under exactly the same pull-approve-call-unapprove sequence, and the pool credits the
    // owner rather than us because `supply()` takes the recipient explicitly.
    /*
     * Buying and closing are different transactions.
     *
     * `spend()` measures against a daily cap denominated in the settlement token, so a sell cannot
     * go through it: 0.3e18 wei of WETH against a cap of 2000e6 USDC units is nonsense arithmetic,
     * and worse, a used-up spending cap would silence a stop-loss. `closePosition()` is separately
     * authorised by the same policy and does not touch the cap, because de-risking is not spending.
     */
    /*
     * Where this leg fills — Uniswap v3 on X Layer, or OKX DEX when its answer beats it.
     *
     * The ordering rules and the reasons for them live in `settle.ts`. They were 109 lines in the
     * middle of this function, between the gate checks and the transaction bookkeeping, and they
     * are the part that grows every time a venue is added.
     */
    // A direct leg is never a close: it puts capital to work rather than taking it off the table,
    // so it spends against the cap like any other outflow.
    const isClose = !intent.direct && intent.outSymbol === 'USDC';
    /*
     * In the SOLD token's own units, not dollars — and from the chain when the planner had the exact figure.
     * The float path overshot a real balance by 8 wei and reverted; a partial sell can keep using it, because
     * there the float IS the intended size. Worked out before settlement, so a fork's dry run of the route
     * pulls exactly what the close below will (PLAN.md X77).
     */
    const soldToken = VENUE_TOKENS[intent.inSymbol];
    if (!soldToken) throw new Error(`No token registry entry for ${intent.inSymbol}`);
    const closeAmount = intent.amountInRaw ?? BigInt(Math.floor(intent.amountIn * 10 ** soldToken.decimals));
    const { payToken, swap, venue, floor, spender } = await chooseSettlement({
      intent,
      owner,
      isClose: isCloseIntent(intent),
      delegationFrom: DELEGATION_FROM,
      send: isClose ? { via: 'closePosition', amount: closeAmount } : { via: 'spend', amount: usdToUnits(intent.usd) },
    });

    /*
     * From here on the period claim can never be released.
     *
     * `sent` flips before the write, not after, because the dangerous case is a transaction that
     * WAS broadcast and whose receipt we then failed to read. Releasing the claim there would let
     * the next tick place the same order again — the exact double-buy the unique `period_key`
     * exists to prevent. Erring the other way costs a user one missed run; erring this way costs
     * them a duplicate trade.
     */
    sent = true;

    // Read before the transaction so the delta afterwards is the fill and nothing else.
    const balanceBefore = intent.direct
      ? undefined
      : await rawBalanceOf(owner, intent.outSymbol === 'USDC' ? intent.inSymbol : intent.outSymbol);
    // A sale is also measured by what it paid, in the settlement token (PLAN.md 2.8).
    const usdcBefore = isClose ? await usdcRawOf(owner) : undefined;
    const signature = isClose
      ? await closeAsDelegate({
          owner,
          token: payToken.address,
          venue: swap.to as Address,
          // OKX DEX pulls through its approval contract, so the close goes through `closePositionVia`.
          spender,
          // The amount the route was measured with on a fork — see `closeAmount` above.
          amount: closeAmount,
          data: swap.data,
          ...floor,
        })
      : await spendAsDelegate({
          owner,
          token: payToken.address,
          venue: swap.to,
          spender,
          usd: intent.usd,
          data: swap.data,
          ...floor,
        });

    /*
     * What the fill ACTUALLY delivered, measured on chain.
     *
     * The units written to the book were `usd / price` — an estimate from the quote, not the
     * amount the router handed over. A $90 buy recorded 0.035879 WETH and delivered 0.035775, and
     * the difference stayed on the book forever as 0.0001 phantom units carrying $0.26 of cost.
     * Every entry price, every unrealised figure and every rebalance drift was computed against a
     * position that did not exist.
     *
     * So: wait for the receipt, then read the balance either side. Waiting is the right thing to
     * do regardless — recording a fill before it is mined is a race on any chain that does not
     * automine, and this executor is meant for one that does not.
     */
    let filledUnits = units;

    /*
     * EVERY leg waits for its receipt. Only a swap has a delta to measure.
     *
     * The wait was inside `if (!intent.direct)`, so an Aave supply reported `filled`, wrote the
     * position row, the audit entry and the day's spend — all before the transaction was mined. On
     * a chain that does not automine that is the exact race the paragraph above forbids, and if
     * the supply reverted the book would carry a position the chain never had. The reason the
     * guard existed is the balance READ, which a direct leg has no counterpart for; that part
     * stays conditional and the wait does not.
     */
    const settled = await waitForTx(signature).catch(() => false);
    if (!settled) throw new Error(`transaction ${signature} did not confirm`);

    if (!intent.direct) {
      const measured = await measuredDelta({
        owner,
        symbol: intent.outSymbol === 'USDC' ? intent.inSymbol : intent.outSymbol,
        before: balanceBefore,
      });
      // A close removes units; the delta is negative and the magnitude is what moved.
      if (measured !== undefined) filledUnits = Math.abs(measured);
    }

    /*
     * What a sale actually paid (PLAN.md 2.8).
     *
     * A close recorded `intent.usd` — the value its run started from — as its proceeds, so realised
     * P&L was booked from an estimate. It is the USDC that arrived. When the balance cannot be read
     * back the estimate stands, and the run keeps no quote to compare it with, so fill quality counts
     * it as unmeasured rather than as a perfect fill.
     */
    const proceeds = isClose ? await proceedsSince(owner, usdcBefore) : undefined;
    const recordedUsd = proceeds ?? intent.usd;
    const tradedSymbol = intent.outSymbol === 'USDC' ? intent.inSymbol : intent.outSymbol;

    /*
     * The price this fill was actually made at: what moved in USDC over the units the chain says moved.
     *
     * `price` above is the market's mark, taken to size the order. On X Layer mainnet it is the pool the order fills
     * in, and the two agree to the fee. On a fork they do not — the mark reads the live market, the fill lands in the
     * fork's pools as they stood at the fork block — and a $20 TSLAx order reported "price 379.22" for units that cost
     * $365.41 each. That figure is what the fill's exits are armed from (`armExits`, "measured from the FILL price"),
     * so an entry recorded at the market's price put a fresh buy 3.7% under water before it had moved, and a METAx buy
     * — the market 10% above the fork — past its own 5% stop. A supply leg has no units to divide and keeps its own.
     */
    const fillPrice = !intent.direct && filledUnits > 0 && recordedUsd > 0 ? recordedUsd / filledUnits : price;

    /*
     * Record what just happened.
     *
     * This was missing entirely: the trade settled on chain and the app learned nothing from it —
     * no position, no audit entry, no next run scheduled, and the run row left claimed but never
     * finished. `applyFill` was imported and never called. The chain was right and every screen
     * was wrong, which is the worst way for those two to disagree.
     *
     * One transaction, because a position without an audit entry is an unexplained holding and an
     * audit entry without a position is a trade the portfolio does not know about.
     */
    /*
     * The audit row's own id, carried out of the transaction for the push below.
     *
     * A notification saying "Bought 0.1234 NVDAx" used to open the top of the activity log and
     * leave the reader to find the row it meant. With the id the tap opens ON it
     * (`src/notifications/routes.ts`). Declared out here because `append` runs inside the
     * transaction and the push is deliberately outside it.
     */
    let auditSeq: string | undefined;

    await tx(async (client) => {
      await client.query(
        `UPDATE strategy_runs
            SET status='filled', signature=$2, units=$3, price=$4, usd=$5,
                quoted_units=$6, venue=$7, side=$8, quoted_usd=$9, asset_class=$10, finished_at=now()
          WHERE id=$1`,
        /*
         * `usd` was never written on a fill, so the one column that records what a run COST was
         * empty for every run that cost anything. The per-strategy cap below is summed from it.
         *
         * `quoted_units` is `units` — the pre-fill expectation — kept beside `filledUnits`, which
         * is the delta read off the chain. They are the same number only when the router was
         * exactly right, and the distance between them is the only honest measure of how well a
         * venue actually filled. It was being discarded at the moment it became checkable.
         *
         * `venue` is written rather than inferred later from the audit sentence.
         */
        [
          runId,
          signature,
          filledUnits,
          fillPrice,
          recordedUsd,
          units,
          venue,
          intent.direct ? 'supply' : isClose ? 'sell' : 'buy',
          proceeds === undefined ? null : intent.usd,
          isStock(tradedSymbol) ? 'equity' : 'crypto',
        ],
      );
      /*
       * A supply is not a position, so it does not go in the position book.
       *
       * Tier 4 wrote an `aUSDC` row, which then appeared in Holdings priced at $0.00 — there is no
       * price feed for a receipt token — next to a real balance of $1,220. Worse, it was a second
       * record of something the chain already answers exactly: `suppliedUsd()` reads the aToken
       * and the portfolio total already includes it. Two sources for one fact, one of which can
       * drift and neither of which is more authoritative than the chain.
       *
       * A close reduces the position; a buy adds to it. A supply does neither.
       */
      if (intent.direct) {
        // Nothing to book for the receipt: the aToken balance IS the record, and it is read from the chain. What was
        // supplied leaves the book, though, when the book holds it — tier 4's USDC→USDT0 swap booked the USDT0 it now
        // supplies, and left there it would sit in Holdings as a position the wallet no longer has.
        if (intent.inSymbol !== SETTLEMENT_SYMBOL) {
          const booked = await client.query<{ units: string }>(
            `SELECT units FROM positions WHERE wallet_id = $1 AND symbol = $2 AND side = 'long' AND chain = ${THIS_CHAIN}`,
            [walletId, intent.inSymbol],
          );
          const held = Number(booked.rows?.[0]?.units ?? 0);
          const out = Math.min(held, intent.amountIn);
          if (out > 0) {
            await applyFill(client, {
              walletId,
              symbol: intent.inSymbol,
              units: -out,
              usd: -out * intent.direct.unitPriceUsd,
              attribution: { source: 'strategy', id: strategy.id, label: strategy.label },
            });
          }
        }
      } else await applyFill(client, {
        walletId,
        symbol: intent.outSymbol === 'USDC' ? intent.inSymbol : intent.outSymbol,
        units: intent.outSymbol === 'USDC' ? -filledUnits : filledUnits,
        usd: intent.outSymbol === 'USDC' ? -recordedUsd : intent.usd,
        /*
         * Which strategy this sleeve belongs to.
         *
         * The label is captured now rather than joined later, so renaming or deleting the strategy
         * does not rewrite the attribution of a fill that already happened.
         */
        attribution: { source: 'strategy', id: strategy.id, label: strategy.label },
      });
      // Closing is not spending, so it does not consume the day's allowance — the contract
      // agrees, and the two tallies must not disagree.
      if (!isClose) await recordSpend(walletId, intent.usd, client);
      /*
       * Who placed it. A one-shot order an agent placed (the autonomous agent, the basket) names that agent in
       * `params.placedBy`; its fill row is the trade's only audit row, so the trail must not credit it to the person.
       */
      const placedBy = (strategy.params as Record<string, unknown> | null)?.placedBy;
      const auditRow = await append(
        {
          walletId,
          agent: typeof placedBy === 'string' && placedBy ? placedBy : agentForKind(strategy.kind),
          action: describeLeg(intent, filledUnits, venue),
          detail: intent.direct
            ? `$${intent.usd.toLocaleString('en-US', { maximumFractionDigits: 2 })} moved. ${intent.because}`
            : `$${intent.usd.toLocaleString('en-US', { maximumFractionDigits: 2 })} at $${fillPrice.toLocaleString('en-US', { maximumFractionDigits: 2 })}. ${intent.because}`,
          // Putting cash to work is not a trade, and the audit schema has had a 'yield' category
          // from the start that nothing ever wrote. Filing a supply as a trade makes the activity
          // filter lie about what the bot has been doing.
          kind: intent.direct ? 'yield' : 'trade',
          signature,
          payload: {
            runId,
            strategyId: strategy.id,
            units: filledUnits,
            price: fillPrice,
            usd,
            ...(isClose ? { proceedsUsd: recordedUsd, proceedsMeasured: proceeds !== undefined } : {}),
            explorer: explorerTx(signature),
          },
        },
        client,
      );
      /*
       * Optional, and deliberately so.
       *
       * This id exists to make a notification land on the right row. It is not part of the fill,
       * and reading it must never be able to throw inside the transaction that recorded one — the
       * surrounding code already holds that line for the push itself ("a push that fails must never
       * roll back a trade that settled"), and the id it carries is held to the same one.
       */
      auditSeq = auditRow?.seq === undefined ? undefined : String(auditRow.seq);
      /*
       * Carry the strategy's state forward, in the SAME transaction as the fill.
       *
       * A grid that bought a rung and crashed before recording it would buy that rung again on
       * the next tick — the classic double-fill this executor is built to make impossible. The
       * period claim stops a repeat within one period; this stops a repeat across them.
       *
       * Merged rather than replaced, so a planner returning only the keys it changed cannot wipe
       * the user's own configuration.
       */
      if (intent.stateAfter) {
        await client.query(`UPDATE strategies SET params = params || $2::jsonb WHERE id = $1`, [
          strategy.id,
          JSON.stringify(intent.stateAfter),
        ]);
      }
      // Schedule the next one. Without this a strategy fills once and then sits there looking
      // live, which is indistinguishable from being broken.
      await settleSchedule(client, strategy, at);
    });

    // What the wallet is worth with this fill in it (PLAN.md 2.10). Not awaited: a snapshot never holds up a run.
    void snapshotWallet({ id: walletId, address: owner }, isClose ? 'close' : 'fill').catch(() => undefined);

    /*
     * Tell the user.
     *
     * The bot trading while they are asleep is the product; them finding out is the other half of
     * it, and that half was never connected — `send()` existed and only `/notify/test` called it.
     * Deliberately outside the transaction and deliberately not awaited for correctness: a push
     * that fails must never roll back a trade that settled.
     */
    void send(walletId, {
      title: describeLeg(intent, filledUnits),
      body: intent.direct
        ? intent.because
        : `${filledUnits.toFixed(4)} at $${fillPrice.toLocaleString('en-US', { maximumFractionDigits: 2 })}. ${intent.because}`,
      route: '/activity',
      kind: 'dca-executed',
      /*
       * What the tap should open: the row this fill wrote, and the instrument it was in.
       *
       * `seq` is the id `/activity` puts on the row, so the app can open the list on it rather
       * than at the top. Both are absent rather than guessed if the write did not report one.
       */
      data: {
        ...(auditSeq === undefined ? {} : { seq: auditSeq }),
        symbol: intent.outSymbol === 'USDC' ? intent.inSymbol : intent.outSymbol,
      },
    }).catch(() => undefined);

    return { status: 'filled', runId, signature, units: filledUnits, price: fillPrice };
  } catch (e) {
    return failRun({ runId, walletId, strategy, error: messageOf(e), sent, at });
  }
}

/**
 * A run that threw, before it reached the chain or after.
 *
 * Every throw after the claim ends here (PLAN.md 1.6), so a failure is recorded the same way
 * wherever in the run it happened.
 */
async function failRun(p: {
  runId: string;
  walletId: string;
  strategy: StrategyRow;
  error: string;
  /** Whether anything may have been broadcast. A run that may have landed is never retried. */
  sent: boolean;
  at: Date;
}): Promise<RunOutcome> {
  const { runId, walletId, strategy, error, sent, at } = p;

  /*
   * A run that never reached the chain, and failed for a reason that will not recur, releases its
   * period so it can be tried again.
   *
   * `strategy_runs.period_key` is UNIQUE — that is what makes a retry, a restart and two
   * schedulers racing all safe. It also means a FAILED row consumes the period permanently: a
   * user whose daily buy hit a five-second RPC timeout silently lost that day, and the only trace
   * was a `failed` row nothing ever revisits.
   *
   * Two conditions, both required. Nothing may have been sent — see `sent` above. And the cause
   * must be transient: a policy refusal, a revoked permission or a spent cap will fail again in
   * exactly the same way, and re-running them is noise plus gas. Deleting the row is the release,
   * because the uniqueness IS the claim.
   *
   * The retry waits longer each time, and the trail hears about it once. It used to be the next
   * tick, thirty seconds later, every time, each writing its own "Retrying" row — an hour of RPC
   * trouble was a hundred and twenty identical rows per strategy in a log that can never be edited.
   * Only a DUE schedule is pushed back: a manual run of a strategy whose next slot is still ahead
   * leaves that slot alone.
   */
  if (!sent && isTransient(error)) {
    await query(`DELETE FROM strategy_runs WHERE id = $1`, [runId]).catch(() => undefined);
    const attempt = (strategy.retry_attempts ?? 0) + 1;
    const retryAt = new Date(at.getTime() + retryDelayMs(attempt));
    await query(
      `UPDATE strategies
          SET retry_attempts = retry_attempts + 1,
              next_run_at = CASE WHEN next_run_at IS NOT NULL AND next_run_at <= $2 THEN $3 ELSE next_run_at END
        WHERE id = $1`,
      [strategy.id, at, retryAt],
    ).catch(() => undefined);

    if (attempt === 1) {
      await append({
        walletId,
        agent: 'xorr',
        action: `Retrying ${strategy.label}`,
        detail: `${humanFailure(error)} Nothing was placed and nothing reached the chain, so it will be tried again, waiting a little longer each time until it goes through.`,
        kind: 'block',
        payload: { runId, strategyId: strategy.id, raw: error, released: true },
      }).catch(() => undefined);
    } else {
      log.warn(
        `[run] ${strategy.label}: still failing (attempt ${attempt}), next try ${retryAt.toISOString()}: ${error}`,
      );
    }
    return { status: 'failed', runId, error: humanFailure(error), raw: error };
  }

  await tx(async (client) => {
    await client.query(
      `UPDATE strategy_runs SET status='failed', error=$2, finished_at=now() WHERE id=$1`,
      [runId, error],
    );
    await settleSchedule(client, strategy, at);
    await append(
      {
        walletId,
        agent: agentForKind(strategy.kind),
        action: `Could not run ${strategy.label}`,
        detail: humanFailure(error),
        kind: 'block',
        payload: { runId, strategyId: strategy.id, raw: error },
      },
      client,
    );
  });
  return { status: 'failed', runId, error: humanFailure(error), raw: error };
}

/**
 * A tier 6–7 entry, put to the user instead of placed.
 *
 * The run ends `skipped · awaiting_approval` and moves the schedule on. The proposal carries what
 * approving needs — the size, the symbol, the stop, and the state the strategy should hold once the
 * position is open — and names the strategy, so the one that asked manages the exit. One open
 * proposal per strategy: a breakout that holds for three runs is one question, not three.
 */
async function proposeInstead(p: {
  runId: string;
  walletId: string;
  strategy: StrategyRow;
  intent: TradeIntent;
  at: Date;
}): Promise<RunOutcome> {
  const { runId, walletId, strategy, intent, at } = p;
  const symbol = intent.outSymbol;
  const agent = agentForKind(strategy.kind);
  const usdText = (n: number) => `$${n.toLocaleString('en-US', { maximumFractionDigits: 2 })}`;

  const open = await one<{ id: string }>(
    `SELECT id FROM proposals
      WHERE wallet_id = $1 AND decision IS NULL AND expires_at > now() AND payload->>'strategyId' = $2
      LIMIT 1`,
    [walletId, strategy.id],
  );
  const price = await priceOf(symbol).catch(() => 0);
  const stopPrice = Number(intent.stateAfter?.stopPrice ?? 0);

  await tx(async (client) => {
    await client.query(
      `UPDATE strategy_runs SET status='skipped', error='awaiting_approval', finished_at=now() WHERE id=$1`,
      [runId],
    );
    await settleSchedule(client, strategy, at);
    if (open) return;

    await client.query(
      `INSERT INTO proposals (id, wallet_id, agent, payload, expires_at)
       VALUES ($1, $2, $3, $4, now() + interval '15 minutes')`,
      [
        randomUUID(),
        walletId,
        agent,
        JSON.stringify({
          symbol,
          usd: String(intent.usd),
          stopPrice: stopPrice > 0 ? String(stopPrice) : '',
          targetPrice: '',
          strategyId: strategy.id,
          stateAfter: JSON.stringify(intent.stateAfter ?? {}),
          status: `${strategy.label} wants to trade`,
          opening: null,
          action: `Buy ${usdText(intent.usd)} of ${symbol}`,
          notional: usdText(intent.usd),
          entry: price > 0 ? usdText(price) : 'Market',
          stop: stopPrice > 0 ? usdText(stopPrice) : 'Managed by the strategy',
          target: '—',
          rationale: intent.because,
          onApprove: `Buys ${usdText(intent.usd)} of ${symbol} through your permission; ${strategy.label} then manages the exit.`,
          onSkip: `Skipped. ${strategy.label} will look again on its next run.`,
        }),
      ],
    );
    await append(
      {
        walletId,
        agent,
        action: `Asked before buying ${symbol}`,
        detail: `${intent.because} ${strategy.label} trades only with your approval, so this is waiting for a yes.`,
        kind: 'risk',
        payload: { runId, strategyId: strategy.id },
      },
      client,
    );
  });

  if (!open) {
    void send(walletId, {
      title: `${strategy.label} wants to buy ${symbol}`,
      body: intent.because,
      route: '/bot',
      kind: 'proposal-awaiting',
    }).catch(() => undefined);
  }
  return { status: 'skipped', reason: 'awaiting_approval' };
}

/**
 * Is this leg reducing risk rather than taking it on?
 *
 * A close and a supply are both "not a scheduled buy", but only the close is urgent enough to pay
 * up for. Kept as one function so the slippage decision and the cap decision cannot drift apart.
 */
/**
 * The hired agent's own limits, or null when this trade is inside them (PLAN.md 2.15).
 *
 * `maxUsdPerTrade` bounds one entry; `maxUsdPerDay` bounds the filled buys of every strategy the agent runs,
 * since the start of the UTC day, on this chain. Both are the user dividing what the permission already
 * allows between the agents they hired, so neither can raise anything — the cap and the contract still
 * apply on top.
 */
async function agentLimitRefusal(agentId: string, usd: number): Promise<{ reason: string; detail: string } | null> {
  const agent = await one<{ name: string; risk_limits: Record<string, unknown> | null }>(
    `SELECT name, risk_limits FROM agents WHERE id = $1`,
    [agentId],
  );
  if (!agent) return null;
  const limits = agent.risk_limits ?? {};
  const dollars = (n: number) => `$${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

  const perTrade = Number(limits.maxUsdPerTrade);
  if (Number.isFinite(perTrade) && perTrade > 0 && usd > perTrade + 0.005) {
    return {
      reason: 'agent_trade_limit',
      detail: `${agent.name} is limited to ${dollars(perTrade)} a trade, and this one was ${dollars(usd)}.`,
    };
  }
  const perDay = Number(limits.maxUsdPerDay);
  if (Number.isFinite(perDay) && perDay > 0) {
    const spentRows = await query<{ spent: string | null }>(
      `SELECT COALESCE(SUM(r.usd), 0) AS spent
         FROM strategy_runs r
         JOIN strategies s ON s.id = r.strategy_id
        WHERE s.agent_id = $1 AND s.chain = ${THIS_CHAIN}
          AND r.status = 'filled' AND r.side = 'buy'
          AND r.finished_at >= date_trunc('day', now() AT TIME ZONE 'UTC')`,
      [agentId],
    );
    const spent = Number(spentRows[0]?.spent ?? 0);
    if (spent + usd > perDay + 0.005) {
      return {
        reason: 'agent_daily_limit',
        detail: `${agent.name} may place ${dollars(perDay)} a day; ${dollars(spent)} is already placed and this asks for ${dollars(usd)}.`,
      };
    }
  }
  return null;
}

/**
 * Watch mode: the kind's own planner, run for real and placed nowhere (PLAN.md 2.16).
 *
 * Every watch run said "Would have bought {usd ÷ price} {symbol}" whatever the strategy was — a stop-loss
 * watching a position reported a buy, a rebalance priced "PORTFOLIO", and a momentum strategy reported an
 * entry on a day it would have done nothing. The trust ramp exists to show what THIS strategy would do, so
 * it asks the planner the live path asks, against the live wallet and prices, and reports that leg — or
 * that there was none. Nothing is signed, and nothing observed is kept: a watch run leaves its run row, its
 * trail entry and the strategy's state as it found it.
 */
async function watchRun(p: {
  runId: string;
  walletId: string;
  strategy: StrategyRow;
  usd: number;
  at: Date;
}): Promise<RunOutcome> {
  const { runId, walletId, strategy, usd, at } = p;
  const planner = PLANNERS[strategy.kind];
  if (!planner) {
    return finishBlocked(
      runId,
      walletId,
      strategy,
      'kind_not_executable',
      `Nothing here knows how to run a "${strategy.kind}" strategy yet, so it was not watched.`,
    );
  }
  const owner = (await one<{ address: string }>(`SELECT address FROM wallets WHERE id = $1`, [walletId]))
    ?.address as Address | undefined;
  if (!owner) return finishBlocked(runId, walletId, strategy, 'no_wallet', 'This wallet has no address on file.');

  let params = strategy.params as Record<string, unknown>;
  const context = { owner, budgetUsd: usd, params, symbol: strategy.symbol, levelSetAt: strategy.created_at };
  const observed = await observationFor(strategy.kind, context).catch(() => null);
  if (observed) params = { ...params, ...observed };
  // A strategy that cannot run here would have done nothing, which is what watching it says.
  const intent = await Promise.resolve(planner({ ...context, params })).catch((e: unknown) => {
    if (e instanceof PlanRefused) return null;
    throw e;
  });

  const traded = intent ? (intent.outSymbol === 'USDC' ? intent.inSymbol : intent.outSymbol) : undefined;
  const price = intent && !intent.direct && traded ? await priceOf(traded) : 0;
  const units = !intent ? 0 : intent.direct ? intent.usd : intent.outSymbol === 'USDC' ? intent.amountIn : intent.usd / price;
  const leg = intent ? describeLeg(intent, units) : null;

  await tx(async (client) => {
    await client.query(
      `UPDATE strategy_runs SET status='skipped', usd=$2, units=$3, price=$4, error='watch_mode', finished_at=now()
       WHERE id=$1`,
      [runId, intent ? intent.usd : null, intent ? units : null, price > 0 ? price : null],
    );
    await settleSchedule(client, strategy, at);
    await append(
      {
        walletId,
        agent: agentForKind(strategy.kind),
        action: leg ? `Would have ${leg.charAt(0).toLowerCase()}${leg.slice(1)}` : 'Would have done nothing',
        detail: intent
          ? `Simulated · ${strategy.label}${price > 0 ? ` · $${price.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` : ''}. ${intent.because} No capital moved.`
          : `Simulated · ${strategy.label}. Watched, and there was nothing to do this run. No capital moved.`,
        kind: 'risk',
        payload: { runId, strategyId: strategy.id, simulated: true, ...(intent ? { symbol: traded, usd: intent.usd, units } : {}) },
      },
      client,
    );
  });
  return intent ? { status: 'watch', runId, units, price } : { status: 'skipped', reason: 'nothing_to_do' };
}

function isCloseIntent(intent: TradeIntent): boolean {
  return !intent.direct && intent.outSymbol === 'USDC';
}

/**
 * What this leg did, in the words a person would use.
 *
 * "Bought 100.0000 aUSDC" is technically what the receipt token says and tells the user nothing.
 * The action line in the activity log is the only place some people ever read what the bot did, so
 * it names the thing that happened, not the token that moved.
 */
function describeLeg(intent: TradeIntent, units: number, venue?: SettlementVenue): string {
  if (intent.direct) {
    return `Supplied ${intent.usd.toLocaleString('en-US', { maximumFractionDigits: 2 })} ${intent.inSymbol} to Aave on X Layer`;
  }
  // Naming the venue in the activity log is the difference between "the bot bought something" and
  // a user being able to check where it went.
  const where =
    venue === 'uniswap-v3' ? ' on Uniswap v3' : venue === 'okx-dex' ? ' through OKX DEX' : '';
  return intent.outSymbol === 'USDC'
    ? `Sold ${units.toFixed(4)} ${intent.inSymbol}${where}`
    : `Bought ${units.toFixed(4)} ${intent.outSymbol}${where}`;
}

/**
 * The run happened, looked, and correctly did nothing.
 *
 * Distinct from `blocked`, which means a limit stopped it. Collapsing the two would make a healthy
 * rebalance look like a refused one every time the portfolio was already on target.
 */
async function finishNoop(
  runId: string,
  walletId: string,
  strategy: StrategyRow,
  detail: string,
): Promise<RunOutcome> {
  await tx(async (client) => {
    await client.query(
      `UPDATE strategy_runs SET status='skipped', error=NULL, finished_at=now() WHERE id=$1`,
      [runId],
    );
    await settleSchedule(client, strategy, new Date());
    await append(
      {
        walletId,
        agent: agentForKind(strategy.kind),
        action: `Nothing to do for ${strategy.label}`,
        detail,
        kind: 'risk',
        payload: { runId, strategyId: strategy.id },
      },
      client,
    );
  });
  return { status: 'skipped', reason: 'nothing_to_do' };
}

async function finishBlocked(
  runId: string,
  walletId: string,
  strategy: StrategyRow,
  reason: string,
  detail: string,
): Promise<RunOutcome> {
  // The row the push below should open. See the same pattern on the fill path above.
  let auditSeq: string | undefined;

  await tx(async (client) => {
    await client.query(
      `UPDATE strategy_runs SET status='blocked', error=$2, finished_at=now() WHERE id=$1`,
      [runId, reason],
    );
    // The period is spent either way; a schedule left due was re-selected on every tick.
    await settleSchedule(client, strategy, new Date());
    // A non-action is logged exactly like an action. That is the point of the trail.
    const auditRow = await append(
      {
        walletId,
        agent: agentForKind(strategy.kind),
        action: `Skipped ${strategy.symbol}`,
        detail,
        kind: 'block',
        payload: { runId, strategyId: strategy.id, reason },
      },
      client,
    );
    // Optional for the same reason as on the fill path: a row id is for a tap, not for the run.
    auditSeq = auditRow?.seq === undefined ? undefined : String(auditRow.seq);
  });

  /*
   * A blocked run is the notification that matters most.
   *
   * "Your cap stopped a trade" and "your permission expired" are the two things a user needs to
   * hear without opening the app — they are the moments the safety layer did its job, and silence
   * would look identical to the bot simply not trying.
   */
  void send(walletId, {
    title: 'A trade was not placed',
    body: detail,
    route: '/activity',
    kind: 'strategy-blocked',
    /*
     * Which row, and which instrument.
     *
     * This is the push that most needs to land somewhere precise: it says a trade did not happen,
     * and "which one" is the first thing anybody reading it wants. The trail is filed under
     * "Blocked", so the app widens the filter to reach the row rather than showing an empty list.
     */
    data: {
      ...(auditSeq === undefined ? {} : { seq: auditSeq }),
      symbol: strategy.symbol,
    },
  }).catch(() => undefined);

  return { status: 'blocked', runId, reason, detail };
}
