/**
 * What the account switcher says.
 *
 * Switching is not a display preference: everything in this product is scoped by wallet, so it
 * changes which permission is read, whose money the caps apply to and which trail is written. The
 * cases here are mostly about saying that honestly, and about never inventing a date nobody
 * recorded.
 */
import { describe, expect, it } from 'vitest';
import {
  SWITCH_CONSEQUENCE,
  agoLabel,
  kindLabel,
  shortAddress,
  switchedNote,
  walletSubtitle,
  worthSwitching,
} from './switcher';
import type { AccountWallet } from '@/data/repositories';

const NOW = new Date('2026-09-17T12:00:00Z').getTime();
const DAY = 86_400_000;

const wallet = (over: Partial<AccountWallet> = {}): AccountWallet => ({
  id: 'w-1',
  address: '0x95A0b368588713011a15f4b1041423f31B08e615',
  kind: 'embedded',
  cluster: 'base-sepolia',
  active: false,
  createdAt: NOW - 30 * DAY,
  ...over,
});

describe('the address on a row', () => {
  it('is shortened at both ends, so the tail is still comparable', () => {
    // Two addresses on one account often differ only in the middle; keeping both ends is what lets
    // someone tell them apart at a glance.
    expect(shortAddress('0x95A0b368588713011a15f4b1041423f31B08e615')).toBe('0x95A0…e615');
  });

  it('leaves something already short alone', () => {
    expect(shortAddress('0x95A0')).toBe('0x95A0');
  });
});

describe('what kind of wallet it is', () => {
  it('says which one the user brought and which was made for them', () => {
    expect(kindLabel('connected')).toBe('Connected wallet');
    expect(kindLabel('embedded')).toBe('Wallet made with your email');
  });

  it('names no vendor and no network', () => {
    // PLAN.md O3: neither belongs on a main sheet.
    for (const label of [kindLabel('connected'), kindLabel('embedded')]) {
      expect(label).not.toMatch(/privy|base|solana|sepolia/i);
    }
  });
});

describe('the line under each address', () => {
  it('says the active one is in use', () => {
    expect(walletSubtitle(wallet({ active: true }), NOW)).toBe('Wallet made with your email · in use');
  });

  it('says when an inactive one was last used', () => {
    // The fact that tells someone which of two similar addresses they actually traded on.
    expect(walletSubtitle(wallet({ kind: 'connected', lastActiveAt: NOW - 3 * DAY }), NOW)).toBe(
      'Connected wallet · last used 3 days ago',
    );
  });

  it('says nothing about a date nobody recorded', () => {
    /*
     * A row written before the executor tracked this has no last-active time. Borrowing `createdAt`
     * would read as "you were on this address in September", which is a claim nobody made.
     */
    const line = walletSubtitle(wallet({ lastActiveAt: undefined }), NOW);
    expect(line).toBe('Wallet made with your email');
    expect(line).not.toMatch(/last used|ago/);
  });
});

describe('how long ago', () => {
  it('is coarse on purpose', () => {
    // "Recently or not" is the useful answer; a duration to the minute is noise on this row.
    expect(agoLabel(NOW - 2 * 3_600_000, NOW)).toBe('today');
    expect(agoLabel(NOW - 1 * DAY, NOW)).toBe('yesterday');
    expect(agoLabel(NOW - 12 * DAY, NOW)).toBe('12 days ago');
    expect(agoLabel(NOW - 45 * DAY, NOW)).toBe('a month ago');
    expect(agoLabel(NOW - 200 * DAY, NOW)).toBe('6 months ago');
  });

  it('does not say a future time is in the past', () => {
    // Clock skew between the device and the executor is real and must not print "-1 days ago".
    expect(agoLabel(NOW + 5 * DAY, NOW)).toBe('today');
  });
});

describe('whether to show the switcher at all', () => {
  it('shows it for more than one address', () => {
    expect(worthSwitching([wallet(), wallet({ id: 'w-2' })])).toBe(true);
  });

  it('hides it for one, which is the common case', () => {
    // A switcher with a single row invites a tap and then does nothing, which reads as broken.
    expect(worthSwitching([wallet({ active: true })])).toBe(false);
    expect(worthSwitching([])).toBe(false);
  });
});

describe('what switching will do, said before the tap', () => {
  it('names everything that is scoped to the address', () => {
    for (const scoped of ['permission', 'balance', 'strategies', 'history']) {
      expect(SWITCH_CONSEQUENCE, scoped).toContain(scoped);
    }
  });

  it('says plainly that it is not a destructive act', () => {
    // Someone reading "switch account" on a trading app is entitled to know nothing is being sold.
    expect(SWITCH_CONSEQUENCE).toMatch(/moves nothing and cancels nothing/i);
  });
});

describe('the confirmation afterwards', () => {
  it('names the address landed on', () => {
    // "Switched" alone leaves someone to verify it themselves.
    expect(switchedNote(wallet({ active: true }))).toBe('Now on 0x95A0…e615.');
  });
});
