/**
 * Alerts, proved against real conditions.
 *
 * Creates alerts that MUST fire and alerts that MUST NOT, using the live BTC price and the live
 * on-chain policy as the conditions, then asserts the hysteresis: fires once, stays quiet while
 * the condition holds, re-arms when it clears.
 *
 * Run: npx tsx server/src/alerts/prove.ts
 */
import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { one, query } from '../db/index.js';
import { evaluateAlerts } from './evaluate.js';
import { priceOf } from '../market/prices.js';
import { readPolicy } from '../evm/delegation.js';
import type { Address } from 'viem';

function must(label: string, cond: boolean, detail = '') {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${detail ? `  — ${detail}` : ''}`);
  if (!cond) process.exitCode = 1;
}

const ids: string[] = [];

async function makeAlert(
  walletId: string,
  kind: string,
  symbol: string | null,
  name: string,
  config: Record<string, unknown>,
): Promise<string> {
  const id = randomUUID();
  ids.push(id);
  await query(
    `INSERT INTO alerts (id, wallet_id, kind, symbol, name, detail, config)
     VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    [id, walletId, kind, symbol, name, 'created by prove.ts', JSON.stringify(config)],
  );
  return id;
}

const outcomeFor = (all: { id: string; action: string; detail: string }[], id: string) =>
  all.find((o) => o.id === id);

async function main() {
  const wallet = await one<{ id: string; address: string }>(
    `SELECT id, address FROM wallets WHERE address = $1`,
    [process.argv[2] ?? '0x95A0b368588713011a15f4b1041423f31B08e615'],
  );
  if (!wallet) throw new Error('no such wallet');

  const btc = await priceOf('BTC', 10_000);
  const policy = await readPolicy(wallet.address as Address);
  console.log(`\nBTC ${btc.toFixed(2)}, cap remaining ${policy?.remainingTodayUsd ?? 'n/a'}\n`);

  // The levels are derived from the LIVE price, so "must fire" and "must not fire" are facts about
  // the real world at this instant rather than numbers that happen to work today.
  const willFire = await makeAlert(wallet.id, 'price', 'BTC', 'BTC above a level it is already past', {
    above: Math.floor(btc * 0.9),
  });
  const willNot = await makeAlert(wallet.id, 'price', 'BTC', 'BTC above a level far above it', {
    above: Math.ceil(btc * 2),
  });
  const belowFires = await makeAlert(wallet.id, 'price', 'BTC', 'BTC below a level far above it', {
    below: Math.ceil(btc * 2),
  });
  const capAlert = await makeAlert(wallet.id, 'risk', null, 'Daily cap nearly gone', {
    capRemainingUsd: (policy?.dailyCapUsd ?? 1000) * 10,
  });
  const expiryQuiet = await makeAlert(wallet.id, 'risk', null, 'Permission expiring within an hour', {
    expiresWithinHours: 1,
  });
  const broken = await makeAlert(wallet.id, 'price', 'BTC', 'Misconfigured, no level at all', {});

  // ── First sweep ──
  const first = await evaluateAlerts();
  must('an alert whose condition is true fires', outcomeFor(first, willFire)?.action === 'fired',
    outcomeFor(first, willFire)?.detail);
  must('an alert whose condition is false stays quiet', outcomeFor(first, willNot)?.action === 'quiet');
  must('a "below" alert fires on its own edge', outcomeFor(first, belowFires)?.action === 'fired',
    outcomeFor(first, belowFires)?.detail);
  must('a risk alert reads the cap from the contract', outcomeFor(first, capAlert)?.action === 'fired',
    outcomeFor(first, capAlert)?.detail);
  must('an expiry alert is quiet while the permission is healthy',
    outcomeFor(first, expiryQuiet)?.action === 'quiet', outcomeFor(first, expiryQuiet)?.detail);
  must('a misconfigured alert is reported, not thrown',
    outcomeFor(first, broken)?.action === 'unevaluable', outcomeFor(first, broken)?.detail);
  /*
 * All six of THIS test's alerts got an outcome — not "the sweep returned six results".
 *
 * The sweep is global by design: it evaluates every enabled alert for every wallet. Asserting a
 * total made the test depend on whatever else happens to be in the database, and it started
 * failing the moment the seed script added four more. What is actually being checked is that one
 * unevaluable alert does not abort the others, and that is a statement about these six.
 */
must(
  'one broken alert does not stop the sweep',
  ids.every((id) => outcomeFor(first, id) !== undefined),
  `${ids.filter((id) => outcomeFor(first, id) === undefined).length} of ${ids.length} were skipped`,
);

  // ── Second sweep: the whole point. Nothing changed, so nothing should fire again. ──
  const second = await evaluateAlerts();
  must('a fired alert does not fire again while the condition holds',
    outcomeFor(second, willFire)?.action === 'quiet', outcomeFor(second, willFire)?.detail);

  const fireCount = await one<{ fire_count: number }>(
    `SELECT fire_count FROM alerts WHERE id = $1`, [willFire],
  );
  must('it fired exactly once', fireCount?.fire_count === 1, `fire_count = ${fireCount?.fire_count}`);

  // ── The condition clears: it must re-arm, then be able to fire again. ──
  await query(`UPDATE alerts SET config = $2 WHERE id = $1`, [
    willFire, JSON.stringify({ above: Math.ceil(btc * 2) }),
  ]);
  const third = await evaluateAlerts();
  must('it re-arms when the condition clears', outcomeFor(third, willFire)?.action === 'rearmed');

  await query(`UPDATE alerts SET config = $2 WHERE id = $1`, [
    willFire, JSON.stringify({ above: Math.floor(btc * 0.9) }),
  ]);
  const fourth = await evaluateAlerts();
  must('a second crossing fires again', outcomeFor(fourth, willFire)?.action === 'fired');
  const finalCount = await one<{ fire_count: number }>(
    `SELECT fire_count FROM alerts WHERE id = $1`, [willFire],
  );
  must('two crossings, two notifications', finalCount?.fire_count === 2, `fire_count = ${finalCount?.fire_count}`);

  // ── A disabled alert is not evaluated at all. ──
  await query(`UPDATE alerts SET enabled = false WHERE id = $1`, [belowFires]);
  const fifth = await evaluateAlerts();
  must('a disabled alert is skipped entirely', outcomeFor(fifth, belowFires) === undefined);

  // ── Every firing left an audit entry. ──
  const trail = await query<{ action: string; detail: string }>(
    `SELECT action, detail FROM audit_log WHERE payload->>'alertId' = ANY($1) ORDER BY seq DESC`,
    [ids],
  );
  must('every firing is in the audit trail', trail.length >= 4, `${trail.length} entries`);

  await query(`DELETE FROM alerts WHERE id = ANY($1)`, [ids]);
  console.log(`\n  ${trail.length} audit entries written, ${ids.length} test alerts removed.\n`);
}

await main();
process.exit(process.exitCode ?? 0);
