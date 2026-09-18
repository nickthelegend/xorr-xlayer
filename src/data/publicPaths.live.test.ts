/**
 * The client's idea of the public surface must match the server's.
 *
 * A second copy of a fact is fine as long as something notices when it stops matching. If the
 * server makes a route public and the client does not know, a signed-out visitor silently loses
 * that data; if the client thinks a route is public and the server does not, the request is sent
 * without a token and comes back 401 — which is the bug this list exists to fix, reintroduced from
 * the other direction.
 *
 * LIVE because it asks the running executor. `npm run test:live`.
 */
import { describe, expect, it } from 'vitest';
import { PUBLIC_PATHS, PUBLIC_PREFIXES } from './publicPaths';

const BASE = process.env.EXPO_PUBLIC_API_URL ?? 'http://localhost:8788';

describe('the public surface', () => {
  it('is exactly what the executor says it is', async () => {
    const res = await fetch(`${BASE}/health`);
    const health = (await res.json()) as {
      publicSurface?: { paths: string[]; prefixes: string[] };
    };
    expect(health.publicSurface, 'the executor did not publish its public surface').toBeDefined();
    expect([...health.publicSurface!.paths].sort()).toEqual([...PUBLIC_PATHS].sort());
    expect([...health.publicSurface!.prefixes].sort()).toEqual([...PUBLIC_PREFIXES].sort());
  });

  it('really does answer those routes without a token', async () => {
    // The list being equal is not the same as it being true. One route is actually called.
    const res = await fetch(`${BASE}/market/symbols`);
    expect(res.status).toBe(200);
  });

  it('really does refuse the others', async () => {
    const res = await fetch(`${BASE}/wallet/balance`);
    expect(res.status).toBe(401);
  });
});
