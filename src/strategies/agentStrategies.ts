/**
 * Every strategy an agent someone makes can be given, and which of them are picked (2026-09-16).
 *
 * Only kinds the executor plans and runs here (`EXECUTABLE_KINDS`), on the two assets it routes, settles and holds price
 * history for. Each shows what the executor's replay of it did over the last 90 days of real prices, fees and slippage
 * charged (`/strategies/backtest`, `/agents/:id/backtest`); one whose result is not a price path — cash earning a rate, a
 * stop on what you hold, a mix that trades only its drift — says what it does instead of a number nobody computed.
 * Ranges and stops are drawn against today's price, so they can be picked once that price is read.
 *
 * The picked set lives here rather than in a screen because two screens share it: New agent, which shows what is picked
 * and makes the agent, and the picker it opens.
 *
 * Not there: events and earnings (the tokenized equities cannot settle on every chain this runs on, and a strategy that
 * schedules forever and fills never is refused at creation), and anything with a level a person should draw themselves.
 */
import { useEffect } from 'react';
import { create } from 'zustand';
import { repos } from '@/data';
import { system } from '@/data/system';
import { errorText } from '@/data/apiError';
import { money } from '@/format';
import type { Strategy } from '@/data/types';

export type StrategyGroup = 'buys' | 'trading' | 'protect' | 'cash';
export type PricedSymbol = 'WETH' | 'CBBTC';
export type Marks = Partial<Record<PricedSymbol, number>>;

export type StrategyTemplate = {
  key: string;
  group: StrategyGroup;
  title: string;
  what: string;
  /** Drawn against this asset's price today: not pickable until that price is read. */
  needs?: PricedSymbol;
  /** The executor's replay over the last 90 days of real prices. */
  replay?: (marks: Marks) => Promise<{ ret: number; trades: number }>;
  /** What it does, said in place of a return, for a strategy whose result is not a price path. */
  note?: string;
  build: (usd: number, marks: Marks) => Omit<Strategy, 'id' | 'createdAt'>;
};

export type Replay = { ret: number; trades: number } | { failed: string };

/** The one window every replay covers, so the returns can be read against each other. */
export const LOOKBACK = '90d' as const;
/** The assets priced for ranges and stops. A module constant, so the price hook is asked the same question each draw. */
export const PRICED: string[] = ['WETH', 'CBBTC'];

const NAMES: Record<PricedSymbol, string> = { WETH: 'ETH', CBBTC: 'Bitcoin' };
/** What a replay spends a run: returns are percentages, so the size only has to be real. */
const REPLAY_USD = 50;
/** The band either side of today's price — the one the range screen suggests (`app/strategy/grid.tsx`). */
const RANGE_PCT = 0.12;
const RANGE_STEPS = 4;
const STOP_PCT = 10;
const TARGET_PCT = 25;
const BREAKOUT_DAYS = 20;
const BREAKOUT_STOP_PCT = 8;

const markOf = (marks: Marks, sym: PricedSymbol): number => marks[sym] ?? 0;
const bandOf = (mark: number) => ({
  lower: Math.round(mark * (1 - RANGE_PCT)),
  upper: Math.round(mark * (1 + RANGE_PCT)),
});

function weeklyBuy(sym: PricedSymbol): StrategyTemplate {
  return {
    key: `dca-weekly-${sym}`,
    group: 'buys',
    title: `Weekly ${NAMES[sym]} buy`,
    what: 'The same amount every week, whatever the price.',
    replay: () =>
      system.backtestStrategy({ kind: 'dca', symbol: sym, lookback: LOOKBACK, params: { usd: REPLAY_USD, everyNDays: 7 } }),
    build: (usd) => ({
      kind: 'dca',
      state: 'live',
      label: `$${usd} of ${sym}, weekly`,
      symbol: sym,
      params: { usd },
      cadence: 'weekly',
      nextRunAt: Date.now(),
      dailyAllocationUsd: usd,
    }),
  };
}

function dailyBuy(sym: PricedSymbol): StrategyTemplate {
  return {
    key: `dca-daily-${sym}`,
    group: 'buys',
    title: `Daily ${NAMES[sym]} buy`,
    what: 'A smaller amount every day, so no single day decides the price.',
    replay: () =>
      system.backtestStrategy({ kind: 'dca', symbol: sym, lookback: LOOKBACK, params: { usd: REPLAY_USD, everyNDays: 1 } }),
    build: (usd) => ({
      kind: 'dca',
      state: 'live',
      label: `$${usd} of ${sym}, daily`,
      symbol: sym,
      params: { usd },
      cadence: 'daily',
      nextRunAt: Date.now(),
      dailyAllocationUsd: usd,
    }),
  };
}

function breakout(sym: PricedSymbol): StrategyTemplate {
  return {
    key: `momentum-${sym}`,
    group: 'trading',
    title: `${NAMES[sym]} breakouts`,
    what: `Buys a ${BREAKOUT_DAYS}-day breakout, with an ${BREAKOUT_STOP_PCT}% stop on every entry.`,
    replay: () => repos.bot.backtest('momentum-scout', LOOKBACK, sym),
    build: (usd) => ({
      kind: 'momentum',
      state: 'live',
      label: `${NAMES[sym]} breakouts, $${usd} an entry`,
      symbol: sym,
      params: { usdPerEntry: usd, lookbackDays: BREAKOUT_DAYS, stopPct: BREAKOUT_STOP_PCT },
      cadence: 'daily',
      nextRunAt: Date.now(),
      dailyAllocationUsd: usd,
    }),
  };
}

function range(sym: PricedSymbol): StrategyTemplate {
  return {
    key: `grid-${sym}`,
    group: 'trading',
    title: `${NAMES[sym]} range`,
    what: 'Buys a rung lower and sells a rung higher, within 12% of today’s price.',
    needs: sym,
    replay: (marks) =>
      system.backtestStrategy({
        kind: 'grid',
        symbol: sym,
        lookback: LOOKBACK,
        params: { ...bandOf(markOf(marks, sym)), steps: RANGE_STEPS, usdPerStep: REPLAY_USD },
      }),
    build: (usd, marks) => {
      const band = bandOf(markOf(marks, sym));
      return {
        kind: 'grid',
        state: 'live',
        label: `${sym} ${money(band.lower, { fractionDigits: 0 })}–${money(band.upper, { fractionDigits: 0 })}`,
        symbol: sym,
        params: { ...band, steps: RANGE_STEPS, usdPerStep: usd },
        cadence: 'daily',
        nextRunAt: Date.now(),
        // The most it can have at work: one rung per level.
        dailyAllocationUsd: usd * RANGE_STEPS,
      };
    },
  };
}

function stops(sym: PricedSymbol): StrategyTemplate {
  return {
    key: `exit-${sym}`,
    group: 'protect',
    title: `${NAMES[sym]} stop and target`,
    what: `Sells ${NAMES[sym]} you hold at −${STOP_PCT}%, or takes profit at +${TARGET_PCT}%. It never buys.`,
    needs: sym,
    note: 'Acts only on what you hold',
    build: (usd, marks) => ({
      kind: 'exit-rules',
      state: 'live',
      label: `${NAMES[sym]} stop −${STOP_PCT}%, target +${TARGET_PCT}%`,
      symbol: sym,
      params: { entryPrice: markOf(marks, sym), stopLossPct: STOP_PCT, takeProfitPct: TARGET_PCT },
      cadence: 'daily',
      nextRunAt: Date.now(),
      dailyAllocationUsd: usd,
    }),
  };
}

export const STRATEGY_TEMPLATES: readonly StrategyTemplate[] = [
  weeklyBuy('WETH'),
  weeklyBuy('CBBTC'),
  dailyBuy('WETH'),
  dailyBuy('CBBTC'),
  breakout('WETH'),
  breakout('CBBTC'),
  range('WETH'),
  range('CBBTC'),
  stops('WETH'),
  stops('CBBTC'),
  {
    key: 'yield-USDC',
    group: 'cash',
    title: 'Idle cash to yield',
    what: 'Supplies idle cash at the rate the pool publishes.',
    note: 'Earns the pool’s rate · not a price bet',
    build: (usd) => ({
      kind: 'yield-rotation',
      state: 'live',
      label: 'Idle cash to yield, daily',
      symbol: 'USDC',
      params: { usd, keepCashUsd: 0, minMoveUsd: 25 },
      cadence: 'daily',
      nextRunAt: Date.now(),
      dailyAllocationUsd: usd,
    }),
  },
  {
    key: 'rebalance-mix',
    group: 'cash',
    title: 'ETH and Bitcoin mix',
    what: 'Keeps 50% in ETH and 30% in Bitcoin; the rest stays cash.',
    note: 'Trades only the drift from the mix',
    build: (usd) => ({
      kind: 'rebalance',
      state: 'live',
      label: 'Rebalance to 50% ETH, 30% Bitcoin',
      symbol: 'PORTFOLIO',
      params: { targets: { WETH: 50, CBBTC: 30 } },
      cadence: 'weekly',
      nextRunAt: Date.now(),
      dailyAllocationUsd: usd,
    }),
  },
];

/** Made money over the window. */
export function isWorking(replay: Replay | undefined): boolean {
  return !!replay && !('failed' in replay) && replay.ret > 0;
}

/** Best first: a return, then what does not bet on price, then what lost, then what could not say. */
export function scoreOf(template: StrategyTemplate, replay: Replay | undefined): number {
  if (!template.replay) return 0;
  if (!replay || 'failed' in replay) return Number.NEGATIVE_INFINITY;
  return replay.ret;
}

/** Today's prices for the priced assets, from whatever the price hook holds. */
export function marksOf(quotes: Readonly<Record<string, { price?: number | null } | undefined>>): Marks {
  const out: Marks = {};
  for (const sym of PRICED as PricedSymbol[]) {
    const price = quotes[sym]?.price;
    if (typeof price === 'number' && price > 0) out[sym] = price;
  }
  return out;
}

type Picker = {
  chosen: ReadonlySet<string>;
  replays: Readonly<Record<string, Replay>>;
  toggle: (key: string) => void;
  choose: (keys: readonly string[]) => void;
  unchoose: (keys: readonly string[]) => void;
  clear: () => void;
  record: (key: string, replay: Replay) => void;
  /** A replay that failed is asked again the next time a screen shows it. */
  forgetFailures: () => void;
};

export const useAgentStrategies = create<Picker>((set) => ({
  chosen: new Set(),
  replays: {},
  toggle: (key) =>
    set((s) => {
      const next = new Set(s.chosen);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return { chosen: next };
    }),
  choose: (keys) => set((s) => ({ chosen: new Set([...s.chosen, ...keys]) })),
  unchoose: (keys) =>
    set((s) => {
      const next = new Set(s.chosen);
      for (const k of keys) next.delete(k);
      return { chosen: next };
    }),
  clear: () => set({ chosen: new Set() }),
  record: (key, replay) => set((s) => ({ replays: { ...s.replays, [key]: replay } })),
  forgetFailures: () =>
    set((s) => ({ replays: Object.fromEntries(Object.entries(s.replays).filter(([, r]) => !('failed' in r))) })),
}));

/** Replays asked for and not yet answered, across both screens, so neither asks twice. */
const inflight = new Set<string>();

/**
 * Asks the executor for every replay not yet held, one at a time: each replays real history the executor rate-limits, and
 * each lands on its row as it answers. A range waits for today's price, since its band is drawn against it.
 */
export function useStrategyReplays(marks: Marks, enabled: boolean): void {
  const record = useAgentStrategies((s) => s.record);
  const weth = marks.WETH;
  const cbbtc = marks.CBBTC;
  useEffect(() => {
    if (!enabled) return;
    let alive = true;
    void (async () => {
      for (const t of STRATEGY_TEMPLATES) {
        if (!alive) return;
        if (!t.replay || inflight.has(t.key) || useAgentStrategies.getState().replays[t.key]) continue;
        const now: Marks = { WETH: weth, CBBTC: cbbtc };
        if (t.needs && !now[t.needs]) continue;
        inflight.add(t.key);
        try {
          const r = await t.replay(now);
          record(t.key, { ret: r.ret, trades: r.trades });
        } catch (e) {
          record(t.key, { failed: errorText(e) });
        } finally {
          inflight.delete(t.key);
        }
      }
    })();
    return () => {
      alive = false;
    };
  }, [enabled, weth, cbbtc, record]);
}
