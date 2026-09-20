/**
 * Nasdaq market hours and the off-hours decoupling guard — PLAN.md §8.4.
 *
 * xStocks trade 24/7 on X Layer, but the underlying US equities only trade during Nasdaq regular
 * and extended sessions.
 *
 * Sessions (America/New_York):
 * - Pre-market:    04:00 - 09:30 ET (Mon-Fri)
 * - Regular:       09:30 - 16:00 ET (Mon-Fri)
 * - After-hours:   16:00 - 20:00 ET (Mon-Fri)
 * - Closed:        20:00 - 04:00 ET overnight, and Friday 20:00 - Monday 04:00 ET
 *
 * While the underlying exchange is closed, a Uniswap pool price can drift away from what the share
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
 * So the reference comes from a real, separate market: the same xStock on Solana, where Jupiter's public price API
 * (keyless) reports xStocks' own reference price for the underlying share (`stockData.price`). Different chain,
 * different pools, same underlying — if the two disagree, one of them has decoupled. It is not the Nasdaq print and
 * does not claim to be. The wrapper on X Layer carries the issuer's multiplier (splits, reinvested dividends), so the
 * reference is the share price times the wrapper's own `convertToAssets(1e18)`: measured 2026-09-19, SPYx $761.34 ×
 * 1.00571 = $765.69 against the pool's $765.62, NVDAx $219.49 × 1.00170 = $219.86 against $220.17.
 *
 * When no reference is available, this module does not guess. It reports `spreadBps: null` and,
 * outside regular hours, holds: the guard exists to detect decoupling, and "I could not measure it"
 * is not the same answer as "there is none".
 */
import { underlyingTicker } from './edgar.js';
import { getJson } from '../http/get.js';
import { stockKey } from '../venues/stocks.js';
import { readMultiplierOrNull } from '../venues/multiplier.js';

/**
 * The same xStocks on Solana — reference data, the mints Backed issued there. Used only to ask Jupiter's price API for
 * xStocks' reference price of the underlying share; nothing here touches Solana.
 */
const SOLANA_XSTOCK_MINTS: Record<string, string> = {
  NVDAx: 'Xsc9qvGR1efVDFGLrVsmkzv3qi45LTBjeUKSPmx9qEh',
  TSLAx: 'XsDoVfqeBukxuZHWhdvWHBhgEHjGNst4MLodqsJHzoB',
  AAPLx: 'XsbEhLAtcf6HdfpFZ5xEMdqW8nfAvcsP5bdudRLJzJp',
  MSFTx: 'XspzcW1PRtgf6Wj92HCiZdjzKCyFekVD8P5Ueh3dRMX',
  AMZNx: 'Xs3eBt7uRfJX8QUs4suhyU8p2M6DoUDrJyWBa8LLZsg',
  GOOGLx: 'XsCPL9dNWBMvFtTmwcCA5v3xWPSMEBCszbQdiLLq6aN',
  METAx: 'Xsa62P5mvPszXL1krVUnU5ar38bBSVcWAB6fmPCo5Zu',
  MSTRx: 'XsP7xzNPvEHS1m6qfanPUGjNmdnmsLKEoNAnHjdxxyZ',
  COINx: 'Xs7ZdzSHLU9ftNJsii5fCeJhoRWSC32SQGzGQtePxNu',
  SPYx: 'XsoCS1TfEyfFhfvj8EtZ528L3CaKBDBRqRapnBbDF2W',
  QQQx: 'Xs8S1uUs1zvS2p7iwtsG3b6fkhpvmwz4GYU3gWAmWHZ',
};

const JUPITER_PRICE_API = 'https://lite-api.jup.ag/price/v3';

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
 * A second opinion on what one wrapped xStock is worth, or null when there is not one.
 *
 * xStocks' reference price for the underlying share, as Jupiter reports it for the same xStock on Solana, times the X
 * Layer wrapper's multiplier. Null when the symbol has no Solana counterpart, when Jupiter does not answer or answers
 * without a share price, or when the wrapper's multiplier cannot be read — each a real answer, none papered over.
 */
export async function referencePriceUsd(symbol: string): Promise<number | null> {
  return (await referencePricesUsd([symbol])).get(stockKey(symbol) ?? symbol) ?? null;
}

/**
 * The same second opinion for several tokens, in ONE request to Jupiter.
 *
 * The catalog asks for all eleven at once. Asked one at a time that is eleven round trips on a cold cache, for a
 * screen — and Jupiter's `ids` parameter takes a list, so it is one. Multipliers are still a chain read apiece, in
 * parallel, alongside the eleven pool quotes the catalog already makes.
 *
 * Keyed by the registry's spelling (`stockKey`), so a caller gets back what it can look up. A symbol with no Solana
 * counterpart is absent, exactly as it is null from the single-symbol form.
 */
export async function referencePricesUsd(symbols: string[]): Promise<Map<string, number>> {
  const wanted = new Map<string, string>();
  for (const s of symbols) {
    const key = stockKey(s);
    const mint = key ? SOLANA_XSTOCK_MINTS[key] : undefined;
    if (key && mint) wanted.set(key, mint);
  }
  const out = new Map<string, number>();
  if (wanted.size === 0) return out;

  const shares = await getJson<Record<string, { stockData?: { price?: number } } | undefined>>(
    `${JUPITER_PRICE_API}?ids=${[...wanted.values()].join(',')}`,
    60_000,
    6_000,
    {},
    { attempts: 1 },
  ).catch(() => ({}) as Record<string, { stockData?: { price?: number } } | undefined>);

  await Promise.all(
    [...wanted].map(async ([key, mint]) => {
      const share = shares[mint]?.stockData?.price;
      if (typeof share !== 'number' || !Number.isFinite(share) || share <= 0) return;
      const reading = await readMultiplierOrNull(key).catch(() => null);
      if (!reading) return;
      out.set(key, share * reading.multiplier);
    }),
  );
  return out;
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
  const drift = spreadPct === null ? '' : ` Drift against the Solana reference is ${(spreadPct * 100).toFixed(2)}%.`;

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
        reason: `Nasdaq ${session.phase} and the pool has drifted ${(spreadPct * 100).toFixed(2)}% from the Solana reference, past 1.2%. Holding until the regular session.`,
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
      reason: `Nasdaq is closed (${session.phase}) and the pool has drifted ${(spreadPct * 100).toFixed(2)}% from the Solana reference, past 1.5%. Holding to protect against off-hours slippage.`,
    };
  }

  return {
    session: 'closed',
    spreadBps,
    spreadPct,
    action: 'widen_slippage',
    suggestedSlippageBps: 120,
    reason: `Nasdaq is closed (${session.phase}), and the pool is still tracking the Solana reference to within ${(spreadPct * 100).toFixed(2)}%. Trading 24/7 with a 120 bps slippage guard.`,
  };
}
