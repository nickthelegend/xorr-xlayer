/**
 * Whose permission the cached one is.
 *
 * `delegation` in the store is the on-chain grant for ONE address, and nothing recorded which. That
 * was harmless while an account had one wallet and became a real hazard the moment the switcher
 * shipped: `useHydrateDelegation` keyed its "already loaded" ref on `useAuth().address`, which is
 * the EMBEDDED wallet's address and does not change when the user switches to a connected one. So
 * a switch re-pointed every executor call at the second account while the store went on holding
 * the first account's permission, and nothing re-read it.
 *
 * Safety is the screen that reads it. The failure is therefore not cosmetic: it would show a live
 * cap for an account that never granted one, or "stopped" for an account that is not — on the
 * screen whose entire job is to say what the bot may do with the user's money.
 *
 * Fixing it needs a third state. `null` already means "this address has granted nothing", which is
 * a claim, and it cannot also mean "we have not asked about this address yet" — the docblock on
 * `useHydrateDelegation` was written about exactly that false negative, one field over.
 */
import type { Delegation } from '@/data/types';

export type DelegationScope =
  /** Nothing has been read for the address in use. Not a claim about it — a claim about us. */
  | { state: 'unread' }
  /** Read, and this address has no permission. */
  | { state: 'none' }
  /** Read, and here it is. */
  | { state: 'granted'; delegation: Delegation };

/**
 * What is actually known about the active address's permission.
 *
 * Addresses compared case-insensitively: EIP-55 checksums differ from the lowercase form by case
 * alone, and the two spellings reach this from different places — Privy, the executor and the
 * chain do not agree on which to hand back.
 */
export function delegationScope(params: {
  /** The cached permission, whoever it belongs to. */
  cached: Delegation | null;
  /** The address it was read for. Null on a store written before this was recorded. */
  cachedFor: string | null;
  /** The address the executor is resolving to right now. */
  active: string | undefined;
}): DelegationScope {
  const { cached, cachedFor, active } = params;

  // Without an active address there is nothing to be right or wrong about yet.
  if (!active) return { state: 'unread' };

  /*
   * A cache with no address on it is from before this was recorded.
   *
   * Treated as unread rather than as belonging to whoever is active now. Assuming it matches is
   * the exact bug this file exists to close, and the cost of being wrong the safe way is one read.
   */
  if (!cachedFor) return { state: 'unread' };

  if (cachedFor.toLowerCase() !== active.toLowerCase()) return { state: 'unread' };

  return cached ? { state: 'granted', delegation: cached } : { state: 'none' };
}

/**
 * The permission to render, or undefined while nothing is known.
 *
 * For the screens that already take `Delegation | null` and treat `null` as "none granted". They
 * get `undefined` for unread, which is the value they already use for "still loading".
 */
export function delegationOrUnknown(scope: DelegationScope): Delegation | null | undefined {
  switch (scope.state) {
    case 'granted':
      return scope.delegation;
    case 'none':
      return null;
    case 'unread':
      return undefined;
  }
}

/**
 * Does a switch to `next` invalidate what is cached?
 *
 * Every account-scoped thing in the store — the permission, the stop switch, the caps, the
 * approvals — belongs to one address, and carrying any of it across a switch means showing one
 * account's safety state while the executor acts on another.
 */
export function switchInvalidatesCache(current: string | undefined, next: string): boolean {
  if (!current) return true;
  return current.toLowerCase() !== next.toLowerCase();
}
