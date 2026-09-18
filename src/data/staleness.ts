/**
 * Saying that a number on screen is from before the outage.
 *
 * The offline banner says the executor cannot be reached. It does not say which of the figures
 * underneath it are still true, and `Reachability.tsx` already names the danger this creates:
 * every screen catches its own failure and renders its own local emptiness — no positions, no
 * strategies, "nothing has settled yet" — which compose into a confident and completely false
 * picture of an account with nothing in it.
 *
 * Keeping the last good read instead of emptying the screen fixes that and introduces the opposite
 * hazard, which is worse: a balance from twenty minutes ago, drawn exactly like a live one, on a
 * screen someone is reading to decide whether to intervene. A cached figure presented as current is
 * a lie with a timestamp we chose not to show.
 *
 * So cached data is always labelled and always dated. The rule this file exists to enforce is that
 * there is no third option — a figure is live, or it says when it was read.
 */

export type Freshness =
  /** Read just now, from a reachable executor. Draw it plainly. */
  | { state: 'live' }
  /** The last good read, and how long ago. Must be labelled wherever it is drawn. */
  | { state: 'last-known'; at: number; label: string }
  /** Nothing has ever been read. Not a value to dress up — the screen shows its empty state. */
  | { state: 'never' };

/**
 * How old a reading is, in words.
 *
 * Coarse, and deliberately pessimistic at the boundaries: "a minute ago" for anything under two is
 * a smaller claim than "just now", and on a screen about money the smaller claim is the safer one.
 */
export function ageLabel(at: number, now: number): string {
  const seconds = Math.max(0, Math.round((now - at) / 1000));
  if (seconds < 60) return 'less than a minute ago';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? '' : 's'} ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? '' : 's'} ago`;
  const days = Math.floor(hours / 24);
  return `${days} day${days === 1 ? '' : 's'} ago`;
}

/**
 * What the screen is actually showing.
 *
 * `reachable` is the executor's own heartbeat rather than anything this read knows, because a read
 * that succeeded before the connection dropped has no idea it is now stale. That is exactly the
 * case being guarded: the figure is fine, the moment has passed, and only the heartbeat knows.
 */
export function freshness(params: {
  /** Whether this read has ever produced data. */
  hasData: boolean;
  /** When it settled. Undefined before the first answer. */
  settledAt: number | undefined;
  /** Whether the executor is answering right now. */
  reachable: boolean;
  now: number;
}): Freshness {
  if (!params.hasData || params.settledAt === undefined) return { state: 'never' };
  if (params.reachable) return { state: 'live' };
  return {
    state: 'last-known',
    at: params.settledAt,
    label: `Last read ${ageLabel(params.settledAt, params.now)}`,
  };
}

/**
 * Whether a figure may be drawn as though it were current.
 *
 * One call, so a screen cannot accidentally render cached data plainly by forgetting to check —
 * the answer is either "yes" or a label that has to go somewhere.
 */
export function isLive(f: Freshness): boolean {
  return f.state === 'live';
}
