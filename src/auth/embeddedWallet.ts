/**
 * Which of Privy's wallets is OURS.
 *
 * `useWallets()` on web returns every wallet Privy can see, and an injected browser extension is
 * one of them. Both call sites took `wallets[0]` — so on any browser with a wallet extension
 * installed, the first entry was the extension rather than the embedded wallet Privy created.
 *
 * Two things broke, and the second is worse than it looks:
 *
 *   - The grant was signed by the extension. Caught on the hosted build: pressing "Sign this
 *     permission" raised an injected wallet's own signing dialog for the USDC approval instead of
 *     going through Privy at all.
 *   - `useAuth().address` — the value this app registers with the executor and calls "the `owner`
 *     in the on-chain delegation policy", in those words — was the extension's address too. So the
 *     policy would be granted for one address while the executor reads `policyOf()` for another,
 *     and the bot ends up with a permission nobody can see. Silently: every screen reports "not
 *     granted", which is indistinguishable from never having pressed the button.
 *
 * Native is unaffected and stays as it is — `useEmbeddedEthereumWallet()` only ever lists embedded
 * wallets, so there is nothing to disambiguate there.
 *
 * No fallback to `wallets[0]`. Falling back is the bug: an absent embedded wallet is a state the
 * caller must report, not paper over with somebody else's key.
 */

/** The shape both Privy web wallets and the tests need — deliberately structural, not the SDK type. */
type MaybeEmbedded = {
  address?: string;
  /** Privy's own marker: 'privy' for the wallet it custodies, the connector's name otherwise. */
  walletClientType?: string;
  /** Present on newer SDKs; 'embedded' for the same wallet. Checked as a second opinion. */
  connectorType?: string;
};

export function isEmbedded(w: MaybeEmbedded | undefined): boolean {
  if (!w) return false;
  return w.walletClientType === 'privy' || w.connectorType === 'embedded';
}

/**
 * The embedded wallet, or nothing.
 *
 * Returning `undefined` rather than a substitute is the whole point — see the note above about
 * signing a permission with the wrong key.
 */
export function pickEmbedded<T extends MaybeEmbedded>(wallets: readonly T[] | undefined): T | undefined {
  return wallets?.find((w) => isEmbedded(w));
}
