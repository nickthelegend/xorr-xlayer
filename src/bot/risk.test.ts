import { describe, expect, it } from 'vitest';
import { differences, settingLines, type RiskSettings } from './risk';

const balanced: RiskSettings = {
  maxTradeUsd: 25,
  minTradeUsd: 10,
  allowanceShare: 0.25,
  momentumEntryAt: 0.75,
  dcaEntryBelow: 0.4,
  minObservations: 6,
  corporateActionWindowHours: 48,
  earningsErrorToleranceDays: 3,
  cooldownMinutes: 10,
};

const conservative: RiskSettings = {
  ...balanced,
  maxTradeUsd: 10,
  allowanceShare: 0.1,
  momentumEntryAt: 0.85,
  dcaEntryBelow: 0.25,
  minObservations: 10,
  corporateActionWindowHours: 96,
  earningsErrorToleranceDays: 1,
  cooldownMinutes: 30,
};

const valueFor = (s: RiskSettings, label: string) =>
  settingLines(s).find((l) => l.label === label)?.value;

describe('settingLines', () => {
  it('states a threshold with the direction it runs in', () => {
    // "96 hours" means nothing without "clear of": a reader must not have to work out which way is safer.
    expect(valueFor(conservative, 'Clear of a split or dividend')).toBe('96 hours');
    expect(valueFor(balanced, 'Counts as a breakout')).toBe('75th percentile and above');
    expect(valueFor(balanced, 'Counts as a dip')).toBe('below the 40th');
  });

  it('reads the allowance share as a percentage', () => {
    expect(valueFor(balanced, 'Of what is left today')).toBe('up to 25%');
    expect(valueFor(conservative, 'Of what is left today')).toBe('up to 10%');
  });

  it('says one day rather than 1 days', () => {
    expect(valueFor(conservative, 'Earnings date must be pinned to')).toBe('1 day');
    expect(valueFor(balanced, 'Earnings date must be pinned to')).toBe('3 days');
  });

  it('describes every profile with the same set of lines, so they compare row for row', () => {
    expect(settingLines(balanced).map((l) => l.label)).toEqual(
      settingLines(conservative).map((l) => l.label),
    );
  });
});

describe('differences', () => {
  /*
   * A list of eight rows where six are identical makes the reader do the comparison the screen
   * exists to do for them, and buries the two that matter.
   */
  it('lists only what actually changes', () => {
    // One knob moved, so one row — the other seven must not be along for the ride.
    const biggerOnly: RiskSettings = { ...balanced, maxTradeUsd: 50 };
    const diff = differences(balanced, biggerOnly);

    expect(diff).toEqual([{ label: 'Largest entry', before: '$25', after: '$50' }]);
  });

  it('lists every row when every threshold moves', () => {
    const diff = differences(balanced, conservative);
    expect(diff).toHaveLength(settingLines(balanced).length);
    expect(diff.every((d) => d.before !== d.after)).toBe(true);
    expect(diff.map((d) => d.label)).toContain('Clear of a split or dividend');
  });

  it('carries both sides so the change can be shown as a change', () => {
    const entry = differences(balanced, conservative).find((d) => d.label === 'Largest entry');
    expect(entry).toEqual({ label: 'Largest entry', before: '$25', after: '$10' });
  });

  it('is empty when nothing moves', () => {
    expect(differences(balanced, balanced)).toEqual([]);
  });

  it('is symmetric in what it considers changed', () => {
    expect(differences(conservative, balanced).map((d) => d.label)).toEqual(
      differences(balanced, conservative).map((d) => d.label),
    );
  });
});
