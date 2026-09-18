/**
 * Every path the client calls must exist.
 *
 * Three did not — `/perp/:symbol`, `/alerts/:id` and a stale `/staking/yield` — and each was
 * swallowed by a `.catch` on the client, so the screens rendered their empty state and looked
 * fine. Nothing failed. That is the worst shape a bug can take, and this test exists so that
 * particular shape cannot recur: it reads the paths straight out of the data layer and asks the
 * running server for each one.
 *
 * Two kinds of 404 have to be told apart. A route that does not exist returns Hono's bare
 * "404 Not Found"; a route that exists and could not find the ROW returns JSON saying so. Only the
 * first is a bug — asking for a strategy id that was never created should of course be a 404.
 *
 * Run with the executor up: npm run test:live
 */
import { describe, expect, it, beforeAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const BASE = process.env.EXPO_PUBLIC_API_URL ?? 'http://localhost:8788';
const TEST_EMAIL = process.env.E2E_PRIVY_EMAIL ?? 'test-8958@privy.io';
const LOCAL = fileURLToPath(new URL('../../../src/data/local.ts', import.meta.url));
/*
 * Resolve the minter relative to THIS file, never to the working directory.
 *
 * It was `cwd: process.cwd()` with a relative `src/e2e-token.ts`, so the suite ran from `server/`
 * and failed from the repo root — where the root `vitest.config.mts` also includes these files.
 * `npm run test:live` at the root therefore reported two suites as broken for a reason that had
 * nothing to do with the server.
 */
const TOKEN_SCRIPT = fileURLToPath(new URL('../e2e-token.ts', import.meta.url));


let token: string;

beforeAll(() => {
  token = execFileSync('npx', ['tsx', TOKEN_SCRIPT, TEST_EMAIL], { encoding: 'utf8' }).trim();
});

/**
 * Pull every `api.get('/x')` / `api.post('/x')` out of the data layer.
 *
 * Template placeholders become something concrete: a route is being checked for EXISTENCE, and a
 * literal `${id}` in a path would 404 for the wrong reason.
 */
function clientPaths(): { method: string; path: string }[] {
  const src = readFileSync(LOCAL, 'utf8');
  const found = new Map<string, { method: string; path: string }>();
  const re = /api\.(get|post|patch|del|getText)<[^>]*>?\(\s*[`'"]([^`'"]+)[`'"]/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src))) {
    const method = m[1] === 'del' ? 'DELETE' : m[1] === 'getText' ? 'GET' : m[1]!.toUpperCase();
    const path = m[2]!
      .replace(/\$\{[^}]*symbol[^}]*\}/gi, 'WETH')
      .replace(/\$\{[^}]*(id|agentId|strategyId)[^}]*\}/gi, '00000000-0000-4000-8000-000000000000')
      .replace(/\$\{[^}]*\}/g, 'x');
    found.set(`${method} ${path}`, { method, path });
  }
  return [...found.values()];
}

describe('every path the client calls exists on the server', () => {
  it('finds the call sites to check', () => {
    expect(clientPaths().length).toBeGreaterThan(8);
  });

  it.each(clientPaths())('$method $path is not a 404', async ({ method, path }) => {
    const res = await fetch(`${BASE}${path}`, {
      method,
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      // A body for the verbs that need one. Validation errors are fine; a missing route is not.
      body: method === 'GET' || method === 'DELETE' ? undefined : '{}',
    });
    if (res.status !== 404) return;

    // A handler answered and said the row is missing: the route exists, which is what this checks.
    const body = await res.text();
    expect(
      body,
      `${method} ${path} returned a bare 404 — the client calls a route that does not exist`,
      // `unknown_agent` is the same shape of answer: a handler ran, looked, and said the thing
      // you named is not on your roster. The route exists, which is the only claim here.
    ).toMatch(/not_found|no_feed|no_wallet|unknown_agent/);
    // Generous on purpose. This checks that a route EXISTS, and one of them — the backtest —
    // legitimately replays ninety days of real history on a cold cache. Speed is a different
    // test's problem; a route that is missing is this one's.
  }, 120_000);
});
