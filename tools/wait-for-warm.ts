/**
 * Do not judge the executor while it is still filling its cache.
 *
 * `warmMarketCache` pulls every chart the app opens on through a 1.1s-spaced queue, so for about
 * a minute after a restart the price and OHLC routes answer 503 or wait out a retry ladder. That
 * is a real state and the app handles it honestly — and it is not the state a user is in, so a
 * live suite that runs into it measures the wrong thing. Twice in this repo it produced red for
 * data that answered in milliseconds thirty seconds later, which is how a suite teaches people to
 * re-run it instead of read it.
 *
 * Only for the live suite. The unit tests touch no network and this never runs for them.
 *
 * It lives in `tools/` rather than `src/` because `src/data/repositories.test.ts` enforces that
 * network access in `src/` exists only in the data and wallet layers — and it is right to: this is
 * test tooling, not app code, and it belongs with `shoot.mjs`.
 */
const API = process.env.EXPO_PUBLIC_API_URL ?? 'http://localhost:8788';

/** Longer than a full warm sweep, so a genuinely stuck upstream still fails rather than hangs. */
const DEADLINE_MS = 180_000;

export async function setup(): Promise<void> {
  if (!process.env.LIVE) return;

  const deadline = Date.now() + DEADLINE_MS;
  // The four windows the chart pills ask for. `/market/quotes` warms first and is implied by them.
  const probes = [1, 7, 30, 90].map((d) => `${API}/market/ohlc?symbol=BTC&days=${d}`);

  for (const url of probes) {
    for (;;) {
      const ok = await fetch(url)
        .then((r) => r.ok)
        .catch(() => false);
      if (ok) break;
      if (Date.now() > deadline) {
        console.warn(
          `[live] ${url} still cold after ${DEADLINE_MS / 1000}s — running anyway; ` +
            'expect chart assertions to report the warming state.',
        );
        return;
      }
      await new Promise((r) => setTimeout(r, 3_000));
    }
  }
}
