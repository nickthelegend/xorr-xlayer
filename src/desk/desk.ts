/**
 * The desk under the agents on Home: what each agent will do next, and what the agents did (2026-09-26).
 *
 * Every line is read from something the executor or the chain holds: the agent's budget is the contract's, the next run
 * is the strategy's schedule, and the feed is the audit trail. Nothing here is a guess about the future beyond the
 * schedule itself, and an agent that cannot trade says why before it says when.
 */
import type { ActivityEvent, Agent, Strategy } from '@/data/types';

/** Whether the permission lets anything trade, as Home reads it from the chain. */
export type DeskStanding = 'live' | 'revoked' | 'expired' | 'none' | 'unreadable' | undefined;

export type AgentLine = {
  /** What it runs, in the strategy's own words ("$25 of WOKB, weekly"), or null when it runs nothing. */
  runs: string | null;
  /** Why it cannot trade, or when it will. */
  status: string;
  /** Due now and able to trade: the desk marks it as about to act. */
  due: boolean;
};

/** "6d 23h", "4h 12m", "3:07" — the time until a run, coarse when far away, to the second when close. */
export function until(ms: number): string {
  if (ms <= 0) return 'now';
  const s = Math.floor(ms / 1000);
  const d = Math.floor(s / 86_400);
  const h = Math.floor((s % 86_400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}:${String(s % 60).padStart(2, '0')}`;
}

/** The strategy an agent runs next: its live ones, soonest first. */
export function nextStrategy(agent: Agent, strategies: readonly Strategy[]): Strategy | undefined {
  return strategies
    .filter((s) => s.agentId === agent.id && s.state === 'live')
    .sort((a, b) => (a.nextRunAt ?? Infinity) - (b.nextRunAt ?? Infinity))[0];
}

export function agentLine(
  agent: Agent,
  strategies: readonly Strategy[],
  standing: DeskStanding,
  now: number,
): AgentLine {
  const s = nextStrategy(agent, strategies);
  const runs = s ? s.label : null;
  if (!s) return { runs, status: 'Runs nothing yet', due: false };
  if (standing === 'revoked') return { runs, status: 'Stopped · trading is off', due: false };
  if (standing === 'expired') return { runs, status: 'Permission expired', due: false };
  if (standing === 'none') return { runs, status: 'Needs your permission', due: false };
  if ((agent.budgetUsd ?? 0) <= 0) return { runs, status: 'Waiting for its budget', due: false };
  if (s.nextRunAt === undefined) return { runs, status: 'Not scheduled', due: false };
  const left = s.nextRunAt - now;
  if (left <= 0) return { runs, status: 'Due now · trading on its own', due: true };
  return { runs, status: `Next run in ${until(left)}`, due: false };
}

/** The dollars in an activity row's amount ("−$25.00" → 25), or 0 where it moved none. */
export function dollars(amount: string): number {
  const n = Number(amount.replace(/[^0-9.]/g, ''));
  return Number.isFinite(n) ? n : 0;
}

/** A fill's size: its amount where the row carries one, else the first dollar figure of its detail ("$25 at $120.76"). */
export function fillDollars(e: ActivityEvent): number {
  const fromAmount = dollars(e.amount ?? '');
  if (fromAmount > 0) return fromAmount;
  const m = /\$([0-9][0-9,]*(?:\.[0-9]+)?)/.exec(e.detail ?? '');
  return m?.[1] ? Number(m[1].replace(/,/g, '')) : 0;
}

/** What an agent has spent, from its fills in the trail. */
export function spentBy(agentName: string, events: readonly ActivityEvent[]): number {
  return events.filter((e) => e.agent === agentName && e.kind === 'trade').reduce((sum, e) => sum + fillDollars(e), 0);
}

/** The feed: the newest rows the agents wrote, and the stop that ends them. The system's own bookkeeping stays out. */
export function deskFeed(events: readonly ActivityEvent[], agentNames: readonly string[], max = 6): ActivityEvent[] {
  const names = new Set(agentNames);
  return events.filter((e) => names.has(e.agent) || /stopped|revoked/i.test(e.action)).slice(0, max);
}

/** A row young enough to be news. */
export function isFresh(e: ActivityEvent, now: number, withinMs = 90_000): boolean {
  return typeof e.at === 'number' && now - e.at >= 0 && now - e.at < withinMs;
}
