/**
 * What a polled read holds between answers — kept apart from the hook (`usePoll.ts`) so the rule it exists for is testable
 * without the Expo runtime.
 *
 * `useAsync` settles one question: a failure replaces the data, which is right for a screen loaded once and wrong for a
 * poll. A balance read every few seconds fails now and then — a node hiccups, a request times out — and if each failure
 * erased the last answer, a funded wallet would blank to nothing on every one. So a failure is kept beside the last good
 * answer, each stamped with when it happened, and a number on screen is only ever a number the chain said.
 */
export type PollState<T> = {
  /** The last answer that came back, however long ago. */
  data: T | undefined;
  dataAt: number | undefined;
  /** The latest read's failure, cleared by the next answer. */
  error: Error | undefined;
  errorAt: number | undefined;
};

export type PollResult<T> = { ok: true; data: T; at: number } | { ok: false; error: Error; at: number };

export function emptyPoll<T>(): PollState<T> {
  return { data: undefined, dataAt: undefined, error: undefined, errorAt: undefined };
}

export function settlePoll<T>(prev: PollState<T>, result: PollResult<T>): PollState<T> {
  if (result.ok) return { data: result.data, dataAt: result.at, error: undefined, errorAt: undefined };
  return { ...prev, error: result.error, errorAt: result.at };
}
