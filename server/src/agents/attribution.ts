/**
 * Which agent gets the credit — and the blame — for a run.
 *
 * Every `append` in the executor named its agent with a string literal: five said `'Yield Keeper'`
 * and one said `'Drawdown Guard'`, whatever had actually run. So the audit trail credited Yield
 * Keeper — the tier that moves idle cash into Aave and nothing else — with WETH recurring buys, an
 * equity fill and every slippage failure in the log, while Drawdown Guard was credited with skips
 * belonging to strategies it has never touched.
 *
 * That is worse here than almost anywhere else it could be. This trail is append-only and
 * hash-chained precisely so it can be believed; an attribution column that is decorative makes the
 * rest of the row harder to trust, not easier.
 *
 * Only four of the seven kinds correspond to a persona. The other three — a recurring buy, a
 * rebalance, a grid — are not run by a character, they are run by the scheduler, and `xorr` is the
 * name the executor already uses for the system acting as itself. Inventing a fifth persona to fill
 * the gap would be the same lie in a nicer costume.
 *
 * Its own module so the leaderboard credits a run by the same rule the trail records (PLAN.md 2.2)
 * instead of searching the trail for it.
 */
import type { PersonaId } from '../bot/personas.js';

const PERSONA_FOR_KIND: Partial<Record<string, { id: PersonaId; name: string }>> = {
  'yield-rotation': { id: 'yield-keeper', name: 'Yield Keeper' },
  'exit-rules': { id: 'drawdown-guard', name: 'Drawdown Guard' },
  momentum: { id: 'momentum-scout', name: 'Momentum Scout' },
  'event-driven': { id: 'earnings-desk', name: 'Earnings Desk' },
};

/** The persona that runs this kind of strategy, when a persona runs it at all. */
export function personaForKind(kind: string): PersonaId | undefined {
  return PERSONA_FOR_KIND[kind]?.id;
}

/** The name the trail records for a run of this kind. */
export function agentForKind(kind: string): string {
  return PERSONA_FOR_KIND[kind]?.name ?? 'xorr';
}

/**
 * The persona a recorded name refers to — the inverse of `agentForKind`, for reading back what was written.
 *
 * An agent's own order is a one-shot `buy`, and no persona runs a `buy`; what names the agent is `placedBy` in the
 * strategy's params, written by `autonomous.ts` at the moment it placed the order and carried into the audit row the
 * activity screen reads. Anything else — `xorr`, a name no persona has — is nobody's, and says so.
 */
export function personaByName(name: unknown): PersonaId | undefined {
  if (typeof name !== 'string') return undefined;
  for (const entry of Object.values(PERSONA_FOR_KIND)) {
    if (entry && entry.name === name) return entry.id;
  }
  return undefined;
}
