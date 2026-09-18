/**
 * Retrying a public RPC that says it is rate limiting — and nothing else.
 *
 * `https://mainnet.base.org` is the free public endpoint. It throttles after a short burst and
 * answers a throttle as a JSON-RPC error INSIDE a 200 whose detail reads `over rate limit`, which
 * viem's transport does not classify as retryable. So a burst of reads against Base mainnet — the
 * Aave pool, the eight tokenized equities — fails in a way that is indistinguishable from the
 * contract being wrong, and the product reported real deployed state as missing.
 *
 * `base-readiness.ts` already documents this behaviour and spaces its own reads for it. This is the
 * same knowledge applied where the product reads rather than where a script does.
 *
 * NARROW ON PURPOSE. It retries only when the endpoint used the throttle's own words. A blanket
 * retry would make a genuinely dead contract take five times as long to report, and would turn a
 * real failure into a slow one instead of a visible one — which is the shape of change this
 * codebase argues against everywhere else.
 */
import { log } from '../http/request-id.js';

const THROTTLED = /over rate limit|rate ?limit|429|too many requests/i;

/** True when this error is the endpoint asking us to slow down, rather than a real failure. */
export function isThrottle(e: unknown): boolean {
  return THROTTLED.test(e instanceof Error ? e.message : String(e));
}

/**
 * Run `work`, backing off while the endpoint is throttling.
 *
 * Linear backoff rather than exponential: the window these endpoints throttle over is short and
 * fixed, so doubling mostly adds latency after the limit has already cleared.
 */
export async function pastTheThrottle<T>(
  work: () => Promise<T>,
  attempts = 4,
  baseDelayMs = 1_200,
): Promise<T> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await work();
    } catch (e) {
      if (!isThrottle(e) || attempt >= attempts) throw e;
      log.warn(`[rpc] throttled, retrying in ${baseDelayMs * (attempt + 1)}ms`);
      await new Promise((r) => setTimeout(r, baseDelayMs * (attempt + 1)));
    }
  }
}
