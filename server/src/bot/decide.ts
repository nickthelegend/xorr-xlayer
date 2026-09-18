/**
 * The decide step of propose -> decide -> execute, named — PLAN.md §8.6.
 *
 * Thin on purpose. `runAutonomousCycle` is where the gates and the spend live; this is the name the
 * plan uses for entering it, and the place to reach for when a caller has already chosen a setup
 * and wants that one placed rather than whatever a fresh scan would turn up.
 */
import { runAutonomousCycle, type CandidateSetup, type AutonomousTradeResult } from './autonomous.js';
import type { ToneId } from './tone.js';

export async function decideAndExecute(
  walletId: string,
  options: { fixedUsd?: number; tone?: ToneId; setup?: CandidateSetup } = {},
): Promise<AutonomousTradeResult> {
  return await runAutonomousCycle(walletId, options);
}
