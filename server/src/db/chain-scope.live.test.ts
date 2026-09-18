/**
 * LIVE — one database, more than one chain's book (PLAN.md 2.6).
 *
 * Against a real Postgres with migration 015 applied: the pool's session carries the chain, a row
 * written without one takes it, the same wallet can hold the same symbol on two chains, and the book
 * this process reads and writes is its own chain's alone.
 *
 * Run: LIVE=1 npx vitest run chain-scope.live   (DATABASE_URL and XORR_CHAIN from the environment)
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { one, pool, query, tx } from './index.js';
import { CHAIN_KEY } from '../evm/chains.js';
import { applyFill, listPositions, realisedPnl } from '../positions/index.js';

const walletId = randomUUID();
const OTHER = 'chain-scope-probe';
// No price feed, so nothing in this file reaches the network.
const SYMBOL = 'CHAINPROBE';
const address = `0x${(randomUUID() + randomUUID()).replace(/-/g, '').slice(0, 40)}`;

beforeAll(async () => {
  await query(`INSERT INTO wallets (id, user_id, address, kind, cluster) VALUES ($1, $2, $3, 'connected', $4)`, [
    walletId,
    `did:privy:chain-scope-${walletId}`,
    address,
    CHAIN_KEY,
  ]);
});

afterAll(async () => {
  // Cascades to the probe's positions, strategies and runs.
  await query(`DELETE FROM wallets WHERE id = $1`, [walletId]);
  await pool.end();
});

describe('a session', () => {
  it('carries the chain this process serves', async () => {
    expect((await one<{ v: string }>(`SELECT current_setting('xorr.chain_key') AS v`))?.v).toBe(CHAIN_KEY);
  });

  it('a strategy and its run written without a chain take this one', async () => {
    const s = await one<{ id: string; chain: string }>(
      `INSERT INTO strategies (id, wallet_id, kind, state, label, symbol)
       VALUES ($1, $2, 'dca', 'paused', 'chain scope probe', $3) RETURNING id, chain`,
      [randomUUID(), walletId, SYMBOL],
    );
    expect(s?.chain).toBe(CHAIN_KEY);
    const r = await one<{ chain: string }>(
      `INSERT INTO strategy_runs (id, strategy_id, period_key, status) VALUES ($1, $2, $3, 'skipped') RETURNING chain`,
      [randomUUID(), s!.id, `chain-scope-${randomUUID()}`],
    );
    expect(r?.chain).toBe(CHAIN_KEY);
  });
});

describe('the book', () => {
  it('holds the same symbol on two chains, and this process lists and fills only its own', async () => {
    // Another chain's position on the same wallet, symbol and side — including profit it has taken.
    await query(
      `INSERT INTO positions (id, wallet_id, chain, symbol, side, units, cost_usd, realised_usd, units_sold, proceeds_usd)
       VALUES ($1, $2, $3, $4, 'long', 5, 50, 99, 3, 129)`,
      [randomUUID(), walletId, OTHER, SYMBOL],
    );
    await tx((c) => applyFill(c, { walletId, symbol: SYMBOL, units: 1, usd: 10 }));
    await tx((c) => applyFill(c, { walletId, symbol: SYMBOL, units: 1, usd: 10 }));

    const book = await listPositions({ id: walletId, address });
    expect(book).toHaveLength(1);
    expect(book[0]).toMatchObject({ symbol: SYMBOL, units: 2, feed: 'unavailable' });

    const rows = await query<{ chain: string; units: string }>(`SELECT chain, units FROM positions WHERE wallet_id = $1`, [
      walletId,
    ]);
    expect(Number(rows.find((r) => r.chain === CHAIN_KEY)?.units)).toBe(2);
    expect(Number(rows.find((r) => r.chain === OTHER)?.units)).toBe(5);
  });

  it("a sale books against this chain's position and leaves the other chain's alone", async () => {
    await tx((c) => applyFill(c, { walletId, symbol: SYMBOL, units: -1, usd: 12 }));

    const rows = await query<{ chain: string; units: string; realised_usd: string }>(
      `SELECT chain, units, realised_usd FROM positions WHERE wallet_id = $1`,
      [walletId],
    );
    expect(Number(rows.find((r) => r.chain === CHAIN_KEY)?.units)).toBe(1);
    expect(Number(rows.find((r) => r.chain === OTHER)?.units)).toBe(5);
    expect(Number(rows.find((r) => r.chain === OTHER)?.realised_usd)).toBe(99);

    // Sold 1 at $12 against an average cost of $10: $2 made here. The other chain's $99 is not this book's.
    const pnl = await realisedPnl(walletId);
    expect(pnl.total).toBeCloseTo(2, 6);
  });
});
