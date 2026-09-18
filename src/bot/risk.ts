/**
 * The agent's risk profile, as the app talks about it.
 *
 * The thresholds themselves are NOT duplicated here. They come down with the options from
 * `/agents/risk-profile`, because a screen carrying its own copy of the table would drift from the
 * agent the first time one moved — and the drift would surface as a screen confidently describing
 * behaviour the agent no longer has. This file holds only the shapes and the wording.
 */

export const RISK_PROFILES = ['conservative', 'balanced', 'aggressive'] as const;
export type RiskProfile = (typeof RISK_PROFILES)[number];

export type RiskSettings = {
  maxTradeUsd: number;
  minTradeUsd: number;
  allowanceShare: number;
  momentumEntryAt: number;
  dcaEntryBelow: number;
  minObservations: number;
  corporateActionWindowHours: number;
  earningsErrorToleranceDays: number;
  cooldownMinutes: number;
};

export type RiskOption = { profile: RiskProfile; blurb: string; settings: RiskSettings };

export type RiskProfileState = {
  active: RiskProfile;
  settings: RiskSettings;
  options: RiskOption[];
};

export const PROFILE_TITLE: Readonly<Record<RiskProfile, string>> = Object.freeze({
  conservative: 'Conservative',
  balanced: 'Balanced',
  aggressive: 'Aggressive',
});

/**
 * The differences between profiles, as rows a person can compare.
 *
 * Every line is derived from the settings the server sent, so this cannot describe a threshold the
 * agent is not actually using. The wording says which direction is which, because "96 hours" means
 * nothing without "clear of", and a reader should not have to work out whether larger is safer.
 */
export function settingLines(s: RiskSettings): { label: string; value: string }[] {
  return [
    { label: 'Largest entry', value: `$${s.maxTradeUsd}` },
    { label: 'Of what is left today', value: `up to ${Math.round(s.allowanceShare * 100)}%` },
    {
      label: 'Counts as a breakout',
      value: `${Math.round(s.momentumEntryAt * 100)}th percentile and above`,
    },
    { label: 'Counts as a dip', value: `below the ${Math.round(s.dcaEntryBelow * 100)}th` },
    { label: 'Readings before a band counts', value: `${s.minObservations}` },
    {
      label: 'Clear of a split or dividend',
      value: `${s.corporateActionWindowHours} hours`,
    },
    {
      label: 'Earnings date must be pinned to',
      value: `${s.earningsErrorToleranceDays} ${s.earningsErrorToleranceDays === 1 ? 'day' : 'days'}`,
    },
    { label: 'Between entries', value: `${s.cooldownMinutes} minutes` },
  ];
}

/**
 * What changes if this profile is chosen, against the one in force.
 *
 * Only the lines that differ. A list of eight rows where six are identical makes the reader do the
 * comparison the screen exists to do for them, and buries the two that matter.
 */
export function differences(
  from: RiskSettings,
  to: RiskSettings,
): { label: string; before: string; after: string }[] {
  const a = settingLines(from);
  const b = settingLines(to);
  return b
    .map((line, i) => ({ label: line.label, before: a[i]?.value ?? '', after: line.value }))
    .filter((d) => d.before !== d.after);
}
