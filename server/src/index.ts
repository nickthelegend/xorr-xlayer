import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import 'dotenv/config';
import { ZodError } from 'zod';
import { routes } from './routes/index.js';
import { strategyRoutes } from './routes/strategies.js';
import { extra } from './routes/extra.js';
import { market, warmMarketCache } from './routes/market.js';
import { agents } from './agents/routes.js';
import { agentSurface } from './routes/agent.js';
import { alerts } from './routes/alerts.js';
import { verifyRoutes } from './routes/verify.js';
import { panic } from './routes/panic.js';
import { ops } from './routes/ops.js';
import { catchup } from './routes/catchup.js';
import { privyRoutes } from './routes/privy.js';
import { tokenRoutes } from './routes/tokens.js';
import { historyRoutes } from './routes/history.js';
import { mirrorRoutes, startMirrorSchedule } from './routes/mirror.js';
import { faucetRoutes } from './routes/faucet.js';
import { withdrawalRoutes } from './routes/withdrawals.js';
import { businessRoutes } from './routes/business.js';
import { xstockRoutes } from './routes/xstocks.js';
import { guardRequests } from './http/guards.js';
import { requestId, currentRequestId, log } from './http/request-id.js';
import { startScheduler } from './executor/scheduler.js';
import { inFlightRuns } from './executor/run.js';
import { reconcileInterruptedRuns } from './executor/reconcile.js';
import { CHAIN_KEY, rpcUrl } from './evm/chains.js';
import { DELEGATION_ADDRESS, delegatePublicKey } from './evm/delegation.js';
import { authMiddleware } from './auth/middleware.js';
import { errorResponse } from './http/errors.js';
import { DATABASE_URL, pool } from './db/index.js';
import { withoutPassword } from './db/redact.js';

const app = new Hono();

/*
 * First, so every line logged by anything downstream carries the id — including the error handler
 * and the rate limiter, which are the two places you most want it.
 */
app.use('*', requestId);

/*
 * One line per request, after it finishes, with the status and how long it took.
 *
 * There was no access log at all, so "the app was slow at 3pm" had nothing behind it. Logged after
 * `next()` because the status and the duration only exist once the handler is done.
 */
app.use('*', async (c, next) => {
  const t0 = Date.now();
  await next();
  const ms = Date.now() - t0;
  // Health checks and metrics run every few seconds; logging them buries everything else.
  const noisy = c.req.path === '/health' || c.req.path === '/metrics';
  if (!noisy || c.res.status >= 400) {
    log.info(`${c.req.method} ${c.req.path} ${c.res.status} ${ms}ms`);
  }
});

/**
 * Which origins may call this executor.
 *
 * `*` was the wrong answer once real state-changing routes existed: any page a user has open can
 * make a same-credentials request to a wildcard origin. It matters less than it looks here —
 * authentication is a bearer token rather than a cookie, so a hostile page cannot borrow the
 * session — but "less than it looks" is not a reason to leave it open, and CORS is the cheapest
 * control in the stack.
 *
 * Configurable, because the origins genuinely differ per deployment: Expo's dev server moves port
 * when 8081 is taken, and a device build has no origin at all. An unset list keeps the wildcard
 * and says so at boot rather than silently locking out the local client.
 */
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS ?? '')
  .split(',')
  .map((o) => o.trim())
  .filter(Boolean);

function originFor(requested: string | undefined): string {
  if (ALLOWED_ORIGINS.length === 0) return '*';
  if (requested && ALLOWED_ORIGINS.includes(requested)) return requested;
  // Deny by echoing the first allowed origin rather than the requested one: the browser compares
  // them and refuses. Echoing nothing at all produces a confusing "no CORS header" error instead
  // of the accurate "this origin is not allowed".
  return ALLOWED_ORIGINS[0]!;
}

app.use('*', async (c, next) => {
  const requested = c.req.header('origin');
  await next();
  c.header('access-control-allow-origin', originFor(requested));
  // Required whenever the origin is not `*`, or caches will serve one origin's response to another.
  if (ALLOWED_ORIGINS.length > 0) c.header('vary', 'Origin');
  // The web client sends `Authorization: Bearer <privy token>`; without it here the browser's
  // preflight rejects every authenticated request and the whole app looks logged-out.
  // `idempotency-key` and `x-request-id` are ours; without them here the browser preflight
  // strips exactly the two headers that make a retry safe and a failure traceable.
  c.header('access-control-allow-headers', 'content-type,authorization,idempotency-key,x-request-id');
  c.header('access-control-allow-methods', 'GET,POST,PATCH,DELETE,OPTIONS');
  c.header('access-control-expose-headers', 'x-request-id,idempotent-replay,retry-after');
});
app.options('*', (c) => c.body(null, 204));

// How a thrown error becomes a response. See `http/errors.ts`.
app.onError(errorResponse);

/**
 * A ceiling on the unauthenticated surface.
 *
 * The /market/* routes are public on purpose — a spot price is not user data — but public and
 * unlimited are different things: they proxy a rate-limited upstream on our key, so one script can
 * exhaust the quota for every real user. Everything served from cache is cheap; this only bites a
 * caller asking faster than a human could.
 *
 * Deliberately per-process and in memory. A distributed limiter is the right answer behind a load
 * balancer and the wrong answer to reach for before there is one.
 */
const RATE_WINDOW_MS = 60_000;
const RATE_MAX = 240;
const hits = new Map<string, { count: number; resetAt: number }>();

app.use('*', async (c, next) => {
  if (!c.req.path.startsWith('/market/') && c.req.path !== '/yield/supply') return next();

  const who =
    c.req.header('x-forwarded-for')?.split(',')[0]?.trim() ??
    c.req.header('x-real-ip') ??
    'local';
  const now = Date.now();
  const row = hits.get(who);
  if (!row || now > row.resetAt) {
    hits.set(who, { count: 1, resetAt: now + RATE_WINDOW_MS });
  } else if (++row.count > RATE_MAX) {
    c.header('retry-after', String(Math.ceil((row.resetAt - now) / 1000)));
    return c.json({ error: 'rate_limited', detail: 'Too many market requests.' }, 429);
  }

  // Keep the map from growing without bound on a long-running process.
  if (hits.size > 10_000) {
    for (const [k, v] of hits) if (now > v.resetAt) hits.delete(k);
  }
  return next();
});

/*
 * Auth, then the rate limiter, then idempotency — in front of every route.
 *
 * Idempotency sat in front of the limiter, so a 429 claimed its key and was replayed to every retry for a day. The order
 * is the fix; `http/guards.ts` keeps it, and says why each one sits where it does.
 */
guardRequests(app, authMiddleware);

app.route('/', routes);
app.route('/', strategyRoutes);
app.route('/', agentSurface);
app.route('/', extra);
app.route('/', market);
app.route('/', agents);
app.route('/', alerts);
app.route('/', verifyRoutes);
app.route('/', panic);
app.route('/', ops);
app.route('/', catchup);
app.route('/', privyRoutes);
app.route('/', tokenRoutes);
app.route('/', historyRoutes);
app.route('/', mirrorRoutes);
app.route('/', faucetRoutes);
app.route('/', withdrawalRoutes);
app.route('/', businessRoutes);
app.route('/', xstockRoutes);

const port = Number(process.env.PORT ?? 8787);
const server = serve({ fetch: app.fetch, port });

/**
 * Shut down without abandoning work.
 *
 * A SIGTERM in the middle of a run left the `strategy_runs` row claimed and never finished — the
 * period key means that period can never be retried, so the strategy silently skips a day and the
 * row sits `pending` forever. Draining first is the difference between a deploy costing nothing
 * and a deploy costing a user their scheduled buy.
 *
 * Bounded: a drain that never finishes is a process that never dies, and an orchestrator will kill
 * it less politely. Ten seconds is longer than any single fill has taken and shorter than the
 * grace period every scheduler gives.
 */
const DRAIN_MS = 10_000;
let shuttingDown = false;
/** The MongoDB copy's schedule, when this deployment has one (routes/mirror.ts). Declared here so shutdown can stop it. */
let stopMirror: (() => void) | undefined;

async function shutdown(signal: string) {
  if (shuttingDown) return;
  shuttingDown = true;
  log.info(`${signal} — draining for up to ${DRAIN_MS}ms`);

  if (scheduler) clearInterval(scheduler);
  stopMirror?.();
  server.close();

  const deadline = Date.now() + DRAIN_MS;
  while (inFlightRuns() > 0 && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 200));
  }
  const stranded = inFlightRuns();
  if (stranded > 0) {
    log.warn(`${stranded} run(s) still in flight after ${DRAIN_MS}ms — exiting anyway`);
  }

  await pool.end().catch(() => undefined);
  log.info('stopped cleanly');
  process.exit(0);
}

process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
console.log(`xorr executor on :${port}`);
console.log(`  db      ${withoutPassword(DATABASE_URL)}`);
console.log(`  chain    ${CHAIN_KEY} ${rpcUrl}`);
console.log(`  contract ${DELEGATION_ADDRESS}`);
console.log(`  delegate ${delegatePublicKey}`);
console.log('  auth     Privy (every route except /health)');

/*
 * Heal anything the last shutdown could not.
 *
 * Before the scheduler starts, so a tick cannot race a row that is about to be closed. Failures
 * here are logged and not fatal: an executor that refuses to start because it could not tidy up
 * is worse than one that starts with a few rows still untidy.
 */
await reconcileInterruptedRuns().catch((e: unknown) =>
  log.error('reconcile failed:', e instanceof Error ? e.message : e),
);

/** Held so shutdown can stop it before draining; otherwise a tick starts a run mid-drain. */
const scheduler = process.env.SCHEDULER !== 'off' ? startScheduler() : undefined;

// Populate the price and chart caches before anyone opens a screen.
warmMarketCache();

// Copy the database into MongoDB Atlas on a schedule, where a destination is configured.
stopMirror = startMirrorSchedule();
