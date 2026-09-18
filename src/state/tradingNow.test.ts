import { describe, expect, it } from 'vitest';
import { STALE_AFTER_MS, tradingLine, tradingNow, type RunLike } from './tradingNow';

const NOW = Date.UTC(2026, 8, 17, 12);
const run = (over: Partial<RunLike> = {}): RunLike => ({
  id: 'r1',
  status: 'pending',
  symbol: 'NVDAx',
  label: 'Recurring buy',
  at: new Date(NOW - 5_000).toISOString(),
  ...over,
});

describe('tradingNow — a claim about the present tense', () => {
  it('is trading while a run is genuinely in flight', () => {
    const state = tradingNow([run()], { now: NOW });
    expect(state.kind).toBe('trading');
    expect(state.kind === 'trading' && state.runs).toHaveLength(1);
  });

  it('is idle when nothing is pending', () => {
    expect(tradingNow([run({ status: 'filled' }), run({ status: 'blocked' })], { now: NOW }).kind).toBe('idle');
    expect(tradingNow([], { now: NOW }).kind).toBe('idle');
  });

  /*
   * The lie this guards against. A row left `pending` by a crashed process, a lost connection or a restart stays
   * pending for ever, and believed literally it has the app announcing an agent is trading, continuously, for days —
   * the most confident possible statement about the least certain thing.
   */
  it('stops calling a long-open run trading, and calls it stuck', () => {
    const old = run({ at: new Date(NOW - STALE_AFTER_MS - 1).toISOString() });
    const state = tradingNow([old], { now: NOW });
    expect(state.kind).toBe('stuck');
    expect(state.kind === 'stuck' && state.runs).toHaveLength(1);
  });

  it('holds right up to the boundary', () => {
    const edge = run({ at: new Date(NOW - STALE_AFTER_MS).toISOString() });
    expect(tradingNow([edge], { now: NOW }).kind).toBe('trading');
  });

  it('reports the live ones when a stuck run sits beside a fresh one', () => {
    const stale = run({ id: 'old', at: new Date(NOW - STALE_AFTER_MS - 1).toISOString() });
    const state = tradingNow([stale, run({ id: 'new' })], { now: NOW });
    expect(state.kind).toBe('trading');
    expect(state.kind === 'trading' && state.runs.map((r) => r.id)).toEqual(['new']);
  });

  /* An unreadable start is not evidence that something is happening now. */
  it('treats a run whose start cannot be read as stuck, not as trading', () => {
    expect(tradingNow([run({ at: 'not a date' })], { now: NOW }).kind).toBe('stuck');
  });
});

describe('not knowing is never idle', () => {
  /* "No agent is trading" is itself a claim, and one somebody might act on. */
  it('says unknown for a failed read and checking for one still out', () => {
    expect(tradingNow(undefined, { failed: true, now: NOW }).kind).toBe('unknown');
    expect(tradingNow([], { failed: true, now: NOW }).kind).toBe('unknown');
    expect(tradingNow(undefined, { now: NOW }).kind).toBe('checking');
  });

  it('never resolves either into idle or trading', () => {
    for (const state of [tradingNow(undefined, { now: NOW }), tradingNow(undefined, { failed: true, now: NOW })]) {
      expect(state.kind).not.toBe('idle');
      expect(state.kind).not.toBe('trading');
    }
  });
});

describe('tradingLine — what the ticker says', () => {
  it('names the strategy and symbol for a single run', () => {
    expect(tradingLine(tradingNow([run()], { now: NOW }))).toBe('Recurring buy is trading NVDAx');
  });

  it('counts them when there is more than one', () => {
    const line = tradingLine(tradingNow([run({ id: 'a' }), run({ id: 'b' })], { now: NOW }));
    expect(line).toMatch(/^2 runs in flight/);
  });

  /*
   * A run does not carry an agent, so the sentence must not name one. Putting a persona in a claim about what is
   * happening right now would be inventing the actor.
   */
  it('never invents an agent name', () => {
    for (const state of [
      tradingNow([run()], { now: NOW }),
      tradingNow([run({ at: 'nope' })], { now: NOW }),
      tradingNow([], { now: NOW }),
    ]) {
      const line = tradingLine(state) ?? '';
      expect(line).not.toMatch(/Momentum Scout|Earnings Desk|Yield Keeper|Strategist|agent named/i);
    }
  });

  it('says something for every state, and never the same thing twice', () => {
    const lines = [
      tradingLine(tradingNow([run()], { now: NOW })),
      tradingLine(tradingNow([run({ at: 'nope' })], { now: NOW })),
      tradingLine(tradingNow([], { now: NOW })),
      tradingLine(tradingNow(undefined, { now: NOW })),
      tradingLine(tradingNow(undefined, { failed: true, now: NOW })),
    ];
    for (const line of lines) expect(line && line.length).toBeGreaterThan(0);
    expect(new Set(lines).size).toBe(lines.length);
  });

  /* The two not-knowing states must not borrow the words of the two settled ones. */
  it('does not describe checking or unknown as trading or as idle', () => {
    for (const state of [tradingNow(undefined, { now: NOW }), tradingNow(undefined, { failed: true, now: NOW })]) {
      const line = tradingLine(state) ?? '';
      expect(line).not.toMatch(/is trading/);
      expect(line).not.toMatch(/^No agent is trading right now$/);
    }
  });
});
