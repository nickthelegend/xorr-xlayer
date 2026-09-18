/**
 * rollOver.ts — which way a figure turns when it changes.
 *
 * The one decision behind `<RollingNumber roll>` (FEATURES.md, animations.md "The balance roll-over"):
 * a balance that rose hands its changed characters upward, one that fell hands them downward. Pure, and
 * separate from the component, because it is the part that can be wrong in a way a screenshot does not
 * show — and the part a test can reach.
 *
 * It reads the two FORMATTED figures rather than the numbers behind them, because that is what the
 * component is handed: `<RollingNumber>` takes a string, deliberately, since `Price` does not format and
 * the screen has already decided the fraction digits. Parsing it back is only ever used to pick a
 * direction; no digit drawn on screen ever comes from here.
 */

/** U+2212, the minus every money figure here uses. A hyphen is accepted for figures formatted elsewhere. */
const MINUS_SIGNS = /−/g;

/**
 * The number a formatted figure states, or undefined if it states none.
 *
 * `$4,862.18` → 4862.18 · `−1.4%` → −1.4 · `—` → undefined. A dash is the app's "no value", and an
 * empty parse must not become 0: a balance arriving where a dash was has not "risen from zero", it has
 * simply become known, and treating it as a rise would roll every digit of a figure nothing replaced.
 */
export function figureValue(text: string): number | undefined {
  const bare = text.replace(MINUS_SIGNS, '-').replace(/[^0-9.-]/g, '');
  if (bare === '' || bare === '-' || bare === '.') return undefined;
  const n = Number(bare);
  return Number.isFinite(n) ? n : undefined;
}

/**
 * Which way the characters turn, going from `before` to `after`.
 *
 * `+1` up, `−1` down. When either figure states no number, or the two state the same one, the last
 * direction stands: nothing about the change says up or down, and reversing on a whim would make two
 * identical updates look like opposite events.
 */
export function rollDirection(before: string, after: string, last: number): number {
  const was = figureValue(before);
  const now = figureValue(after);
  if (was === undefined || now === undefined || was === now) return last;
  return now > was ? 1 : -1;
}
