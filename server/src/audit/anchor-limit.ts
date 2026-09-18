/**
 * How often a wallet may be anchored on demand (PLAN.md 1.12).
 *
 * `POST /audit/anchor` publishes the trail's head to Base and pays for it from the bot's own key. It
 * skipped an unchanged head, but any change — a pause, a resume, anything that writes a trail row —
 * made the next press a real transaction, so a loop of toggle-and-anchor could spend the delegate's
 * gas without limit. The hourly sweep anchors every wallet anyway; on demand is for "publish what I
 * just did", and once an hour is enough for that.
 *
 * Counted from the CHAIN — the last anchor's own block timestamp — so the limit cannot be reset by
 * anything this server stores.
 */
export const ON_DEMAND_ANCHOR_EVERY_SEC = 3_600;

/** Seconds until this wallet may be anchored on demand again: 0 when it may be now. */
export function anchorCooldownSec(lastAnchorAtSec: number | undefined, nowSec: number): number {
  if (lastAnchorAtSec === undefined) return 0;
  return Math.max(0, lastAnchorAtSec + ON_DEMAND_ANCHOR_EVERY_SEC - nowSec);
}
