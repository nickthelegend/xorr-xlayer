import { describe, expect, it } from 'vitest';
import { MUTABLE, routeFor, type AlertKind } from './routes';

describe('12.19 notification routing [G30]', () => {
  it('every alert type has a deep-link target — PLAN.md 10.10', () => {
    const kinds: AlertKind[] = [
      'price',
      'earnings',
      'daily-cap',
      'drawdown',
      'staking-unlock',
      'proposal-awaiting',
      'dca-executed',
      'strategy-blocked',
      // The push kinds the executor also sends (server/src/notifications), added when the inbox began routing them.
      'alert-fired',
      'panic-flatten',
      'allowlist-changed',
    ];
    for (const k of kinds) {
      expect(routeFor(k), k).toMatch(/^\//);
    }
  });

  it('a proposal awaiting approval opens the bot, not a list', () => {
    expect(routeFor('proposal-awaiting')).toBe('/bot');
  });

  it('anything about limits opens Safety, where the kill switch is', () => {
    expect(routeFor('daily-cap')).toBe('/safety');
    expect(routeFor('drawdown')).toBe('/safety');
  });

  it('muting is about interruption only — screen 18 is explicit', () => {
    // Every kind is mutable as a NOTIFICATION. The circuit breaker that stops trading is
    // server-side and is not represented here at all, which is the point.
    for (const v of Object.values(MUTABLE)) expect(v).toBe(true);
  });
});
