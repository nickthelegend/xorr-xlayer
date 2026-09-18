/**
 * Whose permission the cached one is.
 *
 * `useHydrateDelegation` keyed its "already loaded" ref on the EMBEDDED wallet's address, which
 * does not change when someone switches to a connected wallet on the same account. So a switch
 * re-pointed every executor call at the second account while the store went on holding the first
 * account's permission, and nothing re-read it.
 *
 * Safety reads that value. The failure is a live cap shown for an account that never granted one —
 * on the screen whose entire job is to say what the bot may do with the user's money.
 */
import { describe, expect, it } from 'vitest';
import { delegationOrUnknown, delegationScope, switchInvalidatesCache } from './delegationScope';
import type { Delegation } from '@/data/types';

const GRANT = { dailyCapUsd: 2810, expiresAt: 1_800_000_000_000, revoked: false } as Delegation;
const A = '0x95A0b368588713011a15f4b1041423f31B08e615';
const B = '0xC38f38f45463f77bD823FebE16b15714Eb98c8A5';

describe('when the cache belongs to the address in use', () => {
  it('reports the permission', () => {
    expect(delegationScope({ cached: GRANT, cachedFor: A, active: A })).toEqual({
      state: 'granted',
      delegation: GRANT,
    });
  });

  it('reports none when that address genuinely has none', () => {
    // A claim, and an earned one: we asked about this address and it has nothing.
    expect(delegationScope({ cached: null, cachedFor: A, active: A })).toEqual({ state: 'none' });
  });

  it('compares addresses without caring about checksum case', () => {
    // Privy, the executor and the chain do not agree on which spelling to hand back.
    expect(
      delegationScope({ cached: GRANT, cachedFor: A.toLowerCase(), active: A }).state,
    ).toBe('granted');
  });
});

describe('when it belongs to a different address', () => {
  it('reports unread rather than the other account’s permission', () => {
    /*
     * The whole point. Carrying this across would show account A's live cap on account B — or
     * "stopped" for an account that is not stopped.
     */
    expect(delegationScope({ cached: GRANT, cachedFor: A, active: B })).toEqual({ state: 'unread' });
  });

  it('does not report none either, which would be its own false claim', () => {
    // "This account has granted nothing" is a statement about the account, and we have not looked.
    expect(delegationScope({ cached: null, cachedFor: A, active: B }).state).toBe('unread');
  });
});

describe('when nothing says whose it is', () => {
  it('treats a cache with no address as unread', () => {
    // Written before the address was recorded. Assuming it matches whoever is active now is the
    // exact bug this closes, and being wrong the safe way costs one read.
    expect(delegationScope({ cached: GRANT, cachedFor: null, active: A }).state).toBe('unread');
  });

  it('is unread while there is no active address at all', () => {
    expect(delegationScope({ cached: GRANT, cachedFor: A, active: undefined }).state).toBe('unread');
  });
});

describe('what a screen receives', () => {
  it('gets the permission when there is one', () => {
    expect(delegationOrUnknown({ state: 'granted', delegation: GRANT })).toBe(GRANT);
  });

  it('gets null only for an address known to have none', () => {
    expect(delegationOrUnknown({ state: 'none' })).toBeNull();
  });

  it('gets undefined while nothing is known, which screens already read as loading', () => {
    // `null` is a claim and must never stand in for "not asked yet".
    expect(delegationOrUnknown({ state: 'unread' })).toBeUndefined();
  });
});

describe('whether a switch throws the cache away', () => {
  it('does when the address changes', () => {
    expect(switchInvalidatesCache(A, B)).toBe(true);
  });

  it('does not when it is the same address in a different spelling', () => {
    // Re-tapping the row you are already on should not wipe the permission and re-read it.
    expect(switchInvalidatesCache(A, A.toLowerCase())).toBe(false);
  });

  it('does when nothing was active before', () => {
    expect(switchInvalidatesCache(undefined, A)).toBe(true);
  });
});
