/**
 * The ladder is what the strategy library renders and where an agent's "Add strategy" goes, so a wrong
 * entry here is a dead button on two screens. These pin the ones it has actually had.
 */
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import {
  RECURRING_BUY_SYMBOLS,
  STRATEGY_LADDER,
  kindLabel,
  requiresApprovalByDefault,
  setupFor,
} from './ladder';

const APP = path.resolve(import.meta.dirname, '../../app');

describe('the strategy ladder — PLAN.md §1.2', () => {
  it('keeps its order: tiers 1 to 7, once each', () => {
    expect(STRATEGY_LADDER.map((e) => e.tier)).toEqual([1, 2, 3, 4, 5, 6, 7]);
  });

  /*
   * Tiers 6 and 7 routed to `/strategies` — the list their cards sit in — so "Set it up" reopened
   * the screen it was pressed on.
   */
  it('sends every available rung to a screen that exists, never back to the list it sits in', () => {
    for (const entry of STRATEGY_LADDER) {
      if (!entry.available) continue;
      expect(entry.route, entry.label).not.toBe('/strategies');
      expect(fs.existsSync(path.join(APP, `${entry.route}.tsx`)), `${entry.route} is not a screen`).toBe(true);
    }
  });

  // `/holdings` rows open the asset screen, which cannot set a take-profit or a stop.
  it('sets exit rules from the positions, where each one opens its own', () => {
    const exits = STRATEGY_LADDER.find((e) => e.kind === 'exit-rules')!;
    expect(exits.available && exits.route).toBe('/portfolio');
  });

  it('offers no button for a rung nothing in the app can create', () => {
    for (const kind of ['momentum', 'event-driven'] as const) {
      const entry = STRATEGY_LADDER.find((e) => e.kind === kind)!;
      expect(entry.available, kind).toBe(false);
      expect('route' in entry, kind).toBe(false);
    }
  });

  it('names no venue or chain in what the library shows', () => {
    for (const e of STRATEGY_LADDER) {
      const copy = [e.label, e.what, e.available ? e.cta : ''].join(' ');
      expect(copy, e.label).not.toMatch(/Aave|Uniswap|OKX DEX|Privy|X Layer|testnet/);
    }
  });

  it('asks first from tier 6 up', () => {
    expect(requiresApprovalByDefault('grid')).toBe(false);
    expect(requiresApprovalByDefault('momentum')).toBe(true);
    expect(requiresApprovalByDefault('event-driven')).toBe(true);
  });
});

describe("an agent's Add strategy", () => {
  it('goes where its kind is set up', () => {
    expect(setupFor(['yield-rotation'])?.route).toBe('/strategy/yield');
    expect(setupFor(['exit-rules'])?.route).toBe('/portfolio');
  });

  it('has nowhere to go when nothing can create its kind', () => {
    expect(setupFor(['momentum'])).toBeUndefined();
    expect(setupFor(['event-driven'])).toBeUndefined();
    expect(setupFor([])).toBeUndefined();
  });
});

describe('kind labels', () => {
  it('reads a kind the way the library names it', () => {
    expect(kindLabel('dca')).toBe('Recurring buy');
    expect(kindLabel('exit-rules')).toBe('Take profit and stop loss');
  });

  it('keeps a kind it does not know rather than inventing a name for it', () => {
    expect(kindLabel('something-new')).toBe('something-new');
  });
});

describe('what a recurring buy can buy', () => {
  it('never offers the token a buy is paid in', () => {
    expect(RECURRING_BUY_SYMBOLS).not.toContain('USDC');
  });

  it('offers only what routes on X Layer — never WETH, which no pool there holds against a stablecoin', () => {
    expect([...RECURRING_BUY_SYMBOLS]).toEqual(['XBTC', 'WOKB']);
    expect(RECURRING_BUY_SYMBOLS).not.toContain('WETH' as never);
  });
});
