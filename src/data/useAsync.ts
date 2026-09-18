/**
 * The one way a screen reads a repository. Returns explicit loading/error state so every screen
 * can render the states PLAN.md 10.11 requires — and so no screen is tempted to call fetch.
 *
 * animations.md bans entrance animations and staggered reveals, so a loading state is a static
 * placeholder that swaps instantly. No shimmer.
 *
 * `loading` is DERIVED, not set. Writing setLoading(true) at the top of an effect triggers a
 * cascading render on every dependency change; comparing the settled key against the current one
 * gives the same answer for free.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { settleReread, shouldReread, type RereadResult, type Settled } from './reread';

export type AsyncState<T> = {
  data: T | undefined;
  loading: boolean;
  error: Error | undefined;
  reload: () => void;
  /**
   * `Date.now()` at the moment this data settled, or `undefined` before the first answer.
   *
   * Screens that report "when did I last hear from the executor" — the briefing header, a
   * price staleness note — need the fetch time, and stamping it in a screen-level effect
   * means setting state from an effect on every load. The hook already knows; it just
   * never said.
   */
  settledAt: number | undefined;
  /**
   * Read again in place, when the answer on screen is old enough to be worth replacing (FEATURES.md #27).
   *
   * `reload` asks a new question, so `loading` turns on and a screen draws its placeholder until the answer lands. This
   * asks the same question again: `loading` stays off and the data stays on screen until the answer replaces it. A failure
   * is kept beside the data rather than in place of it (`settleReread`). Nothing is asked while a read is on its way, or
   * within fifteen seconds of the last answer (`shouldReread`), so calling it often costs nothing. A screen opts in with
   * `useFreshOnReturn`.
   */
  refreshIfStale: () => void;
};

export function useAsync<T>(fn: () => Promise<T>, deps: unknown[] = []): AsyncState<T> {
  const [nonce, setNonce] = useState(0);
  const [settled, setSettled] = useState<Settled<T>>({ key: '' });
  const alive = useRef(true);

  const key = useMemo(() => JSON.stringify([deps, nonce]), [deps, nonce]);
  const loading = settled.key !== key;

  /*
   * What a re-read needs when it is asked for, which is after the render that made the callback: the read, the question
   * on screen, and whether its answer is still on the way. Written by an effect, never during a render.
   */
  const asked = useRef({ fn, key, loading });
  /** When the last read came back, answered or failed — the age `shouldReread` judges. */
  const lastSettledAt = useRef<number | undefined>(undefined);
  const rereading = useRef(false);

  useEffect(() => {
    asked.current = { fn, key, loading };
  });

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  useEffect(() => {
    let current = true;
    fn()
      .then((data) => {
        if (current && alive.current) {
          const at = Date.now();
          lastSettledAt.current = at;
          setSettled({ key, data, at });
        }
      })
      .catch((e: unknown) => {
        if (current && alive.current) {
          const at = Date.now();
          lastSettledAt.current = at;
          setSettled({
            key,
            at,
            error: e instanceof Error ? e : new Error(String(e)),
          });
        }
      });
    return () => {
      current = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  const reload = useCallback(() => setNonce((n) => n + 1), []);

  const refreshIfStale = useCallback(() => {
    const { fn: read, key: question, loading: answering } = asked.current;
    const inFlight = answering || rereading.current;
    if (!shouldReread({ now: Date.now(), lastSettledAt: lastSettledAt.current, inFlight })) return;
    rereading.current = true;
    // Started from a resolved promise, so a read that throws before it returns one still ends the re-read.
    void Promise.resolve()
      .then(read)
      .then(
        (data): RereadResult<T> => ({ ok: true, data, at: Date.now() }),
        (e: unknown): RereadResult<T> => ({ ok: false, error: e instanceof Error ? e : new Error(String(e)) }),
      )
      .then((result) => {
        rereading.current = false;
        lastSettledAt.current = Date.now();
        if (alive.current) setSettled((prev) => settleReread(prev, question, result));
      });
  }, []);

  // Keep showing the previous data while a new key is in flight — a list that empties on every
  // filter change reads as a bug, and animations.md forbids covering it with a transition.
  return {
    data: settled.data,
    error: settled.key === key ? settled.error : undefined,
    loading,
    reload,
    settledAt: settled.at,
    refreshIfStale,
  };
}
