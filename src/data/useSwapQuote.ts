/**
 * A real swap quote — PLAN.md 12.16.
 *
 * Screen 19's "Best of 3 venues" was a fixed string. This asks the aggregator and reports what it
 * actually routed through, what the minimum received is at the user's slippage, and the real
 * price impact. Debounced, because the amount stepper fires on every tap.
 */
import { useEffect, useState } from 'react';
import { api } from './api';
import { waitOutWarming } from './warming';

export type SwapQuoteResult = {
  outAmount: number;
  minimumOut: number;
  /** null where it cannot be measured — a dash, never a fabricated zero. See the server. */
  priceImpactPct: number | null;
  /*
   * The server returns `slippagePct`, and this said `slippageBps`. Nothing in the response ever
   * carried that name, so the row fell through to its default and happened to be right; the
   * price-impact row next to it fell through to `undefined` and rendered "NaN%". A type that
   * describes a response the server does not send is not a type, it is a guess.
   */
  slippagePct: number;
  venues: string[];
  route: string;
  /**
   * What the route costs to send (PLAN.md 3.13): the gas price, and 1inch's estimate for the route in dollars where
   * ETH can be priced. The executor's delegate sends every swap and order, so none of it is charged to the user.
   * Null when the executor could not read a gas price; absent from an executor older than the field.
   */
  gas?: {
    priceGwei: number;
    source: '1inch' | 'chain';
    units: number | null;
    feeUsd: number | null;
    paidBy: 'executor';
  } | null;
};

export function useSwapQuote(inSymbol: string, outSymbol: string, amount: number, slippagePct?: number) {
  const key = `${inSymbol}:${outSymbol}:${amount}:${slippagePct ?? ''}`;
  // `loading` is DERIVED by comparing the settled key against the current one, the same way
  // useAsync does it. Setting a loading flag in the effect body cascades a render on every tap
  // of the amount stepper.
  const [settled, setSettled] = useState<{ key: string; data?: SwapQuoteResult; error?: Error }>({
    key: '',
  });

  useEffect(() => {
    // A zero amount is handled in the RETURN value, not by writing state here — an early
    // setSettled would be exactly the synchronous effect-body write we are avoiding.
    if (!(amount > 0)) return;
    let alive = true;
    const t = setTimeout(() => {
      /*
       * A quote the executor could not get inside a screen's patience is `warming`: the aggregator's answer is still on
       * its way, and asking again joins it (E187). It is waited out rather than shown as a failure.
       */
      waitOutWarming(() =>
        // At the tolerance the screen shows, so the floor it prints is the one a swap would be held to.
        api.get<SwapQuoteResult>(
          `/swap/quote?in=${inSymbol}&out=${outSymbol}&amount=${amount}${slippagePct === undefined ? '' : `&slippage=${slippagePct}`}`,
        ),
      )
        .then((q) => {
          if (alive) setSettled({ key, data: q });
        })
        .catch((e: unknown) => {
          // No route is a real answer. The screen says so rather than showing a computed guess.
          if (alive) setSettled({ key, error: e instanceof Error ? e : new Error(String(e)) });
        });
    }, 350);
    return () => {
      alive = false;
      clearTimeout(t);
    };
  }, [key, inSymbol, outSymbol, amount, slippagePct]);

  if (!(amount > 0)) return { data: undefined, loading: false, error: undefined };
  return {
    data: settled.key === key ? settled.data : undefined,
    loading: settled.key !== key,
    error: settled.key === key ? settled.error : undefined,
  };
}
