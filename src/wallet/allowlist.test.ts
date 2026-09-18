/**
 * The allowlist is the only thing standing between a compromised phone and an empty wallet, so
 * its rules are tested rather than trusted to the screens that render them.
 *
 * Since PLAN.md 4.9 the list and its clock are the executor's. What is left on the device is reading
 * an address correctly and repeating the executor's answers faithfully — including never deciding
 * usability from this device's clock, which is what the old cooling-off did and why it was not one.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  isUsable,
  isValidAddress,
  nextChangeIn,
  normaliseAddress,
  sameAddress,
  usableIn,
  type AllowlistEntry,
} from './allowlist';

// The network boundary, which nothing here reaches: only the hook calls it, and the hook is not under test.
vi.mock('@/data/withdrawals', () => ({ withdrawals: {} }));

const HOUR = 3_600_000;
const entry = (over: Partial<AllowlistEntry> = {}): AllowlistEntry => ({
  label: 'Cold storage',
  address: '0x95A0b368588713011a15f4b1041423f31B08e615',
  addedAt: 0,
  usableAt: 24 * HOUR,
  usable: false,
  ...over,
});

describe('a destination has to be an address on THIS chain', () => {
  it('accepts an X Layer (EVM) address', () => {
    expect(isValidAddress('0x95A0b368588713011a15f4b1041423f31B08e615')).toBe(true);
    // Checksums are not case-sensitive here: an all-lowercase address is the same address.
    expect(isValidAddress('0x95a0b368588713011a15f4b1041423f31b08e615')).toBe(true);
    expect(isValidAddress('  0x95A0b368588713011a15f4b1041423f31B08e615  ')).toBe(true);
  });

  it('rejects a Solana address, which is what the screen used to REQUIRE', () => {
    /*
     * The add screen once validated base58, 32–44 characters — left over from a Solana build. Base58
     * has no `0` and no `x`, so no EVM address could pass it and the button never enabled. The
     * one screen that matters when someone is trying to get their money out rejected every real
     * destination and told them their own wallet "does not look like a Solana address".
     */
    expect(isValidAddress('9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM')).toBe(false);
  });

  it('accepts a 0X prefix, which is the same address', () => {
    /*
     * The screen refused this with "That is not a valid address. It should start 0x and be 42
     * characters." — about a string that starts with 0x and is 42 characters. A confidently wrong
     * error on the screen someone reaches while trying to get their money out, and the second
     * time this screen has rejected valid destinations.
     */
    expect(isValidAddress('0X95A0b368588713011a15f4b1041423f31B08e615')).toBe(true);
    expect(isValidAddress('  0X95A0b368588713011a15f4b1041423f31B08e615  ')).toBe(true);
    expect(normaliseAddress('  0X95A0b368588713011a15f4b1041423f31B08e615  ')).toBe(
      '0x95A0b368588713011a15f4b1041423f31B08e615',
    );
    // The hex body keeps its casing — EIP-55 encodes a checksum in it.
    expect(normaliseAddress('0Xabcdef0123456789012345678901234567890ABC')).toBe(
      '0xabcdef0123456789012345678901234567890ABC',
    );
  });

  it('rejects the near-misses', () => {
    expect(isValidAddress('')).toBe(false);
    expect(isValidAddress('0x')).toBe(false);
    // 39 hex digits — one short.
    expect(isValidAddress('0x95A0b368588713011a15f4b1041423f31B08e61')).toBe(false);
    // 41 — one long.
    expect(isValidAddress('0x95A0b368588713011a15f4b1041423f31B08e6155')).toBe(false);
    // Right length, wrong alphabet.
    expect(isValidAddress('0xZZA0b368588713011a15f4b1041423f31B08e615')).toBe(false);
    // No prefix.
    expect(isValidAddress('95A0b368588713011a15f4b1041423f31B08e615')).toBe(false);
    // Normalising the prefix must not smuggle a wrong-length body through.
    expect(isValidAddress('0X95A0b368588713011a15f4b1041423f31B08e61')).toBe(false);
  });

  it('treats case, a 0X prefix and surrounding space as one address', () => {
    const a = '0x4200000000000000000000000000000000000006';
    expect(sameAddress(a, '  0x4200000000000000000000000000000000000006  ')).toBe(true);
    expect(sameAddress('0x95A0b368588713011a15f4b1041423f31B08e615', '0X95a0b368588713011a15f4b1041423f31b08e615')).toBe(true);
    expect(sameAddress(a, '0x95A0b368588713011a15f4b1041423f31B08e615')).toBe(false);
  });
});

describe('whether an address is usable is the executor’s answer', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('repeats what the executor said, wherever this device’s clock is set', () => {
    /*
     * A phone with its date moved a day ahead used to have no cooling-off at all: the old `isUsable`
     * subtracted `addedAt` from `Date.now()`. Now moving this device's clock changes nothing.
     */
    const pendingInThePast = entry({ usable: false, usableAt: Date.UTC(2020, 0, 1) });
    const usableInTheFuture = entry({ usable: true, usableAt: Date.UTC(2099, 0, 1) });
    vi.useFakeTimers();
    for (const deviceTime of [Date.UTC(2019, 0, 1), Date.UTC(2026, 8, 13), Date.UTC(2100, 0, 1)]) {
      vi.setSystemTime(deviceTime);
      expect(isUsable(pendingInThePast)).toBe(false);
      expect(isUsable(usableInTheFuture)).toBe(true);
    }
  });

  it('knows when to ask again: the soonest pending address, by the executor’s clock', () => {
    const serverTime = 10 * HOUR;
    expect(nextChangeIn({ serverTime, addresses: [] })).toBeUndefined();
    expect(nextChangeIn({ serverTime, addresses: [entry({ usable: true })] })).toBeUndefined();
    expect(
      nextChangeIn({
        serverTime,
        addresses: [
          entry({ usableAt: 30 * HOUR }),
          entry({ usableAt: 12 * HOUR }),
          // Usable already, so it is not the next change whatever its time says.
          entry({ usable: true, usableAt: 11 * HOUR }),
        ],
      }),
    ).toBe(2 * HOUR);
    // Never a negative delay, even when the two answers straddle the moment.
    expect(nextChangeIn({ serverTime, addresses: [entry({ usableAt: 9 * HOUR })] })).toBe(0);
  });

  it('says how far off a pending address is, never sooner than it is', () => {
    const serverTime = 10 * HOUR;
    expect(usableIn(entry({ usableAt: serverTime + 30_000 }), serverTime)).toBe('in under a minute');
    expect(usableIn(entry({ usableAt: serverTime + 44 * 60_000 + 1 }), serverTime)).toBe('in 45 min');
    expect(usableIn(entry({ usableAt: serverTime + 23 * HOUR + 60_000 }), serverTime)).toBe('in 24 h');
    expect(usableIn(entry({ usableAt: serverTime + 24 * HOUR }), serverTime)).toBe('in 24 h');
  });
});
