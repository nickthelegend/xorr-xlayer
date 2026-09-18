import pg from 'pg';
import 'dotenv/config';
import { CHAIN_KEY } from '../evm/chains.js';

const { Pool } = pg;

export const DATABASE_URL =
  process.env.DATABASE_URL ?? `postgres://${process.env.USER ?? 'postgres'}@localhost:5432/xorr`;

/*
 * Every connection says which chain it serves (PLAN.md 2.6).
 *
 * `positions`, `strategies` and `strategy_runs` carry a `chain` column that defaults to this session
 * setting, and their wallet-wide and global reads filter on it (`THIS_CHAIN`). Set in each
 * connection's startup packet, so nothing has to remember to pass it — the scripts that share this
 * pool included — and a row cannot be written without its chain or read across one.
 */
if (!/^[a-z0-9-]+$/.test(CHAIN_KEY)) {
  throw new Error(`XORR_CHAIN must be a plain chain key such as base-sepolia, not "${CHAIN_KEY}".`);
}

export const pool = new Pool({
  connectionString: DATABASE_URL,
  max: 10,
  options: `-c xorr.chain_key=${CHAIN_KEY}`,
});

export async function query<T extends pg.QueryResultRow = pg.QueryResultRow>(
  text: string,
  params: unknown[] = [],
): Promise<T[]> {
  const res = await pool.query<T>(text, params);
  return res.rows;
}

export async function one<T extends pg.QueryResultRow = pg.QueryResultRow>(
  text: string,
  params: unknown[] = [],
): Promise<T | undefined> {
  const rows = await query<T>(text, params);
  return rows[0];
}

/** Run a set of statements in a single transaction. Used by every money-moving path. */
export async function tx<T>(fn: (c: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const out = await fn(client);
    await client.query('COMMIT');
    return out;
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}
