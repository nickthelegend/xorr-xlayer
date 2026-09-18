/**
 * Anchoring on a cadence, not on every write.
 *
 * Every audit row could be anchored, and that would be both ruinous in gas and no stronger: what
 * an anchor proves is that a trail existed in a given state before a given block, and one anchor
 * per hour proves that for every row written in the hour before it. The cost is the resolution of
 * the claim — "unchanged since 22:59" rather than "unchanged since the last row" — and that is the
 * right trade for a log nobody edits.
 *
 * Wallets with nothing new are skipped without a transaction. `anchorWallet` compares the head it
 * would publish against the head already on-chain, so an idle wallet costs one `eth_call`.
 */
import { anchorWallet, anchorableWallets, anchoringConfigured } from './anchor.js';
import { log } from '../http/request-id.js';

/** How often the sweep is allowed to publish. Cheap on Base, and hourly is a fine resolution. */
export const ANCHOR_EVERY_MS = Number(process.env.ANCHOR_EVERY_MS ?? 3_600_000);

let lastSweepAt = 0;

export type SweepResult = { considered: number; anchored: number; skipped: number; failed: number };

/**
 * Anchor every wallet whose trail has moved.
 *
 * `force` exists for the route that lets someone anchor on demand; the scheduler always respects
 * the cadence, so a busy tick loop cannot turn into a stream of transactions.
 */
export async function anchorSweep(force = false): Promise<SweepResult | undefined> {
  if (!anchoringConfigured()) return undefined;
  if (!force && Date.now() - lastSweepAt < ANCHOR_EVERY_MS) return undefined;
  lastSweepAt = Date.now();

  const wallets = await anchorableWallets();
  const result: SweepResult = { considered: wallets.length, anchored: 0, skipped: 0, failed: 0 };

  for (const w of wallets) {
    try {
      const out = await anchorWallet(w.id, w.address);
      if (out.anchored) {
        result.anchored += 1;
        console.log(`[anchor] ${w.address} entry ${out.entryCount} -> ${out.txHash}`);
      } else {
        result.skipped += 1;
      }
    } catch (e) {
      /*
       * A wallet that cannot be anchored must not stop the ones after it. Anchoring is a claim
       * ABOUT the trail, never a precondition for writing to it, so a failure here is loud and
       * otherwise inert.
       */
      result.failed += 1;
      log.error(`[anchor] ${w.address} failed:`, e instanceof Error ? e.message : e);
    }
  }
  return result;
}
