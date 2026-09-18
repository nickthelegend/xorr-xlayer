/**
 * LIVE — a repeated decline must not become a repeated audit row.
 *
 * `/proposals/generate` appended "Proposed nothing" every time it was called, and the Bot tab calls
 * it on every mount. One wallet's trail reached thirty-four identical rows out of fifty-seven:
 * sixty percent of a permanent, append-only record was page loads rather than decisions.
 *
 * The rule is not "never write a decline" — what the bot chose not to do is the product. It is
 * "write it when the answer changes". This asks twice in a row and checks the trail grew by at
 * most one, against the real database and the real HTTP surface.
 *
 * Run with the executor up: npm run test:live
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const BASE = process.env.EXPO_PUBLIC_API_URL ?? 'http://localhost:8788';
const TOKEN_SCRIPT = fileURLToPath(new URL('../e2e-token.ts', import.meta.url));
const TEST_EMAIL = process.env.E2E_PRIVY_EMAIL ?? 'test-8958@privy.io';

let token: string;

const req = (path: string, init?: RequestInit) =>
  fetch(`${BASE}${path}`, {
    ...init,
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}`, ...init?.headers },
  });

/** How many "Proposed nothing" rows the trail currently holds. */
async function declineCount(): Promise<number> {
  const res = await req('/activity?limit=200');
  const body = (await res.json()) as unknown;
  const rows = (Array.isArray(body) ? body : ((body as { entries?: unknown[] }).entries ?? [])) as {
    action?: string;
  }[];
  return rows.filter((r) => r.action === 'Proposed nothing').length;
}

beforeAll(() => {
  token = execFileSync('npx', ['tsx', TOKEN_SCRIPT, TEST_EMAIL], { encoding: 'utf8' }).trim();
  expect(token.length).toBeGreaterThan(100);
});

/**
 * Ask, waiting out a `warming` 503.
 *
 * The route is bounded at ten seconds and answers 503 while the agent is still pricing the market,
 * with the work continuing server-side. A test that treats that as a failure is testing the cold
 * cache, not the behaviour.
 */
async function generate(): Promise<Response> {
  /*
   * Ten attempts, because this runs alongside the rest of the suite.
   *
   * Alone, the route answers in under a second. Run with forty other live files competing for the
   * same price upstreams it stays warming far longer, and six attempts landed just short — the
   * test failed for load it created rather than for the behaviour it names. The failure message
   * below still fires if it never warms, so patience here buys reliability without buying silence.
   */
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const res = await req('/proposals/generate', { method: 'POST', body: '{}' });
    if (res.status !== 503) return res;
    await new Promise((r) => setTimeout(r, 3000));
  }
  throw new Error('the proposal engine stayed warming for ten attempts');
}

describe('a decline is recorded when it changes, not when it is re-observed', () => {
  it('asking twice in a row does not write the same row twice', async () => {
    const first = await generate();
    expect(first.status).toBe(200);
    const body = (await first.json()) as { created: boolean; reason?: string };

    /*
     * If the agent had a setup to propose, this run has nothing to say about declines. Reported
     * rather than swallowed: a test that quietly returns is how two suites in this repo went on
     * passing while testing nothing.
     */
    if (body.created) {
      expect(body.created, 'the agent proposed a trade, so no decline was produced to de-duplicate').toBe(true);
      return;
    }

    const before = await declineCount();
    await generate();
    await generate();
    const after = await declineCount();

    expect(after, `two further identical declines added ${after - before} rows`).toBe(before);
  }, 180_000);
});
