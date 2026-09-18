/**
 * A read repeated every `everyMs` while the screen is focused (PLAN.md 4.5).
 *
 * For a screen watching something arrive — a deposit landing, a faucet's transfer — where loading once is the wrong shape.
 * What the state holds between answers is `pollState.ts`: the last answer survives a failed read, and the failure is
 * reported beside it.
 *
 * Only while focused: a screen left open under another one would keep asking the executor about a wallet nobody is looking
 * at. And never two at once: a read slower than the interval is waited for, not stacked behind itself.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { useFocusEffect } from 'expo-router';
import { emptyPoll, settlePoll, type PollState } from './pollState';

export function usePoll<T>(read: () => Promise<T>, everyMs: number): PollState<T> & { refresh: () => Promise<void> } {
  const [state, setState] = useState<PollState<T>>(emptyPoll);
  const latest = useRef(read);
  const inFlight = useRef(false);
  const alive = useRef(true);

  useEffect(() => {
    latest.current = read;
  }, [read]);

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const refresh = useCallback(async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    try {
      const data = await latest.current();
      if (alive.current) setState((prev) => settlePoll(prev, { ok: true, data, at: Date.now() }));
    } catch (e) {
      const error = e instanceof Error ? e : new Error(String(e));
      if (alive.current) setState((prev) => settlePoll(prev, { ok: false, error, at: Date.now() }));
    } finally {
      inFlight.current = false;
    }
  }, []);

  useFocusEffect(
    useCallback(() => {
      void refresh();
      const id = setInterval(() => void refresh(), everyMs);
      return () => clearInterval(id);
    }, [refresh, everyMs]),
  );

  return { ...state, refresh };
}
