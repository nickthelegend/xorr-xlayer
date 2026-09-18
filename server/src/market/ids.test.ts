/**
 * One price map, and everything the app trades has to be in it.
 *
 * `bot/propose.ts` kept a private copy of these ids holding nine of the fourteen symbols. The five
 * it lacked — XAUT, PAXG, WETH, USDC, CBBTC — are every asset this app can settle on Base, and one
 * of them is the proposal engine's own default. So the engine looked up `WETH`, found nothing, and
 * wrote "Proposed nothing — No live market for WETH." into the audit trail on every run, about an
 * asset the same process was pricing correctly one route away.
 *
 * These tests fail the moment a symbol becomes settleable without a feed behind it, which is the
 * shape of that bug rather than its specific instance.
 */
import { describe, expect, it } from 'vitest';
import { COINGECKO_IDS } from './ids.js';
import { TOKENS } from '../venues/oneinch.js';
import { DEFAULT_PROPOSAL_SYMBOL, PRICE_IDS } from '../bot/propose.js';
import { isStock } from '../venues/stocks.js';

describe('the price-feed id map', () => {
  /*
   * Asserted through `PRICE_IDS` — the map the proposal engine actually reads — rather than
   * through `COINGECKO_IDS`. The canonical map always had WETH; the bug was that `propose.ts`
   * was not using it. A test against the canonical map passes in both worlds and guards nothing,
   * so this one fails if a private copy is ever reintroduced.
   */
  it('is the same map the proposal engine reads', () => {
    expect(PRICE_IDS).toBe(COINGECKO_IDS);
  });

  it('can resolve the symbol the proposal engine defaults to', () => {
    expect(PRICE_IDS[DEFAULT_PROPOSAL_SYMBOL]).toBeTruthy();
  });

  it('covers every crypto symbol the executor can settle', () => {
    /*
     * Equities are excluded on purpose: they are priced from their own oracle readings, not from
     * a crypto feed, and `/asset/NVDAc` says "No price history for this market" rather than
     * borrowing a number from somewhere else.
     */
    const settleable = Object.keys(TOKENS).filter((s) => !isStock(s) && s !== 'ETH');
    const missing = settleable.filter((s) => !PRICE_IDS[s]);
    expect(missing).toEqual([]);
  });

  it('maps each symbol to its own asset, never to a stand-in', () => {
    // XAUT once pointed at BITCOIN to get a number out of a feed with no gold entry, and the
    // contract screen read "XAUT/USDT $79,900" while gold traded near $4,400.
    expect(COINGECKO_IDS.XAUT).toBe('tether-gold');
    expect(COINGECKO_IDS.PAXG).toBe('pax-gold');
    const ids = Object.values(COINGECKO_IDS);
    expect(new Set(ids).size).toBe(ids.length);
  });
});
