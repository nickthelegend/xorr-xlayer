/**
 * Leaderboard — PLAN.md 12.23, closing [G33].
 *
 * The handoff shipped four agents with hardcoded pnl30d / win / trades. This computes all three
 * from the REAL trade record: filled runs valued at the current price against what was paid.
 *
 * An agent with no trades gets zeros and says so, rather than borrowing a flattering number.
 */
import { query } from '../db/index.js';
import { THIS_CHAIN } from '../db/chain-scope.js';
import { priceOf } from '../market/prices.js';
import { personaForKind } from './attribution.js';

export type LeaderboardRow = {
  id: string;
  name: string;
  role: string;
  metric: string;
  pnl30d: number;
  win: number;
  trades: number;
  c1: string;
  c2: string;
};

/** One agent's record over the window, whoever the agent is — one of the four or one a person made. */
export type AgentRecord = Pick<LeaderboardRow, 'pnl30d' | 'win' | 'trades' | 'metric'>;

/** No trades means no record. Saying "no trades yet" is honest; a win rate is not. */
export const NO_TRADES: AgentRecord = { pnl30d: 0, win: 0, trades: 0, metric: 'No trades yet' };

const AGENTS = [
  { id: 'momentum-scout', name: 'Momentum Scout', role: 'Rides breakouts on liquid majors', c1: '#5B93FF', c2: '#1B44CE' },
  { id: 'earnings-desk', name: 'Earnings Desk', role: 'Trades tokenized equity earnings', c1: '#F0BE55', c2: '#C98518' },
  { id: 'yield-keeper', name: 'Yield Keeper', role: 'Moves idle cash into best APY', c1: '#49E39B', c2: '#12A45F' },
  { id: 'drawdown-guard', name: 'Drawdown Guard', role: 'Cuts risk when the book bleeds', c1: '#B58CFF', c2: '#7A45E0' },
];

type RunRow = { kind: string; persona_id: string | null; symbol: string; usd: string; units: string; price: string };

/**
 * Every agent's record on this wallet, by persona id: the four always, and every agent a person made that has traded
 * (`custom:<id>`), credited through the strategies it owns.
 */
export async function agentRecords(walletId: string): Promise<Map<string, AgentRecord>> {
  const runs = await query<RunRow>(
    /*
     * Credited by the rule the trail itself records (PLAN.md 2.2): the agent that owns the strategy
     * when it has one, otherwise the persona that runs its kind (`personaForKind`). It was found by
     * searching the wallet's audit log for each run's id inside JSON — a scan of the trail per run —
     * and a run that search missed was credited to Yield Keeper by default.
     *
     * Buys only (PLAN.md 2.15). A sale's `usd` is what it paid, so valuing it as units at today's mark
     * minus that amount scored every profitable exit as a loss of roughly its own proceeds.
     */
    `SELECT s.kind, ag.persona_id, s.symbol, r.usd, r.units, r.price
     FROM strategy_runs r
     JOIN strategies s ON s.id = r.strategy_id
     LEFT JOIN agents ag ON ag.id = s.agent_id
     WHERE s.wallet_id = $1 AND s.chain = ${THIS_CHAIN}
       AND r.status = 'filled' AND r.side = 'buy' AND r.started_at > now() - interval '30 days'`,
    [walletId],
  );

  // One price lookup per symbol, not per run — and all of them at once, not one after another.
  const symbols = [...new Set(runs.map((r) => r.symbol))];
  const marks = new Map<string, number>();
  await Promise.all(
    symbols.map(async (s) => {
      try {
        // A screen, so a short deadline: an unpriced symbol is excluded, not waited for.
        marks.set(s, await priceOf(s, 3_000));
      } catch {
        // No feed for this symbol — its runs are excluded rather than valued at a guess.
      }
    }),
  );

  const byAgent = new Map<string, { pnl: number; wins: number; trades: number }>();
  for (const r of runs) {
    const mark = marks.get(r.symbol);
    if (mark === undefined) continue;
    // A run no persona ran — a recurring buy, a rebalance — is on nobody's record.
    const agent = r.persona_id ?? personaForKind(r.kind);
    if (!agent) continue;
    const value = Number(r.units) * mark;
    const paid = Number(r.usd);
    const pnl = value - paid;
    const acc = byAgent.get(agent) ?? { pnl: 0, wins: 0, trades: 0 };
    acc.pnl += pnl;
    acc.trades += 1;
    if (pnl > 0) acc.wins += 1;
    byAgent.set(agent, acc);
  }

  const records = new Map<string, AgentRecord>(AGENTS.map((a) => [a.id, NO_TRADES]));
  for (const [agent, acc] of byAgent) {
    const win = acc.trades > 0 ? Math.round((acc.wins / acc.trades) * 100) : 0;
    records.set(agent, {
      pnl30d: Number(acc.pnl.toFixed(2)),
      win,
      trades: acc.trades,
      metric: acc.trades === 0 ? NO_TRADES.metric : `${win}% win rate`,
    });
  }
  return records;
}

/** The four personas, each with its record: the leaderboard's rows. */
export async function leaderboard(walletId: string): Promise<LeaderboardRow[]> {
  const records = await agentRecords(walletId);
  return AGENTS.map((a) => ({ ...a, ...(records.get(a.id) ?? NO_TRADES) }));
}
