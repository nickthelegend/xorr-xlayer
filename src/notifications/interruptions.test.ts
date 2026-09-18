/**
 * The inbox lists what interrupted, not the whole trail (PLAN.md 10.10).
 *
 * Each row below is worded exactly as its sender on the executor writes it — executor/run.ts, routes/panic.ts,
 * alerts/evaluate.ts, withdrawals/allowlist.ts — because `/activity` carries no payload and the wording is the only
 * evidence the app has of which rows went out as a push.
 */
import { describe, expect, it } from 'vitest';
import { interruptionFor, routeFor, type TrailRow } from './routes';

const row = (over: Partial<TrailRow>): TrailRow => ({ action: '', detail: '', kind: 'risk', agent: 'xorr', ...over });

describe('what went out as a push', () => {
  it('a proposal waiting for a yes, which opens the bot', () => {
    const kind = interruptionFor(row({ action: 'Asked before buying WETH', agent: 'Momentum Scout' }));
    expect(kind).toBe('proposal-awaiting');
    expect(routeFor(kind!)).toBe('/bot');
  });

  it('a run a limit refused, which opens Activity', () => {
    const kind = interruptionFor(row({ action: 'Skipped WETH', detail: 'The daily cap is spent.', kind: 'block' }));
    expect(kind).toBe('strategy-blocked');
    expect(routeFor(kind!)).toBe('/activity');
  });

  it('a fill, including a sale, a fill on a maker’s book and cash moved into savings', () => {
    for (const r of [
      row({ action: 'Bought 0.1234 WETH', kind: 'trade' }),
      row({ action: 'Sold 0.5000 WETH on an Aqua book', kind: 'trade', agent: 'Drawdown Guard' }),
      row({ action: 'Supplied $250 USDC to Aave', kind: 'yield', agent: 'Yield Keeper' }),
    ]) {
      expect(interruptionFor(r), r.action).toBe('dca-executed');
    }
  });

  it('each leg of a flatten you asked for, and the flatten that found nothing', () => {
    const leg = row({
      action: 'Sold all WETH',
      detail: '0.489000 WETH for $1,200.00. You asked to be flattened.',
      kind: 'trade',
      agent: 'Drawdown Guard',
    });
    const empty = row({
      action: 'Nothing to sell',
      detail: 'You asked to be flattened and there were no positions to close.',
      agent: 'Drawdown Guard',
    });
    expect(interruptionFor(leg)).toBe('panic-flatten');
    expect(interruptionFor(empty)).toBe('panic-flatten');
    expect(routeFor('panic-flatten')).toBe('/activity');
  });

  it('an alert you set, by its own name, which opens Alerts', () => {
    for (const action of ['BTC above $200k', 'Permission expiring', 'Daily cap nearly gone']) {
      const kind = interruptionFor(row({ action, detail: 'A level it has not seen', agent: 'Drawdown Guard' }));
      expect(kind, action).toBe('alert-fired');
    }
    expect(routeFor('alert-fired')).toBe('/alerts');
  });

  it('a withdrawal address added or removed, which opens the allowlist and cannot be muted', () => {
    expect(interruptionFor(row({ action: 'Withdrawal address added', agent: 'You' }))).toBe('allowlist-changed');
    expect(interruptionFor(row({ action: 'Withdrawal address removed', agent: 'You' }))).toBe('allowlist-changed');
    expect(routeFor('allowlist-changed')).toBe('/allowlist');
  });
});

describe('what is only a record', () => {
  it.each([
    ['a strategy created', row({ action: 'Created Recurring buy' })],
    ['a permission granted', row({ action: 'Trading permission granted' })],
    ['a run with nothing to do', row({ action: 'Nothing to do for Exit rules', agent: 'Drawdown Guard' })],
    ['a watched run', row({ action: 'Would have bought 0.1234 WETH', agent: 'Drawdown Guard' })],
    ['an interrupted run', row({ action: 'A run of Exit rules was interrupted', kind: 'block', agent: 'Drawdown Guard' })],
    ['a run that errored', row({ action: 'Could not run Recurring buy', kind: 'block' })],
    ['a refused withdrawal', row({ action: 'Withdrawal refused', kind: 'block' })],
    ['your own swap', row({ action: 'Swapped 100 USDC for 0.0400 WETH', kind: 'trade', agent: 'You' })],
    ['a limit order you took', row({ action: 'Took a limit order: bought 0.0400 WETH', kind: 'trade', agent: 'You' })],
    ['your own close', row({ action: 'Sold 50% of WETH', detail: '0.244500 WETH for $600.00.', kind: 'trade', agent: 'You' })],
    [
      'an agent’s own close, which writes a flatten’s words but not its last sentence',
      row({ action: 'Sold all WETH', detail: '0.489000 WETH for $1,200.00.', kind: 'trade', agent: 'Drawdown Guard' }),
    ],
  ])('%s', (_, r) => {
    expect(interruptionFor(r)).toBeNull();
  });
});
