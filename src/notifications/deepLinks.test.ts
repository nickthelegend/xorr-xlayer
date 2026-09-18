/**
 * Where a tapped notification lands.
 *
 * `routeFor` answers with a screen, and that was as far as a tap could ever get: "Bought 0.1234
 * NVDAx" opened the top of an activity log that might have a hundred rows in it, and the row it was
 * about was somewhere below. `deepRouteFor` answers with the thing itself where the push carried
 * enough to name it.
 *
 * Two properties are worth more than the routing table itself:
 *
 *   - it degrades in steps, and every step is a real answer rather than a guess, so an older
 *     executor's push still lands where it used to;
 *   - a payload is not this app's own data. It arrives from outside and goes straight to the router,
 *     so anything that is not a plain ticker or a plain row id is refused rather than escaped.
 */
import { describe, expect, it } from 'vitest';
import { deepRouteFor, isAlertKind, routeFor } from './routes';

describe('a push about something that happened', () => {
  it('opens the audit row it recorded', () => {
    // The distance between a notification that told you something and one that took you to it.
    expect(deepRouteFor({ kind: 'dca-executed', route: '/activity', seq: '4821' })).toBe(
      '/activity?row=4821',
    );
  });

  it('does the same for a blocked trade and a flatten', () => {
    expect(deepRouteFor({ kind: 'strategy-blocked', route: '/activity', seq: '99' })).toBe(
      '/activity?row=99',
    );
    expect(deepRouteFor({ kind: 'panic-flatten', route: '/activity', seq: '7' })).toBe(
      '/activity?row=7',
    );
  });

  it('takes a numeric id as readily as a string one', () => {
    expect(deepRouteFor({ kind: 'dca-executed', seq: 4821 })).toBe('/activity?row=4821');
  });

  it('falls back to the list when the push carried no row', () => {
    // An executor older than this field. The tap must still land where it always did.
    expect(deepRouteFor({ kind: 'dca-executed', route: '/activity' })).toBe('/activity');
  });

  it('prefers the row over a symbol it also carries', () => {
    // A fill is an event. The receipt is what was asked for, not the chart.
    expect(deepRouteFor({ kind: 'dca-executed', seq: '12', symbol: 'NVDAx' })).toBe(
      '/activity?row=12',
    );
  });
});

describe('a push about an instrument', () => {
  it('opens the asset it names', () => {
    // An alert is a statement about a price, and the chart and the buy are on the asset screen.
    expect(deepRouteFor({ kind: 'alert-fired', route: '/alerts', symbol: 'NVDAx' })).toBe(
      '/asset/NVDAx',
    );
    expect(deepRouteFor({ kind: 'price', symbol: 'WETH' })).toBe('/asset/WETH');
    expect(deepRouteFor({ kind: 'earnings', symbol: 'AAPLx' })).toBe('/asset/AAPLx');
  });

  it('falls back to the alerts list when it names none', () => {
    expect(deepRouteFor({ kind: 'alert-fired', route: '/alerts' })).toBe('/alerts');
  });

  it('ignores a row id, which is not what an alert is about', () => {
    expect(deepRouteFor({ kind: 'price', symbol: 'WETH', seq: '3' })).toBe('/asset/WETH');
  });
});

describe('a push about neither', () => {
  it('goes where the kind has always gone', () => {
    expect(deepRouteFor({ kind: 'proposal-awaiting' })).toBe(routeFor('proposal-awaiting'));
    expect(deepRouteFor({ kind: 'daily-cap' })).toBe('/safety');
    expect(deepRouteFor({ kind: 'allowlist-changed' })).toBe('/allowlist');
  });

  it('honours the screen the executor asked for over this app’s own map', () => {
    // The sender knows things this build does not — a route added on the executor first.
    expect(deepRouteFor({ kind: 'drawdown', route: '/risk' })).toBe('/risk');
  });
});

describe('a push from a newer executor', () => {
  it('still uses the row it took the trouble to name', () => {
    expect(deepRouteFor({ kind: 'margin-call', seq: '55' })).toBe('/activity?row=55');
  });

  it('otherwise follows the route it sent', () => {
    expect(deepRouteFor({ kind: 'margin-call', route: '/futures' })).toBe('/futures');
  });

  it('and lands on the trail when it sent nothing usable', () => {
    // Not nowhere, and not a crash: an unrecognised event belongs in the log of events.
    expect(deepRouteFor({ kind: 'margin-call' })).toBe('/activity');
    expect(deepRouteFor({})).toBe('/activity');
    expect(deepRouteFor(undefined)).toBe('/activity');
  });
});

describe('a payload that cannot be trusted', () => {
  it('refuses a symbol that is not a plain ticker', () => {
    // Straight to the router, from outside this app. There is no legitimate symbol this rejects,
    // and each falls back to the kind's own screen rather than to an escaped path segment.
    for (const symbol of ['../settings', 'NVDA/x', 'NV DAx', '', 'x'.repeat(13), 'a?b=c']) {
      expect(deepRouteFor({ kind: 'alert-fired', symbol }), JSON.stringify(symbol)).toBe('/alerts');
    }
  });

  it('refuses a row id that is not a number', () => {
    for (const seq of ['1 OR 1=1', '../x', '-4', '1.5', '']) {
      expect(deepRouteFor({ kind: 'dca-executed', seq }), String(seq)).toBe('/activity');
    }
  });

  it('refuses a route that is not a path in this app', () => {
    for (const route of ['https://evil.example/x', 'xorr://settings', '/a/../../b', 'settings']) {
      expect(deepRouteFor({ kind: 'margin-call', route }), route).toBe('/activity');
    }
  });

  it('refuses fields of the wrong type outright', () => {
    expect(deepRouteFor({ kind: 'dca-executed', seq: { toString: () => '5' } })).toBe('/activity');
    expect(deepRouteFor({ kind: 'alert-fired', symbol: ['NVDAx'] })).toBe('/alerts');
    expect(deepRouteFor({ kind: 42, seq: '5' })).toBe('/activity?row=5');
  });
});

describe('the kinds this build knows', () => {
  it('are exactly the ones routeFor handles', () => {
    // Derived from `MUTABLE` rather than listed twice, so this cannot drift.
    for (const kind of ['price', 'dca-executed', 'allowlist-changed', 'panic-flatten'] as const) {
      expect(isAlertKind(kind), kind).toBe(true);
      expect(routeFor(kind), kind).toMatch(/^\//);
    }
    expect(isAlertKind('margin-call')).toBe(false);
  });
});
