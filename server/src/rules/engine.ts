/**
 * The rule engine — PLAN.md 12.9, closing [G26].
 *
 * "Limits are enforced in the delegation policy or the executor, never in the client. A
 * client-side cap is not a cap."
 *
 * Every rejection returns a reason that is written to the audit log as a `block` row — that is
 * what produces screen 15's "Skipped NVDAx / Spread 0.42% > your 0.25% limit".
 */
import type { PoolClient } from 'pg';
import { query } from '../db/index.js';

export type RuleContext = {
  walletId: string;
  /** USD the action wants to commit. */
  usd: number;
  /** From the delegation record. */
  dailyCapUsd: number;
  delegationExpiresAt: Date;
  delegationRevoked: boolean;
  /** Optional per-market checks. */
  spreadPct?: number;
  maxSpreadPct?: number;
  killed?: boolean;
  /**
   * This leg only REDUCES exposure, so the daily cap does not apply to it.
   *
   * The cap is a limit on putting capital at risk. A cap that can block an exit is a cap that
   * traps you — and it did: the account cap was checked before the planner had decided anything,
   * so a wallet that had spent its day could not be stopped out. A take-profit and a stop-loss
   * were refused with `daily_cap`, which is the safety rail being switched off by a spending
   * limit. Permission still governs everything: revoked and expired refuse a close too, because
   * those are the user saying no rather than the user saying "not more than this much".
   */
  reducesRiskOnly?: boolean;
};

export type RuleVerdict =
  | { allowed: true; spentTodayUsd: number; remainingUsd: number }
  | { allowed: false; reason: string; detail: string };

function utcDay(now = new Date()): string {
  return now.toISOString().slice(0, 10);
}

export async function spentToday(walletId: string, client?: PoolClient): Promise<number> {
  const sql = `SELECT spent_usd FROM daily_spend WHERE wallet_id=$1 AND day=$2`;
  const rows = client
    ? (await client.query<{ spent_usd: string }>(sql, [walletId, utcDay()])).rows
    : await query<{ spent_usd: string }>(sql, [walletId, utcDay()]);
  return Number(rows[0]?.spent_usd ?? 0);
}

/** Record spend atomically with the action that caused it. Always call inside the same tx. */
export async function recordSpend(
  walletId: string,
  usd: number,
  client: PoolClient,
): Promise<void> {
  await client.query(
    `INSERT INTO daily_spend (wallet_id, day, spent_usd) VALUES ($1,$2,$3)
     ON CONFLICT (wallet_id, day) DO UPDATE SET spent_usd = daily_spend.spent_usd + EXCLUDED.spent_usd`,
    [walletId, utcDay(), usd],
  );
}

export async function evaluate(ctx: RuleContext, client?: PoolClient): Promise<RuleVerdict> {
  if (ctx.killed) {
    return {
      allowed: false,
      reason: 'agents_stopped',
      detail: 'You stopped the agents. Nothing will be placed until you resume.',
    };
  }
  if (ctx.delegationRevoked) {
    return {
      allowed: false,
      reason: 'delegation_revoked',
      detail: 'The trading permission has been revoked, so I cannot place this.',
    };
  }
  if (ctx.delegationExpiresAt.getTime() <= Date.now()) {
    return {
      allowed: false,
      reason: 'delegation_expired',
      detail: 'The trading permission has expired. Renew it and I will pick this up again.',
    };
  }
  if (!(ctx.usd > 0)) {
    return { allowed: false, reason: 'invalid_amount', detail: 'The amount must be above zero.' };
  }
  if (
    ctx.spreadPct !== undefined &&
    ctx.maxSpreadPct !== undefined &&
    ctx.spreadPct > ctx.maxSpreadPct
  ) {
    return {
      allowed: false,
      reason: 'spread_too_wide',
      detail: `Spread ${ctx.spreadPct.toFixed(2)}% > your ${ctx.maxSpreadPct.toFixed(2)}% limit`,
    };
  }

  const spent = await spentToday(ctx.walletId, client);
  const remaining = ctx.dailyCapUsd - spent;
  if (!ctx.reducesRiskOnly && ctx.usd > remaining) {
    /*
     * Never say a negative amount is "left".
     *
     * Lowering the cap mid-day, or re-granting a smaller one, puts today's spend above it — which
     * is the cap working, not a bug. But the refusal read "$-3,315.00 is left", which is not a
     * sentence about money anyone can act on. Below the cap the number is what remains; at or
     * past it the honest statement is that today is done, with the figure that made it so.
     */
    const money = (n: number) =>
      `$${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
    const cap = `$${ctx.dailyCapUsd.toLocaleString('en-US')}`;
    return {
      allowed: false,
      reason: 'daily_cap',
      detail:
        remaining > 0
          ? `That would take today past your ${cap} cap. ${money(remaining)} is left.`
          : `Today's ${cap} cap is used up — ${money(spent)} already went out. Nothing more until tomorrow.`,
    };
  }
  return { allowed: true, spentTodayUsd: spent, remainingUsd: remaining - ctx.usd };
}
