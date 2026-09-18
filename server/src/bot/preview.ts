/**
 * What the agent is about to do, before it does it.
 *
 * The autonomous sweep runs inside the scheduler tick and, until now, the first anybody heard of it
 * was a push notification saying a trade had happened. This answers the two questions a person has
 * in the meantime: when is it next going to look, and what is it going to look at.
 *
 * ## What it deliberately does not do
 *
 * It does not evaluate the setups. Doing that would mean a Jupiter quote, a 1inch quote and a mint
 * read for every symbol on every load of a preview screen — and worse, the answer would be a
 * prediction of what the agent is going to decide, which is a thing this module cannot know. The
 * sweep filters on conditions read AT TICK TIME, and a preview that named a winner would be wrong
 * the moment a price moved, on the one screen whose job is to set expectations accurately.
 *
 * So it reports the universe the sweep will consider and the gates that are already decided — the
 * kill switch, and the cooldown — and says plainly that the rest is read when the tick comes.
 */
import { one } from '../db/index.js';
import { XSTOCKS } from '../venues/xstocks.js';
import { schedulerHeartbeat } from '../executor/scheduler.js';
import { AGENT_DECISION } from './autonomous.js';
import {
  DEFAULT_RISK_PROFILE,
  isRiskProfile,
  settingsFor,
  type RiskProfile,
  type RiskSettings,
} from './risk-profile.js';

export type AgentPreview = {
  /** How often the loop runs, in milliseconds. */
  tickMs: number;
  /**
   * When the next sweep is due, or null when this executor has not ticked yet.
   *
   * Null after a restart, and that is the honest answer: the loop has a period but no anchor until
   * it has run once, and inventing one from the wall clock would be a guess presented as a time.
   */
  nextTickAt: number | null;
  lastTickAt: number | null;
  /** The symbols the sweep will consider. Each is then filtered on conditions read at tick time. */
  universe: { symbol: string; name: string }[];
  /** Why this wallet would be skipped, if it would be. */
  wallet: {
    agentsStopped: boolean;
    /** When the per-wallet cooldown lifts, or null when nothing is holding it. */
    cooldownUntil: number | null;
    /** Would the next tick actually evaluate this wallet? */
    eligible: boolean;
  };
  /**
   * The risk profile in force, and the thresholds it resolves to.
   *
   * The settings ride along rather than being looked up again by the screen. A panel that said
   * "Balanced" while deriving its own numbers from a second copy of the table would drift from the
   * agent the first time one of them changed, on the panel built to say what the agent will do.
   */
  risk: { profile: RiskProfile; settings: RiskSettings };
};

export async function agentPreview(walletId: string): Promise<AgentPreview> {
  const { tickMs, lastTickAt } = schedulerHeartbeat();

  const row = await one<{ agents_stopped: boolean | null; risk_profile: string | null }>(
    `SELECT agents_stopped, risk_profile FROM wallets WHERE id = $1`,
    [walletId],
  );
  const agentsStopped = Boolean(row?.agents_stopped);
  const profile = isRiskProfile(row?.risk_profile) ? row.risk_profile : DEFAULT_RISK_PROFILE;
  const settings = settingsFor(profile);

  /*
   * The most recent decision, which is what the sweep's cooldown actually keys on.
   *
   * Asked without the time window the sweep uses, so this can say WHEN the cooldown lifts rather
   * than only whether it is currently on. A screen that says "held" without saying "until when" is
   * the version of this that sends someone back to check every thirty seconds.
   */
  const recent = await one<{ decided_at: Date }>(
    `SELECT decided_at FROM proposals
      WHERE wallet_id = $1 AND decision = $2 AND decided_at IS NOT NULL
      ORDER BY decided_at DESC LIMIT 1`,
    [walletId, AGENT_DECISION],
  ).catch(() => null);

  const cooldownEnds = recent
    ? new Date(recent.decided_at).getTime() + settings.cooldownMinutes * 60_000
    : null;
  const cooldownUntil = cooldownEnds !== null && cooldownEnds > Date.now() ? cooldownEnds : null;

  return {
    tickMs,
    lastTickAt,
    nextTickAt: lastTickAt === null ? null : lastTickAt + tickMs,
    universe: Object.values(XSTOCKS).map((s) => ({ symbol: s.symbol, name: s.name })),
    wallet: {
      agentsStopped,
      cooldownUntil,
      eligible: !agentsStopped && cooldownUntil === null,
    },
    risk: { profile, settings },
  };
}
