/**
 * The scheduler survives its strategies (PLAN.md 1.6).
 *
 * A tick awaited each run with no catch, so one strategy that threw ended the tick for every
 * strategy after it and skipped the alert and anchor sweeps. And nothing stopped a slow tick from
 * overlapping the next one.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../db/index.js', () => ({ query: vi.fn() }));
vi.mock('./run.js', () => ({ runStrategy: vi.fn() }));
vi.mock('../alerts/evaluate.js', () => ({ evaluateAlerts: vi.fn(async () => []) }));
vi.mock('../audit/anchor-sweep.js', () => ({ anchorSweep: vi.fn(async () => null) }));
vi.mock('../portfolio/snapshots.js', () => ({ snapshotSweep: vi.fn(async () => ({ recorded: 0, failed: 0 })) }));
/*
 * The price observation sweep, stubbed like the sweeps above.
 *
 * Left real, the first tick in this file asked Jupiter's live quote API for every xStock in turn —
 * about four seconds of network — so "runs every due strategy when one of them throws" sat just under
 * vitest's 5s timeout and failed on a slow CI runner. Later ticks skipped it (the sweep is paced), which
 * is why only that test was slow. Nothing here is about prices; the sweep has its own suite in
 * `market/observe.test.ts`. What this file needs is that the tick calls it, which the first test asserts.
 */
vi.mock('../market/observe.js', () => ({ observeSweep: vi.fn(async () => null) }));
/*
 * The agent sweeps and the corporate-action sweep, stubbed for the same reason: left real, the corporate-action sweep
 * reads every xStock's multiplier from a live X Layer RPC, and the slow-tick test below timed out waiting on it.
 */
vi.mock('../bot/autonomous.js', () => ({ autonomousAgentSweep: vi.fn(async () => 0) }));
vi.mock('../bot/basket.js', () => ({ basketSweep: vi.fn(async () => 0) }));
vi.mock('../venues/corporate-actions.js', () => ({ sweepCorporateActions: vi.fn(async () => []) }));

const { query } = await import('../db/index.js');
const { runStrategy } = await import('./run.js');
const { evaluateAlerts } = await import('../alerts/evaluate.js');
const { observeSweep } = await import('../market/observe.js');
const { tick, guardedTick } = await import('./scheduler.js');

const row = (id: string) => ({ id, label: `strategy ${id}` });
const quiet = () => {
  const spies = [vi.spyOn(console, 'error'), vi.spyOn(console, 'warn'), vi.spyOn(console, 'log')];
  for (const s of spies) s.mockImplementation(() => {});
  return () => spies.forEach((s) => s.mockRestore());
};

beforeEach(() => {
  vi.mocked(query).mockReset();
  vi.mocked(runStrategy).mockReset();
  vi.mocked(evaluateAlerts).mockClear();
  vi.mocked(observeSweep).mockClear();
});

describe('a tick', () => {
  it('runs every due strategy when one of them throws, and still sweeps alerts', async () => {
    const restore = quiet();
    vi.mocked(query).mockResolvedValue([row('a'), row('b')] as never);
    vi.mocked(runStrategy)
      .mockRejectedValueOnce(new Error('rpc exploded'))
      .mockResolvedValueOnce({ status: 'filled', runId: 'r', signature: '0x1', units: 1, price: 1 });

    const now = new Date();
    expect(await tick(now)).toBe(1);
    expect(observeSweep).toHaveBeenCalledExactlyOnceWith(now);
    expect(runStrategy).toHaveBeenCalledTimes(2);
    expect(evaluateAlerts).toHaveBeenCalledTimes(1);
    restore();
  });
});

describe('the interval', () => {
  it('skips a tick while the previous one is still running instead of stacking them', async () => {
    const restore = quiet();
    let finish!: () => void;
    vi.mocked(query).mockResolvedValue([row('slow')] as never);
    vi.mocked(runStrategy).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = () => resolve({ status: 'skipped', reason: 'nothing_to_do' });
        }),
    );

    const first = guardedTick(new Date());
    await vi.waitFor(() => expect(runStrategy).toHaveBeenCalledTimes(1));
    expect(await guardedTick(new Date())).toBe('skipped');

    finish();
    expect(await first).toBe(0);

    // Once the slow tick is done, the next one runs as normal.
    vi.mocked(runStrategy).mockResolvedValueOnce({ status: 'skipped', reason: 'nothing_to_do' });
    expect(await guardedTick(new Date())).toBe(0);
    expect(runStrategy).toHaveBeenCalledTimes(2);
    restore();
  });
});

describe('housekeeping', () => {
  it('clears stored idempotent responses older than a day, after the strategies and sweeps', async () => {
    const restore = quiet();
    vi.mocked(query).mockResolvedValue([] as never);
    await tick(new Date());
    const statements = vi.mocked(query).mock.calls.map((c) => String(c[0]));
    expect(statements.at(-1)).toMatch(/DELETE FROM idempotency WHERE created_at < now\(\) - interval '24 hours'/);
    restore();
  });

  it('a cleanup that fails does not fail the tick', async () => {
    const restore = quiet();
    vi.mocked(query).mockResolvedValueOnce([row('a')] as never).mockRejectedValueOnce(new Error('db busy'));
    vi.mocked(runStrategy).mockResolvedValueOnce({ status: 'filled', runId: 'r', signature: '0x1', units: 1, price: 1 });
    expect(await tick(new Date())).toBe(1);
    restore();
  });
});
