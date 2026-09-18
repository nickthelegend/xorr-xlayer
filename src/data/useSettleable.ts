/**
 * Can this deployment actually settle this symbol — yes, no, or not known yet?
 *
 * The third answer is the point. `isSettleable` asks the executor, and both the asset screen and
 * the order ticket rendered from `settleable.data ?? isTradable(symbol)` while waiting — an
 * optimistic default that is right for crypto and wrong for a tokenized equity on a fork. The
 * result, watched on a simulator: `/asset/NVDAc` showed a live **Buy** and **Sell** pair for
 * several seconds, then replaced them with "NVDAc cannot be settled on Base (local fork)". The
 * window is as long as `/market/tradable` takes, and this executor is not fast.
 *
 * Offering a trade the app is about to refuse is the exact failure the settleability check was
 * added to remove, so "checking" is a state screens render rather than a state they guess through:
 * the controls are drawn in place and disabled, and become live only once the answer says so. No
 * layout jump, and nothing offered that has not been confirmed.
 *
 * A symbol the static registry already rules out never reaches "checking" — there is no route to
 * ask about, and the refusal is correct immediately.
 */
import { isSettleable, isTradable } from './tradable';
import { useAsync } from './useAsync';

export type Settleable = 'yes' | 'no' | 'checking';

export function useSettleable(symbol: string): Settleable {
  const known = useAsync(() => isSettleable(symbol), [symbol]);
  if (!symbol || !isTradable(symbol)) return 'no';
  if (known.data === undefined) return 'checking';
  return known.data ? 'yes' : 'no';
}
