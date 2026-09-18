/**
 * format.ts — state.md's formatting rules.
 *
 * `Price` and `Value` deliberately do not format: they would have to guess the fraction
 * digits, and a guess in a price column is worse than no help. These are the guess made
 * once, correctly, where a screen can reach it.
 *
 * The rules themselves live in `@/format` and are **not** reimplemented here. They were
 * duplicated for a while — two `money()`s, same intent, different option shapes — which is
 * exactly how a thousands separator ends up on one screen and not the next. This module is
 * now the design system's *view* of that one implementation: the same functions under the
 * argument shapes `src/ui` presents.
 *
 * The two rules the shared implementation enforces, restated because they are design
 * decisions rather than utility trivia:
 *
 *   - Bare `toFixed(2)` on a four-figure number drops the thousands separator. Every money
 *     value that can exceed 999 goes through `toLocaleString('en-US')` with explicit
 *     fraction digits.
 *   - Negatives use **U+2212 (−)**, not a hyphen. A hyphen at 11px beside a tabular digit
 *     reads as a range dash, not a minus.
 */
import * as base from '@/format';

/** U+2212. Not `-`. */
export const MINUS = base.MINUS;

/** `$4,862.18`. Two decimals, separators, U+2212 for a debit. */
export function money(value: number, options?: { signed?: boolean; decimals?: number }): string {
  return base.money(value, {
    fractionDigits: options?.decimals ?? 2,
    explicitSign: options?.signed ?? false,
  });
}

/** `$66,560` — a price read off a chart, not a balance acted on. */
export function wholeMoney(value: number, options?: { signed?: boolean }): string {
  return base.money(value, { fractionDigits: 0, explicitSign: options?.signed ?? false });
}

/**
 * A price, with the decimals its magnitude calls for:
 * ≥1000 → no decimals plus separators · under 1000 → 2dp · sub-dollar → 4dp.
 */
export function price(value: number): string {
  return base.price(value);
}

/** `+1.0%` / `−1.0%`. One decimal, always signed. */
export function percent(value: number, decimals = 1): string {
  return base.percent(value, { digits: decimals, explicitSign: true });
}

/** A crypto quantity. 4dp by convention; 2dp for a display balance. */
export function quantity(value: number, decimals = 4): string {
  return base.quantity(value, decimals);
}
