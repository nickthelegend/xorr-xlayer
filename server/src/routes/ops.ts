/**
 * Health and metrics — the two questions an operator asks, answered honestly.
 *
 * `/health` returned `{ ok: true }` if the process was alive enough to answer, which is the least
 * informative thing a health check can say: a server whose database is gone and whose RPC is
 * unreachable answers it exactly as cheerfully as a healthy one. Every dependency that a request
 * can fail on is checked, with the latency it took, and the overall status is the worst of them.
 *
 * The distinction that matters is `degraded` vs `down`. A missing price feed means the market
 * screens show dashes; a missing database means nothing works at all. Collapsing those into one
 * boolean is how a load balancer ends up cycling a server that was fine.
 */
import { Hono } from 'hono';
import { query } from '../db/index.js';
import { THIS_CHAIN } from '../db/chain-scope.js';
import { fillQuality } from '../executor/fill-quality.js';
import { publicClient } from '../evm/client.js';
import { CHAIN_KEY } from '../evm/chains.js';
import { DELEGATION_ADDRESS } from '../evm/delegation.js';
import { gasStatus } from '../evm/gas.js';
import { publicSurface } from '../auth/middleware.js';
import { breakerState } from '../http/get.js';
import { voiceConfigured } from '../bot/llm.js';

export const ops = new Hono();

/**
 * Which commit is running.
 *
 * The executors are CLI uploads, not git-linked deploys, so Railway records no commit — and the
 * deployed code could not be matched to the repository at all. `scripts/deploy-executor.mjs` sets
 * `XORR_BUILD_SHA` on the service just before it uploads, with `-dirty` when `server/` had
 * uncommitted changes. Null means nobody recorded one, and the response says so.
 */
const BUILD_SHA: string | null = process.env.XORR_BUILD_SHA ?? null;

type DepStatus = 'up' | 'degraded' | 'down';
type Dep = { name: string; status: DepStatus; ms: number; detail: string; critical: boolean };

const started = Date.now();

async function probe(
  name: string,
  critical: boolean,
  fn: () => Promise<string>,
  timeoutMs = 5_000,
): Promise<Dep> {
  const t0 = Date.now();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const detail = await Promise.race([
      fn(),
      new Promise<never>((_, rej) => {
        timer = setTimeout(() => rej(new Error(`no answer in ${timeoutMs}ms`)), timeoutMs);
      }),
    ]);
    return { name, status: 'up', ms: Date.now() - t0, detail, critical };
  } catch (e) {
    return {
      name,
      status: critical ? 'down' : 'degraded',
      ms: Date.now() - t0,
      detail: e instanceof Error ? e.message : String(e),
      critical,
    };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

ops.get('/health', async (c) => {
  const deps = await Promise.all([
    probe('postgres', true, async () => {
      const rows = await query<{ now: Date }>('SELECT now()');
      return `responded at ${rows[0]?.now?.toISOString()}`;
    }),
    probe('rpc', true, async () => `${CHAIN_KEY} at block ${await publicClient.getBlockNumber()}`),
    probe('delegation', true, async () => {
      const code = await publicClient.getCode({ address: DELEGATION_ADDRESS });
      if (!code || code.length <= 4) throw new Error(`no code at ${DELEGATION_ADDRESS}`);
      return `${(code.length - 2) / 2} bytes`;
    }),
    // Not critical: the bot being out of gas stops trading, and trading stopping is not the
    // server being broken. It is still the single most likely reason a strategy fails.
    probe('gas', false, async () => {
      const g = await gasStatus();
      if (!g.enough) throw new Error(`${g.eth.toFixed(4)} ETH, below the ${g.floor} floor`);
      return `${g.eth.toFixed(4)} ETH`;
    }),
    // Upstreams the circuit breaker has shut out right now: prices and quotes fail fast while one is open.
    probe('upstreams', false, async () => {
      const open = breakerState().filter((b) => b.openUntil > Date.now());
      if (open.length > 0) throw new Error(`open: ${open.map((b) => b.host).join(', ')}`);
      return 'no breaker open';
    }),
  ]);

  const down = deps.some((d) => d.status === 'down');
  const degraded = deps.some((d) => d.status === 'degraded');
  const status: DepStatus = down ? 'down' : degraded ? 'degraded' : 'up';

  return c.json(
    {
      // Kept so existing callers and the README's curl still work: true whenever requests can be
      // served, which is what they were asking.
      ok: !down,
      status,
      chain: CHAIN_KEY,
      version: BUILD_SHA,
      delegation: DELEGATION_ADDRESS,
      uptimeSec: Math.round((Date.now() - started) / 1000),
      dependencies: deps,
      /** Every upstream host the HTTP lane has seen, with its consecutive failures and when a breaker closes. */
      breakers: breakerState().map((b) => ({ ...b, open: b.openUntil > Date.now() })),
      // The old shape had `db` as a timestamp. Several things read it.
      db: deps.find((d) => d.name === 'postgres')?.detail,
      /*
       * What can be called without a session.
       *
       * Published so the client can mirror it rather than keep a second copy that silently drifts
       * — the same reason `tradable.ts` mirrors the token registry and a test fails when they
       * disagree.
       */
      publicSurface,
      /*
       * Whether the agents can reply. With no language model every question is answered with a refusal, and the app
       * offers each agent's screens instead of questions when this says so. Configuration, not a probe: asking a model
       * on every health check would spend a request each time.
       */
      voice: { configured: voiceConfigured() },
    },
    down ? 503 : 200,
  );
});

/**
 * Counters an operator would actually page on, read from the tables that hold them.
 *
 * Deliberately derived rather than incremented in memory: a counter that resets on restart tells
 * you about the last few minutes of a process, not about the system.
 */
ops.get('/metrics', async (c) => {
  const [runs, alerts, strategies, spend] = await Promise.all([
    query<{ status: string; n: string }>(
      `SELECT status, count(*) AS n FROM strategy_runs WHERE chain = ${THIS_CHAIN} GROUP BY status`,
    ),
    query<{ n: string; fired: string }>(
      `SELECT count(*) AS n, COALESCE(SUM(fire_count),0) AS fired FROM alerts WHERE enabled`,
    ),
    query<{ state: string; n: string }>(
      `SELECT state, count(*) AS n FROM strategies WHERE chain = ${THIS_CHAIN} GROUP BY state`,
    ),
    query<{ total: string }>(
      `SELECT COALESCE(SUM(spent_usd),0) AS total FROM daily_spend WHERE day = (now() AT TIME ZONE 'UTC')::date`,
    ),
  ]);

  const byStatus = Object.fromEntries(runs.map((r) => [r.status, Number(r.n)]));
  const filled = byStatus.filled ?? 0;
  const failed = byStatus.failed ?? 0;

  /*
   * WHY runs failed, not just how many.
   *
   * A failure rate says something is wrong and nothing about what. These are the causes an operator
   * would actually act on differently: a price that moved is the market, a revoked permission is
   * the user, a venue that could not fill is us. They were all one number.
   *
   * Grouped from the stored error text because that is where the cause lives — the same strings
   * `humanFailure` and `isTransient` classify.
   */
  const causes = await query<{ error: string | null; n: string }>(
    `SELECT error, count(*) AS n FROM strategy_runs
      WHERE status = 'failed' AND finished_at > now() - interval '7 days' AND chain = ${THIS_CHAIN}
      GROUP BY error ORDER BY n DESC LIMIT 20`,
  ).catch(() => []);
  const bucket = (e: string | null): string => {
    const t = (e ?? '').toLowerCase();
    if (/returnamountisnotenough|slippage/.test(t)) return 'price_moved';
    if (/policyrevoked|revoked/.test(t)) return 'permission_revoked';
    if (/policyexpired|expired/.test(t)) return 'permission_expired';
    if (/dailycapexceeded|cap/.test(t)) return 'daily_cap';
    if (/venuenotallowed/.test(t)) return 'venue_not_allowed';
    if (/notdelegate/.test(t)) return 'wrong_delegate';
    if (/venuecallfailed|\btf\b|no route/.test(t)) return 'venue_could_not_fill';
    if (/timeout|timed out|fetch failed|econn|socket hang up/.test(t)) return 'upstream_unreachable';
    return 'other';
  };
  const failuresByCause: Record<string, number> = {};
  for (const row of causes) {
    const k = bucket(row.error);
    failuresByCause[k] = (failuresByCause[k] ?? 0) + Number(row.n);
  }

  /*
   * Which venue settled each fill, as the run recorded it when it filled (PLAN.md 2.9).
   *
   * This was counted from the audit trail's wording — "Aqua book", "SwapVM program", and any other
   * "Bought"/"Sold" as 1inch — so a reworded sentence was a miscounted venue. `strategy_runs.venue` is
   * written with the fill, and closes and flattens write runs too (2.8).
   */
  const venues = await query<{ venue: string; n: string }>(
    `SELECT COALESCE(venue, 'unrecorded') AS venue, count(*) AS n
       FROM strategy_runs WHERE status = 'filled' AND chain = ${THIS_CHAIN} GROUP BY 1`,
  ).catch(() => []);

  return c.json({
    runs: byStatus,
    /** The number worth alerting on: fills that did not happen because something broke. */
    runFailureRate: filled + failed > 0 ? failed / (filled + failed) : 0,
    /** The number worth acting on: what broke. Last 7 days. */
    failuresByCause,
    /** Where trades actually settled — the claim the 1inch track rests on, counted. */
    fillsByVenue: Object.fromEntries(venues.map((r) => [r.venue, Number(r.n)])),
    /**
     * How close each venue came to the quote it was chosen on.
     *
     * `fillsByVenue` above counts WHERE trades settled. This says how WELL — the distance between
     * what the router promised and what the chain delivered, per venue, in basis points. A count
     * is a label; this is the claim.
     */
    fillQuality: await fillQuality().catch(() => null),
    strategies: Object.fromEntries(strategies.map((r) => [r.state, Number(r.n)])),
    alertsEnabled: Number(alerts[0]?.n ?? 0),
    alertsFiredTotal: Number(alerts[0]?.fired ?? 0),
    spentTodayUsd: Number(spend[0]?.total ?? 0),
    gas: await gasStatus().catch(() => null),
    uptimeSec: Math.round((Date.now() - started) / 1000),
  });
});
