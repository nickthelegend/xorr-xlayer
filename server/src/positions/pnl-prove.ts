/**
 * Average-cost accounting, proved with the case that was wrong.
 *
 * Buy 1 unit at $2,000, sell half at $3,000. The remaining half must still carry a $2,000 entry,
 * and $500 must be recorded as realised. Before this, the entry read $1,000 and the $500 was
 * recorded nowhere — so the position looked twice as profitable as it was and the profit that had
 * genuinely been taken had vanished.
 *
 * Run: npx tsx server/src/positions/pnl-prove.ts
 */
import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { one, query, tx } from '../db/index.js';
import { applyFill, realisedPnl } from './index.js';

function must(label: string, cond: boolean, detail = '') {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${detail ? `  — ${detail}` : ''}`);
  if (!cond) process.exitCode = 1;
}

const wallet = (await one<{ id: string }>(`SELECT id FROM wallets LIMIT 1`))!;
const SYMBOL = `TEST${randomUUID().slice(0, 6).toUpperCase()}`;

const book = async () =>
  (await one<{ units: string; cost_usd: string; realised_usd: string; units_sold: string }>(
    `SELECT units, cost_usd, realised_usd, units_sold FROM positions WHERE wallet_id=$1 AND symbol=$2`,
    [wallet.id, SYMBOL],
  ))!;

console.log(`\nsymbol ${SYMBOL}\n`);

await tx((c) => applyFill(c, { walletId: wallet.id, symbol: SYMBOL, units: 1, usd: 2_000 }));
let b = await book();
must('a buy sets units and cost', Number(b.units) === 1 && Number(b.cost_usd) === 2_000,
  `${b.units} units at $${b.cost_usd}`);

await tx((c) => applyFill(c, { walletId: wallet.id, symbol: SYMBOL, units: -0.5, usd: 1_500 }));
b = await book();
const entry = Number(b.cost_usd) / Number(b.units);
must('half the units remain', Number(b.units) === 0.5, `${b.units}`);
must('the remaining half still carries its real cost', Number(b.cost_usd) === 1_000, `$${b.cost_usd}`);
must('so the entry price is unchanged by the sale', entry === 2_000, `$${entry.toFixed(2)} a unit`);
must('and the profit taken is recorded', Number(b.realised_usd) === 500, `$${b.realised_usd}`);
must('units sold are tracked', Number(b.units_sold) === 0.5, `${b.units_sold}`);

// A loss must be recorded as a loss, not clamped.
await tx((c) => applyFill(c, { walletId: wallet.id, symbol: SYMBOL, units: -0.25, usd: 250 }));
b = await book();
must('a sale below cost books a negative realised', Number(b.realised_usd) === 250,
  `$500 gain then $250 loss = $${b.realised_usd}`);

// Selling the rest must empty it without going negative.
await tx((c) => applyFill(c, { walletId: wallet.id, symbol: SYMBOL, units: -5, usd: 500 }));
b = await book();
must('overselling cannot drive the book negative', Number(b.units) === 0 && Number(b.cost_usd) === 0,
  `${b.units} units, $${b.cost_usd} cost`);

/*
 * A sale with no cost basis at all — the case that produced a fabricated $165 of "profit".
 *
 * A book that has never seen the symbol, or one already emptied, has nothing to compute a gain
 * against. Recording the proceeds as pure profit is the wrong answer and it is the one that looks
 * best, which is exactly why it needs a test.
 */
const ORPHAN = `ORPH${randomUUID().slice(0, 6).toUpperCase()}`;
await tx((c) => applyFill(c, { walletId: wallet.id, symbol: ORPHAN, units: -2, usd: 900 }));
await tx((c) => applyFill(c, { walletId: wallet.id, symbol: ORPHAN, units: -1, usd: 400 }));
const orphan = (await one<{ realised_usd: string; proceeds_usd: string; unbased_units: string }>(
  `SELECT realised_usd, proceeds_usd, unbased_units FROM positions WHERE wallet_id=$1 AND symbol=$2`,
  [wallet.id, ORPHAN],
))!;
must('selling with no cost basis claims no profit', Number(orphan.realised_usd) === 0,
  `realised $${orphan.realised_usd}`);
must('but the proceeds are still recorded as fact', Number(orphan.proceeds_usd) === 1_300,
  `$${orphan.proceeds_usd} received`);
must('and the missing basis is flagged', Number(orphan.unbased_units) === 3, `${orphan.unbased_units} units`);

const pnl = await realisedPnl(wallet.id);
const orphanRow = pnl.bySymbol.find((r) => r.symbol === ORPHAN);
must('the report says the figure is incomplete', orphanRow?.basisIncomplete === true);

await query(`DELETE FROM positions WHERE wallet_id=$1 AND symbol=$2`, [wallet.id, ORPHAN]);
const mine = pnl.bySymbol.find((r) => r.symbol === SYMBOL);
must('a fully closed position still reports what it made', !!mine, `realised $${mine?.realised}`);

await query(`DELETE FROM positions WHERE wallet_id=$1 AND symbol=$2`, [wallet.id, SYMBOL]);
console.log('');
process.exit(process.exitCode ?? 0);
