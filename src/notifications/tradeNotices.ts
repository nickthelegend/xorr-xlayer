/**
 * Which rows on the trail deserve a banner on the phone, while the app is open (2026-09-25).
 *
 * The executor pushes every fill (`server/src/executor/run.ts`, kind `dca-executed`), but a push needs a device token,
 * and a build without an EAS project — the simulator build among them — never gets one (`register()` says
 * 'unconfigured'). So an agent could trade while its owner was looking straight at the app and the phone would stay
 * silent. While the app is open, it watches its own trail instead, and a new fill raises the same banner a push would
 * have. Pure, so it can be tested without the native module.
 */
import type { ActivityEvent } from '@/data/types';

/** Rows that are money moving: a fill, or cash put to work. Refusals and notes are read on the trail, not buzzed. */
const BANNER_KINDS: ReadonlySet<ActivityEvent['kind']> = new Set(['trade', 'yield']);

/** More than this at once is a backlog, not news: the newest few are shown, and the trail holds the rest. */
export const MAX_BANNERS = 3;

const seqOf = (e: ActivityEvent): number => {
  const n = Number(e.id);
  return Number.isSafeInteger(n) ? n : -1;
};

/**
 * The rows newer than `seen` that should raise a banner, oldest first, and the new high-water mark.
 *
 * `seen` undefined is the first read after launch or sign-in: it sets the mark and raises nothing, so opening the app
 * never replays yesterday's fills as if they had just happened.
 */
export function freshTrades(
  events: readonly ActivityEvent[],
  seen: number | undefined,
): { banners: ActivityEvent[]; newest: number | undefined } {
  const newest = events.reduce<number | undefined>((max, e) => {
    const s = seqOf(e);
    return s >= 0 && (max === undefined || s > max) ? s : max;
  }, seen);
  if (seen === undefined) return { banners: [], newest };
  const banners = events
    .filter((e) => seqOf(e) > seen && BANNER_KINDS.has(e.kind))
    .sort((a, b) => seqOf(a) - seqOf(b))
    .slice(-MAX_BANNERS);
  return { banners, newest };
}

/** What the banner says: who did it and what, then the row's own sentence. */
export function bannerFor(e: ActivityEvent): { title: string; body: string; data: Record<string, string> } {
  return {
    title: e.agent ? `${e.agent} · ${e.action}` : e.action,
    body: e.detail,
    // The shape a push carries (`deepRouteFor`), so a tap opens this row exactly as a push's tap would.
    data: { kind: 'dca-executed', seq: e.id, route: '/activity' },
  };
}
