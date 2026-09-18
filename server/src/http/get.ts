/**
 * Resilient JSON reads for the executor — GET, and POST for read APIs that take their question as a
 * body.
 *
 * The public price tiers rate-limit hard (HTTP 429). A trading server that drops a scheduled buy
 * because a chart refreshed somewhere else is worse than one that waits a second, so this layer:
 *   - serialises outbound requests with a minimum spacing,
 *   - caches for a short TTL,
 *   - retries 429 and 5xx with exponential backoff, honouring Retry-After.
 *
 * The client has the same protection in src/data/marketData.ts. Both halves need it: the app
 * refreshing a chart and the executor pricing a fill hit the same upstream quota.
 */
/*
 * Read per call, not at module load.
 *
 * These are the knobs that decide how long a failing dependency takes to give up, and they were
 * baked in at import time — so a test of the retry behaviour had to sit through the real
 * twenty-five seconds per call, four times over, which is not a test anyone runs. Reading them
 * lazily costs nothing and makes the behaviour reachable.
 */
const spacingMs = () => Number(process.env.HTTP_MIN_SPACING_MS ?? 1_100);
const maxAttempts = () => Number(process.env.HTTP_MAX_ATTEMPTS ?? 5);
const backoffBaseMs = () => Number(process.env.HTTP_BACKOFF_BASE_MS ?? 800);

/**
 * One lane per upstream host.
 *
 * A single global queue meant a CoinGecko backlog — and the public tier backs up readily — stalled
 * every 1inch call behind it, so a single slow feed could take a quote from 300ms to half a
 * minute. Rate limits are per host, so the spacing belongs per host too.
 */
type Lane = {
  queue: Promise<unknown>;
  lastRequestAt: number;
  /** Consecutive failures. Reset by any success. */
  failures: number;
  /** While set and in the future, the host is skipped entirely. */
  openUntil: number;
};
const lanes = new Map<string, Lane>();

/**
 * Stop knocking on a door nobody is answering.
 *
 * The retry loop is right for a busy upstream and wrong for a dead one: five attempts with
 * exponential backoff means every single request to a host that is down takes about twenty-five
 * seconds before failing. With a scheduler tick and a page of market rows all asking at once, one
 * dead dependency turns into an app that appears to hang rather than one that degrades.
 *
 * So after enough consecutive failures the host is skipped outright for a cooldown, and callers
 * fail immediately with a message that names the host and when it will be tried again. Every
 * screen already handles a failed read by showing a stated error — they just get there in
 * milliseconds instead of half a minute.
 *
 * One success closes it. A half-open probe would be tidier, but the lane's minimum spacing already
 * means the first request after the cooldown IS the probe.
 */
const BREAKER_THRESHOLD = 4;
const BREAKER_COOLDOWN_MS = 30_000;

export class UpstreamUnavailable extends Error {
  constructor(host: string, until: number) {
    super(
      `${host} has failed ${BREAKER_THRESHOLD} times in a row; not retrying for another ` +
        `${Math.max(0, Math.ceil((until - Date.now()) / 1000))}s.`,
    );
    this.name = 'UpstreamUnavailable';
  }
}

/** Testing and operational visibility: which hosts are currently shut out, and until when. */
export function breakerState(): { host: string; failures: number; openUntil: number }[] {
  return [...lanes.entries()].map(([host, l]) => ({
    host,
    failures: l.failures,
    openUntil: l.openUntil,
  }));
}

/** Testing only. */
export function resetBreakers(): void {
  for (const l of lanes.values()) {
    l.failures = 0;
    l.openUntil = 0;
  }
}

function laneFor(url: string): Lane {
  const host = new URL(url).host;
  let lane = lanes.get(host);
  if (!lane) {
    lane = { queue: Promise.resolve(), lastRequestAt: 0, failures: 0, openUntil: 0 };
    lanes.set(host, lane);
  }
  return lane;
}

const cache = new Map<string, { at: number; value: unknown }>();
/** In-flight requests, so N callers for the same URL make one call rather than N queued ones. */
const inflight = new Map<string, Promise<unknown>>();

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Per-call overrides.
 *
 * `attempts` exists for callers whose data is not worth waiting for. The retry ladder is right for
 * a price — a scheduled buy must not be dropped because a feed was busy — and wrong for a logo,
 * where five attempts with exponential backoff means twenty-five seconds spent on decoration, in a
 * host lane that a price is queued behind. One attempt, then take the gradient.
 */
export type GetOptions = { attempts?: number };

async function rawGet<T>(
  url: string,
  timeoutMs: number,
  headers: Record<string, string> = {},
  opts: GetOptions = {},
  body?: string,
): Promise<T> {
  const lane = laneFor(url);
  const host = new URL(url).host;

  // Fail fast while the breaker is open, rather than spending twenty-five seconds proving what the
  // last four requests already established.
  if (lane.openUntil > Date.now()) throw new UpstreamUnavailable(host, lane.openUntil);

  /*
   * Count EVERY way this can fail, not just the tidy one.
   *
   * The counter was only reached on the fall-through path — retries exhausted against 429s and
   * 5xx — while a connection error threw straight out of the loop and skipped it entirely. That
   * is precisely the case the breaker exists for: a host that is down refuses connections, it does
   * not politely return 503. So the whole attempt loop is wrapped, and any failure counts.
   */
  try {
    return await attempt<T>(url, timeoutMs, headers, lane, opts.attempts ?? maxAttempts(), body);
  } catch (e) {
    lane.failures += 1;
    if (lane.failures >= BREAKER_THRESHOLD && lane.openUntil <= Date.now()) {
      lane.openUntil = Date.now() + BREAKER_COOLDOWN_MS;
      console.warn(`[http] ${host} is failing; pausing requests to it for ${BREAKER_COOLDOWN_MS}ms`);
    }
    throw e;
  }
}

async function attempt<T>(
  url: string,
  timeoutMs: number,
  headers: Record<string, string>,
  lane: Lane,
  attempts: number,
  body?: string,
): Promise<T> {
  let lastStatus = 0;
  let lastError: Error | undefined;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    const wait = spacingMs() - (Date.now() - lane.lastRequestAt);
    if (wait > 0) await sleep(wait);
    lane.lastRequestAt = Date.now();

    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetch(url, {
        signal: ctrl.signal,
        // A body is a read API that takes its question as JSON — still a read, retried and cached
        // exactly like a GET.
        ...(body === undefined ? {} : { method: 'POST', body }),
        headers: {
          accept: 'application/json',
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
          ...headers,
        },
      });
      lastStatus = res.status;
      if (res.status === 429 || res.status >= 500) {
        const retryAfter = Number(res.headers.get('retry-after'));
        const backoff =
          Number.isFinite(retryAfter) && retryAfter > 0
            ? retryAfter * 1000
            : backoffBaseMs() * 2 ** attempt;
        if (attempt === attempts) break;
        await sleep(backoff);
        continue;
      }
      if (!res.ok) {
        // What the upstream said, when it said it in words: 1inch answers a refusal with a JSON `description`, and a
        // bare status told a screen only that it had been refused, never why (PLAN.md 3.16).
        const said = await reasonFrom(res);
        throw new Error(`${res.status} ${res.statusText} for ${url}${said ? ` — ${said}` : ''}`);
      }
      // Any success closes the breaker. The lane's minimum spacing means the first request after a
      // cooldown is already the probe, so there is nothing to add here.
      lane.failures = 0;
      lane.openUntil = 0;
      return (await res.json()) as T;
    } catch (e) {
      // A timeout or a dropped connection is the same kind of failure as a 503 — the upstream is
      // busy — and deserves the same backoff. Previously it escaped the loop on the first attempt,
      // so a single slow response failed the whole call while a 503 got four more tries.
      const transient =
        e instanceof Error &&
        (e.name === 'AbortError' ||
          e.name === 'TimeoutError' ||
          /aborted|fetch failed|ECONNRESET|ETIMEDOUT|socket hang up/i.test(e.message));
      if (!transient || attempt === attempts) throw e;
      lastError = e;
      await sleep(backoffBaseMs() * 2 ** attempt);
    } finally {
      clearTimeout(timer);
    }
  }
  if (lastError) throw lastError;
  throw new Error(`${lastStatus} after ${attempts} attempts: ${url}`);
}

/**
 * A short reason from an error response: its `description`, `message` or `error`, when the body is JSON that has one.
 *
 * Only a named field, and never the raw body — an HTML error page or a stack trace is not a sentence anyone should be
 * shown — cut to 200 characters on one line.
 */
async function reasonFrom(res: Response): Promise<string | undefined> {
  const text = await res.text().catch(() => '');
  if (!text) return undefined;
  try {
    const body = JSON.parse(text) as Record<string, unknown>;
    const said = [body.description, body.message, body.error].find(
      (v): v is string => typeof v === 'string' && v.trim().length > 0,
    );
    return said?.replace(/\s+/g, ' ').trim().slice(0, 200);
  } catch {
    return undefined;
  }
}

/** The cache and in-flight bookkeeping both reads share, keyed by what was asked. */
async function cachedRead<T>(
  key: string,
  url: string,
  ttlMs: number,
  timeoutMs: number,
  headers: Record<string, string>,
  opts: GetOptions,
  body?: string,
): Promise<T> {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < ttlMs) return hit.value as T;

  // Two callers wanting the same URL at the same moment should cost one request, not two queue
  // slots. This is what keeps a page that mounts three components off the rate limiter.
  const pending = inflight.get(key);
  if (pending) return pending as Promise<T>;

  const lane = laneFor(url);
  const run = lane.queue.then(() => rawGet<T>(url, timeoutMs, headers, opts, body));
  lane.queue = run.catch(() => undefined);

  const tracked = run.then(
    (value) => {
      cache.set(key, { at: Date.now(), value });
      inflight.delete(key);
      return value;
    },
    (e: unknown) => {
      inflight.delete(key);
      throw e;
    },
  );
  inflight.set(key, tracked);
  return tracked;
}

export async function getJson<T>(
  url: string,
  ttlMs = 30_000,
  timeoutMs = 15_000,
  headers: Record<string, string> = {},
  opts: GetOptions = {},
): Promise<T> {
  return cachedRead<T>(url, url, ttlMs, timeoutMs, headers, opts);
}

/**
 * The cache key for a POST read: the URL and the exact question asked of it.
 *
 * Two different questions to one endpoint — BTC candles and ETH candles — are two answers, so the
 * body is part of the key. Pass it to `staleValue` for the last-known-good fallback.
 */
export function postKey(url: string, payload: unknown): string {
  return `${url}#${JSON.stringify(payload)}`;
}

/**
 * A read that has to be POSTed — Hyperliquid's `/info` takes every question as a JSON body.
 *
 * Same lane, breaker, retries and cache as `getJson`. Only for reads: a retried write could do its
 * thing twice, and nothing here would know.
 */
export async function postJson<T>(
  url: string,
  payload: unknown,
  ttlMs = 30_000,
  timeoutMs = 15_000,
  opts: GetOptions = {},
): Promise<T> {
  return cachedRead<T>(postKey(url, payload), url, ttlMs, timeoutMs, {}, opts, JSON.stringify(payload));
}

/**
 * Last-known-good fallback for a scheduled run.
 *
 * If the upstream is down after every retry, a stale price is better than a missed buy — but only
 * within a bounded window, and the caller is told the value is stale so it can be labelled.
 */
export function staleValue<T>(url: string, maxAgeMs: number): T | undefined {
  const hit = cache.get(url);
  if (hit && Date.now() - hit.at < maxAgeMs) return hit.value as T;
  return undefined;
}

export function clearHttpCache(): void {
  cache.clear();
  inflight.clear();
}
