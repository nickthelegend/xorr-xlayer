/**
 * Which strategy opened which part of a holding.
 *
 * `positions` is one row per (wallet, chain, symbol, side), whatever built it. That is the right
 * shape for "what do I own" and useless for "who did this" — and once several strategies can stack
 * on one symbol, the second question is the one people ask. A recurring buy accumulating NVDAc and
 * a momentum entry on the same token are one row and two decisions.
 *
 * A sleeve is one source's net contribution to a holding. Sources are deliberately broader than
 * strategies: a limit order, a panic flatten and a manual swap all move units, and attributing
 * those to whichever strategy happened to be running would be an invention.
 *
 * ## Units are fungible, and this does not pretend otherwise
 *
 * When a strategy sells more than it ever bought — which `planExitRules` does by design, closing
 * the whole position — there is no fact about whose units those were. So a sale reduces the
 * seller's OWN sleeve and stops at zero rather than reaching into someone else's. The difference
 * then shows up in the remainder, which is reported rather than absorbed: see `unattributedUnits`
 * and `overAttributedUnits` below. An attribution that always added up would be one that had been
 * made to.
 */
import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { query } from '../db/index.js';
import { THIS_CHAIN } from '../db/chain-scope.js';

export const SLEEVE_SOURCES = [
  'strategy',
  'agent',
  'basket',
  'limit-order',
  'manual',
  'flatten',
] as const;
export type SleeveSource = (typeof SLEEVE_SOURCES)[number];

export type FillAttribution = {
  source: SleeveSource;
  /** The specific strategy, proposal or order. Null for sources with no id of their own. */
  id?: string | null;
  /** What to call it on screen, captured now — see the migration for why it is not a join. */
  label: string;
};

export type Sleeve = {
  source: SleeveSource;
  sourceId: string | null;
  label: string;
  units: number;
  costUsd: number;
  openedAt: number;
};

export type SleeveBreakdown = {
  symbol: string;
  sleeves: Sleeve[];
  /** What the book says the wallet holds, which the sleeves are measured against. */
  heldUnits: number;
  attributedUnits: number;
  /**
   * Units the book holds that no source here claims.
   *
   * Real and common: a wallet funded outside the app, a position opened before sleeves existed, or
   * units bought by a strategy that has since sold more than it bought. Shown as its own line
   * rather than divided among the sleeves, because dividing it would be a guess presented as a
   * record.
   */
  unattributedUnits: number;
  /**
   * Units claimed by sources beyond what the book holds.
   *
   * Normally zero. It goes positive after units leave the wallet by a route this ledger never saw
   * — an outside transfer, most often. Surfaced rather than clamped away, because a sleeve total
   * that quietly exceeds the holding is the symptom of exactly that.
   */
  overAttributedUnits: number;
};

/**
 * Record one source's share of a fill, inside the caller's transaction.
 *
 * Takes the same client as `applyFill` on purpose: the position and its attribution are one fact,
 * and a sleeve written in a second transaction could survive a rolled-back fill.
 *
 * Negative units are a sale. The sleeve floors at zero rather than going negative — a source
 * cannot have contributed less than nothing, and the shortfall is reported by the breakdown rather
 * than encoded as a negative sleeve nobody can read.
 */
export async function recordSleeve(
  client: PoolClient,
  params: {
    walletId: string;
    symbol: string;
    units: number;
    usd: number;
    attribution: FillAttribution;
  },
): Promise<void> {
  const { attribution: a } = params;
  await client.query(
    `INSERT INTO position_sleeves (id, wallet_id, symbol, source, source_id, source_label, units, cost_usd)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
     ON CONFLICT (wallet_id, chain, symbol, source, coalesce(source_id, '')) DO UPDATE
       SET units = GREATEST(0, position_sleeves.units + EXCLUDED.units),
           cost_usd = GREATEST(0, position_sleeves.cost_usd + EXCLUDED.cost_usd),
           source_label = EXCLUDED.source_label,
           updated_at = now()`,
    [
      randomUUID(),
      params.walletId,
      params.symbol,
      a.source,
      a.id ?? null,
      a.label,
      params.units,
      params.usd,
    ],
  );
}

/**
 * The breakdown for one symbol, with the parts that do not add up stated rather than smoothed.
 */
export async function sleevesFor(walletId: string, symbol: string): Promise<SleeveBreakdown> {
  const [rows, held] = await Promise.all([
    query<{
      source: SleeveSource;
      source_id: string | null;
      source_label: string;
      units: string;
      cost_usd: string;
      opened_at: Date;
    }>(
      `SELECT source, source_id, source_label, units, cost_usd, opened_at
         FROM position_sleeves
        WHERE wallet_id = $1 AND symbol = $2 AND chain = ${THIS_CHAIN} AND units > 0.000001
        ORDER BY opened_at ASC`,
      [walletId, symbol],
    ).catch(() => []),
    query<{ units: string }>(
      `SELECT units FROM positions
        WHERE wallet_id = $1 AND symbol = $2 AND side = 'long' AND chain = ${THIS_CHAIN}`,
      [walletId, symbol],
    ).catch(() => []),
  ]);

  const sleeves: Sleeve[] = rows.map((r) => ({
    source: r.source,
    sourceId: r.source_id,
    label: r.source_label,
    units: Number(r.units),
    costUsd: Number(r.cost_usd),
    openedAt: new Date(r.opened_at).getTime(),
  }));

  const heldUnits = Number(held[0]?.units ?? 0);
  const attributedUnits = sleeves.reduce((a, s) => a + s.units, 0);

  return {
    symbol,
    sleeves,
    heldUnits,
    attributedUnits,
    unattributedUnits: Math.max(0, heldUnits - attributedUnits),
    overAttributedUnits: Math.max(0, attributedUnits - heldUnits),
  };
}

/**
 * The sleeve one source holds on one symbol, or null.
 *
 * Used where a trade is explained: the question there is "what did THIS strategy have", and
 * answering it from the whole breakdown would make the caller do the filtering.
 */
export async function sleeveOf(
  walletId: string,
  symbol: string,
  source: SleeveSource,
  sourceId: string | null,
): Promise<Sleeve | null> {
  const breakdown = await sleevesFor(walletId, symbol);
  return (
    breakdown.sleeves.find((s) => s.source === source && (s.sourceId ?? null) === sourceId) ?? null
  );
}
