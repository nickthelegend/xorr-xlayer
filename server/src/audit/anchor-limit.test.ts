/**
 * One on-demand anchor per wallet per hour, counted from the chain (PLAN.md 1.12).
 *
 * `POST /audit/anchor` pays from the bot's key, and any new trail row made the next press a real
 * transaction — so a loop of toggle-and-anchor spent the delegate's gas without limit.
 */
import { describe, expect, it } from 'vitest';
import { ON_DEMAND_ANCHOR_EVERY_SEC, anchorCooldownSec } from './anchor-limit.js';

const now = 1_789_000_000;

describe('anchorCooldownSec', () => {
  it('allows a wallet that has never been anchored', () => {
    expect(anchorCooldownSec(undefined, now)).toBe(0);
  });

  it('holds a wallet anchored less than an hour ago for the rest of the hour', () => {
    expect(anchorCooldownSec(now - 600, now)).toBe(ON_DEMAND_ANCHOR_EVERY_SEC - 600);
    expect(anchorCooldownSec(now, now)).toBe(ON_DEMAND_ANCHOR_EVERY_SEC);
  });

  it('allows it again once the hour has passed', () => {
    expect(anchorCooldownSec(now - ON_DEMAND_ANCHOR_EVERY_SEC, now)).toBe(0);
    expect(anchorCooldownSec(now - 86_400, now)).toBe(0);
  });
});
