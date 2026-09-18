/**
 * The profiles, held to what their names promise — and to the constraint that has to accept them.
 *
 * The monotonicity checks are not decoration. The table is nine numbers times three profiles typed
 * by hand, and two of the knobs run OPPOSITE to the others: a careful agent wants a narrower entry
 * band and a WIDER corporate-action window. A transposed pair would leave the agent describing
 * itself as conservative while standing closer to a split than an aggressive one would, and
 * nothing else in the system would notice.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_RISK_PROFILE,
  RISK_BLURB,
  RISK_PROFILES,
  RISK_SETTINGS,
  isRiskProfile,
  settingsFor,
} from './risk-profile.js';

const migration = readFileSync(
  fileURLToPath(new URL('../db/migrations/030-agent-risk-profile.sql', import.meta.url)),
  'utf8',
);

const conservative = RISK_SETTINGS.conservative;
const balanced = RISK_SETTINGS.balanced;
const aggressive = RISK_SETTINGS.aggressive;

describe('the profiles and the column agree', () => {
  /*
   * The lesson from `proposals.decision`, applied before it can happen twice. That column is a
   * CHECK and the agent wrote a word it did not allow; Postgres refused every insert and the
   * failure was caught and logged, so nothing surfaced for weeks.
   */
  it('every profile the code knows is a value the CHECK accepts', () => {
    const clause = /risk_profile\s+IN\s*\(([^)]*)\)/i.exec(migration);
    if (!clause?.[1]) throw new Error('could not find the risk_profile CHECK in the migration');
    const allowed = [...clause[1].matchAll(/'([^']+)'/g)].map((m) => m[1]);

    expect(allowed.length).toBeGreaterThan(0);
    for (const p of RISK_PROFILES) expect(allowed).toContain(p);
    // And nothing the column allows is a profile the code cannot resolve.
    for (const a of allowed) expect(isRiskProfile(a)).toBe(true);
  });

  it('the column default is the profile the code falls back to', () => {
    const def = /DEFAULT\s+'([^']+)'/i.exec(migration);
    expect(def?.[1]).toBe(DEFAULT_RISK_PROFILE);
  });
});

describe('each profile is complete and self-describing', () => {
  it('states every setting, with no inheritance to look up elsewhere', () => {
    const keys = Object.keys(balanced).sort();
    for (const p of RISK_PROFILES) {
      expect(Object.keys(RISK_SETTINGS[p]).sort()).toEqual(keys);
      for (const v of Object.values(RISK_SETTINGS[p])) expect(Number.isFinite(v)).toBe(true);
    }
  });

  it('has a blurb for each, so the choice can be explained where it is offered', () => {
    for (const p of RISK_PROFILES) expect(RISK_BLURB[p].length).toBeGreaterThan(20);
  });
});

describe('the names mean what they say', () => {
  it('risks more money as it gets more aggressive', () => {
    expect(conservative.maxTradeUsd).toBeLessThan(balanced.maxTradeUsd);
    expect(balanced.maxTradeUsd).toBeLessThan(aggressive.maxTradeUsd);
    expect(conservative.allowanceShare).toBeLessThan(balanced.allowanceShare);
    expect(balanced.allowanceShare).toBeLessThan(aggressive.allowanceShare);
  });

  it('demands a stronger move before calling it a breakout, the more careful it is', () => {
    expect(conservative.momentumEntryAt).toBeGreaterThan(balanced.momentumEntryAt);
    expect(balanced.momentumEntryAt).toBeGreaterThan(aggressive.momentumEntryAt);
  });

  it('demands a deeper dip before accumulating, the more careful it is', () => {
    expect(conservative.dcaEntryBelow).toBeLessThan(balanced.dcaEntryBelow);
    expect(balanced.dcaEntryBelow).toBeLessThan(aggressive.dcaEntryBelow);
  });

  it('wants more recorded history before trusting a band, the more careful it is', () => {
    expect(conservative.minObservations).toBeGreaterThan(balanced.minObservations);
    expect(balanced.minObservations).toBeGreaterThan(aggressive.minObservations);
  });

  /*
   * The inverted one. This is a distance to KEEP, so careful is larger — and it is exactly the
   * knob a single risk multiplier would have had to flip the sign of.
   */
  it('stands further clear of a scheduled corporate action, the more careful it is', () => {
    expect(conservative.corporateActionWindowHours).toBeGreaterThan(
      balanced.corporateActionWindowHours,
    );
    expect(balanced.corporateActionWindowHours).toBeGreaterThan(
      aggressive.corporateActionWindowHours,
    );
  });

  it('accepts a looser earnings projection, the more aggressive it is', () => {
    expect(conservative.earningsErrorToleranceDays).toBeLessThan(
      balanced.earningsErrorToleranceDays,
    );
    expect(balanced.earningsErrorToleranceDays).toBeLessThan(aggressive.earningsErrorToleranceDays);
  });

  it('waits longer between entries, the more careful it is', () => {
    expect(conservative.cooldownMinutes).toBeGreaterThan(balanced.cooldownMinutes);
    expect(balanced.cooldownMinutes).toBeGreaterThan(aggressive.cooldownMinutes);
  });

  /* The floor is a fee question, not a risk appetite one, so it does not move with the profile. */
  it('keeps the same minimum trade size across all three', () => {
    expect(new Set(RISK_PROFILES.map((p) => RISK_SETTINGS[p].minTradeUsd)).size).toBe(1);
  });

  it('never lets a profile size a trade below its own floor', () => {
    for (const p of RISK_PROFILES) {
      expect(RISK_SETTINGS[p].maxTradeUsd).toBeGreaterThanOrEqual(RISK_SETTINGS[p].minTradeUsd);
    }
  });

  /* An entry band where the dip threshold sits above the breakout one would qualify both at once. */
  it('keeps the dip band below the breakout band in every profile', () => {
    for (const p of RISK_PROFILES) {
      expect(RISK_SETTINGS[p].dcaEntryBelow).toBeLessThan(RISK_SETTINGS[p].momentumEntryAt);
    }
  });
});

describe('isRiskProfile', () => {
  it('accepts the three and nothing else', () => {
    for (const p of RISK_PROFILES) expect(isRiskProfile(p)).toBe(true);
    for (const junk of ['reckless', 'Balanced', '', null, undefined, 3, {}]) {
      expect(isRiskProfile(junk)).toBe(false);
    }
  });

  it('resolves settings for every profile it accepts', () => {
    for (const p of RISK_PROFILES) expect(settingsFor(p)).toBe(RISK_SETTINGS[p]);
  });
});
