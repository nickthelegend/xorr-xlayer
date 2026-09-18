/**
 * LIVE 1inch integration — real API, real Base routes, real credential.
 * Run: LIVE=1 npx vitest run src/venues/oneinch.live.test.ts
 */
import { describe, expect, it } from 'vitest';
import {
  CAN_SETTLE,
  DEFAULT_SLIPPAGE_PCT,
  buildSwap,
  prettyVenue,
  quote,
  routeLabel,
  venuesFrom,
} from './oneinch.js';
import { ADDRESSES, CHAIN_KEY } from '../evm/chains.js';

describe('1inch swap routing', () => {
  it('quotes ETH -> USDC across real Base venues', async () => {
    const q = await quote({ inSymbol: 'ETH', outSymbol: 'USDC', amount: 1 });
    expect(q.outAmount).toBeGreaterThan(100);
    expect(q.outAmount).toBeLessThan(100_000);
    expect(q.venues.length).toBeGreaterThan(0);
    // The minimum is bounded by the slippage the user set — screen 19's 0.30%.
    expect(q.slippagePct).toBe(DEFAULT_SLIPPAGE_PCT);
    expect(q.minimumOut).toBeLessThan(q.outAmount);
    expect(q.minimumOut).toBeGreaterThan(q.outAmount * 0.99);
  }, 60_000);

  it('the Route row names venues that were actually used', async () => {
    const q = await quote({ inSymbol: 'ETH', outSymbol: 'USDC', amount: 0.5 });
    expect(q.route).toBeTruthy();
    if (q.venues.length > 1) expect(q.route).toContain('Best of');
    // And they read as venue names, not as SCREAMING_SNAKE protocol ids.
    for (const v of q.venues) expect(v).not.toMatch(/^BASE_|_/);
  }, 60_000);

  it('a larger trade returns a different, generally worse rate', async () => {
    const small = await quote({ inSymbol: 'ETH', outSymbol: 'USDC', amount: 0.1 });
    const large = await quote({ inSymbol: 'ETH', outSymbol: 'USDC', amount: 100 });
    const smallRate = small.outAmount / small.inAmount;
    const largeRate = large.outAmount / large.inAmount;
    expect(largeRate).toBeLessThanOrEqual(smallRate * 1.001);
  }, 90_000);

  /*
   * Skipped where a fill is IMPOSSIBLE, not where it is inconvenient.
   *
   * 1inch has no deployment on Base Sepolia, so `buildSwap` refuses before it asks — and it is
   * right to. Running this there produced a red suite for the two-environment split working
   * exactly as documented, which trains people to ignore the suite. Quotes are asked of Base
   * mainnet and are tested above on every chain; only SETTLEMENT is environment-bound.
   */
  it.skipIf(!CAN_SETTLE)(`builds real swap calldata aimed at the 1inch router (needs a chain 1inch settles on; this is ${CHAIN_KEY})`, async () => {
    const tx = await buildSwap({
      inSymbol: 'USDC',
      outSymbol: 'WETH',
      amount: 25,
      // The delegation contract is what holds the tokens at execution time...
      from: '0x33f1A1aAd627a71dCDED0686A2Ce4c08B772fb13',
      // ...but the user is who receives them. A swap that delivers to the contract would make the
      // product custodial.
      receiver: '0x364d7Bbc139541e0e37450D527ae154B5C292581',
    });
    expect(tx.to.toLowerCase()).toBe(ADDRESSES.oneInchRouter.toLowerCase());
    expect(tx.data).toMatch(/^0x[0-9a-f]{8,}$/i);
    expect(tx.data.length).toBeGreaterThan(100);
  }, 60_000);

  it('refuses a pair it has no route for rather than inventing one', async () => {
    await expect(quote({ inSymbol: 'ETH', outSymbol: 'NOPE', amount: 1 })).rejects.toThrow();
  });
});

describe('venue name handling', () => {
  it('flattens 1inch’s nested protocol matrix', () => {
    const protocols = [[[{ name: 'BASE_UNISWAP_V4' }, { name: 'BASE_AERODROME_SLIPSTREAM' }], [{ name: 'BASE_DODO_V2' }]]];
    expect(venuesFrom(protocols)).toEqual(['Uniswap V4', 'Aerodrome Slipstream', 'Dodo V2']);
  });

  it('deduplicates a venue used on more than one hop', () => {
    const protocols = [[[{ name: 'BASE_UNISWAP_V4' }], [{ name: 'BASE_UNISWAP_V4' }]]];
    expect(venuesFrom(protocols)).toEqual(['Uniswap V4']);
  });

  it('renders protocol ids as readable names', () => {
    expect(prettyVenue('BASE_UNISWAP_V4')).toBe('Uniswap V4');
    expect(prettyVenue('BASE_AERODROME_SLIPSTREAM')).toBe('Aerodrome Slipstream');
  });

  it('labels the route the way screen 19 does', () => {
    expect(routeLabel([])).toBe('Direct');
    expect(routeLabel(['Uniswap V4'])).toBe('Uniswap V4');
    expect(routeLabel(['a', 'b', 'c'])).toBe('Best of 3 venues');
  });
});
