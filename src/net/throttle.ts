/**
 * When something is refusing to be asked again yet, and what to say about it.
 *
 * Two different throttles reach a user of this app, and they are not the same event:
 *
 *   - **Ours.** `server/src/http/rate-limit.ts` answers 429 with a `retry-after` when one caller asks too
 *     often. Every screen that reads a market polls, so a phone left on the Markets tab with a chart open
 *     can walk into it — and when it does, EVERY screen starts failing at once. Each one rendering its own
 *     "that did not load" composes into "the app is broken", which is a much worse description of a
 *     sixty-second window than the truth.
 *   - **An upstream's.** `server/src/http/get.ts` opens a circuit breaker on a host after a run of
 *     failures and then fails fast rather than spending twenty-five seconds per request retrying a dead
 *     dependency. `/health` publishes exactly which hosts are shut out and until when. While one is open,
 *     prices and quotes are being answered from fewer sources — which is worth saying, because the honest
 *     version of this app says when a number is coming from somewhere different than usual.
 *
 * Both are temporary and neither is a fault the user caused or can fix, so neither gets an error screen.
 * They get a sentence and a time, and the app keeps working.
 *
 * Pure, so the wording and the arithmetic are tested on Node. The store that holds the observation is
 * `throttleStore.ts`; what it holds comes from real 429s and real `/health` reports, never from a guess.
 */

/** A host the executor's breaker has shut out, as `/health` reports it. */
export type Breaker = { host: string; failures: number; openUntil: number; open?: boolean };

export type ThrottleState = {
  /**
   * When our own limiter said we could ask again, in epoch ms. Zero where it has not refused us.
   *
   * Recorded from the `retry-after` on a real 429 — never estimated. A guess here would be a countdown to
   * a moment nothing happens at.
   */
  limitedUntil: number;
  /** Hosts the executor's breakers have open, and when the longest of them closes. */
  breakers: Breaker[];
};

export const NO_THROTTLE: ThrottleState = { limitedUntil: 0, breakers: [] };

/** The breakers that are open right now. `open` is the executor's own verdict; `openUntil` is the fallback. */
export function openBreakers(breakers: readonly Breaker[], now: number = Date.now()): Breaker[] {
  return breakers.filter((b) => b.open ?? b.openUntil > now);
}

export type ThrottleBanner = {
  /** What is happening, in the fewest words that are still true. */
  title: string;
  /** What it means for what is on screen. */
  detail: string;
  /** Whether this is us refusing the app, or a dependency being routed around. */
  scope: 'app' | 'upstream';
};

/**
 * The banner, or nothing.
 *
 * Ours wins where both are true. If our own limiter is refusing this device, a sentence about an upstream
 * is about a problem the user is not currently having: nothing is reaching the upstream either.
 */
export function throttleBanner(state: ThrottleState, now: number = Date.now()): ThrottleBanner | undefined {
  if (state.limitedUntil > now) {
    const seconds = Math.ceil((state.limitedUntil - now) / 1000);
    return {
      scope: 'app',
      title: 'Easing off for a moment',
      /*
       * Two facts, in this order: nothing is wrong, and nothing has been lost. Someone watching a portfolio
       * stop updating assumes the worse of those two, and the cost of not saying it is that they reload,
       * which is the one thing that makes this last longer.
       */
      detail:
        `This app asked for more than its share, so reads are paused for about ${seconds}s. ` +
        'Nothing has failed and nothing was sent twice — screens will fill in again on their own.',
    };
  }

  const open = openBreakers(state.breakers, now);
  if (open.length === 0) return undefined;

  return {
    scope: 'upstream',
    title: open.length === 1 ? 'One price source is not answering' : `${open.length} price sources are not answering`,
    detail:
      `${hostList(open)} stopped answering, so the executor is routing around ${open.length === 1 ? 'it' : 'them'} ` +
      'rather than waiting. Some prices and quotes may be missing until it recovers — a missing one is shown as ' +
      'missing, never filled in from somewhere else.',
  };
}

/** The hosts, named. They are named because "a dependency" is not something anyone can check. */
function hostList(open: readonly Breaker[]): string {
  const hosts = open.map((b) => b.host);
  if (hosts.length === 1) return hosts[0]!;
  if (hosts.length === 2) return `${hosts[0]} and ${hosts[1]}`;
  return `${hosts.slice(0, -1).join(', ')} and ${hosts[hosts.length - 1]}`;
}
