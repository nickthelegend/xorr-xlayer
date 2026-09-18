/**
 * A value that stops changing before anything acts on it.
 *
 * `useSwapQuote` has always debounced its own request by 350ms — "the amount stepper fires on
 * every tap" — but the order ticket asks for its route quote through `useAsync` and had no such
 * delay, so a real 1inch call went out on every keypress of the amount.
 *
 * That is not merely wasteful. 1inch is rate limited and the executor serialises calls to it in
 * one lane, so composing "$25" queued five or six quotes ahead of the swap the ORDER then needed
 * to build. A measured `POST /orders` took **153 seconds** and came back 502 — the price had moved
 * past the slippage limit while the trade waited behind quotes drawn for a row of text.
 *
 * 350ms to match `useSwapQuote`. One number, one behaviour, in both places that ask.
 */
import { useEffect, useState } from 'react';

export function useDebounced<T>(value: T, ms = 350): T {
  const [settled, setSettled] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setSettled(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return settled;
}
