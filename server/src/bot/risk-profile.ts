/**
 * How much risk the agent is allowed to take, as one setting the user owns.
 *
 * Every threshold the autonomous agent reasons with used to be a constant in `autonomous.ts` — how
 * big a trade, how far into the band before a breakout counts, how close to a corporate action it
 * will go, how long it waits between entries. Those are not implementation details. They are the
 * whole of what "this agent is careful" or "this agent is aggressive" means, and the person whose
 * money it is had no way to say which they wanted.
 *
 * ## Why the profiles are a table rather than a multiplier
 *
 * The tempting shape is one number — a risk dial from 0 to 1 — with every threshold derived from
 * it. It is tidier and it is wrong: these knobs do not move together. A careful agent wants a
 * NARROWER entry band (fewer setups qualify) and a WIDER corporate-action window (more days of
 * standing clear), so a single multiplier would have to be inverted for half of them, and the
 * inversion is the kind of thing that silently flips one day. Three named columns, each a real
 * number a reader can check against the behaviour, is harder to get quietly wrong.
 *
 * ## Why every value is stated for every profile
 *
 * No inheritance and no partial overrides. A profile is the complete set, so reading one row of
 * this table tells you everything the agent will do, and there is no second place to look to find
 * out that "balanced" silently inherited a conservative cooldown.
 */

export const RISK_PROFILES = ['conservative', 'balanced', 'aggressive'] as const;
export type RiskProfile = (typeof RISK_PROFILES)[number];

/** What the agent falls back to, and what a wallet gets before anybody chooses. */
export const DEFAULT_RISK_PROFILE: RiskProfile = 'balanced';

export type RiskSettings = {
  /** The largest single entry, before the daily allowance is considered. */
  maxTradeUsd: number;
  /** The smallest entry worth the fees and the exit rules attached to it. */
  minTradeUsd: number;
  /** What share of the remaining daily allowance one entry may use. */
  allowanceShare: number;
  /** How far into the recorded band a price must be before a breakout counts. */
  momentumEntryAt: number;
  /** How far down the recorded band a price must be before accumulating. */
  dcaEntryBelow: number;
  /** How many recorded readings before a high and a low count as a band at all. */
  minObservations: number;
  /**
   * How close to a published multiplier change the agent will still open, in hours.
   *
   * Larger is MORE careful — it is a distance to keep, not an appetite. This is the knob a single
   * risk multiplier would have had to invert.
   */
  corporateActionWindowHours: number;
  /** The widest projection error, in days, that still makes an earnings window tradeable. */
  earningsErrorToleranceDays: number;
  /** How long a wallet waits between autonomous entries. */
  cooldownMinutes: number;
};

/**
 * The three profiles, in full.
 *
 * The numbers are chosen so that each knob moves in the direction the name implies AND the set
 * holds together: `conservative` trades less often, smaller, later into a move, and stands further
 * clear of anything scheduled. `profile.test.ts` asserts the monotonicity rather than trusting the
 * table to have been typed correctly.
 */
export const RISK_SETTINGS: Readonly<Record<RiskProfile, RiskSettings>> = Object.freeze({
  conservative: {
    maxTradeUsd: 10,
    minTradeUsd: 10,
    allowanceShare: 0.1,
    // Deeper into the move before calling it a breakout, and further down before calling it a dip.
    momentumEntryAt: 0.85,
    dcaEntryBelow: 0.25,
    // More evidence before a high and a low are treated as a band.
    minObservations: 10,
    // Four days clear of a multiplier change, rather than two.
    corporateActionWindowHours: 96,
    // Only a projection the filing record pins to within a day.
    earningsErrorToleranceDays: 1,
    cooldownMinutes: 30,
  },
  balanced: {
    maxTradeUsd: 25,
    minTradeUsd: 10,
    allowanceShare: 0.25,
    momentumEntryAt: 0.75,
    dcaEntryBelow: 0.4,
    minObservations: 6,
    corporateActionWindowHours: 48,
    earningsErrorToleranceDays: 3,
    cooldownMinutes: 10,
  },
  aggressive: {
    maxTradeUsd: 50,
    minTradeUsd: 10,
    allowanceShare: 0.5,
    momentumEntryAt: 0.65,
    dcaEntryBelow: 0.5,
    minObservations: 4,
    corporateActionWindowHours: 24,
    earningsErrorToleranceDays: 5,
    cooldownMinutes: 5,
  },
});

export function isRiskProfile(value: unknown): value is RiskProfile {
  return typeof value === 'string' && (RISK_PROFILES as readonly string[]).includes(value);
}

/**
 * The settings for a profile, falling back rather than throwing.
 *
 * A row holding a profile this build does not know — written by a newer deploy, or by hand — must
 * not stop the agent. It falls back to the default and the caller can see which profile it ended
 * up on, because `settingsFor` is always asked alongside the name it resolved.
 */
export function settingsFor(profile: RiskProfile): RiskSettings {
  return RISK_SETTINGS[profile];
}

/** How each profile describes itself, for the screen that offers the choice. */
export const RISK_BLURB: Readonly<Record<RiskProfile, string>> = Object.freeze({
  conservative:
    'Smaller entries, deeper into a move before it counts as one, and four days clear of any scheduled split or dividend. Trades least often.',
  balanced:
    'The default. Moderate entries, a breakout in the top quarter of the recorded band, and two days clear of anything scheduled.',
  aggressive:
    'Larger entries, acts earlier in a move, works from less recorded history, and stands one day clear of anything scheduled. Trades most often.',
});
