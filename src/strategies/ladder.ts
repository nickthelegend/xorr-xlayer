/**
 * The strategy ladder — PLAN.md §1.2.
 *
 * Ordered by how much the bot has to be RIGHT ABOUT THE FUTURE, not by how impressive it sounds.
 * "A user who has watched tier 1 work for three weeks will let the bot run tier 6. A user shown
 * tier 6 on day one will not fund the account. Do not reorder this."
 *
 * Each rung carries one line of copy, and none of it names a venue or a chain: the library is a list
 * of what the bot may do, not of whom it does it through. Why a rung sits where it does is the comment
 * above it.
 */
import type { StrategyKind } from '../data/types';
import type { FigureKind } from '../ui/mask';

type Rung = {
  tier: number;
  kind: StrategyKind;
  label: string;
  /** What it does, in one short line — the only copy its card carries. */
  what: string;
};

/**
 * A rung is set up somewhere in the app, or it is not available yet.
 *
 * Not a boolean beside a route every entry had to carry: tiers 6 and 7 were `available: true` with a
 * route of `/strategies`, the list their own cards sit in, so "Set it up" reopened the screen it was
 * pressed on. An unavailable rung has no button to point anywhere, and the type says so.
 */
export type LadderEntry = Rung &
  ({ available: true; cta: string; route: string } | { available: false });

export const STRATEGY_LADDER: LadderEntry[] = [
  // No forecast. Every run can be checked against the calendar.
  {
    tier: 1,
    kind: 'dca',
    label: 'Recurring buy',
    what: 'A fixed amount into one asset, on your schedule.',
    available: true,
    cta: 'Set up a recurring buy',
    route: '/strategy/dca',
  },
  // Deterministic. The only input is the user's own target.
  {
    tier: 2,
    kind: 'rebalance',
    label: 'Rebalance to targets',
    what: 'Holds the weights you approved, trading only the drift.',
    available: true,
    cta: 'Set target weights',
    route: '/(onboarding)/proposal',
  },
  /*
   * Risk-reducing only, which is what makes it easy to trust: it can only close.
   *
   * Exit rules attach to a position and are armed from it. Portfolio lists the positions, each opens
   * its own, and "Edit TP/SL" there is the screen that writes the rule (`app/auto-close/[id].tsx`).
   * This pointed at `/holdings`, whose rows open the asset screen, which has no exit control at all;
   * before that it was `/auto-close/current`, which was never a real id.
   */
  {
    tier: 3,
    kind: 'exit-rules',
    label: 'Take profit and stop loss',
    what: 'Closes a position at levels you set. It never opens one.',
    available: true,
    cta: 'Set exit rules',
    route: '/portfolio',
  },
  // Low judgement, and every move is a published rate anyone can check.
  {
    tier: 4,
    kind: 'yield-rotation',
    label: 'Move idle cash to yield',
    what: 'Supplies idle cash at the rate the pool publishes.',
    available: true,
    cta: 'Move idle cash to yield',
    route: '/strategy/yield',
  },
  // Mechanical. No forecast, but it assumes the range holds.
  {
    tier: 5,
    kind: 'grid',
    label: 'Range accumulation',
    what: 'Buys a rung lower and sells a rung higher, inside your range.',
    available: true,
    cta: 'Draw a range',
    route: '/strategy/grid',
  },
  /*
   * The first rung that needs the bot to be right about the future, so it asks before every entry
   * (`requiresApprovalByDefault` below, and the executor's own `APPROVAL_FIRST_KINDS`).
   *
   * Not available: the executor can run one, and nothing in the app can create one.
   */
  {
    tier: 6,
    kind: 'momentum',
    label: 'Momentum and breakouts',
    what: 'Buys strength on liquid majors, with a stop on every entry.',
    available: false,
  },
  // Most judgement, most ways to be wrong. Last — and not available, for the same reason as tier 6.
  {
    tier: 7,
    kind: 'event-driven',
    label: 'Events and earnings',
    what: 'Positions around scheduled events, and flattens before the print.',
    available: false,
  },
];

/** Approve-before-execute is ON by default from tier 6 up. PLAN.md 9.10. */
export function requiresApprovalByDefault(kind: StrategyKind): boolean {
  const entry = STRATEGY_LADDER.find((e) => e.kind === kind);
  return (entry?.tier ?? 99) >= 6;
}

/**
 * Where to set up the first of these kinds the app can create, or undefined when it can create none.
 *
 * An agent's "Add strategy" reads this. It fell back to `/strategies` for Momentum Scout and Earnings
 * Desk, a list neither of their kinds can be created from.
 */
export function setupFor(
  kinds: readonly StrategyKind[],
): { cta: string; route: string } | undefined {
  for (const entry of STRATEGY_LADDER) {
    if (entry.available && kinds.includes(entry.kind)) return { cta: entry.cta, route: entry.route };
  }
  return undefined;
}

/** A kind as a person reads it — "Recurring buy", not `dca`. One the ladder does not know keeps its own name. */
export function kindLabel(kind: string): string {
  return STRATEGY_LADDER.find((e) => e.kind === kind)?.label ?? kind;
}

/**
 * What a strategy's label is while balances are hidden (FEATURES.md #47). A label is written when the strategy is made,
 * and a recurring buy's carries its size — "$50 of WETH, weekly" — which is the person's money. A range's carries the
 * prices it trades between, which say nothing of how much is held, so those stay.
 */
export function labelFigure(kind: string): FigureKind {
  return kind === 'grid' ? 'market' : 'own';
}

/**
 * What a recurring buy can buy: the two the executor can route, settle and replay.
 *
 * Shared by the creator (`app/strategy/dca.tsx`) and the backtest (`app/backtest.tsx`), because the two
 * drifted. The backtest offered every tradable symbol, including ones a recurring buy can never be:
 *
 *  - USDC is what a buy is PAID IN, so "Buy $50 of USDC, weekly" is a swap from USDC to USDC, which
 *    1inch rejects outright — `src and dst should be different`, HTTP 400. The creator removed it for
 *    that reason, and the executor refuses it at creation. Idle USDC has its own rung, "Move idle cash
 *    to yield", which supplies it instead of swapping it for itself.
 *  - The tokenized equities have no price history to replay (`server/src/backtest/engine.ts` answers
 *    "No price history for …"), so a backtest of one could only fail.
 *
 * ETH settles as WETH, so offering both would be one asset twice.
 */
export const RECURRING_BUY_SYMBOLS = ['WETH', 'CBBTC'] as const;
export type RecurringBuySymbol = (typeof RECURRING_BUY_SYMBOLS)[number];
