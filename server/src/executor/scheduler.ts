/**
 * The scheduler — PLAN.md 9.3 / §3.7.
 *
 * "A phone cannot be relied on to wake up at 09:00 to place a DCA buy — that is the whole promise
 * of trades while you chill." So the schedule lives here, on a server, and the phone is just a
 * window onto it.
 *
 * Safety comes from runStrategy's period claim, not from this loop: two schedulers, a restart
 * mid-run, or a manual trigger racing the tick all converge on one run per period.
 */
import { query } from '../db/index.js';
import { THIS_CHAIN } from '../db/chain-scope.js';
import { log } from '../http/request-id.js';
import { runStrategy, type StrategyRow } from './run.js';
import { autonomousAgentSweep } from '../bot/autonomous.js';
import { basketSweep } from '../bot/basket.js';
import { observeSweep } from '../market/observe.js';
import { evaluateAlerts } from '../alerts/evaluate.js';
import { anchorSweep } from '../audit/anchor-sweep.js';
import { sweepCorporateActions } from '../venues/corporate-actions.js';
import { snapshotSweep } from '../portfolio/snapshots.js';

export const TICK_MS = Number(process.env.SCHEDULER_TICK_MS ?? 30_000);

/**
 * When the last tick started, for this process.
 *
 * The schedule screen wants to say when the next sweep is, and the only honest source for that is
 * the loop itself — `setInterval` keeps no record anyone can read, so anything derived from the
 * wall clock alone would be a guess dressed as a time. Undefined until the first tick, which is
 * the true state after a restart and is reported as such rather than smoothed over.
 *
 * Per-process by design. It describes THIS executor's loop, which is the one the app is talking to.
 */
let lastTickAt: number | undefined;

export function schedulerHeartbeat(): { tickMs: number; lastTickAt: number | null } {
  return { tickMs: TICK_MS, lastTickAt: lastTickAt ?? null };
}

export async function tick(now: Date = new Date()): Promise<number> {
  lastTickAt = now.getTime();

  /*
   * Write down what the xStocks cost, before anything decides anything from it.
   *
   * The agent's range strategies need recorded readings before a high and a low count as a band,
   * and `price_observations` only ever filled as a side effect of somebody opening a screen — so
   * an asset nobody had looked at had no band and the range branches stood down. Found by driving
   * the demo end to end: NVDAx had five readings and TSLAx two.
   *
   * First in the tick, so the decisions below see this tick's reading rather than the last one's.
   * Paced internally (`OBSERVE_EVERY_MS`), and it does not contribute to `ran`: looking at a price
   * is not work this tick did on anyone's behalf.
   */
  try {
    await observeSweep(now);
  } catch (e) {
    log.error('[scheduler] observe sweep failed:', e instanceof Error ? e.message : e);
  }
  const due = await query<StrategyRow>(
    `SELECT * FROM strategies
     WHERE state IN ('live','watch') AND next_run_at IS NOT NULL AND next_run_at <= $1
       AND chain = ${THIS_CHAIN}
     ORDER BY next_run_at ASC LIMIT 20`,
    [now],
  );
  let ran = 0;
  for (const s of due) {
    /*
     * One strategy's failure is that strategy's (PLAN.md 1.6).
     *
     * This awaited each run with no catch, so a strategy that threw ended the tick: every strategy
     * after it in the list waited another interval, and the alert and anchor sweeps below did not run
     * at all. `runStrategy` records its own failures; this only keeps one from becoming everyone's.
     */
    try {
      const outcome = await runStrategy(s, now);
      if (outcome.status !== 'skipped') ran += 1;
      console.log(`[scheduler] ${s.label}: ${outcome.status}`);
    } catch (e) {
      log.error(`[scheduler] ${s.label} threw:`, e instanceof Error ? e.message : e);
    }
  }

  /*
   * The autonomous agent, once per tick (PLAN.md §8.6).
   *
   * Scores momentum, event-driven and DCA entries across the xStocks registry from what is
   * actually readable — a Jupiter quote, the readings this app has recorded, EDGAR's filing
   * cadence, the mint's Scaled UI multiplier, the Nasdaq clock — and sends the best one through
   * the same `guardAndSpend` chokepoint every other spend goes through. Wallets past their
   * cooldown only, and none at all while the kill switch is on.
   *
   * It contributes to `ran` because a sweep that placed a trade is work this tick did.
   */
  try {
    const autoExecuted = await autonomousAgentSweep(now);
    ran += autoExecuted;
  } catch (e) {
    log.error('[scheduler] autonomous agent sweep failed:', e instanceof Error ? e.message : e);
  }

  /*
   * Basket rebalancing, after the agent has had its turn.
   *
   * After, so a rebalance measures a portfolio that includes whatever the agent just opened. The
   * order matters: measuring first and trading second would size a correction against a basket
   * that changed underneath it.
   *
   * Each wallet's run is claimed on a unique period key before anything is read, so a tick that
   * overruns, a restart, or two schedulers all converge on one rebalance per period.
   */
  try {
    ran += await basketSweep(now);
  } catch (e) {
    log.error('[scheduler] basket sweep failed:', e instanceof Error ? e.message : e);
  }

  /*
   * Alerts, after the strategies.
   *
   * After, because an alert about the day's cap or a blocked run should see this tick's runs
   * rather than the previous one's — a "your cap is nearly gone" notification that arrives thirty
   * seconds late is thirty seconds of trades the user did not get to stop.
   *
   * Deliberately not fatal to the tick. An alert sweep that throws must not stop the scheduler
   * from placing trades; the trades are the product and the alerts are commentary on them.
   */
  try {
    const outcomes = await evaluateAlerts();
    const fired = outcomes.filter((o) => o.action === 'fired');
    const broken = outcomes.filter((o) => o.action === 'unevaluable');
    for (const o of fired) console.log(`[alerts] fired "${o.name}": ${o.detail}`);
    for (const o of broken) log.warn(`[alerts] cannot evaluate "${o.name}": ${o.detail}`);
  } catch (e) {
    log.error('[alerts] sweep failed:', e instanceof Error ? e.message : e);
  }

  /*
   * Then anything the issuers have scheduled.
   *
   * Non-fatal for the same reason the alert sweep is, and after it for the same reason: a warning
   * about a split is commentary on the position, never a precondition for trading it. The sweep is
   * idempotent — each holder is claimed once per action — so running it every tick costs one query
   * per xStock and sends nothing it has already sent.
   */
  try {
    const actions = await sweepCorporateActions();
    for (const o of actions) {
      if (o.walletsNotified.length > 0) {
        console.log(
          `[corporate-actions] ${o.action.symbol} ${o.action.reading} on ${o.action.effectiveAt}: told ${o.walletsNotified.length}`,
        );
      }
    }
  } catch (e) {
    log.error('[corporate-actions] sweep failed:', e instanceof Error ? e.message : e);
  }

  /*
   * Then the anchor sweep, last, and on its own cadence.
   *
   * Last because it publishes a commitment to the trail, and a commitment made before this tick's
   * rows were written would be stale the moment it landed. Non-fatal for the same reason the alert
   * sweep is: anchoring is a claim ABOUT the log, never a precondition for writing to it, and a
   * chain that is unreachable must not stop the product from trading.
   */
  try {
    const swept = await anchorSweep();
    if (swept?.anchored) console.log(`[anchor] ${swept.anchored} wallet(s) anchored`);
  } catch (e) {
    log.error('[anchor] sweep failed:', e instanceof Error ? e.message : e);
  }

  /*
   * What each active wallet is worth, every 15 minutes (PLAN.md 2.10). After the runs, so a fill this
   * tick is in the value; non-fatal like the sweeps above — a history with a gap is still true.
   */
  try {
    const shots = await snapshotSweep();
    if (shots.recorded || shots.failed) console.log(`[snapshot] ${shots.recorded} kept, ${shots.failed} could not be read`);
  } catch (e) {
    log.error('[snapshot] sweep failed:', e instanceof Error ? e.message : e);
  }

  /*
   * Stored `Idempotency-Key` responses, kept for a day (PLAN.md 2.6).
   *
   * Nothing deleted them, so the table gained a row per keyed request forever. A retry is a client
   * recovering from a response it never saw; a day is far past any retry. Non-fatal, like the sweeps.
   */
  try {
    await query(`DELETE FROM idempotency WHERE created_at < now() - interval '24 hours'`);
  } catch (e) {
    log.error('[idempotency] cleanup failed:', e instanceof Error ? e.message : e);
  }

  return ran;
}

let ticking = false;

/**
 * A tick, unless the previous one is still running — then this one is skipped, not stacked.
 *
 * `setInterval` fired every thirty seconds whether or not the last tick had finished, and a tick
 * waiting on fills can take longer than that. The period claim stopped a double run, but two ticks
 * still sent transactions from the same delegate key at once, where they contend for a nonce, and
 * ran the alert and anchor sweeps twice. PLAN.md 1.6.
 */
export async function guardedTick(now: Date = new Date()): Promise<number | 'skipped'> {
  if (ticking) {
    log.warn('[scheduler] the previous tick is still running; skipping this one');
    return 'skipped';
  }
  ticking = true;
  try {
    return await tick(now);
  } finally {
    ticking = false;
  }
}

export function startScheduler(): NodeJS.Timeout {
  console.log(`  scheduler every ${TICK_MS}ms`);
  return setInterval(() => {
    guardedTick().catch((e: unknown) => log.error('[scheduler]', e));
  }, TICK_MS);
}
