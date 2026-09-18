/**
 * Alerts — the moments the agents interrupt you for.
 *
 * `app/alerts/new.tsx` built an alert object and discarded it, and the toggle POSTed to a route
 * that did not exist with its 404 swallowed by a `.catch`. The screen looked like it worked and
 * remembered nothing, which is a worse failure than an error would have been.
 */
import { randomUUID } from 'node:crypto';
import { priceable } from '../market/feeds.js';
import { Hono, type Context } from 'hono';
import { z } from 'zod';
import { one, query } from '../db/index.js';
import { currentWallet } from './wallet-context.js';
import { evaluateAlerts } from '../alerts/evaluate.js';

export const alerts = new Hono();

type AlertRow = {
  id: string;
  kind: string;
  symbol: string | null;
  name: string;
  detail: string;
  enabled: boolean;
  config: Record<string, unknown>;
  armed: boolean;
  last_fired_at: Date | null;
  fire_count: number;
};

/*
 * Delegates to `currentWallet` rather than asking again.
 *
 * This was its own `WHERE user_id = $1 LIMIT 1` with no ORDER BY — one of nine such copies, each
 * free to return a different wallet than the others on an account with more than one row. The
 * damage is not that a query is duplicated: it is that your agents, your alerts, your limits and
 * your trades could each be resolved against a DIFFERENT wallet within one signed-in session.
 * One definition, in `wallet-context`, is the whole point of that module.
 */
async function walletId(c: Context): Promise<string | undefined> {
  return (await currentWallet(c))?.id;
}

const toApi = (r: AlertRow) => ({
  id: r.id,
  kind: r.kind,
  symbol: r.symbol,
  name: r.name,
  detail: r.detail,
  enabled: r.enabled,
  config: r.config,
  /*
   * Whether it is armed, and when it last fired.
   *
   * An alert list that shows only "on" cannot distinguish one that is watching from one that has
   * already fired and is waiting for the condition to clear. Those are different states and the
   * user is entitled to both.
   */
  armed: r.armed,
  lastFiredAt: r.last_fired_at ? r.last_fired_at.toISOString() : null,
  fireCount: r.fire_count,
  // The UI's `default` field means "on when you first see it". For a persisted alert the enabled
  // flag IS the answer, so they are the same thing rather than two sources for one fact.
  default: r.enabled,
});

alerts.get('/alerts', async (c) => {
  const id = await walletId(c);
  if (!id) return c.json([]);
  const rows = await query<AlertRow>(
    `SELECT * FROM alerts WHERE wallet_id = $1 ORDER BY created_at DESC`,
    [id],
  );
  return c.json(rows.map(toApi));
});

const NewAlert = z.object({
  kind: z.enum(['price', 'agent', 'risk']),
  symbol: z.string().optional(),
  name: z.string().min(1),
  detail: z.string().default(''),
  config: z.record(z.string(), z.unknown()).default({}),
});

/**
 * Can this alert ever fire?
 *
 * `config` was `.default({})` and nothing checked it, so `POST /alerts` happily created a price
 * alert with no level. `evaluate` then reports it `unevaluable` on every sweep, forever — which is
 * the right thing for the sweep to do with a row that already exists, and the wrong thing to allow
 * anyone to create. The user sees an alert in their list that will never go off, and the only way
 * to find out is to wait for the thing it was supposed to warn about.
 *
 * The rules mirror `verdictFor` exactly, because a second, looser definition of "valid" here is
 * how the two drift apart and the check stops meaning anything.
 */
export function unevaluableReason(body: z.infer<typeof NewAlert>): string | undefined {
  const n = (k: string) => Number(body.config[k] ?? Number.NaN);
  if (body.kind === 'price') {
    if (!body.symbol) return 'a price alert needs a symbol';
    /*
     * And a symbol something can actually price.
     *
     * The level was checked and the symbol was not, so `POST /alerts` accepted a price alert on
     * any string at all — `WETH'; DROP TABLE alerts;--` was created without complaint — and
     * `evaluate` then answered `unevaluable — No price feed for …` on every sweep, forever. That
     * is the exact failure the docblock above describes for a missing level, one field over: an
     * alert sitting in the user's list that cannot fire, discoverable only by waiting for the
     * thing it was supposed to warn about.
     *
     * Asked of `market/feeds.ts`, which is the SAME definition `priceOf` dispatches on, rather
     * than a second list here. This check used to keep its own copy — `isStock || COINGECKO_IDS` —
     * and the copy went stale in the direction nobody guards against: the executor grew a Solana
     * price for xStocks, this route never heard, and `POST /alerts` refused a price alert on NVDAx
     * saying nothing could price it while `venues/xstocks.ts` was pricing it all day. A refusal
     * that is wrong is worse than the bug it was written to prevent.
     */
    if (!priceable(body.symbol)) {
      return `nothing prices ${body.symbol}, so this alert could never fire`;
    }
    if (!Number.isFinite(n('above')) && !Number.isFinite(n('below'))) {
      return 'a price alert needs an `above` or `below` level in config';
    }
    return undefined;
  }
  if (body.kind === 'agent') {
    return Number.isFinite(n('blockedRuns')) ? undefined : 'an agent alert needs `blockedRuns` in config';
  }
  const hasRisk =
    Number.isFinite(n('capRemainingUsd')) ||
    Number.isFinite(n('expiresWithinHours')) ||
    body.config.revoked === true;
  return hasRisk
    ? undefined
    : 'a risk alert needs `capRemainingUsd`, `expiresWithinHours` or `revoked` in config';
}

alerts.post('/alerts', async (c) => {
  const body = NewAlert.parse(await c.req.json());
  const id = await walletId(c);
  if (!id) return c.json({ error: 'no_wallet' }, 400);

  const dead = unevaluableReason(body);
  if (dead) return c.json({ error: 'unevaluable_alert', message: dead }, 400);

  /*
   * The same alert twice is not two alerts.
   *
   * Resubmitting an identical one created a second row — two entries in the list that fire
   * together, notify twice, and have to be deleted twice. A refusal that names the existing one
   * is more useful than a duplicate, and it makes the create idempotent for a retried request.
   */
  const existing = await one<AlertRow>(
    `SELECT * FROM alerts
      WHERE wallet_id = $1 AND kind = $2 AND symbol IS NOT DISTINCT FROM $3 AND config = $4::jsonb
      LIMIT 1`,
    [id, body.kind, body.symbol ?? null, JSON.stringify(body.config)],
  );
  if (existing) {
    return c.json(
      { error: 'duplicate_alert', message: `You already have this alert: ${existing.name}.` },
      409,
    );
  }

  const row = await one<AlertRow>(
    `INSERT INTO alerts (id, wallet_id, kind, symbol, name, detail, config)
     VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
    [randomUUID(), id, body.kind, body.symbol ?? null, body.name, body.detail, JSON.stringify(body.config)],
  );
  return c.json(toApi(row!));
});

/** POST rather than PATCH: this is what the toggle on the alerts screen already calls. */
/**
 * Evaluate every alert now, instead of waiting for the next scheduler tick.
 *
 * The sweep is global, so this returns only the outcomes for the caller's own alerts — a user has
 * no business seeing whether a stranger's price alert fired.
 *
 * Registered BEFORE `/alerts/:id`, and that is load-bearing: Hono matches in declaration order, so
 * with the parameterised route first this resolved to `:id = "evaluate"` and ran the enable/disable
 * handler, which rejected the body for a missing `enabled` field. A literal segment that could be
 * read as a parameter has to be declared first.
 */
alerts.post('/alerts/evaluate', async (c) => {
  const id = await walletId(c);
  if (!id) return c.json({ error: 'no_wallet' }, 400);
  const outcomes = await evaluateAlerts();
  const mine = await query<{ id: string }>(`SELECT id FROM alerts WHERE wallet_id = $1`, [id]);
  const ids = new Set(mine.map((r) => r.id));
  return c.json(outcomes.filter((o) => ids.has(o.id)));
});

alerts.post('/alerts/:id', async (c) => {
  const body = z.object({ enabled: z.boolean() }).parse(await c.req.json());
  const id = await walletId(c);
  if (!id) return c.json({ error: 'no_wallet' }, 400);

  const row = await one<AlertRow>(
    `UPDATE alerts SET enabled = $3 WHERE id = $1 AND wallet_id = $2 RETURNING *`,
    [c.req.param('id'), id, body.enabled],
  );
  if (!row) return c.json({ error: 'not_found' }, 404);
  return c.json(toApi(row));
});

alerts.delete('/alerts/:id', async (c) => {
  const id = await walletId(c);
  if (!id) return c.json({ error: 'no_wallet' }, 400);
  const row = await one<{ id: string }>(
    `DELETE FROM alerts WHERE id = $1 AND wallet_id = $2 RETURNING id`,
    [c.req.param('id'), id],
  );
  if (!row) return c.json({ error: 'not_found' }, 404);
  return c.json({ ok: true });
});
