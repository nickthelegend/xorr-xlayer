/**
 * refreshOutcome.ts — what a pull-to-refresh actually did.
 *
 * The control used to end every refresh the same way: `.finally(() => setRefreshing(false))`. The spinner retracted
 * whether the read answered or threw, so a refresh that failed was **pixel-identical to one that succeeded** — the
 * gesture people use precisely when they suspect what is on screen is stale would quietly leave it stale, and say it
 * had worked.
 *
 * That is the worst shape a failure can take: not an error nobody can act on, but a success nobody can doubt.
 *
 * ## The rules
 *
 * A failure is **kept** until something replaces it. Not dismissed on a timer, because a message that removes itself
 * is one the reader may never have seen, and not cleared by the next render, because nothing about drawing the screen
 * again makes the last read have worked.
 *
 * A new attempt clears it **as it starts**, not when it finishes: the old failure is about a read that is no longer the
 * current one, and leaving it up beside a spinner says two things at once.
 *
 * And a refresh that succeeds says nothing at all. Content arriving is its own confirmation, and a "refreshed" banner
 * on every pull is noise that trains people to ignore the banner that matters.
 */

export type RefreshState =
  /** Nothing in flight, nothing to report. */
  | { kind: 'idle' }
  /** A read is out. Any earlier failure is already cleared. */
  | { kind: 'refreshing' }
  /** The last attempt failed, and what is on screen is still the older answer. */
  | { kind: 'failed'; message: string };

export const REFRESH_IDLE: RefreshState = { kind: 'idle' };

/** What the control does next, given what just happened. */
export type RefreshEvent =
  | { type: 'started' }
  | { type: 'succeeded' }
  | { type: 'failed'; message: string }
  /** The reader dismissed the message. */
  | { type: 'dismissed' };

/**
 * The state machine, whole.
 *
 * Every transition is total: an event that cannot apply leaves the state alone rather than inventing one. A `succeeded`
 * arriving while idle — a second resolution of the same promise, a race between two pulls — must not clear a failure
 * that belongs to a later attempt.
 */
export function refreshStep(state: RefreshState, event: RefreshEvent): RefreshState {
  switch (event.type) {
    // Starting clears the old failure: it describes a read that is no longer the current one.
    case 'started':
      return { kind: 'refreshing' };
    case 'succeeded':
      return state.kind === 'refreshing' ? REFRESH_IDLE : state;
    case 'failed':
      return state.kind === 'refreshing' ? { kind: 'failed', message: event.message } : state;
    case 'dismissed':
      return state.kind === 'failed' ? REFRESH_IDLE : state;
  }
}

/** Whether the spinner should be showing. */
export function isRefreshing(state: RefreshState): boolean {
  return state.kind === 'refreshing';
}

/** The message to show, or undefined when there is nothing to say. A success says nothing. */
export function refreshMessage(state: RefreshState): string | undefined {
  return state.kind === 'failed' ? state.message : undefined;
}
