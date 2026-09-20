/**
 * A one-off market order, and the exits that go with one.
 *
 * Moved out of `POST /orders` so that approving a proposal places its order through exactly the same
 * path (PLAN.md 1.3). Approving used to write "Filled 0.0041 WETH at $2,431. Stop set at $2,406." into
 * the thread and the trail and trade nothing — no order, no stop, no transaction. The only honest way
 * to make that sentence true was to stop writing it and place the order.
 *
 * ## Why the app may call this at all
 *
 * An order is not the bot acting on its own — it is the user exercising the authority they already
 * granted, and every limit on that authority is enforced server-side and on-chain. A compromised
 * phone can spend up to the cap at an allowlisted venue, which is exactly the risk the cap describes
 * and exactly what the kill switch ends in one tap. It cannot withdraw, cannot name a destination,
 * and cannot pick a price.
 */
import { randomUUID } from 'node:crypto';
import type { Address } from 'viem';
import { one, query } from '../db/index.js';
import { THIS_CHAIN } from '../db/chain-scope.js';
import { runStrategy, type RunOutcome, type StrategyRow } from './run.js';
import { nextRuns } from './schedule.js';
import { TOKENS as VENUE_TOKENS, canonicalSymbol } from '../venues/tokens.js';
import { CHAIN_KEY } from '../evm/chains.js';
import { readPolicy } from '../evm/delegation.js';
import { usdcRawOf } from './fill-measure.js';
import type { WalletRow } from '../routes/wallet-context.js';

/** An order's own label. `toLocaleString` so a four-figure order keeps its separator. */
export function money(usd: number): string {
  return `$${usd.toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 2 })}`;
}

/** Refused before anything ran: no strategy row, no claim, nothing sent. */
export type OrderRefusal = { status: 'blocked'; reason: string; detail: string };

export type OrderResult =
  | { placed: false; refusal: OrderRefusal }
  | { placed: true; orderId: string; outcome: RunOutcome };

export async function placeOrder(
  w: WalletRow,
  rawSymbol: string,
  usd: number,
  label?: string,
  /** Carried into the one-shot row's params: a swap's own slippage tolerance (PLAN.md 3.9). */
  extra: Record<string, unknown> = {},
  /**
   * The agent this order is placed FOR, when one placed it (`agents.id`).
   *
   * The trail has always named the persona — the activity row reads "Placed by Momentum Scout", from `placedBy` in
   * `extra` — but the strategy row carried no agent, and the leaderboard credits a run through `strategies.agent_id`
   * (or the persona that runs its kind, and no persona runs a `buy`). So on 2026-09-20 an agent with 18 filled buys
   * in the trail showed "No trades yet" on its own leaderboard, and every other agent did too. One column, two
   * screens disagreeing about the same fills.
   */
  agentId: string | null = null,
): Promise<OrderResult> {
  // Equities are `NVDAc`/`TSLAc`; uppercasing loses the suffix and the venue lookup misses.
  const symbol = canonicalSymbol(rawSymbol);
  const refuse = (reason: string, detail: string): OrderResult => ({
    placed: false,
    refusal: { status: 'blocked', reason, detail },
  });

  if (!VENUE_TOKENS[symbol]) {
    return refuse('not_tradable', `${symbol} cannot be settled on ${CHAIN_KEY}, so there is no order to place.`);
  }

  // The same on-chain permission check `/strategies` does at creation. Read from the CHAIN:
  // absent permission has to mean refuse, not allow.
  const policy = await readPolicy(w.address as Address);
  if (!policy || policy.revoked) {
    return refuse('no_delegation', 'No active trading permission on-chain. Grant one before placing an order.');
  }
  if (policy.expiresAt <= Date.now()) {
    return refuse('delegation_expired', 'The trading permission has expired. Renew it before placing an order.');
  }

  /*
   * The money has to be there.
   *
   * `spend()` pulls USDC from the owner, so an order for more than the owner holds cannot settle — and without this
   * the attempt went all the way to the contract, where the simulation came back with ERC20's own words: "The
   * contract function \"spend\" reverted with the following reason: ERC20: transfer amount exceeds balance", contract
   * address and calldata included. That string is what the run detail screen shows a person, verbatim and on purpose
   * (`app/runs/[id].tsx`), and it tells them nothing they can act on. Seen on 2026-09-20 when an agent traded a
   * wallet whose permission was live before its USDC had arrived.
   *
   * A balance that cannot be READ is not a refusal: the chain is the authority on this and an unreadable answer is an
   * outage, which the contract will catch anyway.
   */
  const heldRaw = await usdcRawOf(w.address as Address);
  if (heldRaw !== undefined && heldRaw < BigInt(Math.ceil(usd * 1e6))) {
    const held = Number(heldRaw) / 1e6;
    return refuse(
      'insufficient_funds',
      `This wallet holds $${held.toFixed(2)} of USDC, and the order needs $${usd.toFixed(2)}. Add funds, or place a smaller order.`,
    );
  }

  // A one-shot `buy`: no cadence, so `advance()` never reschedules it.
  const row = await one<StrategyRow>(
    `INSERT INTO strategies (id, wallet_id, kind, state, label, symbol, params, cadence, next_run_at, daily_allocation_usd, agent_id)
     VALUES ($1,$2,'buy','live',$3,$4,$5,NULL,NULL,$6,$7) RETURNING *`,
    [
      randomUUID(),
      w.id,
      label ?? `${money(usd)} of ${symbol}`,
      symbol,
      JSON.stringify({ ...extra, usd, manual: true }),
      usd,
      agentId,
    ],
  );

  const outcome = await runStrategy(row!);

  // Retire it either way. A one-shot that stays `live` would sit on the strategy list
  // holding allowance against the cap for a trade that has already happened.
  await query(`UPDATE strategies SET state='ended' WHERE id=$1`, [row!.id]);

  return { placed: true, orderId: row!.id, outcome };
}

/**
 * A proposal's stop and target, made real: an `exit-rules` strategy on the position the fill opened —
 * the executor's own tier-3 mechanism, the one the Auto Close screen creates.
 *
 * Measured from the FILL price, never the price the proposal was written at: percentages taken from
 * a stale quote would put the stop somewhere nobody chose. `planExitRules` sells the whole holding of
 * the symbol, and the sentence says so. An exit already live on the symbol is left alone rather than
 * doubled — two exit strategies on one holding would race each other to sell it.
 */
export async function armExits(
  /*
   * Only the fields this actually reads.
   *
   * It wanted a whole `WalletRow`, and used `w.id`. The autonomous agent selects three columns —
   * it has no use for `kind`, `cluster`, `user_id` or `last_seen_at` — so a full row was a demand
   * for four values nobody here needs, and the caller either widened its query to satisfy the
   * type or lied about the shape it had.
   */
  w: Pick<WalletRow, 'id' | 'address' | 'agents_stopped'>,
  p: { symbol: string; entryPrice: number; stopPrice: number; targetPrice: number },
): Promise<{ strategyId: string | null; sentence: string }> {
  if (!(p.stopPrice > 0) || !(p.targetPrice > 0)) {
    return { strategyId: null, sentence: 'It came with no stop or target, so none is set.' };
  }
  const stopLossPct = ((p.entryPrice - p.stopPrice) / p.entryPrice) * 100;
  const takeProfitPct = ((p.targetPrice - p.entryPrice) / p.entryPrice) * 100;
  if (!(p.entryPrice > 0) || !(stopLossPct > 0) || !(takeProfitPct > 0)) {
    return {
      strategyId: null,
      sentence: `It filled outside the ${money(p.stopPrice)} to ${money(p.targetPrice)} range the proposal was written for, so no exit is set. Set one in Auto Close.`,
    };
  }

  /*
   * An exit at the SAME levels is a duplicate; one at different levels is a stack.
   *
   * This used to refuse any second exit on a symbol, because `planExitRules` closes the whole
   * position and two of them firing together would have the second selling units the first had
   * already sold. That is now handled where it belongs — a sell is sized against what the rest of
   * the stack has claimed (`executor/stack.ts`) — so a tighter stop under an existing take-profit
   * is allowed, which is the ordinary thing people want.
   *
   * What is still refused is the same exit twice. Two identical stops are not a strategy, they are
   * a double-tap, and arming both would put two rows on the schedule that fire on the same tick.
   */
  const duplicate = await one<{ id: string }>(
    `SELECT id FROM strategies
      WHERE wallet_id = $1 AND kind = 'exit-rules' AND symbol = $2 AND state = 'live'
        AND chain = ${THIS_CHAIN}
        AND round((params->>'takeProfitPct')::numeric, 2) = round($3::numeric, 2)
        AND round((params->>'stopLossPct')::numeric, 2) = round($4::numeric, 2)
      LIMIT 1`,
    [w.id, p.symbol, takeProfitPct.toFixed(2), stopLossPct.toFixed(2)],
  ).catch(() => null);
  if (duplicate) {
    return { strategyId: null, sentence: `Your existing exit on ${p.symbol} stays as it is.` };
  }

  const row = await one<{ id: string }>(
    `INSERT INTO strategies (id, wallet_id, kind, state, label, symbol, params, cadence, next_run_at, daily_allocation_usd)
     VALUES ($1,$2,'exit-rules','live',$3,$4,$5,'daily',$6,0) RETURNING id`,
    [
      randomUUID(),
      w.id,
      `Exit ${p.symbol} at +${takeProfitPct.toFixed(1)}% / -${stopLossPct.toFixed(1)}%`,
      p.symbol,
      JSON.stringify({ entryPrice: p.entryPrice, takeProfitPct, stopLossPct }),
      nextRuns('daily', 1)[0],
    ],
  );
  return {
    strategyId: row!.id,
    sentence: `Exit set: sells your ${p.symbol} if it falls to ${money(p.stopPrice)} or reaches ${money(p.targetPrice)}, checked daily.`,
  };
}
