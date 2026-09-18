/**
 * The main screens say what the bot did, not where it settled, and shorten what the trail keeps in full.
 */
import { describe, expect, it } from 'vitest';
import { plainAction, plainDetail } from './activity';

describe('an activity line on a main screen', () => {
  it('says what the bot did, without the venue it settled on', () => {
    expect(plainAction("Bought 0.0020 WETH against a maker's SwapVM program")).toBe('Bought 0.0020 WETH');
    expect(plainAction('Bought 0.0020 WETH against a maker’s SwapVM program')).toBe('Bought 0.0020 WETH');
    expect(plainAction('Sold 0.0040 WETH on an Aqua book')).toBe('Sold 0.0040 WETH');
    expect(plainAction('Bought 0.0565 WETH through 1inch Aqua')).toBe('Bought 0.0565 WETH');
    expect(plainAction('Supplied $100 USDC to Aave')).toBe('Supplied $100 USDC to savings');
  });

  it('leaves every other line as it was written', () => {
    for (const line of [
      'Bought 0.0079 WETH',
      'Sold 50% of WETH',
      'Trading permission granted',
      'Withdrawal address added',
      'Transfer out refused',
      'Hired Yield Keeper',
    ]) {
      expect(plainAction(line)).toBe(line);
    }
  });
});

describe('an activity detail on a main screen', () => {
  it("shortens addresses and hashes, and leaves out the executor's clock", () => {
    expect(
      plainDetail(
        "qa-full prepare (0xB9B791e45A2Ba2733C15774F27375B12eC227fB3) is still cooling off. Nothing can be sent to it before 2026-09-16 04:45 UTC, by the executor's clock.",
      ),
    ).toBe('qa-full prepare (0xB9B7…7fB3) is still cooling off. Nothing can be sent to it before 2026-09-16 04:45 UTC.');
    expect(plainDetail(`Revoked in 0x${'ab'.repeat(32)}.`)).toBe('Revoked in 0xabab…abab.');
  });

  it('leaves a sentence with neither as it was written', () => {
    const line = 'Up to $50 a day, expiring Tue Sep 22 2026.';
    expect(plainDetail(line)).toBe(line);
    // An amount that happens to start with 0x-like digits is not an address.
    expect(plainDetail('Sold 0.0020 WETH for $5.01.')).toBe('Sold 0.0020 WETH for $5.01.');
  });
});
