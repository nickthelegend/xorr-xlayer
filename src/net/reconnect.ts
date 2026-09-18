/**
 * Saying that the app is still trying, and saying when it gets back.
 *
 * The offline banner was true and inert. "Can't reach xorr" with nothing moving reads as a verdict
 * — as though the app had given up and were waiting to be restarted — when in fact a health check
 * is going out every few seconds. Someone on a train watching a static banner has no way to tell a
 * dropped connection from a broken app, and the difference decides whether they wait or start
 * pulling their money out by hand.
 *
 * Two things fix that and both are about honesty rather than reassurance: show the attempt that is
 * actually happening, and say plainly when the connection comes back — because the screens behind
 * the banner are stale by then and nothing else would tell them.
 *
 * Nothing here invents a recovery. Every number comes from the heartbeat that is really running.
 */

/** Where the connection stands, as the provider knows it. */
export type ReconnectState = {
  reachable: boolean;
  /** When it was first seen down in this outage. Null while it has never been down. */
  downSince: number | null;
  /** How many health checks have failed in a row. 0 while up. */
  attempts: number;
  /** When the next check is due, as a timestamp. Null when one is in flight right now. */
  nextAttemptAt: number | null;
  /** When it last came back, so the recovery notice can expire. Null before the first recovery. */
  recoveredAt: number | null;
};

export type Banner = {
  title: string;
  detail: string;
  /** `down` is a failure; `back` is a recovery and reads in ordinary ink. */
  tone: 'down' | 'back';
  /** Whether a "Try now" control belongs on it — only while down and only between attempts. */
  retryable: boolean;
};

/**
 * How long the "back online" notice stays up.
 *
 * Long enough to be read, short enough that it is gone before it becomes furniture. It carries an
 * action, so it must not disappear while a thumb is on the way to it.
 */
export const RECOVERED_NOTICE_MS = 8_000;

/** Seconds until `at`, never negative and never zero while something is still pending. */
function secondsUntil(at: number, now: number): number {
  return Math.max(1, Math.round((at - now) / 1000));
}

/**
 * How long this outage has lasted, in words.
 *
 * Coarse on purpose. The useful distinction is "a moment ago" against "this has been going on",
 * because the second is the one that means the problem is probably not the lift you are in.
 */
export function outageLabel(downSince: number, now: number): string {
  const seconds = Math.max(0, Math.round((now - downSince) / 1000));
  if (seconds < 45) return 'just now';
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? '' : 's'}`;
  const hours = Math.round(minutes / 60);
  return `${hours} hour${hours === 1 ? '' : 's'}`;
}

/**
 * The banner to show, or null when there is nothing to say.
 *
 * Order matters: being down outranks having just come back, because a connection that dropped again
 * during the recovery notice is the more important fact.
 */
export function reconnectBanner(state: ReconnectState, now: number): Banner | null {
  if (!state.reachable) {
    return {
      title: 'Can’t reach xorr',
      detail: downDetail(state, now),
      tone: 'down',
      /*
       * Only between attempts. Offering "Try now" while a check is already in flight would let
       * someone tap a button that does nothing and conclude the app is broken — which is the exact
       * impression this whole file exists to remove.
       */
      retryable: state.nextAttemptAt !== null,
    };
  }

  if (state.recoveredAt !== null && now - state.recoveredAt < RECOVERED_NOTICE_MS) {
    return {
      title: 'Back online',
      /*
       * The reload is the point. Every screen behind this banner was rendered against a failed
       * read, so the app is connected and still showing the outage's emptiness — and silently
       * leaving it there is how someone walks away believing their positions are gone.
       */
      detail: 'Screens behind this were out of date. Reload to see what is actually there.',
      tone: 'back',
      retryable: false,
    };
  }

  return null;
}

/**
 * The second line while down.
 *
 * Three facts, in the order someone needs them: what is still true about their money, that the app
 * is trying, and when it will try again. The first is not reassurance — it is a property of the
 * design, which is why it can be stated flatly: the permission lives on chain and the kill switch
 * is signed by the user, so a dead executor cannot touch either.
 */
function downDetail(state: ReconnectState, now: number): string {
  const safety =
    'Screens may be out of date and anything you start will not go through. Your funds and your permission are on chain and unaffected — stopping your agents still works, because that is signed by you, not by us.';

  const trying =
    state.nextAttemptAt === null
      ? 'Trying now…'
      : `Trying again in ${secondsUntil(state.nextAttemptAt, now)}s`;

  /*
   * How long it has been down, once that is worth knowing.
   *
   * Said from the second attempt, not the first: a single missed check is a blip, and stamping a
   * duration on it makes a hiccup look like an incident.
   */
  const howLong =
    state.downSince !== null && state.attempts > 1
      ? ` · offline ${outageLabel(state.downSince, now)}`
      : '';

  return `${trying}${howLong}. ${safety}`;
}

/**
 * How long to wait before the next health check, given how many have failed.
 *
 * Backs off so a struggling executor is not hammered by every open app, and caps quickly because
 * the person is waiting: a minute is already long enough to feel abandoned, and a check is cheap.
 * The first retry is fast, because most outages are a moment of bad signal.
 */
export function retryDelayMs(attempts: number): number {
  const steps = [2_000, 5_000, 10_000, 20_000, 30_000];
  return steps[Math.min(Math.max(attempts, 1), steps.length) - 1]!;
}
