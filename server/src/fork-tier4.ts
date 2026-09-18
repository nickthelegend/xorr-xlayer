/**
 * Tier 4 through the EXECUTOR, not just through the contract.
 *
 * `fork-yield.ts` proves the permission layer accepts a lending pool as a venue. This proves the
 * product does: a real strategy row, the real planner, the real gates, the real `spend()`, and the
 * real bookkeeping afterwards. Those are different claims, and only the second one is what a user
 * gets. A tier whose contract call works and whose executor never records the position is a tier
 * that silently loses track of the user's money.
 *
 * Run: npx tsx server/src/fork-tier4.ts   (with .env.fork loaded, anvil forking Base mainnet)
 */
import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { erc20Abi, formatUnits, type Address } from 'viem';
import { one, query } from './db/index.js';
import { spentToday } from './rules/engine.js';
import { readPolicy } from './evm/delegation.js';
import { runStrategy, type StrategyRow } from './executor/run.js';
import { publicClient } from './evm/client.js';
import { usdcReserve } from './market/yield.js';
import { cashUsd, suppliedUsd } from './evm/balances.js';

const SUPPLY_USD = 120;

function must(label: string, cond: boolean, detail = '') {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${detail ? `  — ${detail}` : ''}`);
  if (!cond) process.exitCode = 1;
}

async function main() {
  const wallet = await one<{ id: string; address: string }>(
    `SELECT id, address FROM wallets WHERE address = $1`,
    [process.argv[2] ?? '0x95A0b368588713011a15f4b1041423f31B08e615'],
  );
  if (!wallet) throw new Error('No such wallet on file.');
  const owner = wallet.address as Address;

  const reserve = await usdcReserve();

  /*
   * Is there room to spend today at all?
   *
   * Two tallies guard the cap and the STRICTER one wins: the contract's `_spentOnDay`, and our own
   * `daily_spend` row. They are allowed to disagree — redeploying the delegation on a fork resets
   * the chain's tally while the database correctly does not forget — and when they do, failing
   * closed is the right direction to be wrong in.
   *
   * That matters here because a run refused by a cap that is genuinely used up is the safety layer
   * working, not the tier failing. Reporting it as FAIL would be this script lying about the thing
   * it exists to check. So: say what is left, and stop before asserting anything.
   */
  const policy = await readPolicy(owner);
  if (!policy) throw new Error('No delegation on chain for this wallet — run fork-grant.ts first.');
  const dbSpent = await one<{ id: string }>(`SELECT id FROM wallets WHERE address = $1`, [owner])
    .then(() => spentToday(wallet.id));
  const roomUsd = Math.min(policy.remainingTodayUsd, policy.dailyCapUsd - dbSpent);
  if (roomUsd < SUPPLY_USD) {
    console.log(
      `\nToday's cap is used up, so there is nothing to prove here right now.\n` +
        `  chain says $${policy.remainingTodayUsd.toFixed(2)} left, the database says ` +
        `$${(policy.dailyCapUsd - dbSpent).toFixed(2)} — the smaller one governs.\n` +
        `  Re-grant with a higher cap, or wait for the UTC day to roll.\n`,
    );
    return;
  }

  const [cashBefore, suppliedBefore] = await Promise.all([cashUsd(owner), suppliedUsd(owner)]);
  console.log(
    `\nwallet ${owner}\n  cash $${cashBefore.toFixed(2)}  supplied $${suppliedBefore.toFixed(2)}  ` +
      `Aave USDC ${(reserve.apy * 100).toFixed(2)}%\n`,
  );

  const id = randomUUID();
  await query(
    `INSERT INTO strategies (id, wallet_id, kind, state, label, symbol, params, cadence, next_run_at, daily_allocation_usd)
     VALUES ($1,$2,'yield-rotation','live','Idle cash to Aave','USDC',$3,'daily',now(),$4)`,
    [
      id,
      wallet.id,
      // keepCashUsd is the buffer the sweep must not touch, expressed relative to what is actually
      // there — a fixed buffer on a fork wallet holding 74k would sweep the whole cap every run.
      JSON.stringify({ usd: SUPPLY_USD, keepCashUsd: Math.max(cashBefore - SUPPLY_USD, 0), minMoveUsd: 25 }),
      SUPPLY_USD,
    ],
  );

  const row = (await one<StrategyRow>(`SELECT * FROM strategies WHERE id = $1`, [id]))!;
  const outcome = await runStrategy(row);
  console.log(`  executor said: ${JSON.stringify(outcome)}\n`);
  must('the executor filled the run', outcome.status === 'filled', outcome.status);
  if (outcome.status !== 'filled') return;

  const [cashAfter, suppliedAfter] = await Promise.all([cashUsd(owner), suppliedUsd(owner)]);
  must(
    'spendable cash went down by the swept amount',
    Math.abs(cashBefore - cashAfter - SUPPLY_USD) < 0.01,
    `$${cashBefore.toFixed(2)} → $${cashAfter.toFixed(2)}`,
  );
  must(
    'the supplied balance went up by the same amount',
    Math.abs(suppliedAfter - suppliedBefore - SUPPLY_USD) < 0.01,
    `$${suppliedBefore.toFixed(2)} → $${suppliedAfter.toFixed(2)}`,
  );
  /*
   * The whole reason `suppliedUsd` exists: without it this tier looks like it deletes money.
   *
   * Cash plus supplied, not the whole portfolio — a scheduled DCA running in the background
   * converts USDC into WETH, and a total that included holdings would move for reasons this
   * assertion is not about. Naming it "the portfolio total" was overstating what it checks.
   */
  must(
    'cash plus supplied is unchanged by the move',
    Math.abs(cashAfter + suppliedAfter - (cashBefore + suppliedBefore)) < 0.01,
    `$${(cashBefore + suppliedBefore).toFixed(2)} → $${(cashAfter + suppliedAfter).toFixed(2)}`,
  );

  const stranded = await publicClient.readContract({
    address: reserve.aToken, abi: erc20Abi, functionName: 'balanceOf',
    args: [process.env.DELEGATION_ADDRESS as Address],
  });
  must('the delegation contract kept no aUSDC', stranded === 0n, formatUnits(stranded, 6));

  const run = await one<{ status: string; signature: string; units: string; price: string }>(
    `SELECT status, signature, units, price FROM strategy_runs WHERE id = $1`, [outcome.runId],
  );
  must('the run is recorded as filled with a real signature', run?.status === 'filled' && !!run?.signature, run?.signature ?? 'none');

  const entry = await one<{ action: string; detail: string; kind: string }>(
    `SELECT action, detail, kind FROM audit_log WHERE payload->>'runId' = $1 ORDER BY seq DESC LIMIT 1`,
    [outcome.runId],
  );
  must('the activity log says what happened in plain language', !!entry && entry.action.includes('Supplied'), entry ? `"${entry.action} — ${entry.detail}"` : 'no entry');
  // The schema has had a 'yield' category all along and nothing ever wrote one. A supply filed as
  // a 'trade' is not wrong enough to notice and not right enough to filter on.
  must('it is filed as yield, not as a trade', entry?.kind === 'yield', entry?.kind ?? 'none');

  const next = await one<{ next_run_at: Date | null }>(`SELECT next_run_at FROM strategies WHERE id = $1`, [id]);
  must('the next run is scheduled', !!next?.next_run_at && next.next_run_at > new Date(), next?.next_run_at?.toISOString() ?? 'none');

  // Idempotence: the same period must not sweep twice. This is the property that stops a retry or
  // a second scheduler from double-spending, and it has to hold for every kind, not just DCA.
  const again = await runStrategy(row);
  must('a second run in the same period is refused', again.status === 'skipped' && again.reason === 'already_ran_this_period', JSON.stringify(again));

  // And with no idle cash left above the buffer, the planner must do nothing rather than force a
  // trade. "Nothing to do" is the correct answer most days.
  await query(`UPDATE strategies SET params = $2 WHERE id = $1`, [
    id, JSON.stringify({ usd: SUPPLY_USD, keepCashUsd: 10_000_000, minMoveUsd: 25 }),
  ]);
  const idleRow = (await one<StrategyRow>(`SELECT * FROM strategies WHERE id = $1`, [id]))!;
  // Tomorrow, so it claims a different period rather than being refused as a repeat — the same
  // strategy row, because a run must belong to a strategy that exists.
  const quiet = await runStrategy(idleRow, new Date(Date.now() + 86_400_000));
  must('with nothing idle it does nothing, and does not call it an error', quiet.status === 'skipped', JSON.stringify(quiet));

  await query(`DELETE FROM strategies WHERE id = $1`, [id]);
  console.log(`\n  $${SUPPLY_USD} of idle cash moved to Aave by the scheduler, and the books agree.\n`);
}

await main();
process.exit(process.exitCode ?? 0);
