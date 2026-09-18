/**
 * Load the wallet from the executor whenever the user is signed in.
 *
 * `setWallet` was called in exactly one place — the onboarding wallet screen — so the client only
 * knew about a wallet if you had walked through onboarding in THIS session, in THIS browser. Every
 * other entry point left it null:
 *
 *   - a returning user on a new device or after clearing site data
 *   - a deep link straight to any screen
 *   - a reload once the persisted store had been cleared
 *
 * And the consequences were not cosmetic. `/` redirects to `/welcome` when the store has no wallet,
 * so a user with an account, a granted on-chain permission and open positions was bounced back to
 * onboarding. Assets said "No wallet connected", Safety showed a dash where the two parties to the
 * permission should be, and Fund could not show the address to send USDC to — all while the server
 * knew every one of those things.
 *
 * So the wallet is fetched once per signed-in session, from the one place that actually knows.
 */
import { useEffect, useRef } from 'react';
import { useAuth } from '@/auth/useAuth';
import { repos } from '@/data';
import { useStore } from '@/state/store';
import { setAuthKnowledge } from '@/auth/authState';

export function useHydrateWallet(): void {
  const { ready, authenticated, address } = useAuth();
  /*
   * READ through a ref, never a dependency.
   *
   * Subscribing to `wallet` and listing it as a dependency makes this effect its own trigger:
   * it fetches, `setWallet` changes the value, the effect re-runs, it fetches again — a loop
   * that put several thousand `/wallet` requests through the executor in seconds and starved
   * every other read on the screen, so the home screen showed a dash for a balance the server
   * was answering correctly the whole time. The effect wants to know whether a wallet is
   * already cached; it does not want to hear about it changing.
   */
  const walletRef = useRef(useStore.getState().wallet);
  useEffect(
    () => useStore.subscribe((s) => { walletRef.current = s.wallet; }),
    [],
  );
  const setWallet = useStore((s) => s.setWallet);
  const setWalletChecked = useStore((s) => s.setWalletChecked);

  /*
   * Publish what Privy knows, so `api` can tell "signed out" from "not ready yet".
   *
   * This hook already watches exactly the two flags that answer the question, and it is mounted at
   * the root, so it is the natural place to say it out loud.
   */
  useEffect(() => {
    setAuthKnowledge(!ready ? 'unknown' : authenticated ? 'signed-in' : 'signed-out');
  }, [ready, authenticated]);

  useEffect(() => {
    if (!ready) return;

    /*
     * Signed out is a real answer, and it has to be recorded.
     *
     * The entry gate waits for `walletChecked` before deciding, so leaving it unset here would
     * hold a signed-out visitor on a blank screen instead of sending them to the splash.
     */
    if (!authenticated) {
      setWallet(null);
      setWalletChecked(true);
      return;
    }

    /*
     * The persisted copy is the fast path, and it is also a snapshot that can go stale.
     *
     * This returned early whenever anything was cached, so `/wallet` was read once and never
     * again — and the row carries live facts, not just the address. `chain` is the one that
     * showed: a wallet created while the executor settled on Sepolia kept saying
     * "Connected · base-sepolia" underneath live Base-fork balances, for good, because the
     * only code that could have corrected it had decided it already knew.
     *
     * So: render from the cache immediately — nothing waits, the gate opens on the same tick as
     * before — and refresh behind it. The address is the part that must not flicker, and it is
     * the part that never changes.
     */
    const cached = Boolean(walletRef.current);
    if (cached) setWalletChecked(true);

    let alive = true;
    void repos.wallet
      .current()
      .then(async (w) => {
        if (!alive) return;

        /*
         * Reconcile: the executor's idea of "your wallet" must be the wallet you actually sign with.
         *
         * This only ever READ the row, so once the executor had an address it kept it for ever. That
         * is fine while the address cannot change, and it can. On web, Privy lists injected browser
         * extensions alongside the embedded wallet, and until `pickEmbedded` landed the app
         * registered whichever came first — so an account could have an extension's address on file
         * while every signature now comes from the embedded one.
         *
         * The symptom is silent and total: the user grants the permission, it lands on chain, and
         * the executor reads `policyOf()` for the OTHER address and finds nothing. Safety says "not
         * granted", Limits says the cap is zero, the bot never runs. Measured on the hosted build —
         * a grant verified on chain ($1,600/day, delegate matches) while every screen said the
         * permission did not exist. The only thing that repaired it was walking back through
         * onboarding, which is the one screen that had ever called `connect`.
         *
         * `connect` is an idempotent upsert, and this runs only when the two disagree, so it
         * settles after one call rather than looping.
         */
        const known = w?.address?.toLowerCase();
        if (address && known !== address.toLowerCase()) {
          const reconciled = await repos.wallet.connect(address).catch(() => undefined);
          if (!alive) return;
          if (reconciled) {
            setWallet(reconciled);
            setWalletChecked(true);
            return;
          }
        }

        if (w) setWallet(w);
        setWalletChecked(true);
      })
      .catch(() => {
        /*
         * A failed read must not be mistaken for "no wallet".
         *
         * Marking it checked anyway would redirect a signed-in user to onboarding because the
         * executor was briefly unreachable — destroying their session state to recover from a
         * network blip. Leaving it unchecked keeps the gate waiting, which is the honest state.
         *
         * Unless we already had one: a background refresh that fails leaves the cached wallet
         * exactly as it was, and must not close a gate it did not open.
         */
        if (alive && !cached) setWalletChecked(false);
      });
    return () => {
      alive = false;
    };
  }, [ready, authenticated, address, setWallet, setWalletChecked]);
}
