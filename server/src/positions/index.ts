/**
 * Positions — PLAN.md 12.7.
 *
 * The handoff's screen 22 was entirely hardcoded (entry $63,880, mark $66,560, liquidation
 * $58,110). Nothing in the system produced a position, so there was nothing real for it to show.
 *
 * A spot position here is an average-cost lot: every fill adds units and moves the average cost.
 * Mark, unrealised P&L and percentage are computed against the LIVE price at read time, so the
 * screen shows what the book is actually worth rather than what a designer typed.
 */
import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { one, query } from '../db/index.js';
import { THIS_CHAIN } from '../db/chain-scope.js';
import { recordSleeve, type FillAttribution } from './sleeves.js';
import { priceOf } from '../market/prices.js';
import { chainUnitsOf } from '../evm/balances.js';
import { readChain } from '../http/chain-read.js';
import type { Address } from 'viem';

export type PositionRow = {
  id: string;
  symbol: string;
  side: 'long' | 'short';
  leverage: string;
  units: string;
  cost_usd: string;
  realised_usd: string;
  units_sold: string;
  proceeds_usd: string;
  unbased_units: string;
  opened_at: Date;
};

export type Position = {
  id: string;
  symbol: string;
  side: 'long' | 'short';
  leverage: number;
  /** Average cost per unit — the "Entry" row on screen 22. */
  entry: number;
  mark: number;
  liquidation: number;
  notional: number;
  margin: number;
  unrealised: number;
  unrealisedPct: number;
  units: number;
  fundingPaid: number;
  feed: 'live' | 'unavailable';
  /**
   * Profit already taken on this symbol, at average cost. Distinct from `unrealised`, which is
   * what the remaining units are worth on paper — one is money, the other is an opinion.
   */
  realised: number;
  unitsSold: number;
  /** What the executor's ledger records, before the chain check. */
  ledgerUnits: number;
  /** What the wallet holds on this chain, or `null` where the token cannot be asked about here. */
  chainUnits: number | null;
  /** `ledgerUnits − chainUnits`: positive when the ledger records more than the wallet holds. */
  driftUnits: number | null;
};

/**
 * Record a fill against the position book. Always called inside the fill's own transaction.
 *
 * A buy and a sell are not the same operation with a different sign, and treating them as one was
 * wrong in a way that only showed up after a profitable partial sale:
 *
 *   buy  1 WETH @ $2,000  ->  units 1,   cost $2,000,  entry $2,000
 *   sell 0.5   @ $3,000   ->  units 0.5, cost $500,    entry $1,000   <- wrong
 *
 * Subtracting the PROCEEDS left the remaining half carrying half the cost it actually has, so
 * every unrealised-gain figure after it was inflated — and the $500 of profit that was genuinely
 * taken was recorded nowhere.
 *
 * Selling therefore removes units at AVERAGE COST and books the difference as realised. That is
 * ordinary average-cost accounting, and it is what makes "entry" mean the same thing before and
 * after a sale.
 */
export async function applyFill(
  client: PoolClient,
  params: {
    walletId: string;
    symbol: string;
    units: number;
    usd: number;
    /**
     * Who did this, when the caller knows.
     *
     * Optional because not every caller has an answer, and a caller with no answer must not be
     * made to invent one — an unattributed fill shows up in the breakdown as exactly that. See
     * `positions/sleeves.ts`.
     */
    attribution?: FillAttribution;
  },
): Promise<void> {
  // Written inside the caller's transaction: a position and its attribution are one fact.
  if (params.attribution) {
    await recordSleeve(client, {
      walletId: params.walletId,
      symbol: params.symbol,
      units: params.units,
      usd: params.usd,
      attribution: params.attribution,
    });
  }
  if (params.units >= 0) {
    await client.query(
      `INSERT INTO positions (id, wallet_id, symbol, side, units, cost_usd)
       VALUES ($1,$2,$3,'long',$4,$5)
       ON CONFLICT (wallet_id, chain, symbol, side) DO UPDATE
         SET units = positions.units + EXCLUDED.units,
             cost_usd = positions.cost_usd + EXCLUDED.cost_usd,
             updated_at = now()`,
      [randomUUID(), params.walletId, params.symbol, params.units, params.usd],
    );
    return;
  }

  /*
   * A sale. Lock the row first: two fills for the same symbol landing together would otherwise
   * each read the same average cost and both book the same realised gain.
   */
  const { rows } = await client.query<{ units: string; cost_usd: string }>(
    `SELECT units, cost_usd FROM positions
      WHERE wallet_id = $1 AND symbol = $2 AND side = 'long' AND chain = ${THIS_CHAIN} FOR UPDATE`,
    [params.walletId, params.symbol],
  );
  const existing = rows[0];
  if (!existing) {
    /*
     * Selling something the book has never seen.
     *
     * It happens legitimately — a wallet funded outside the app, or a position opened before this
     * table existed — and there is no cost basis to work from, so the whole proceeds are recorded
     * as realised rather than invented as a gain against a made-up entry.
     */
    await client.query(
      `INSERT INTO positions (id, wallet_id, symbol, side, units, cost_usd, realised_usd, units_sold, proceeds_usd, unbased_units)
       VALUES ($1,$2,$3,'long',0,0,0,$4,$5,$4)
       ON CONFLICT (wallet_id, chain, symbol, side) DO NOTHING`,
      [randomUUID(), params.walletId, params.symbol, Math.abs(params.units), Math.abs(params.usd)],
    );
    // A disposal with no cost basis is still a disposal, and the report has to show it — flagged,
    // so nobody mistakes an unknown cost for a zero one.
    await client.query(
      `INSERT INTO disposals (id, wallet_id, symbol, units, proceeds_usd, cost_usd, realised_usd, basis_known)
       VALUES ($1,$2,$3,$4,$5,0,0,false)`,
      [randomUUID(), params.walletId, params.symbol, Math.abs(params.units), Math.abs(params.usd)],
    );
    return;
  }

  /*
   * Clamp at zero before doing any arithmetic.
   *
   * Rows written by the old accounting can hold NEGATIVE units — it subtracted proceeds from cost
   * and units without a floor — and `Math.min(soldUnits, heldUnits)` against a negative held
   * count returns the negative, which then went into `units_sold` and made the whole symbol
   * disappear from the realised report. Bad historical data must not be able to produce bad new
   * data.
   */
  const heldUnits = Math.max(Number(existing.units), 0);
  const heldCost = Math.max(Number(existing.cost_usd), 0);
  const soldUnits = Math.min(Math.abs(params.units), heldUnits);
  const proceeds = Math.abs(params.usd);

  /*
   * No cost basis means no gain can be computed — and saying so beats guessing.
   *
   * It happens for real: a wallet funded outside the app, a position that predates this table, or
   * a book already emptied by the old accounting. The tempting shortcut is `realised = proceeds`,
   * which reports the entire sale as profit. On a trading app that is not a rounding error, it is
   * the single most misleading number the screen could show. So the proceeds and the units are
   * recorded — both are facts — and the realised figure is left alone.
   */
  const hasBasis = heldUnits > 0 && heldCost > 0;
  const avgCost = hasBasis ? heldCost / heldUnits : 0;
  const costOut = soldUnits * avgCost;
  const realised = hasBasis ? proceeds - costOut : 0;
  // What was really sold, even when the book had no record of holding it.
  const soldForRecord = hasBasis ? soldUnits : Math.abs(params.units);

  /*
   * Record the disposal itself, not just its effect on the totals.
   *
   * The running totals answer "how am I doing". They cannot answer the question an accountant
   * asks, which is per-disposal: what was sold, when, for how much, against what cost. Those four
   * numbers exist right here and were being added into a sum and discarded.
   */
  await client.query(
    `INSERT INTO disposals (id, wallet_id, symbol, units, proceeds_usd, cost_usd, realised_usd, basis_known)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [
      randomUUID(),
      params.walletId,
      params.symbol,
      soldForRecord,
      proceeds,
      costOut,
      realised,
      hasBasis,
    ],
  );

  await client.query(
    `UPDATE positions
        SET units = GREATEST(units - $3, 0),
            cost_usd = GREATEST(cost_usd - $4, 0),
            realised_usd = realised_usd + $5,
            units_sold = units_sold + $7,
            proceeds_usd = proceeds_usd + $6,
            unbased_units = unbased_units + $8,
            updated_at = now()
      WHERE wallet_id = $1 AND symbol = $2 AND side = 'long' AND chain = ${THIS_CHAIN}`,
    [
      params.walletId,
      params.symbol,
      soldUnits,
      costOut,
      realised,
      proceeds,
      soldForRecord,
      hasBasis ? 0 : Math.abs(params.units),
    ],
  );
}

/**
 * Read the book, valued at the live mark and held to what the wallet actually has.
 * A symbol with no feed comes back `feed: 'unavailable'` rather than with a guessed mark.
 *
 * The ledger is what the executor recorded; the chain is what the wallet holds (PLAN.md 2.7). They part
 * ways — a fork rebuilt under the book, a token sent out of the wallet directly — and the Portfolio
 * listed the ledger's WETH beside a balance with none in it. Units are capped at the chain balance, the
 * cost basis scaled with them so the entry price is unchanged, and the difference is returned as
 * `driftUnits` for the screen to show. A token this chain cannot be asked about is listed as recorded
 * with `chainUnits: null`; a balance read that fails is a 502, never an empty or unchecked book.
 */
export async function listPositions(wallet: { id: string; address: string }): Promise<Position[]> {
  const rows = await query<PositionRow>(
    /*
     * Dust is not a holding.
     *
     * `units > 0` let a position that had been sold down to a few wei survive as a row, and the
     * Assets screen listed it as "WETH · 0.0000 · avg $0.00 · $0.00" — a holding of nothing,
     * priced at nothing, next to real ones. The threshold is in the token's own units and
     * deliberately tiny: anything at or below a millionth of a unit cannot be worth a row.
     */
    `SELECT * FROM positions WHERE wallet_id=$1 AND chain = ${THIS_CHAIN} AND units > 0.000001 ORDER BY updated_at DESC`,
    [wallet.id],
  );

  const symbols = rows.map((r) => r.symbol);
  const [marks, held] = await Promise.all([
    marksFor(symbols),
    readChain('your holdings', () => chainUnitsOf(wallet.address as Address, symbols)),
  ]);
  return rows.map((r) => toPosition(r, marks.get(r.symbol), held.get(r.symbol) ?? null));
}

/**
 * A screen's patience for a mark. A symbol whose feed misses it reads `feed: 'unavailable'` — the
 * answer a symbol with no feed already gets — instead of holding up the whole book.
 */
const MARK_DEADLINE_MS = 4_000;

/**
 * One mark per symbol, all asked at once (PLAN.md 2.3).
 *
 * The book was priced a row at a time, each lookup waiting on the one before and none with a
 * deadline, so a cold feed made the Portfolio screen wait on every holding in turn.
 */
async function marksFor(symbols: string[]): Promise<Map<string, number>> {
  const marks = new Map<string, number>();
  await Promise.all(
    [...new Set(symbols)].map(async (symbol) => {
      try {
        marks.set(symbol, await priceOf(symbol, MARK_DEADLINE_MS));
      } catch {
        // No feed, or none in time: left out, so the row says `unavailable` rather than a guess.
      }
    }),
  );
  return marks;
}

/**
 * A ledger row valued at `mark` (reported unpriced without one) and capped at `chainUnits`, what the
 * wallet holds — `null` where that could not be asked.
 */
function toPosition(r: PositionRow, mark: number | undefined, chainUnits: number | null): Position {
  const ledgerUnits = Number(r.units);
  const ledgerCost = Number(r.cost_usd);
  // A balance can confirm a long spot holding. It says nothing about a short.
  const onChain = r.side === 'long' ? chainUnits : null;
  const units = onChain === null ? ledgerUnits : Math.min(ledgerUnits, onChain);
  // Scaled with the units: the entry stays what was paid, and nothing is valued that is not held.
  const cost = ledgerUnits > 0 ? ledgerCost * (units / ledgerUnits) : 0;
  const entry = ledgerUnits > 0 ? ledgerCost / ledgerUnits : 0;
  const leverage = Number(r.leverage);
  const feed: 'live' | 'unavailable' = mark === undefined ? 'unavailable' : 'live';
  const value = units * (mark ?? 0);
  const unrealised = feed === 'live' ? value - cost : 0;
  return {
    id: r.id,
    symbol: r.symbol,
    side: r.side,
    leverage,
    entry,
    mark: mark ?? 0,
    // Spot cannot be liquidated. Reporting 0 is honest — the screen hides the row rather than
    // inventing a liquidation price for a position that has none.
    liquidation: leverage > 1 ? entry * (1 - 0.92 / leverage) : 0,
    notional: value,
    margin: leverage > 1 ? cost / leverage : cost,
    unrealised,
    unrealisedPct: cost > 0 && feed === 'live' ? (unrealised / cost) * 100 : 0,
    units,
    ledgerUnits,
    chainUnits: onChain,
    driftUnits: onChain === null ? null : Number((ledgerUnits - onChain).toFixed(9)),
    // Spot carries no funding. A perp position would accrue it; there are none yet.
    fundingPaid: 0,
    feed,
    realised: Number(r.realised_usd),
    unitsSold: Number(r.units_sold),
  };
}

/**
 * One of this wallet's positions, or null when the id is not one of them.
 *
 * It fell back to `all[0]`, so an id that was not in the book — a stale link, a closed position, a
 * mistyped route — opened the wallet's first position instead, and the screen showed WETH under a
 * tap on something else. PLAN.md 1.7.
 */
export async function getPosition(
  wallet: { id: string; address: string },
  id: string,
): Promise<Position | null> {
  // One row, priced once. It priced the whole book to keep one entry of it (PLAN.md 2.3).
  const row = await one<PositionRow>(
    `SELECT * FROM positions WHERE wallet_id=$1 AND id=$2 AND chain = ${THIS_CHAIN} AND units > 0.000001`,
    [wallet.id, id],
  );
  if (!row) return null;
  const [marks, held] = await Promise.all([
    marksFor([row.symbol]),
    readChain('your holdings', () => chainUnitsOf(wallet.address as Address, [row.symbol])),
  ]);
  return toPosition(row, marks.get(row.symbol), held.get(row.symbol) ?? null);
}

/**
 * Realised profit and loss for a wallet, across every symbol including closed ones.
 *
 * `listPositions` filters to `units > 0`, correctly — a closed position is not a holding. But
 * that also means the money actually MADE on it disappears from the app the moment it is sold,
 * which is the opposite of what a person wants to see. This reads the whole book.
 */
export async function realisedPnl(walletId: string): Promise<{
  total: number;
  bySymbol: {
    symbol: string;
    realised: number;
    unitsSold: number;
    proceeds: number;
    basisIncomplete: boolean;
  }[];
}> {
  const rows = await query<{
    symbol: string;
    realised_usd: string;
    units_sold: string;
    proceeds_usd: string;
    unbased_units: string;
  }>(
    `SELECT symbol, realised_usd, units_sold, proceeds_usd, unbased_units
       FROM positions WHERE wallet_id = $1 AND chain = ${THIS_CHAIN} AND units_sold > 0
      ORDER BY realised_usd DESC`,
    [walletId],
  );
  const bySymbol = rows.map((r) => ({
    symbol: r.symbol,
    realised: Number(r.realised_usd),
    unitsSold: Number(r.units_sold),
    proceeds: Number(r.proceeds_usd),
    /**
     * True when some of what was sold had no recorded cost, so the realised figure understates
     * the outcome. Shown rather than hidden: an incomplete number the reader knows is incomplete
     * is useful, and one they believe is complete is not.
     */
    basisIncomplete: Number(r.unbased_units) > 0,
  }));
  return { total: bySymbol.reduce((a, r) => a + r.realised, 0), bySymbol };
}
