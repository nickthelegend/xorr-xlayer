/**
 * Privy's "you already have an embedded wallet" refusal, recognised.
 *
 * `createWallet()` is guarded by `if (address) return address`, and that guard is stale exactly
 * once: in the render immediately after `loginWithCode` resolves, the SDK's `wallets` array has
 * not repopulated yet, so a returning user looks wallet-less for a beat. Onboarding then asks for
 * a wallet, Privy refuses because one exists, and the screen printed the SDK's developer message
 * verbatim, in red, underneath four green ticks:
 *
 *   > Wallet already exists for this user. Set 'createAdditional' to 'true' to create another
 *   > wallet.
 *
 * Nothing failed. The postcondition the caller wanted — this user has an embedded wallet — held
 * before the call. Treating that as success is not swallowing an error; every other failure still
 * propagates, which is why this matches on the specific refusal rather than catching broadly.
 *
 * The message is the only signal the SDK gives: there is no code or typed error to switch on — and
 * the two SDKs do not word it the same way, which is how this shipped half-fixed:
 *
 *   @privy-io/expo         "Wallet already exists for this user. Set 'createAdditional' to 'true'…"
 *   @privy-io/react-auth   "User already has an embedded wallet."
 *
 * The first version matched `already exists` only, so the native screen was clean and the web one
 * still printed the SDK's sentence in red under four green ticks. Both phrasings are matched now,
 * and the test carries both verbatim so a third wording fails loudly rather than silently.
 */
export function alreadyHasWallet(e: unknown): boolean {
  const message = e instanceof Error ? e.message : String(e);
  if (!/wallet/i.test(message)) return false;
  return /already exists/i.test(message) || /already has/i.test(message);
}
