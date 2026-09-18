/**
 * What the account switcher says about each address, and what switching actually does.
 *
 * A user having more than one wallet is not hypothetical: web Privy lists any injected browser
 * extension alongside the embedded wallet, so an account that once connected through an extension
 * has both on file. Everything in this product is scoped by wallet — the permission, the balance,
 * the strategies, the trail — which means the second address had a whole parallel set of all of it
 * that nothing in the app could reach, and no way to tell that was why the numbers looked wrong.
 *
 * Switching is therefore not a display preference. It changes which permission is read, whose
 * money the caps apply to and which trail is written, and the screen has to say so before someone
 * taps it rather than after.
 */
import type { AccountWallet } from '@/data/repositories';

/** `0x95A0…e615`. The full address is what gets copied; this is what fits on a row. */
export function shortAddress(address: string): string {
  return address.length <= 12 ? address : `${address.slice(0, 6)}…${address.slice(-4)}`;
}

/**
 * What kind of wallet this is, in plain words.
 *
 * No vendor name and no network on a main sheet (PLAN.md O3), and the distinction is worth making:
 * one was created for the account and the other was already the user's, which is the difference
 * between "we made this for you" and "you brought this".
 */
export function kindLabel(kind: AccountWallet['kind']): string {
  return kind === 'connected' ? 'Connected wallet' : 'Wallet made with your email';
}

/**
 * The line under each address.
 *
 * The active one says it is in use; the others say when they last were, which is the fact that
 * tells someone which of two similar addresses they actually traded on. A wallet the executor has
 * no record of having been active on says nothing rather than borrowing its creation date — "you
 * were on this address in September" is a claim nobody recorded.
 */
export function walletSubtitle(w: AccountWallet, now: number = Date.now()): string {
  if (w.active) return `${kindLabel(w.kind)} · in use`;
  if (w.lastActiveAt === undefined) return kindLabel(w.kind);
  return `${kindLabel(w.kind)} · last used ${agoLabel(w.lastActiveAt, now)}`;
}

/** Coarse on purpose: the useful answer is "recently or not", not a duration to the minute. */
export function agoLabel(at: number, now: number = Date.now()): string {
  const days = Math.floor((now - at) / 86_400_000);
  if (days <= 0) return 'today';
  if (days === 1) return 'yesterday';
  if (days < 30) return `${days} days ago`;
  const months = Math.floor(days / 30);
  return months === 1 ? 'a month ago' : `${months} months ago`;
}

/**
 * Whether the switcher is worth showing at all.
 *
 * One wallet is the overwhelmingly common case, and a switcher with a single row is a control that
 * cannot do anything — it invites a tap and then does nothing, which reads as broken.
 */
export function worthSwitching(wallets: readonly AccountWallet[]): boolean {
  return wallets.length > 1;
}

/**
 * What switching will change, said before the tap.
 *
 * Everything is scoped by wallet, so this is not a cosmetic change: the caps that apply, the
 * positions shown and the history recorded all belong to one address. Someone who thought they
 * were changing a display and finds their strategies gone has been misled by the control.
 */
export const SWITCH_CONSEQUENCE =
  'Each address has its own permission, balance, strategies and history. Switching shows that account — it moves nothing and cancels nothing.';

/**
 * The confirmation after a switch, naming the address landed on.
 *
 * Naming it matters: two addresses on one account often differ only in the middle, and "Switched"
 * alone leaves someone to verify it themselves.
 */
export function switchedNote(w: AccountWallet): string {
  return `Now on ${shortAddress(w.address)}.`;
}
