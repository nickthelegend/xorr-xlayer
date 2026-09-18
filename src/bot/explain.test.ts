import { describe, expect, it } from 'vitest';
import { explainLines, strategyLabel, type DecisionRecord } from './explain';

const RECORD: DecisionRecord = {
  symbol: 'NVDAx',
  strategyKind: 'momentum',
  persona: 'momentum-scout',
  personaName: 'Momentum Scout',
  score: 94,
  usd: 25,
  units: 0.1154,
  price: 216.5,
  stopPrice: 205,
  targetPrice: 240,
  signature: '5K3ySig',
  slot: 289412950,
  opening: 'The band held, so it took the break.',
  reason: 'NVDAx is trading in the top quarter of the recorded band.',
  marketCondition: 'Upper band, 95th percentile of observed range',
  multiplier: 1,
  pendingMultiplier: null,
  pendingEffectiveAtMs: null,
  nasdaqSession: 'regular',
  spreadBps: 12,
  slippageBps: 50,
  riskProfile: 'balanced',
  exitStrategyId: 'exit-1',
  decidedAtMs: 1_760_000_000_000,
};

const lineFor = (r: DecisionRecord, label: string) =>
  explainLines(r).find((l) => l.label === label)?.value;

describe('strategyLabel', () => {
  it('uses the library word, not the enum', () => {
    expect(strategyLabel('dca')).toBe('Accumulating');
    expect(strategyLabel('event-driven')).toBe('Around an earnings date');
  });

  it('falls back to the raw kind rather than dropping it', () => {
    expect(strategyLabel('something-new')).toBe('something-new');
  });
});

describe('explainLines', () => {
  it('leads with the setup the agent actually scored', () => {
    expect(lineFor(RECORD, 'The setup')).toBe('Momentum, scored 94');
    expect(lineFor(RECORD, 'What it saw')).toBe('Upper band, 95th percentile of observed range');
  });

  it('states the drift it measured, against the session it measured it in', () => {
    expect(lineFor(RECORD, 'Where it was priced')).toBe(
      'Nasdaq was open, and the pool was within 12 bps of the Base listing',
    );
  });

  /*
   * `spreadBps: null` is the agent saying it had no second source. Rendering that as "0 bps" turns
   * "I could not check" into "I checked and it was perfect" — the exact inversion this app exists
   * not to make.
   */
  it('never renders an unmeasured drift as a measurement of zero', () => {
    const line = lineFor({ ...RECORD, spreadBps: null, nasdaqSession: 'closed' }, 'Where it was priced');
    expect(line).toBe('Nasdaq was closed, and no second venue answered, so the drift was unmeasured');
    expect(line).not.toContain('0 bps');
  });

  it('distinguishes a measured zero from an unmeasured one', () => {
    expect(lineFor({ ...RECORD, spreadBps: 0 }, 'Where it was priced')).toContain('within 0 bps');
  });

  it('shows the levels against the price it actually filled at', () => {
    expect(lineFor(RECORD, 'Levels it set')).toBe(
      'out at $205.00 or $240.00, from a fill at $216.50',
    );
  });

  it('says so when no exit was armed, rather than staying silent', () => {
    expect(lineFor({ ...RECORD, exitStrategyId: null }, 'Exit')).toContain('Not armed');
  });

  /* A multiplier of 1 is the absence of news, and a line saying so on every trade is noise. */
  it('mentions the share multiplier only once an issuer has moved it', () => {
    expect(lineFor(RECORD, 'Share multiplier')).toBeUndefined();
    expect(lineFor({ ...RECORD, multiplier: 1.0017 }, 'Share multiplier')).toBe(
      '1.0017 in force at the time',
    );
  });

  it('trims a multiplier to something a person can read', () => {
    expect(lineFor({ ...RECORD, multiplier: 1.001701196801074 }, 'Share multiplier')).toContain(
      '1.0017',
    );
  });

  it('cites the profile that was active when it decided', () => {
    expect(lineFor(RECORD, 'Risk profile')).toBe('Balanced at the time');
    expect(lineFor({ ...RECORD, riskProfile: 'aggressive' }, 'Risk profile')).toBe(
      'Aggressive at the time',
    );
  });

  /*
   * A trade from before the setting existed has no profile. Captioning it with today's value would
   * attribute the decision to thresholds that were not in force when it was made.
   */
  it('omits the profile entirely rather than borrowing the current one', () => {
    const { riskProfile: _p, ...older } = RECORD;
    expect(lineFor(older, 'Risk profile')).toBeUndefined();
  });

  it('shows an unrecognised profile raw rather than dropping what the record says', () => {
    expect(lineFor({ ...RECORD, riskProfile: 'experimental' }, 'Risk profile')).toBe(
      'experimental at the time',
    );
  });

  it('carries the slippage the guard chose, not a default', () => {
    expect(lineFor({ ...RECORD, slippageBps: 120 }, 'Slippage allowed')).toBe('120 bps');
  });
});
