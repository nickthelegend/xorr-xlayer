/**
 * What pausing a strategy is, and — more importantly — what it is not.
 *
 * This app has three different stops and they are not interchangeable:
 *
 *   pause one strategy   one row stops being picked up by the scheduler. Everything else — the
 *                        other strategies, the agents, the permission — carries on. Off chain.
 *   stop all trading     every agent and strategy is held. Still off chain: the delegation stands.
 *   the kill switch      revokes the delegation ON CHAIN. It is the only one of the three that
 *                        takes away what the bot is allowed to do, and the only one that survives
 *                        this app being wrong about anything.
 *
 * Someone who paused a strategy and believed they had pulled the kill switch has a wrong model of
 * what their money is exposed to, and would find out at the worst possible time. So the difference
 * is stated where the pause control is, in the app's own words rather than in a help page nobody
 * opens — and the sentences live here, checked, rather than inline where they drift.
 */

/** Where the real kill switch is, for the link under the note. */
export const KILL_SWITCH_ROUTE = '/safety';

/**
 * The line under the pause control.
 *
 * Two clauses and no jargon: what stops, and what does not. "Permission" is the word the Safety
 * screen and the audit trail already use for the delegation, so this does not introduce a fourth
 * name for the same thing.
 */
export const PAUSE_IS_NOT_THE_KILL_SWITCH =
  'Pausing stops one strategy. Your permission stays live and everything else keeps trading — only the kill switch revokes it on chain.';

/** The tappable half of that line. */
export const KILL_SWITCH_LINK = 'Open the kill switch';

/**
 * What a paused strategy's badge says, and what a resume will do to it.
 *
 * A paused row used to read just "Paused", which says nothing about what it will be when it comes
 * back — and it does not always come back the same: a strategy paused out of `watch` resumes into
 * `watch`, and one paused out of `live` resumes live. Saying so on the row is how someone can tell
 * the two apart before they tap.
 */
export function pausedNote(pausedFrom: string | undefined): string {
  return pausedFrom === 'watch' ? 'Paused · resumes watching' : 'Paused';
}

/**
 * The state badge for any strategy.
 *
 * `Watch` and `Paused` are not losses and must not be coloured as such — the P&L colours are
 * reserved, which is why this returns words and the caller picks a neutral tone for everything
 * but `live`.
 */
export function stateBadge(state: string, pausedFrom: string | undefined): string {
  switch (state) {
    case 'paused':
      return pausedNote(pausedFrom);
    case 'live':
      return 'Live';
    case 'watch':
      return 'Watch';
    case 'draft':
      return 'Draft';
    case 'ended':
      return 'Ended';
    default:
      // A state a newer executor knows and this build does not. Its own name beats a wrong guess.
      return state;
  }
}
