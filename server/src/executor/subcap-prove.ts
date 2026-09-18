/**
 * The per-strategy daily allocation, proved.
 *
 * A strategy allocated $60 a day must be stopped at $60 even when the account's own cap has
 * thousands left — otherwise the allocation is a label, and the first strategy to run each day
 * gets to spend everyone else's budget.
 *
 * Run: npx tsx server/src/executor/subcap-prove.ts
 */
import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { one, query } from '../db/index.js';
import { runStrategy, type StrategyRow } from './run.js';
import { readPolicy } from '../evm/delegation.js';
import type { Address } from 'viem';

function must(label: string, cond: boolean, detail = '') {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${detail ? `  — ${detail}` : ''}`);
  if (!cond) process.exitCode = 1;
}

const ALLOCATION = 60;
const PER_RUN = 40;

const wallet = (await one<{ id: string; address: string }>(
  `SELECT id, address FROM wallets WHERE address = $1`,
  [process.argv[2] ?? '0x95A0b368588713011a15f4b1041423f31B08e615'],
))!;

const policy = await readPolicy(wallet.address as Address);
console.log(`\naccount cap: $${policy?.dailyCapUsd} / day, $${policy?.remainingTodayUsd} left`);
console.log(`strategy allocation: $${ALLOCATION} / day, $${PER_RUN} per run\n`);

const id = randomUUID();
await query(
  `INSERT INTO strategies (id, wallet_id, kind, state, label, symbol, params, cadence, next_run_at, daily_allocation_usd)
   VALUES ($1,$2,'dca','live','subcap proof','WETH',$3,'daily',now(),$4)`,
  [id, wallet.id, JSON.stringify({ usd: PER_RUN }), ALLOCATION],
);

const row = async () => (await one<StrategyRow>(`SELECT * FROM strategies WHERE id=$1`, [id]))!;

// Run 1: $40 of $60. Fine.
const first = await runStrategy(await row(), new Date());
must('the first run fits inside the allocation and fills', first.status === 'filled', JSON.stringify(first));

// Run 2, a different period so the idempotence claim does not absorb it: $40 more would be $80.
// The account has thousands left, so ONLY the strategy's own allocation can stop this.
const second = await runStrategy(await row(), new Date(Date.now() + 86_400_000));
must(
  'a second run that would exceed the allocation is blocked',
  second.status === 'blocked' && second.reason === 'strategy_daily_allocation',
  second.status === 'blocked' ? second.detail : JSON.stringify(second),
);

const after = await readPolicy(wallet.address as Address);
must(
  'the account cap was NOT what stopped it',
  (after?.remainingTodayUsd ?? 0) > PER_RUN,
  `$${after?.remainingTodayUsd} still available account-wide`,
);

const runs = await query<{ status: string; usd: string | null }>(
  `SELECT status, usd FROM strategy_runs WHERE strategy_id=$1 ORDER BY started_at`, [id],
);
must('the filled run recorded what it cost', runs.some((r) => r.status === 'filled' && Number(r.usd) === PER_RUN),
  runs.map((r) => `${r.status}:${r.usd}`).join(' '));

// Raising the allocation must let it through: the rule is the number, not a permanent lockout.
await query(`UPDATE strategies SET daily_allocation_usd = $2 WHERE id = $1`, [id, ALLOCATION * 10]);
const third = await runStrategy(await row(), new Date(Date.now() + 2 * 86_400_000));
must('raising the allocation lets the next run through', third.status === 'filled', JSON.stringify(third));

await query(`DELETE FROM strategies WHERE id=$1`, [id]);
console.log('');
process.exit(process.exitCode ?? 0);
