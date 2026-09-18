/**
 * Read the permission, and remember whose it was.
 *
 * `/wallet/delegation` reads the chain for whichever wallet the executor currently resolves to, and
 * every caller then put the answer in the store with no note of which address that was. Harmless
 * with one wallet per account; a hazard the moment the switcher shipped.
 *
 * The address has to be captured BEFORE the read, not after. A switch that lands while the request
 * is in flight would otherwise file account A's permission under account B — which is the exact
 * failure the pairing exists to prevent, arrived at from the other direction.
 */
import { repos } from '@/data';
import { useStore } from '@/state/store';

/**
 * Read it and store it against the address it was read for.
 *
 * Throws what the read threw. A failed read must not be recorded as "no permission" — that is the
 * false negative `useHydrateDelegation` was written about, and `delegationScope` keeps "not asked"
 * distinct from "none" precisely so a caller here never has to fake one.
 */
export async function readDelegationIntoStore(): Promise<void> {
  const readFor = useStore.getState().wallet?.address ?? null;
  const delegation = await repos.wallet.delegation();

  /*
   * Dropped if the account changed while the read was out.
   *
   * The answer is about `readFor` and the app has moved on; storing it now would put one account's
   * cap on another's Safety screen, and the new account's own read is already on its way.
   */
  const stillActive = useStore.getState().wallet?.address ?? null;
  if (readFor !== null && stillActive !== null && readFor.toLowerCase() !== stillActive.toLowerCase()) {
    return;
  }

  useStore.getState().setDelegation(delegation, readFor);
}
