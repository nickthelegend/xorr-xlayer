/**
 * The grid through the real executor: reading, buy on a fall, sell on a rise.
 *
 * The price cannot be moved on a live feed, so the LADDER is moved instead — which is the same
 * crossing seen from the other side, and leaves every other part of the path real: the planner,
 * the gates, the on-chain fill, the state written in the fill's own transaction.
 *
 * Run: npx tsx server/src/executor/grid-e2e.ts
 */
import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { one, query } from '../db/index.js';
import { runStrategy, type StrategyRow } from './run.js';
import { priceOf } from '../market/prices.js';

function must(label: string, cond: boolean, detail = '') {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${detail ? `  — ${detail}` : ''}`);
  if (!cond) process.exitCode = 1;
}

const wallet = (await one<{ id: string }>(
  `SELECT id FROM wallets WHERE address = $1`,
  [process.argv[2] ?? '0x95A0b368588713011a15f4b1041423f31B08e615'],
))!;

const mark = await priceOf('WETH');
const gap = 150;
const id = randomUUID();

// A ladder placed so the price sits squarely on rung 2 of four.
const lower = Math.round(mark - 2 * gap);
const upper = lower + 4 * gap;
console.log(`\nWETH ${mark.toFixed(2)} — ladder ${lower} to ${upper}, ${gap} a rung\n`);

await query(
  `INSERT INTO strategies (id, wallet_id, kind, state, label, symbol, params, cadence, next_run_at, daily_allocation_usd)
   VALUES ($1,$2,'grid','live','grid e2e','WETH',$3,'daily',now(),160)`,
  [id, wallet.id, JSON.stringify({ lower, upper, steps: 4, usdPerStep: 40 })],
);

const row = async () => (await one<StrategyRow>(`SELECT * FROM strategies WHERE id=$1`, [id]))!;
const params = async () =>
  (await one<{ params: Record<string, unknown> }>(`SELECT params FROM strategies WHERE id=$1`, [id]))!
    .params;
/** Shift the whole ladder, which moves the price's rung without moving the market. */
const shift = async (by: number) => {
  const p = await params();
  await query(`UPDATE strategies SET params = params || $2::jsonb WHERE id = $1`, [
    id,
    JSON.stringify({ lower: Number(p.lower) + by, upper: Number(p.upper) + by }),
  ]);
};

/**
 * Each run claims a different period.
 *
 * The period claim is what stops a strategy running twice in one day, so a test that wants four
 * consecutive runs has to advance the clock it passes in — otherwise every run after the first is
 * correctly refused as a repeat, which proves the idempotence and nothing about the grid.
 */
let day = 1;
const run = async () => runStrategy(await row(), new Date(Date.now() + day++ * 86_400_000));

const first = await runStrategy(await row(), new Date());
must('the first run takes a reading and places nothing', first.status === 'skipped', JSON.stringify(first));
must('and it records the rung the price is on', (await params()).lastLevel === 2,
  `lastLevel ${(await params()).lastLevel}`);

// ── Price falls a rung (ladder up) ──
await shift(gap);
const buy = await run();
must('crossing a rung downward buys', buy.status === 'filled', JSON.stringify(buy));
let p = await params();
must('the lot is remembered', Array.isArray(p.openLots) && (p.openLots as number[]).length === 1,
  JSON.stringify(p.openLots));
must('and the rung marker moved', p.lastLevel === 1, `lastLevel ${p.lastLevel}`);

// ── Price sits still: must not buy the same rung again ──
const again = await run();
must('it does not buy the same rung twice', again.status === 'skipped', JSON.stringify(again));

// ── Price rises back a rung (ladder down) ──
await shift(-gap);
const sell = await run();
must('crossing back upward sells', sell.status === 'filled', JSON.stringify(sell));
p = await params();
must('the lot is released', (p.openLots as number[]).length === 0, JSON.stringify(p.openLots));

// ── Price leaves the range entirely ──
await shift(gap * 20);
const gone = await run();
must('outside the range it stops rather than chasing', gone.status === 'skipped', JSON.stringify(gone));

const trail = await query<{ action: string; detail: string }>(
  `SELECT action, detail FROM audit_log WHERE payload->>'strategyId' = $1 ORDER BY seq ASC`,
  [id],
);
console.log('\n  audit trail:');
for (const t of trail) console.log(`    ${t.action} — ${t.detail.slice(0, 80)}`);

await query(`DELETE FROM strategies WHERE id=$1`, [id]);
console.log('');
process.exit(process.exitCode ?? 0);
