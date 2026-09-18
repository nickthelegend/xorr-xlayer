/**
 * From an empty database to something worth looking at, in one command.
 *
 * The README tells a judge to run three commands and then look at the app. What they actually see
 * at that point is every empty state in the product, which is an honest picture of a fresh install
 * and a poor picture of what was built. Clicking through onboarding, granting a permission,
 * creating four strategies and waiting for a scheduler tick is ten minutes nobody spends.
 *
 * Everything this creates is REAL: real rows, real on-chain fills through the real delegation, a
 * real audit chain. It is a shortcut through the clicking, not a shortcut through the system —
 * nothing here writes a number the executor would not have written itself.
 *
 * Run: npx tsx server/src/seed.ts <ownerAddress>
 */
import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import type { Address } from 'viem';
import { one, query } from './db/index.js';
import { runStrategy, type StrategyRow } from './executor/run.js';
import { readPolicy } from './evm/delegation.js';
import { priceOf } from './market/prices.js';
import { cashUsd } from './evm/balances.js';
import { evaluateAlerts } from './alerts/evaluate.js';

const owner = (process.argv[2] ?? process.env.SEED_OWNER) as Address | undefined;
if (!owner) {
  console.error('usage: npx tsx server/src/seed.ts <ownerAddress>');
  process.exit(1);
}

const step = (s: string) => console.log(`\n${s}`);
const done = (s: string) => console.log(`  ${s}`);

const wallet = await one<{ id: string }>(`SELECT id FROM wallets WHERE lower(address)=lower($1)`, [
  owner,
]);
if (!wallet) {
  console.error(
    `No wallet row for ${owner}. Sign in through the app once first — this script seeds a wallet's\n` +
      `activity, it does not create the identity, because that is Privy's job and faking it would\n` +
      `make every screen below a lie.`,
  );
  process.exit(1);
}

step('Checking the permission on chain');
const policy = await readPolicy(owner);
if (!policy || policy.revoked) {
  console.error(
    `  No usable permission for ${owner}.\n` +
      `  On a fork:   npx tsx server/src/fork-grant.ts ${owner} 2000\n` +
      `  On a testnet: grant it from the app — nothing here can sign for the user, by design.`,
  );
  process.exit(1);
}
done(`$${policy.dailyCapUsd}/day cap, $${policy.remainingTodayUsd} left today`);

const cash = await cashUsd(owner);
done(`${cash.toFixed(2)} USDC in the wallet`);

/** Create a strategy and run it once, so the demo has real fills rather than empty schedules. */
async function seedStrategy(
  label: string,
  kind: string,
  symbol: string,
  params: Record<string, unknown>,
  allocation: number,
  run: boolean,
): Promise<void> {
  const id = randomUUID();
  await query(
    `INSERT INTO strategies (id, wallet_id, kind, state, label, symbol, params, cadence, next_run_at, daily_allocation_usd)
     VALUES ($1,$2,$3,'live',$4,$5,$6,'daily',now(),$7)`,
    [id, wallet!.id, kind, label, symbol, JSON.stringify(params), allocation],
  );
  if (!run) {
    done(`${label} — created, first run on the next tick`);
    return;
  }
  const row = (await one<StrategyRow>(`SELECT * FROM strategies WHERE id=$1`, [id]))!;
  const outcome = await runStrategy(row);
  done(`${label} — ${outcome.status}${outcome.status === 'filled' ? ` (${outcome.signature.slice(0, 12)}…)` : ''}`);
}

step('Creating strategies across the ladder');
const mark = await priceOf('WETH');
await seedStrategy('Weekly WETH buy', 'dca', 'WETH', { usd: 25 }, 25, true);
await seedStrategy(
  'Idle cash to Aave',
  'yield-rotation',
  'USDC',
  { usd: 100, keepCashUsd: Math.max(cash - 400, 0), minMoveUsd: 25 },
  100,
  true,
);
await seedStrategy(
  'WETH range',
  'grid',
  'WETH',
  { lower: Math.round(mark * 0.9), upper: Math.round(mark * 1.1), steps: 4, usdPerStep: 40 },
  160,
  true,
);
await seedStrategy(
  'Trailing stop on WETH',
  'exit-rules',
  'WETH',
  { entryPrice: mark, trailPct: 12 },
  0,
  false,
);

step('Creating alerts');
/*
 * One of these is already true, deliberately.
 *
 * An alert list where nothing has ever fired shows only half the feature — and the half it hides
 * is the one that matters. The level is derived from the live price rather than picked, so it is a
 * real threshold a real person might set, and it firing immediately is the correct behaviour for
 * an alert set below the market rather than a staged event.
 */
const btc = await priceOf('BTC').catch(() => 0);
for (const a of [
  ...(btc > 0
    ? [{
        kind: 'price',
        symbol: 'BTC',
        name: `BTC above $${Math.round(btc * 0.95).toLocaleString('en-US')}`,
        detail: 'Set below the market, so it goes off at once',
        config: { above: Math.round(btc * 0.95) },
      }]
    : []),
  { kind: 'price', symbol: 'BTC', name: 'BTC above $200k', detail: 'A level it has not seen', config: { above: 200_000 } },
  { kind: 'risk', symbol: null, name: 'Permission expiring', detail: 'A day before it lapses', config: { expiresWithinHours: 24 } },
  { kind: 'risk', symbol: null, name: 'Daily cap nearly gone', detail: 'So you can raise it or stop', config: { capRemainingUsd: 50 } },
]) {
  await query(
    `INSERT INTO alerts (id, wallet_id, kind, symbol, name, detail, config) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    [randomUUID(), wallet.id, a.kind, a.symbol, a.name, a.detail, JSON.stringify(a.config)],
  );
  done(a.name);
}

step('Evaluating alerts once, so the ones that are already true have fired');
const outcomes = await evaluateAlerts();
for (const o of outcomes.filter((x) => x.action === 'fired')) done(`fired: ${o.name} — ${o.detail}`);

const counts = await one<{ strategies: string; runs: string; audit: string }>(
  `SELECT
     (SELECT count(*) FROM strategies WHERE wallet_id=$1 AND state='live') AS strategies,
     (SELECT count(*) FROM strategy_runs r JOIN strategies s ON s.id=r.strategy_id WHERE s.wallet_id=$1) AS runs,
     (SELECT count(*) FROM audit_log WHERE wallet_id=$1) AS audit`,
  [wallet.id],
);
console.log(
  `\nSeeded: ${counts?.strategies} live strategies, ${counts?.runs} runs, ${counts?.audit} audit entries.\n` +
    `Open the app. Everything on screen came from the executor, not from this script.\n`,
);
process.exit(0);
