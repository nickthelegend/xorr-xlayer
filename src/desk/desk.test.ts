import { describe, expect, it } from 'vitest';
import type { ActivityEvent, Agent, Strategy } from '@/data/types';
import { agentLine, deskFeed, isFresh, spentBy, until } from './desk';

const NOW = Date.UTC(2026, 8, 26, 0, 0, 0);
const agent = (over: Partial<Agent> = {}) => ({ id: 'a1', name: 'Weekly Stacker', hired: true, budgetUsd: 25, ...over }) as Agent;
const strategy = (over: Partial<Strategy> = {}) =>
  ({
    id: 's1',
    kind: 'dca',
    state: 'live',
    label: '$25 of WOKB, weekly',
    symbol: 'WOKB',
    params: {},
    dailyAllocationUsd: 25,
    createdAt: NOW,
    agentId: 'a1',
    nextRunAt: NOW + 3 * 86_400_000 + 5 * 3_600_000,
    ...over,
  }) as Strategy;
const event = (over: Partial<ActivityEvent>) =>
  ({ id: '1', t: '', agent: 'Weekly Stacker', action: 'Bought 0.2070 WOKB', detail: '', amount: '−$25.00', kind: 'trade', ...over }) as ActivityEvent;

describe('the desk', () => {
  it('says when an agent runs next, coarse far off and to the second close by', () => {
    expect(until(3 * 86_400_000 + 5 * 3_600_000)).toBe('3d 5h');
    expect(until(4 * 3_600_000 + 12 * 60_000)).toBe('4h 12m');
    expect(until(3 * 60_000 + 7_000)).toBe('3:07');
    expect(until(0)).toBe('now');
    expect(agentLine(agent(), [strategy()], 'live', NOW)).toEqual({
      runs: '$25 of WOKB, weekly',
      status: 'Next run in 3d 5h',
      due: false,
    });
  });

  it('says why an agent cannot trade before it says when it would', () => {
    expect(agentLine(agent(), [strategy()], 'revoked', NOW).status).toBe('Stopped · trading is off');
    expect(agentLine(agent(), [strategy()], 'none', NOW).status).toBe('Needs your permission');
    expect(agentLine(agent({ budgetUsd: 0 }), [strategy()], 'live', NOW).status).toBe('Waiting for its budget');
    expect(agentLine(agent(), [], 'live', NOW)).toEqual({ runs: null, status: 'Runs nothing yet', due: false });
  });

  it('marks an agent that is due and able to trade as acting on its own', () => {
    expect(agentLine(agent(), [strategy({ nextRunAt: NOW - 1 })], 'live', NOW)).toEqual({
      runs: '$25 of WOKB, weekly',
      status: 'Due now · trading on its own',
      due: true,
    });
  });

  it('reads what an agent spent from its fills, and keeps the system out of the feed but the stop in it', () => {
    const rows = [
      event({ id: '4', agent: 'xorr', action: 'All agents stopped', kind: 'risk', amount: '' }),
      event({ id: '3' }),
      event({ id: '2', action: 'Skipped a trade', kind: 'block', amount: '' }),
      event({ id: '1', agent: 'xorr', action: 'Wallet connected', kind: 'risk', amount: '' }),
    ];
    expect(spentBy('Weekly Stacker', rows)).toBe(25);
    // The executor's trail keeps a fill's dollars in its sentence and leaves the amount empty.
    expect(spentBy('Weekly Stacker', [event({ amount: '', detail: '$25 at $120.76. Scheduled recurring buy.' })])).toBe(25);
    expect(deskFeed(rows, ['Weekly Stacker']).map((e) => e.id)).toEqual(['4', '3', '2']);
    expect(isFresh(event({ at: NOW - 30_000 }), NOW)).toBe(true);
    expect(isFresh(event({ at: NOW - 600_000 }), NOW)).toBe(false);
    expect(isFresh(event({}), NOW)).toBe(false);
  });
});
