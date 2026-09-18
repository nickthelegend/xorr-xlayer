/**
 * Runs that were interrupted, reconciled at boot.
 *
 * Graceful shutdown stops new ones being abandoned. It cannot heal the ones already there: a run
 * killed mid-flight leaves its `strategy_runs` row `pending` forever, and because `period_key` is
 * unique that period can never be claimed again — so the strategy silently skips a day and a row
 * sits in a state nothing will ever move it out of.
 *
 * The important decision is what NOT to do. A pending run cannot be retried, because we genuinely
 * do not know whether the transaction landed: the delegate may have signed and the process died
 * before the receipt. Retrying would be the double-spend this whole executor is built to make
 * impossible. So the run is closed as failed, the reason says exactly that, and the period stays
 * consumed — one skipped buy is a far better outcome than one duplicated buy.
 */
import { query, tx } from '../db/index.js';
import { THIS_CHAIN } from '../db/chain-scope.js';
import { append } from '../audit/log.js';
import { log } from '../http/request-id.js';

/**
 * Older than this and a `pending` run cannot be in flight any more.
 *
 * A fill takes seconds; five minutes is longer than the slowest one observed and short enough that
 * a restart heals the damage before the next scheduler tick tries to work around it.
 */
const STALE_MS = 5 * 60_000;

export async function reconcileInterruptedRuns(): Promise<number> {
  const stale = await query<{ id: string; strategy_id: string; wallet_id: string; label: string }>(
    `SELECT r.id, r.strategy_id, s.wallet_id, s.label
       FROM strategy_runs r
       JOIN strategies s ON s.id = r.strategy_id
      WHERE r.status = 'pending' AND r.started_at < now() - interval '${STALE_MS} milliseconds'
        AND s.chain = ${THIS_CHAIN}`,
  );
  if (stale.length === 0) return 0;

  for (const r of stale) {
    await tx(async (client) => {
      await client.query(
        `UPDATE strategy_runs SET status='failed', error=$2, finished_at=now() WHERE id=$1`,
        [r.id, 'interrupted'],
      );
      /*
       * Say it in the trail, not only in a column.
       *
       * "Nothing happened that period" and "we do not know what happened that period" are
       * different facts, and the second one is the user's to know about.
       */
      await append(
        {
          walletId: r.wallet_id,
          agent: 'Drawdown Guard',
          action: `A run of ${r.label} was interrupted`,
          detail:
            'The executor stopped while this run was in flight, so it is not known whether it ' +
            'placed anything. It will not be retried — repeating a trade that may have happened ' +
            'is worse than missing one.',
          kind: 'block',
          payload: { runId: r.id, strategyId: r.strategy_id, reconciled: true },
        },
        client,
      );
    });
  }

  log.warn(`reconciled ${stale.length} interrupted run(s)`);
  return stale.length;
}
