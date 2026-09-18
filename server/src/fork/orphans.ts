/**
 * Fills this database recorded that the chain beneath it no longer has — found, and taken back out of the book.
 *
 * A fork can be rebuilt under a running executor. The node starts again from a Base block, every transaction sent to
 * the old node is gone, and the database keeps every row it wrote about them. On the Railway fork that left seven 1inch
 * fills from 2026-09-13 in `daily_spend` — $46 the contract's own tally did not have, so `/limits` published a remainder
 * that did not follow from its own spend — and 0.8026 WETH in the position book that the wallet did not hold
 * (docs/qa/ENDPOINTS.md E096).
 *
 * An orphan is a `filled` run on this chain whose transaction the node has neither mined nor pending. What it put into
 * the book is known from what recorded it, so that is exactly what comes out:
 *
 *   - a buy — a strategy's, an order's, a limit order's: its dollars off that UTC day's `daily_spend`, its units and cost
 *     off the position;
 *   - a supply: its dollars off `daily_spend`, and nothing else — a supply is not a position;
 *   - a sale — a close, a flatten, a strategy's exit: the disposals written with it are deleted, and what they record is
 *     put back — the units and cost it removed, the gain it realised, the units and proceeds it counted;
 *   - a swap: the sale of what it paid with, and the buy of what it received, from the trail row written with it.
 *
 * Some cannot come out exactly, and are listed for a person instead of guessed at: a sale that booked no cost basis (how
 * many units it removed from the book was never written down), a portfolio rebalance leg (its run does not name the token
 * it traded), a swap whose trail row is missing, a position the book spells two ways or does not hold, a run recorded
 * before fills carried a side. And when one orphan of a token cannot come out, none of that wallet's orphans of that
 * token do: taking part of a position's history out and leaving the rest leaves an average cost that no sequence of real
 * trades produced.
 *
 * A run taken out is kept, marked `failed` with the reason, so `/runs` says it did not happen on this chain and a second
 * pass finds nothing left to do. The trail is append-only and keeps what was recorded at the time; one row per wallet
 * says what was reconciled and why.
 *
 * Nothing here signs or sends. `reconcile-orphans.ts` runs it, and refuses every chain but an anvil fork of Base before
 * it does (`guard.ts`): on a real chain a transaction that cannot be found is an RPC problem, never a reason to rewrite
 * a book.
 */
import type { PoolClient } from 'pg';
import { TransactionNotFoundError, TransactionReceiptNotFoundError, type Hex } from 'viem';
import { THIS_CHAIN } from '../db/chain-scope.js';
import { append } from '../audit/log.js';

/** The part of a Postgres client this uses, so a test can stand one in. */
export type Queryable = Pick<PoolClient, 'query'>;

/** The two reads that say whether a node has a transaction. */
export type ChainReads = {
  getTransactionReceipt(args: { hash: Hex }): Promise<unknown>;
  getTransaction(args: { hash: Hex }): Promise<unknown>;
};

/** A filled run as this database recorded it, with what its strategy says about it. */
export type RecordedFill = {
  runId: string;
  walletId: string;
  /** `strategies.kind`: which recorder wrote the run, and so what it put into the book. */
  kind: string;
  /** `strategies.symbol`: the token a single-token strategy, an order or a sale traded. */
  symbol: string;
  side: string | null;
  units: number | null;
  usd: number | null;
  signature: string;
  /** The UTC day the fill was recorded on (`YYYY-MM-DD`): the `daily_spend` row its dollars went into. */
  day: string | null;
};

/** A disposal written in a sale's own transaction. */
export type DisposalRow = {
  id: string;
  runId: string;
  symbol: string;
  units: number;
  proceedsUsd: number;
  costUsd: number;
  realisedUsd: number;
  basisKnown: boolean;
};

/** What a swap received, from the trail row written in its transaction. */
export type SwapLeg = { runId: string; symbol: string; units: number; usd: number };

/** A long position row this wallet has on this chain: the only side a fill is ever recorded against. */
export type PositionRef = { id: string; walletId: string; symbol: string };

/** How one position moves as orphans come out of it. Signed: what is put back is positive. */
export type PositionDelta = {
  positionId: string;
  walletId: string;
  symbol: string;
  units: number;
  costUsd: number;
  realisedUsd: number;
  unitsSold: number;
  proceedsUsd: number;
  unbasedUnits: number;
};

export type Reconciliation = {
  reversed: RecordedFill[];
  unreversible: { fill: RecordedFill; why: string }[];
  /** Dollars to take off each wallet's `daily_spend` row for a day. */
  spend: { walletId: string; day: string; usd: number }[];
  positions: PositionDelta[];
  disposalIds: string[];
};

const PORTFOLIO = 'PORTFOLIO';
const HASH = /^0x[0-9a-fA-F]{64}$/;

/**
 * One token, however the book spelled it.
 *
 * The registry keys every token by its uppercase form (`canonicalSymbol`, venues/oneinch.ts), so two spellings of a
 * registry token name the same one exactly when their uppercase forms match. Compared here without the registry itself,
 * which refuses to load without a 1inch key that a reconciliation has no use for.
 */
export function sameSymbol(a: string, b: string): boolean {
  return a.trim().toUpperCase() === b.trim().toUpperCase();
}

/** Whether the node has this transaction, mined or pending. A read that fails throws: it is not an answer of "no". */
export async function isOnChain(hash: Hex, chain: ChainReads): Promise<boolean> {
  const receipt = await chain.getTransactionReceipt({ hash }).catch((e: unknown) => {
    if (e instanceof TransactionReceiptNotFoundError) return null;
    throw e;
  });
  if (receipt) return true;
  const pending = await chain.getTransaction({ hash }).catch((e: unknown) => {
    if (e instanceof TransactionNotFoundError) return null;
    throw e;
  });
  return Boolean(pending);
}

/** What one orphan put into the book. */
type Effect = {
  spendUsd: number;
  buys: { symbol: string; units: number; costUsd: number }[];
  sales: { symbol: string; disposals: DisposalRow[] }[];
};

/** What `fill` put into the book, or why that cannot be known exactly. Mirrors the code that recorded it. */
function effectOf(fill: RecordedFill, disposals: DisposalRow[], legs: SwapLeg[]): Effect | string {
  if (!HASH.test(fill.signature)) return 'its signature is not a transaction hash';
  if (fill.units === null || fill.usd === null || fill.day === null) {
    return 'it was recorded without its units, its dollars or the time it filled';
  }
  const { units, usd } = fill;
  const bought = { symbol: fill.symbol, units, costUsd: usd };
  const sale = (): Effect['sales'][number] | string => {
    const own = disposals.filter((d) => d.runId === fill.runId && sameSymbol(d.symbol, fill.symbol));
    if (own.length === 0) return `no disposal of ${fill.symbol} was written with this sale`;
    if (!own.some((d) => d.basisKnown)) {
      return `this sale of ${fill.symbol} booked no cost basis, so how many units it took off the book was never recorded`;
    }
    return { symbol: fill.symbol, disposals: own };
  };

  switch (fill.kind) {
    // routes/limit-orders.ts: `applyFill` with the units that arrived and the dollars paid, and `recordSpend` of them.
    case 'limit':
      return { spendUsd: usd, buys: [bought], sales: [] };
    // routes/panic.ts, and executor/swap.ts into the settlement token: a sale, which spends nothing.
    case 'close': {
      const s = sale();
      return typeof s === 'string' ? s : { spendUsd: 0, buys: [], sales: [s] };
    }
    // executor/swap.ts: the sale of what was paid, and the buy of what arrived — the numbers its trail row carries.
    case 'swap': {
      const s = sale();
      if (typeof s === 'string') return s;
      const leg = legs.find((l) => l.runId === fill.runId);
      if (!leg) return 'the trail row that says what this swap received is missing';
      return { spendUsd: 0, buys: [{ symbol: leg.symbol, units: leg.units, costUsd: leg.usd }], sales: [s] };
    }
    // executor/run.ts: a buy and a supply are recorded against the day's spend; a sale is not.
    default: {
      if (fill.side === 'supply') return { spendUsd: usd, buys: [], sales: [] };
      if (fill.symbol === PORTFOLIO) return 'a portfolio rebalance leg does not record which token it traded';
      if (fill.side === 'buy') return { spendUsd: usd, buys: [bought], sales: [] };
      if (fill.side === 'sell') {
        const s = sale();
        return typeof s === 'string' ? s : { spendUsd: 0, buys: [], sales: [s] };
      }
      return 'it was recorded before fills carried a side, so what it did to the book is not known';
    }
  }
}

/** One wallet's one token. Wallet ids are uuids and symbols are tickers, so neither ever holds the separator. */
const tokenKey = (walletId: string, symbol: string) => `${walletId}|${symbol.trim().toUpperCase()}`;

/** Decide what comes out of the book, and what stays for a person. Pure: everything it reads is passed in. */
export function planReconciliation(input: {
  orphans: RecordedFill[];
  disposals: DisposalRow[];
  swapLegs: SwapLeg[];
  positions: PositionRef[];
}): Reconciliation {
  const effects = new Map<string, Effect>();
  const why = new Map<string, string>();
  for (const fill of input.orphans) {
    const effect = effectOf(fill, input.disposals, input.swapLegs);
    if (typeof effect === 'string') why.set(fill.runId, effect);
    else effects.set(fill.runId, effect);
  }

  const positionsOf = (walletId: string, symbol: string) =>
    input.positions.filter((p) => p.walletId === walletId && sameSymbol(p.symbol, symbol));

  /** The tokens an orphan that is staying touches: none for a supply, `unknown` where its records do not say. */
  const tokensOf = (fill: RecordedFill): string[] | 'unknown' => {
    const key = (symbol: string) => tokenKey(fill.walletId, symbol);
    if (fill.kind === 'swap') {
      const leg = input.swapLegs.find((l) => l.runId === fill.runId);
      return leg ? [key(fill.symbol), key(leg.symbol)] : 'unknown';
    }
    if (fill.kind === 'limit' || fill.kind === 'close') return [key(fill.symbol)];
    if (fill.side === 'supply') return [];
    if (fill.symbol === PORTFOLIO) return 'unknown';
    return [key(fill.symbol)];
  };

  /*
   * A token's orphans come out together or not at all, and a staying orphan can make another stay — so this repeats
   * until nothing changes. A token is blocked when an orphan of it is staying; every token of a wallet is, when an
   * orphan whose token is not known is staying there; and a token the book holds no single position for cannot take
   * anything back.
   */
  const blocked = new Set<string>();
  const wholeWallet = new Set<string>();
  const blockedBecause = (walletId: string, symbol: string): string | undefined => {
    const token = symbol.trim().toUpperCase();
    if (wholeWallet.has(walletId) || blocked.has(tokenKey(walletId, symbol))) {
      return `another orphaned fill of ${token} in this wallet cannot come out exactly, and part of a position's history cannot come out alone`;
    }
    const rows = positionsOf(walletId, symbol).length;
    if (rows === 0) return `the book holds no ${token} position for it to come out of`;
    if (rows > 1) return `the book spells ${token} ${rows} ways, so which position it went into is not known`;
    return undefined;
  };
  for (let changed = true; changed; ) {
    changed = false;
    for (const fill of input.orphans) {
      if (effects.has(fill.runId)) continue;
      const tokens = tokensOf(fill);
      if (tokens === 'unknown') {
        if (!wholeWallet.has(fill.walletId)) {
          wholeWallet.add(fill.walletId);
          changed = true;
        }
        continue;
      }
      for (const key of tokens) {
        if (!blocked.has(key)) {
          blocked.add(key);
          changed = true;
        }
      }
    }
    for (const fill of input.orphans) {
      const effect = effects.get(fill.runId);
      if (!effect) continue;
      const reason = [...effect.buys, ...effect.sales].map((leg) => blockedBecause(fill.walletId, leg.symbol)).find(Boolean);
      if (reason) {
        effects.delete(fill.runId);
        why.set(fill.runId, reason);
        changed = true;
      }
    }
  }

  const spend = new Map<string, { walletId: string; day: string; usd: number }>();
  const positions = new Map<string, PositionDelta>();
  const disposalIds: string[] = [];
  const reversed: RecordedFill[] = [];
  const deltaFor = (walletId: string, symbol: string): PositionDelta => {
    const row = positionsOf(walletId, symbol)[0]!;
    const existing = positions.get(row.id);
    if (existing) return existing;
    const fresh: PositionDelta = {
      positionId: row.id,
      walletId,
      symbol: row.symbol,
      units: 0,
      costUsd: 0,
      realisedUsd: 0,
      unitsSold: 0,
      proceedsUsd: 0,
      unbasedUnits: 0,
    };
    positions.set(row.id, fresh);
    return fresh;
  };

  for (const fill of input.orphans) {
    const effect = effects.get(fill.runId);
    if (!effect) continue;
    reversed.push(fill);
    if (effect.spendUsd > 0) {
      const key = `${fill.walletId}|${fill.day}`;
      const day = spend.get(key) ?? { walletId: fill.walletId, day: fill.day!, usd: 0 };
      day.usd += effect.spendUsd;
      spend.set(key, day);
    }
    // A buy added its units and cost (`applyFill`, positions/index.ts); taking it out subtracts them.
    for (const buy of effect.buys) {
      const d = deltaFor(fill.walletId, buy.symbol);
      d.units -= buy.units;
      d.costUsd -= buy.costUsd;
    }
    /*
     * A sale's disposals are what it did to the position.
     *
     * With a basis, a sale removed exactly the units its basis-known disposals record, at the cost they record, and
     * realised their gain; every disposal it wrote counted toward units sold and proceeds, and those without a basis
     * toward unbased units. That holds for the split `applyFill` writes for a sale larger than the book, and for the
     * single row it wrote for one before.
     */
    for (const sale of effect.sales) {
      const d = deltaFor(fill.walletId, sale.symbol);
      for (const row of sale.disposals) {
        if (row.basisKnown) {
          d.units += row.units;
          d.costUsd += row.costUsd;
          d.realisedUsd -= row.realisedUsd;
        } else {
          d.unbasedUnits -= row.units;
        }
        d.unitsSold -= row.units;
        d.proceedsUsd -= row.proceedsUsd;
        disposalIds.push(row.id);
      }
    }
  }

  return {
    reversed,
    unreversible: input.orphans.filter((f) => why.has(f.runId)).map((fill) => ({ fill, why: why.get(fill.runId)! })),
    spend: [...spend.values()],
    positions: [...positions.values()],
    disposalIds,
  };
}

/** The error a reconciled run keeps, so `/runs` says why it is no longer a fill. */
export const RECONCILED_ERROR =
  'not_on_chain: this transaction is not on the chain any more — the network was rebuilt after it filled — so it no longer counts toward the day’s spend or the position book';

/**
 * Write a plan inside the caller's transaction: the runs marked, the spend and the positions put back, the disposals
 * deleted, and one trail row per wallet. A run that is no longer `filled` stops everything, and the caller rolls back.
 */
export async function applyReconciliation(client: Queryable, plan: Reconciliation): Promise<void> {
  for (const fill of plan.reversed) {
    const marked = await client.query(
      `UPDATE strategy_runs SET status = 'failed', error = $2 WHERE id = $1 AND status = 'filled'`,
      [fill.runId, RECONCILED_ERROR],
    );
    if (marked.rowCount !== 1) throw new Error(`Run ${fill.runId} changed while this ran; nothing was written.`);
  }
  for (const s of plan.spend) {
    await client.query(`UPDATE daily_spend SET spent_usd = GREATEST(spent_usd - $3, 0) WHERE wallet_id = $1 AND day = $2`, [
      s.walletId,
      s.day,
      s.usd,
    ]);
    // A day with nothing left on it is the day with no row, as it was before anything was recorded.
    await client.query(`DELETE FROM daily_spend WHERE wallet_id = $1 AND day = $2 AND spent_usd = 0`, [s.walletId, s.day]);
  }
  for (const p of plan.positions) {
    await client.query(
      `UPDATE positions
          SET units = GREATEST(units + $2, 0),
              cost_usd = GREATEST(cost_usd + $3, 0),
              realised_usd = realised_usd + $4,
              units_sold = GREATEST(units_sold + $5, 0),
              proceeds_usd = GREATEST(proceeds_usd + $6, 0),
              unbased_units = GREATEST(unbased_units + $7, 0),
              updated_at = now()
        WHERE id = $1 AND chain = ${THIS_CHAIN}`,
      [p.positionId, p.units, p.costUsd, p.realisedUsd, p.unitsSold, p.proceedsUsd, p.unbasedUnits],
    );
  }
  if (plan.disposalIds.length > 0) {
    await client.query(`DELETE FROM disposals WHERE id = ANY($1::text[])`, [plan.disposalIds]);
  }

  const byWallet = new Map<string, RecordedFill[]>();
  for (const fill of plan.reversed) byWallet.set(fill.walletId, [...(byWallet.get(fill.walletId) ?? []), fill]);
  for (const [walletId, fills] of byWallet) {
    const one = fills.length === 1;
    await append(
      {
        walletId,
        agent: 'xorr',
        action: `Took ${fills.length} fill${one ? '' : 's'} the chain does not have out of the book`,
        detail:
          `This network was rebuilt after ${one ? 'it' : 'they'} filled, so ${one ? 'its transaction is' : 'their transactions are'} not on it. ` +
          `${one ? 'It no longer counts' : 'They no longer count'} toward the day’s spend or your positions. The earlier rows still say what was recorded at the time.`,
        kind: 'risk',
        payload: { reconciled: true, runIds: fills.map((f) => f.runId), signatures: fills.map((f) => f.signature) },
      },
      client as PoolClient,
    );
  }
}

const FILL_COLUMNS = `r.id AS run_id, s.wallet_id, s.kind, s.symbol, r.side, r.units, r.usd, r.signature,
       to_char(r.finished_at AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS day`;

type FillRow = {
  run_id: string;
  wallet_id: string;
  kind: string;
  symbol: string;
  side: string | null;
  units: string | null;
  usd: string | null;
  signature: string;
  day: string | null;
};

const toFill = (r: FillRow): RecordedFill => ({
  runId: r.run_id,
  walletId: r.wallet_id,
  kind: r.kind,
  symbol: r.symbol,
  side: r.side,
  units: r.units === null ? null : Number(r.units),
  usd: r.usd === null ? null : Number(r.usd),
  signature: r.signature,
  day: r.day,
});

/**
 * Find this chain's orphans, plan what comes out, print it, and — with `apply` — write it in one transaction.
 *
 * The node is asked first, outside any transaction; the runs it does not have are then locked and read again, with the
 * disposals, trail rows and positions the plan reads, so nothing the plan was drawn from can move before it is written.
 * Without `apply` the same transaction is rolled back: a dry run is the real run, not a separate estimate of it.
 */
export async function reconcile(opts: {
  client: Queryable;
  chain: ChainReads;
  apply: boolean;
  walletId?: string;
  out: (line: string) => void;
}): Promise<Reconciliation> {
  const { client, chain, out } = opts;
  const candidates = (
    await client.query<FillRow>(
      `SELECT ${FILL_COLUMNS}
         FROM strategy_runs r JOIN strategies s ON s.id = r.strategy_id
        WHERE r.status = 'filled' AND r.signature IS NOT NULL
          AND r.chain = ${THIS_CHAIN} AND s.chain = ${THIS_CHAIN}
          AND ($1::text IS NULL OR s.wallet_id = $1)
        ORDER BY r.finished_at`,
      [opts.walletId ?? null],
    )
  ).rows.map(toFill);

  const missing: string[] = [];
  const unchecked: RecordedFill[] = [];
  for (const fill of candidates) {
    if (!HASH.test(fill.signature)) unchecked.push(fill);
    else if (!(await isOnChain(fill.signature as Hex, chain))) missing.push(fill.runId);
  }
  out(
    `${candidates.length} filled run(s) on this chain: ${missing.length} not on the node, ` +
      `${unchecked.length} without a transaction hash to look up.`,
  );

  await client.query('BEGIN');
  try {
    const orphans = (
      await client.query<FillRow>(
        `SELECT ${FILL_COLUMNS}
           FROM strategy_runs r JOIN strategies s ON s.id = r.strategy_id
          WHERE r.id = ANY($1::text[]) AND r.status = 'filled'
          ORDER BY r.finished_at
          FOR UPDATE OF r`,
        [missing],
      )
    ).rows.map(toFill);
    const wallets = [...new Set(orphans.map((f) => f.walletId))];
    const disposals = (
      await client.query<{
        id: string;
        run_id: string;
        symbol: string;
        units: string;
        proceeds_usd: string;
        cost_usd: string;
        realised_usd: string;
        basis_known: boolean;
      }>(
        `SELECT d.id, r.id AS run_id, d.symbol, d.units, d.proceeds_usd, d.cost_usd, d.realised_usd, d.basis_known
           FROM strategy_runs r
           JOIN strategies s ON s.id = r.strategy_id
           JOIN disposals d ON d.wallet_id = s.wallet_id AND d.at = r.finished_at
          WHERE r.id = ANY($1::text[])
          FOR UPDATE OF d`,
        [missing],
      )
    ).rows.map((d) => ({
      id: d.id,
      runId: d.run_id,
      symbol: d.symbol,
      units: Number(d.units),
      proceedsUsd: Number(d.proceeds_usd),
      costUsd: Number(d.cost_usd),
      realisedUsd: Number(d.realised_usd),
      basisKnown: d.basis_known,
    }));
    const swapLegs = (
      await client.query<{ run_id: string; symbol: string; units: string; usd: string }>(
        `SELECT payload->>'runId' AS run_id, payload->>'to' AS symbol, payload->>'received' AS units, payload->>'usd' AS usd
           FROM audit_log
          WHERE wallet_id = ANY($1::text[]) AND payload->>'runId' = ANY($2::text[])
            AND payload ? 'to' AND payload ? 'received' AND payload ? 'usd'`,
        [wallets, missing],
      )
    ).rows.map((l) => ({ runId: l.run_id, symbol: l.symbol, units: Number(l.units), usd: Number(l.usd) }));
    // The long rows only: every fill is recorded against one (`applyFill`), so a short row is never where one went.
    const positions = (
      await client.query<{ id: string; wallet_id: string; symbol: string }>(
        `SELECT id, wallet_id, symbol FROM positions
          WHERE wallet_id = ANY($1::text[]) AND chain = ${THIS_CHAIN} AND side = 'long'
          FOR UPDATE`,
        [wallets],
      )
    ).rows.map((p) => ({ id: p.id, walletId: p.wallet_id, symbol: p.symbol }));

    const plan = planReconciliation({ orphans, disposals, swapLegs, positions });
    printPlan(plan, unchecked, out);

    if (opts.apply) {
      await applyReconciliation(client, plan);
      await client.query('COMMIT');
      out(`Applied: ${plan.reversed.length} run(s) taken out of the book.`);
    } else {
      await client.query('ROLLBACK');
      out('Dry run: nothing was written. Run again with --apply to write exactly this.');
    }
    return plan;
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  }
}

function printPlan(plan: Reconciliation, unchecked: RecordedFill[], out: (line: string) => void): void {
  const short = (hash: string) => `${hash.slice(0, 10)}…`;
  const signed = (n: number) => (n >= 0 ? `+${n}` : String(n));
  for (const f of plan.reversed) {
    out(`  take out  ${f.runId}  wallet ${f.walletId}  ${f.day}  ${f.kind}/${f.side ?? '?'}  ${f.units} ${f.symbol}  $${f.usd}  ${short(f.signature)}`);
  }
  for (const { fill: f, why } of plan.unreversible) {
    out(`  leave     ${f.runId}  wallet ${f.walletId}  ${f.kind}/${f.side ?? '?'}  ${f.symbol}: ${why}`);
  }
  for (const f of unchecked) out(`  unchecked ${f.runId}  wallet ${f.walletId}: "${f.signature}" is not a transaction hash`);
  for (const s of plan.spend) out(`  daily_spend  wallet ${s.walletId}  ${s.day}: -$${s.usd.toFixed(2)}`);
  for (const p of plan.positions) {
    out(
      `  position  ${p.symbol} (${p.positionId})  wallet ${p.walletId}: units ${signed(p.units)}, cost ${signed(p.costUsd)}, ` +
        `realised ${signed(p.realisedUsd)}, sold ${signed(p.unitsSold)}, proceeds ${signed(p.proceedsUsd)}, unbased ${signed(p.unbasedUnits)}`,
    );
  }
  if (plan.disposalIds.length > 0) out(`  disposals deleted: ${plan.disposalIds.length}`);
}
