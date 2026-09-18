/**
 * Nasdaq market hours and the off-hours decoupling guard — PLAN.md §8.4.
 *
 * xStocks trade 24/7 on Solana, but the underlying US equities only trade during Nasdaq regular
 * and extended sessions.
 *
 * Sessions (America/New_York):
 * - Pre-market:    04:00 - 09:30 ET (Mon-Fri)
 * - Regular:       09:30 - 16:00 ET (Mon-Fri)
 * - After-hours:   16:00 - 20:00 ET (Mon-Fri)
 * - Closed:        20:00 - 04:00 ET overnight, and Friday 20:00 - Monday 04:00 ET
 *
 * While the underlying exchange is closed, a Jupiter pool price can drift away from what the share
 * is actually worth, because nothing is arbitraging it back. This module measures that drift and
 * says whether to widen slippage or stand down.
 *
 * ## The reference price, and what happens without one
 *
 * Measuring drift needs a second, independent price for the same underlying. There is no free
 * Nasdaq feed this project can reach, and a table of hard-coded "reference" prices is a fabrication
 * that goes stale the day it is written — the earlier version of this file carried one, and every
 * verdict it produced was measured against numbers nobody had checked since.
 *
 * So the reference comes from a real venue: the same company's tokenized share on Base, priced from
 * a live 1inch route by `venues/stocks.ts`. Different chain, different pools, same underlying — if
 * the two disagree, one of them has decoupled. It is not the Nasdaq print and does not claim to be.
 *
 * When no reference is available, this module does not guess. It reports `spreadBps: null` and,
 * outside regular hours, holds: the guard exists to detect decoupling, and "I could not measure it"
 * is not the same answer as "there is none".
 */
import { underlyingTicker } from './edgar.js';
import { stockPriceUsd } from '../venues/stocks.js';

export { underlyingTicker };

export type NasdaqSessionType = 'regular' | 'extended' | 'closed';

export type NasdaqSessionDetail = {
  session: NasdaqSessionType;
  phase: 'pre-market' | 'regular' | 'after-hours' | 'overnight' | 'weekend';
  isExchangeOpen: boolean;
  easternTime: string;
  dayOfWeek: number; // 0 = Sun, 1 = Mon, ..., 6 = Sat
  hourET: number;
  minuteET: number;
};

export type OffHoursGuardVerdict = {
  session: NasdaqSessionType;
  /** Null when no independent reference price was available, so no drift could be measured. */
  spreadBps: number | null;
  spreadPct: number | null;
  action: 'normal' | 'widen_slippage' | 'hold';
  suggestedSlippageBps: number;
  reason: string;
};

/** Above this in an extended session, the pool and the reference are telling different stories. */
const EXTENDED_HOLD_PCT = 0.012;
/** Above this while the exchange is shut. Wider, because nothing is arbitraging the gap closed. */
const CLOSED_HOLD_PCT = 0.015;

/**
 * A second opinion on what the underlying share is worth, or null when there is not one.
 *
 * The same company's tokenized share on Base, priced from a live 1inch route. Returns null for an
 * xStock with no Base counterpart (the index products, for instance) and for any symbol the Base
 * venue cannot route right now — both of which are real answers, and neither of which this module
 * papers over.
 */
export async function referencePriceUsd(symbol: string): Promise<number | null> {
  const ticker = underlyingTicker(symbol);
  return await stockPriceUsd(`${ticker}c`).catch(() => null);
}

/**
 * Computes current Nasdaq session state based on the America/New_York clock.
 */
export function getNasdaqSession(now: Date = new Date()): NasdaqSessionDetail {
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    hour12: false,
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
  });

  const parts = formatter.formatToParts(now);
  let weekdayStr = 'Mon';
  let hourET = 12;
  let minuteET = 0;

  for (const p of parts) {
    if (p.type === 'weekday') weekdayStr = p.value;
    if (p.type === 'hour') hourET = parseInt(p.value, 10);
    if (p.type === 'minute') minuteET = parseInt(p.value, 10);
  }

  const dayMap: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  const dayOfWeek = dayMap[weekdayStr] ?? 1;
  const timeInMinutes = hourET * 60 + minuteET;
  const easternTime = `${String(hourET).padStart(2, '0')}:${String(minuteET).padStart(2, '0')} ET`;
  const base = { easternTime, dayOfWeek, hourET, minuteET };

  const isWeekend =
    dayOfWeek === 6 ||
    dayOfWeek === 0 ||
    (dayOfWeek === 5 && timeInMinutes >= 20 * 60) ||
    (dayOfWeek === 1 && timeInMinutes < 4 * 60);

  if (isWeekend) {
    return { session: 'closed', phase: 'weekend', isExchangeOpen: false, ...base };
  }

  // Pre-market: 04:00 to 09:30 ET
  if (timeInMinutes >= 4 * 60 && timeInMinutes < 9 * 60 + 30) {
    return { session: 'extended', phase: 'pre-market', isExchangeOpen: true, ...base };
  }

  // Regular market: 09:30 to 16:00 ET
  if (timeInMinutes >= 9 * 60 + 30 && timeInMinutes < 16 * 60) {
    return { session: 'regular', phase: 'regular', isExchangeOpen: true, ...base };
  }

  // After-hours: 16:00 to 20:00 ET
  if (timeInMinutes >= 16 * 60 && timeInMinutes < 20 * 60) {
    return { session: 'extended', phase: 'after-hours', isExchangeOpen: true, ...base };
  }

  // Overnight: 20:00 to 04:00 ET
  return { session: 'closed', phase: 'overnight', isExchangeOpen: false, ...base };
}

/**
 * Decides how much slippage an entry deserves right now, or whether to stand down.
 *
 * - Regular session: 50 bps and no drift question — the underlying is trading and the pool tracks it.
 * - Extended session: 75 bps, unless the measured drift exceeds 1.2%, which holds.
 * - Closed: 120 bps, unless the measured drift exceeds 1.5%, which holds.
 * - Outside regular hours with no reference price: hold. Unmeasured is not the same as fine.
 *
 * `referencePrice` is the caller's — `referencePriceUsd` fetches one, and passing null is the
 * honest way to say there was none.
 */
export function evaluateOffHoursGuard(params: {
  symbol: string;
  onChainPrice: number;
  referencePrice: number | null;
  now?: Date;
}): OffHoursGuardVerdict {
  const { onChainPrice, referencePrice, now } = params;
  const session = getNasdaqSession(now);

  const measurable = referencePrice !== null && referencePrice > 0 && onChainPrice > 0;
  const spreadPct = measurable
    ? Math.abs(onChainPrice - referencePrice) / referencePrice
    : null;
  const spreadBps = spreadPct === null ? null : Math.round(spreadPct * 10_000);
  const drift = spreadPct === null ? '' : ` Drift against the Base listing is ${(spreadPct * 100).toFixed(2)}%.`;

  if (session.session === 'regular') {
    return {
      session: 'regular',
      spreadBps,
      spreadPct,
      action: 'normal',
      suggestedSlippageBps: 50,
      reason: `Nasdaq regular hours (${session.easternTime}), so the underlying is trading and the pool is being arbitraged against it.${drift}`,
    };
  }

  if (spreadPct === null) {
    return {
      session: session.session,
      spreadBps: null,
      spreadPct: null,
      action: 'hold',
      suggestedSlippageBps: session.session === 'closed' ? 120 : 75,
      reason: `Nasdaq ${session.phase} and no independent price for ${params.symbol} to measure the pool against. Holding rather than entering on an unchecked price.`,
    };
  }

  if (session.session === 'extended') {
    if (spreadPct > EXTENDED_HOLD_PCT) {
      return {
        session: 'extended',
        spreadBps,
        spreadPct,
        action: 'hold',
        suggestedSlippageBps: 100,
        reason: `Nasdaq ${session.phase} and the pool has drifted ${(spreadPct * 100).toFixed(2)}% from the Base listing, past 1.2%. Holding until the regular session.`,
      };
    }
    return {
      session: 'extended',
      spreadBps,
      spreadPct,
      action: 'widen_slippage',
      suggestedSlippageBps: 75,
      reason: `Nasdaq ${session.phase} (${session.easternTime}).${drift} Thinner book, so slippage is set to 75 bps.`,
    };
  }

  if (spreadPct > CLOSED_HOLD_PCT) {
    return {
      session: 'closed',
      spreadBps,
      spreadPct,
      action: 'hold',
      suggestedSlippageBps: 150,
      reason: `Nasdaq is closed (${session.phase}) and the pool has drifted ${(spreadPct * 100).toFixed(2)}% from the Base listing, past 1.5%. Holding to protect against off-hours slippage.`,
    };
  }

  return {
    session: 'closed',
    spreadBps,
    spreadPct,
    action: 'widen_slippage',
    suggestedSlippageBps: 120,
    reason: `Nasdaq is closed (${session.phase}), and the pool is still tracking the Base listing to within ${(spreadPct * 100).toFixed(2)}%. Trading 24/7 with a 120 bps slippage guard.`,
  };
}
