/**
 * A ceiling on how fast one caller can spend everybody's upstream quota.
 *
 * The executor has one 1inch key, one CoinGecko tier and one delegate key. Nothing bounded how
 * often a single caller could use them, so one agent key in a tight loop — or one screen with a
 * runaway `useEffect`, which this repo has produced before — could exhaust the rate limit for every
 * other user and every scheduled run. The scheduler competes for the same quota, so the first thing
 * to break would be the trading, silently, while the app looked fine.
 *
 * Two things make this worth having rather than theatre:
 *
 * **It counts per identity, not per IP.** Behind Railway every request arrives from the platform's
 * proxy, so an IP bucket is one bucket for the whole world. The Privy user id or the agent key's
 * own id is the thing that actually names a caller, and the auth middleware has already resolved it
 * by the time this runs.
 *
 * **The expensive routes have their own, tighter budget.** A price read and a swap quote are not
 * the same cost to us: one is a cache hit, the other is an upstream call against a metered key. A
 * single limit generous enough for the first is useless against the second.
 *
 * Deliberately in-memory. A shared store would make this survive a restart and coordinate across
 * instances, and it would also put a network round trip in front of every request to protect
 * against something that has not happened yet. One process, one bucket, reset on deploy — and the
 * limit is a safety rail, not a billing boundary.
 */
import type { Context, Next } from 'hono';

/**
 * Who is calling, as one string.
 *
 * A deployed worker presents an agent key and a person presents a Privy session, and they are
 * counted separately because they are separate callers with separate budgets. `anonymous` covers
 * the public market routes, where every caller shares one bucket — which is the right shape: an
 * unauthenticated flood is one problem, not one problem per stranger.
 */
function callerId(c: Context): string {
  /*
   * Read the context directly rather than importing the auth helpers.
   *
   * `middleware.ts` pulls in `privy.ts`, which refuses to load without credentials — deliberately,
   * since an unauthenticated trading server must not be a possible state. Importing it here to
   * borrow one accessor would make this module, and anything testing it, require the whole auth
   * stack to be configured. These two keys are set by the middleware that runs before this one.
   */
  const p = c.get('principal') as { kind: string; id: string } | undefined;
  if (p) return `${p.kind}:${p.id}`;
  const user = c.get('user') as { userId?: string } | undefined;
  return user?.userId ? `user:${user.userId}` : 'anonymous';
}

/** Requests per window, for anything that does not hit a metered upstream. */
const GENERAL_LIMIT = Number(process.env.RATE_LIMIT_GENERAL ?? 300);

/**
 * Requests per window for routes that spend an upstream quota we pay for and share.
 *
 * Low enough that a loop cannot drain the 1inch key, high enough that a person moving quickly
 * through the app never meets it — the order ticket re-quotes on every keystroke of the amount.
 */
const UPSTREAM_LIMIT = Number(process.env.RATE_LIMIT_UPSTREAM ?? 60);

const WINDOW_MS = Number(process.env.RATE_LIMIT_WINDOW_MS ?? 60_000);

/**
 * The paths that cost us money or quota on every call.
 *
 * `/market/*` is deliberately absent: it is served from the shared cache and the single-flight
 * fetcher, so a hundred readers cost one upstream call. Limiting it would throttle the cheap path
 * and leave the expensive one open.
 */
const UPSTREAM_PATHS = [
  '/swap', // the quote, and the swap itself
  '/crosschain/quote', // the Fusion+ quoter — one metered 1inch call per question (PLAN.md 3.16)
  '/wallet/tokens', // 1inch's Balance and Token APIs on Base (PLAN.md 3.10)
  '/history', // a paged eth_getLogs scan, and 1inch's History API on Base (PLAN.md 3.14)
  '/limit-orders', // the list reads the chain on every call; …/:hash/fill simulates and sends through spend() (PLAN.md 3.15)
  '/faucet', // reads the node and the holder or faucet key on every call; POST sends a transfer and waits for it (PLAN.md 4.4)
  '/orders',
  '/strategies/', // …/:id/run
  '/agent/strategies/',
  '/positions/close',
  '/panic/flatten',
  '/agent/positions/close',
  '/yield/supply',
  '/yield/withdraw-calldata',
  '/withdrawals/', // prepare-all reads a balance from the chain; record waits on a receipt and reads its logs (PLAN.md 4.9)
  '/agents/', // …/:id/backtest — replays a year of history
  '/strategies/backtest',
  '/bot/say',
];

type Bucket = { count: number; resetAt: number };
const buckets = new Map<string, Bucket>();

/**
 * Sweep expired buckets so a long-lived process does not accumulate one entry per caller forever.
 * Cheap because it only runs when the map is large enough to be worth walking.
 */
const SWEEP_AT = 5_000;
function sweep(now: number): void {
  if (buckets.size < SWEEP_AT) return;
  for (const [k, b] of buckets) if (b.resetAt <= now) buckets.delete(k);
}

function limitFor(path: string): number {
  return UPSTREAM_PATHS.some((p) => path.startsWith(p)) ? UPSTREAM_LIMIT : GENERAL_LIMIT;
}

/** Testing only — a limiter that remembers across cases proves nothing about any of them. */
export function resetRateLimits(): void {
  buckets.clear();
}

export async function rateLimit(c: Context, next: Next): Promise<Response | void> {
  const path = new URL(c.req.url).pathname;

  /*
   * `/health` and `/metrics` are never limited.
   *
   * Railway polls `/health` to decide whether the container is alive. Rate-limiting it means that
   * under load — exactly when the limiter is doing its job — the platform concludes the service is
   * down and restarts it, turning a busy minute into an outage and killing in-flight runs.
   */
  if (path === '/health' || path === '/metrics') return next();

  const who = callerId(c);
  const limit = limitFor(path);
  const key = `${who}:${limit === UPSTREAM_LIMIT ? 'upstream' : 'general'}`;

  const now = Date.now();
  sweep(now);

  const b = buckets.get(key);
  if (!b || b.resetAt <= now) {
    buckets.set(key, { count: 1, resetAt: now + WINDOW_MS });
    return next();
  }

  b.count += 1;
  if (b.count > limit) {
    const retryAfter = Math.max(1, Math.ceil((b.resetAt - now) / 1000));
    c.header('retry-after', String(retryAfter));
    return c.json(
      {
        error: 'rate_limited',
        message: `Too many requests. Try again in ${retryAfter}s.`,
        limit,
        windowSeconds: WINDOW_MS / 1000,
      },
      429,
    );
  }
  return next();
}
