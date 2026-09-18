/**
 * Formatting — state.md "Formatting rules". Every rule here was a real review finding in the
 * handoff; regressing one is a bug, not a nit.
 *
 *  - toLocaleString('en-US', {min/maxFractionDigits}) for any money that can exceed 999.
 *    Bare toFixed(2) drops thousands separators — found on the swap screen in review.
 *  - U+2212 (MINUS SIGN), not a hyphen, for negative numbers.
 *  - Percentages: 1dp with an explicit sign.
 *  - Crypto quantities: 4dp (SOL), 2dp for display balances.
 *  - Prices >= 1000: no decimals plus separators. Under 1000: 2dp. Sub-dollar: 4dp.
 */

/** U+2212 MINUS SIGN. Never use '-' (U+002D) in numeric output. */
export const MINUS = '−';

/** Replace any leading ASCII hyphen with U+2212. */
export function toMinus(s: string): string {
  return s.replace(/-/g, MINUS);
}

function localise(n: number, min: number, max: number): string {
  return Math.abs(n).toLocaleString('en-US', {
    minimumFractionDigits: min,
    maximumFractionDigits: max,
  });
}

/** Whether `n` prints as zero at `digits` decimal places. */
export function roundsToZero(n: number, digits: number): boolean {
  return Math.abs(n) < 0.5 * 10 ** -digits;
}

/*
 * The minus is judged on the figure as printed. A 24-hour change of −0.0001% printed as "−0.00%" — USDC on the
 * watchlist reading as a fall that no digit on screen shows. A figure that prints as zero is never negative; an explicit
 * sign still reads "+", as the formatting rules have every zero percentage do.
 */
function sign(n: number, explicit: boolean, digits: number): string {
  if (n < 0 && !roundsToZero(n, digits)) return MINUS;
  return explicit ? '+' : '';
}

/**
 * Money. Always separated, never toFixed.
 * @param fractionDigits default 2 — pass 0 for whole-dollar values like the spend cap.
 */
export function money(n: number, opts: { fractionDigits?: number; explicitSign?: boolean } = {}): string {
  const { fractionDigits = 2, explicitSign = false } = opts;
  return `${sign(n, explicitSign, fractionDigits)}$${localise(n, fractionDigits, fractionDigits)}`;
}

/**
 * A price, formatted by magnitude — state.md:
 * ">= 1000: no decimals plus separators. Under 1000: 2dp. Sub-dollar: 4dp."
 */
export function price(n: number): string {
  const a = Math.abs(n);
  if (a >= 1000) return `${sign(n, false, 0)}$${localise(n, 0, 0)}`;
  if (a >= 1) return `${sign(n, false, 2)}$${localise(n, 2, 2)}`;
  return `${sign(n, false, 4)}$${localise(n, 4, 4)}`;
}

/** Percentage: 1dp with an explicit sign. `+1.0%`, `−1.0%`; a change that prints as zero is never negative. */
export function percent(n: number, opts: { digits?: number; explicitSign?: boolean } = {}): string {
  const { digits = 1, explicitSign = true } = opts;
  return `${sign(n, explicitSign, digits)}${localise(n, digits, digits)}%`;
}

/** Crypto quantity — 4dp by default (SOL), 2dp for display balances. */
export function quantity(n: number, digits = 4): string {
  return `${sign(n, false, digits)}${localise(n, digits, digits)}`;
}

/**
 * A moment as a person reads one: "Sep 14, 7:08 AM", with the year only when it is not this year.
 *
 * Screens printed `toLocaleString('en-US')` — "9/14/2026, 7:08:08 AM", seconds and all — beside figures formatted with
 * care, and a History row read like a log line. In the device's own zone, as every other time on screen. A time that
 * is not a number is not known, so it is a dash.
 */
export function when(ms: number, now: number = Date.now()): string {
  if (!Number.isFinite(ms)) return '—';
  const d = new Date(ms);
  const thisYear = d.getFullYear() === new Date(now).getFullYear();
  return d.toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    ...(thisYear ? {} : { year: 'numeric' }),
    hour: 'numeric',
    minute: '2-digit',
  });
}

/** A time of day as a person reads one: "7:08 AM". No seconds, no leading zero. */
export function clock(ms: number): string {
  if (!Number.isFinite(ms)) return '—';
  return new Date(ms).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
}

/** A day as a person reads one: "Sep 14", with the year only when it is not this year. */
export function day(ms: number, now: number = Date.now()): string {
  if (!Number.isFinite(ms)) return '—';
  const d = new Date(ms);
  const thisYear = d.getFullYear() === new Date(now).getFullYear();
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', ...(thisYear ? {} : { year: 'numeric' }) });
}

/** A signed P&L amount, e.g. `+$318.40` / `−$96.00`. */
export function signedMoney(n: number, fractionDigits = 2): string {
  return money(n, { fractionDigits, explicitSign: true });
}

/** Compact notional for stat tiles: $182.4M, $1.06B. */
export function compactMoney(n: number): string {
  const a = Math.abs(n);
  const s = sign(n, false, 2);
  if (a >= 1e9) return `${s}$${(a / 1e9).toFixed(2)}B`;
  if (a >= 1e6) return `${s}$${(a / 1e6).toFixed(1)}M`;
  if (a >= 1e3) return `${s}$${(a / 1e3).toFixed(1)}K`;
  return `${s}$${localise(a, 2, 2)}`;
}

/** A price-axis label — design.md §6: `(tHi - t*(tHi-tLo))/1000` rendered as "66.7K". */
export function axisLabel(priceValue: number): string {
  return `${(priceValue / 1000).toFixed(1)}K`;
}

/** A countdown as HH:MM:SS — screen 25's "Next funding 02:14:38". */
export function countdown(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(h)}:${pad(m)}:${pad(sec)}`;
}

/** mm:ss — screen 12's proposal expiry "4:12". */
export function mmss(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

/**
 * A settlement date relative to now — replaces the handoff's hardcoded "Tue, Sep 8" [G42].
 * Business days only, because bank transfers do not settle at weekends.
 */
/**
 * An address, short enough to read and long enough to check.
 *
 * Six leading characters and four trailing: the first six cover `0x` plus four of the address, and
 * four at the end is what people actually compare against an explorer. Four-and-four, which the app
 * also uses in one place, leaves only two real characters at the front.
 *
 * Anything not long enough to shorten is returned as-is rather than mangled — a short string here
 * is a bug upstream, and hiding it behind an ellipsis would make it look deliberate.
 */
export function shortAddress(address: string | null | undefined, lead = 6, tail = 4): string {
  /*
   * Absent renders as a dash rather than throwing.
   *
   * This took `string` and called `.trim()` on it, so a field an older executor did not send
   * crashed the whole screen — `/sponsors` went to the error boundary because a rolling deploy left
   * one field undefined. A formatter is the wrong place to enforce a contract: it is called from
   * render, its callers are screens, and the blast radius of a throw is everything they were about
   * to draw. Formatting nothing is a dash; deciding whether nothing is acceptable belongs to the
   * screen, which can say so in words.
   *
   * An em dash, the app's mark for "not known". It was U+2212, the minus sign, which beside an
   * address reads as a negative number where there is no number at all.
   */
  if (!address) return '—';
  const a = address.trim();
  if (a.length <= lead + tail + 1) return a;
  return `${a.slice(0, lead)}…${a.slice(-tail)}`;
}

export function businessDaysFromNow(days: number, now: Date = new Date()): string {
  const d = new Date(now.getTime());
  let added = 0;
  while (added < days) {
    d.setDate(d.getDate() + 1);
    const wd = d.getDay();
    if (wd !== 0 && wd !== 6) added += 1;
  }
  return d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
}
