/**
 * What the bot did while you were not looking.
 *
 * "A bot that trades your capital while you get on with your life" is the first line of the README,
 * and the app had no way to close that loop. The activity screen answers "what has ever happened",
 * which on day twenty is a wall. This answers the question the premise actually creates — what
 * changed since I last looked — and it is the difference between trusting the bot and auditing it.
 *
 * Two decisions worth stating:
 *
 *   - Reading the summary does NOT mark it seen. A card the user scrolled past without reading
 *     would silently consume the only chance to tell them. The marker advances when they
 *     acknowledge, which is a separate request.
 *   - A first visit is not "everything since the beginning of time". With no marker, the window
 *     is the last day — otherwise the first thing a new user sees is a summary of an account that
 *     has not done anything yet, or a returning one is buried under a month.
 */
import { Hono } from 'hono';
import { query } from '../db/index.js';
import { currentWallet } from './wallet-context.js';

export const catchup = new Hono();

const FIRST_VISIT_WINDOW = '1 day';

type Entry = {
  action: string;
  detail: string;
  kind: string;
  at: Date;
  signature: string | null;
};

catchup.get('/catchup', async (c) => {
  /*
   * The SAME wallet every other route resolves, not a second guess at it.
   *
   * This was `WHERE user_id = $1 LIMIT 1` with no ORDER BY — the exact shape `wallet-context`
   * exists to prevent — so on an account with two wallet rows the catch-up could summarise a
   * different wallet's trail than the one the app is showing, and could pick differently between
   * calls.
   */
  const w = await currentWallet(c);
  if (!w) return c.json({ since: null, entries: [], counts: {}, isFirstVisit: true });

  const since = w.last_seen_at;
  const rows = await query<Entry>(
    `SELECT action, detail, kind, at, signature
       FROM audit_log
      WHERE wallet_id = $1
        AND at > COALESCE($2::timestamptz, now() - interval '${FIRST_VISIT_WINDOW}')
      ORDER BY seq DESC
      LIMIT 50`,
    [w.id, since],
  );

  /*
   * Counted by kind, because the shape of what happened matters more than the list.
   *
   * "Three trades and one block" is something a person can absorb in a second; twelve rows of
   * detail is something they scroll past. The rows are there for whoever wants them.
   */
  const counts: Record<string, number> = {};
  for (const r of rows) counts[r.kind] = (counts[r.kind] ?? 0) + 1;

  return c.json({
    since: since ? since.toISOString() : null,
    isFirstVisit: since === null,
    counts,
    entries: rows.map((r) => ({
      action: r.action,
      detail: r.detail,
      kind: r.kind,
      at: r.at.toISOString(),
      signature: r.signature,
    })),
  });
});

/** Acknowledge: everything up to now has been seen. Deliberately explicit. */
catchup.post('/catchup/seen', async (c) => {
  const w = await currentWallet(c);
  if (!w) return c.json({ ok: false }, 400);
  await query(`UPDATE wallets SET last_seen_at = now() WHERE id = $1`, [w.id]);
  return c.json({ ok: true, seenAt: new Date().toISOString() });
});
