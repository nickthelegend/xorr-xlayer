/**
 * Alerts, evaluated.
 *
 * Both alert screens and the whole `alerts` table existed and nothing ever looked at a single row.
 * A user could set "BTC above $95,000", see it saved, and never hear about it — which is worse
 * than not offering the feature, because they were counting on it.
 *
 * Three rules shape this file:
 *
 *   1. **Fire once per crossing.** `armed` is the hysteresis: an alert disarms when it fires and
 *      only re-arms when the condition goes false again. Without it a sweep every thirty seconds
 *      sends the same push every thirty seconds for as long as BTC stays above the level, and the
 *      user turns off notifications — losing the ones that matter along with this one.
 *   2. **Every condition is read from the real thing.** Prices from the feed the charts use, the
 *      cap and the expiry from the contract. Nothing here consults our own cache for a decision.
 *   3. **A firing alert is an audit entry as well as a push.** A notification that did not arrive
 *      — wrong token, no network, app deleted — must still leave a record the user can find.
 */
import type { PoolClient } from 'pg';
import type { Address } from 'viem';
import { query, tx } from '../db/index.js';
import { THIS_CHAIN } from '../db/chain-scope.js';
import { append } from '../audit/log.js';
import { send } from '../notifications/push.js';
import { priceOf } from '../market/prices.js';
import { readPolicy } from '../evm/delegation.js';

type AlertRow = {
  id: string;
  wallet_id: string;
  kind: string;
  symbol: string | null;
  name: string;
  detail: string;
  armed: boolean;
  config: Record<string, unknown>;
};

/** What a condition evaluated to, and the sentence to show if it fired. */
type Verdict = { met: boolean; because?: string };

export type AlertOutcome = {
  id: string;
  name: string;
  action: 'fired' | 'rearmed' | 'quiet' | 'unevaluable';
  detail: string;
};

const money = (n: number) => `$${n.toLocaleString('en-US', { maximumFractionDigits: 2 })}`;

/**
 * A price alert. `above` and `below` may both be set — that is a band, and either edge fires.
 *
 * The price comes from `priceOf` with a deadline, not from a cached quote: an alert that fires on
 * a stale number is worse than one that does not fire, because the user acts on it.
 */
async function priceVerdict(a: AlertRow): Promise<Verdict> {
  const above = Number(a.config.above ?? NaN);
  const below = Number(a.config.below ?? NaN);
  if (!a.symbol || (!Number.isFinite(above) && !Number.isFinite(below))) {
    throw new Error('a price alert needs a symbol and an above or below level');
  }
  const px = await priceOf(a.symbol, 8_000);
  if (Number.isFinite(above) && px >= above) {
    return { met: true, because: `${a.symbol} is ${money(px)}, above your ${money(above)} level.` };
  }
  if (Number.isFinite(below) && px <= below) {
    return { met: true, because: `${a.symbol} is ${money(px)}, below your ${money(below)} level.` };
  }
  return { met: false };
}

/**
 * A risk alert, read from the contract.
 *
 * `capRemainingUsd` fires when the day's allowance drops under a floor — the moment a user might
 * want to raise the cap or stop the bot, and the one thing our own database should not be trusted
 * to answer. `expiresWithinHours` fires before the permission lapses, which is otherwise a silent
 * failure: every strategy simply stops, correctly, and the user has no idea why.
 */
async function riskVerdict(a: AlertRow, owner: Address | undefined): Promise<Verdict> {
  if (!owner) throw new Error('no wallet address on file');
  const policy = await readPolicy(owner);
  if (!policy) throw new Error('no permission granted on-chain');

  const floor = Number(a.config.capRemainingUsd ?? NaN);
  if (Number.isFinite(floor)) {
    if (policy.remainingTodayUsd <= floor) {
      return {
        met: true,
        because: `${money(policy.remainingTodayUsd)} left of today's ${money(policy.dailyCapUsd)} cap.`,
      };
    }
    return { met: false };
  }

  const hours = Number(a.config.expiresWithinHours ?? NaN);
  if (Number.isFinite(hours)) {
    const msLeft = policy.expiresAt - Date.now();
    if (msLeft <= hours * 3_600_000) {
      const h = Math.max(0, Math.round(msLeft / 3_600_000));
      return {
        met: true,
        because:
          h <= 0
            ? 'Your trading permission has expired. Nothing will run until you renew it.'
            : `Your trading permission expires in about ${h} hour${h === 1 ? '' : 's'}.`,
      };
    }
    return { met: false };
  }

  if (a.config.revoked === true) {
    return policy.revoked
      ? { met: true, because: 'The trading permission is revoked on-chain.' }
      : { met: false };
  }
  throw new Error('a risk alert needs capRemainingUsd, expiresWithinHours or revoked');
}

/**
 * An agent alert: something the bot did, counted from what actually happened.
 *
 * `blockedRuns` fires when the number of blocked runs since the alert last fired crosses a
 * threshold — a bot being stopped repeatedly is a signal, and one blocked run is not.
 */
async function agentVerdict(a: AlertRow): Promise<Verdict> {
  const threshold = Number(a.config.blockedRuns ?? NaN);
  if (!Number.isFinite(threshold)) throw new Error('an agent alert needs blockedRuns');
  const rows = await query<{ n: string }>(
    `SELECT count(*) AS n
       FROM strategy_runs r
       JOIN strategies s ON s.id = r.strategy_id
      WHERE s.wallet_id = $1 AND s.chain = ${THIS_CHAIN}
        AND r.status = 'blocked'
        AND r.finished_at > coalesce((SELECT last_fired_at FROM alerts WHERE id = $2), 'epoch')`,
    [a.wallet_id, a.id],
  );
  const n = Number(rows[0]?.n ?? 0);
  return n >= threshold
    ? { met: true, because: `${n} run${n === 1 ? '' : 's'} blocked since the last time this fired.` }
    : { met: false };
}

async function verdictFor(a: AlertRow, owner: Address | undefined): Promise<Verdict> {
  if (a.kind === 'price') return priceVerdict(a);
  if (a.kind === 'risk') return riskVerdict(a, owner);
  if (a.kind === 'agent') return agentVerdict(a);
  throw new Error(`no evaluator for alert kind "${a.kind}"`);
}

/**
 * Sweep every enabled alert once.
 *
 * Returns what happened to each, so the caller — the scheduler, or a test — can assert on it
 * rather than infer it from a log line.
 */
export async function evaluateAlerts(): Promise<AlertOutcome[]> {
  const rows = await query<AlertRow & { address: string | null }>(
    `SELECT a.*, w.address
       FROM alerts a
       JOIN wallets w ON w.id = a.wallet_id
      WHERE a.enabled`,
  );

  const outcomes: AlertOutcome[] = [];
  for (const a of rows) {
    let v: Verdict;
    try {
      v = await verdictFor(a, (a.address ?? undefined) as Address | undefined);
    } catch (e) {
      /*
       * A misconfigured or unevaluable alert is reported, not thrown.
       *
       * One alert with a missing level must not stop the sweep — the other alerts belong to other
       * people, and silently dropping them is exactly the failure this whole file exists to fix.
       */
      outcomes.push({
        id: a.id,
        name: a.name,
        action: 'unevaluable',
        detail: e instanceof Error ? e.message : String(e),
      });
      continue;
    }

    if (v.met && a.armed) {
      await tx(async (client: PoolClient) => {
        await client.query(
          `UPDATE alerts SET armed = false, last_fired_at = now(), fire_count = fire_count + 1
            WHERE id = $1`,
          [a.id],
        );
        // The record first. A push that fails must not mean the event never happened.
        await append(
          {
            walletId: a.wallet_id,
            agent: 'Drawdown Guard',
            action: a.name,
            detail: v.because ?? a.detail,
            kind: 'risk',
            payload: { alertId: a.id, kind: a.kind, symbol: a.symbol },
          },
          client,
        );
      });
      void send(a.wallet_id, {
        title: a.name,
        body: v.because ?? a.detail,
        route: '/alerts',
        kind: 'alert-fired',
        /*
         * The instrument, so the tap opens it rather than the list of alerts.
         *
         * An alert is a statement about a price, and what someone does next is look at the chart or
         * buy. Landing on a list of alert rules is landing one screen short of both. An alert with
         * no symbol — a portfolio drawdown — sends none, and the app falls back to `/alerts`.
         */
        ...(a.symbol ? { data: { symbol: a.symbol } } : {}),
      }).catch(() => undefined);
      outcomes.push({ id: a.id, name: a.name, action: 'fired', detail: v.because ?? a.detail });
      continue;
    }

    if (!v.met && !a.armed) {
      // The condition went false again, so the next crossing is a new event worth hearing about.
      await query(`UPDATE alerts SET armed = true WHERE id = $1`, [a.id]);
      outcomes.push({ id: a.id, name: a.name, action: 'rearmed', detail: 'condition cleared' });
      continue;
    }

    outcomes.push({
      id: a.id,
      name: a.name,
      action: 'quiet',
      detail: v.met ? 'still true, already fired' : 'condition not met',
    });
  }
  return outcomes;
}
