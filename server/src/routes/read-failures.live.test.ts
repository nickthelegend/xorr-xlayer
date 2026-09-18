/**
 * LIVE — an unknown id and a missing permission answer as what they are (PLAN.md 1.7).
 *
 * `getPosition` answered an id that was not in the wallet with the wallet's first position, so a
 * stale link opened someone's WETH as if it were the asset they tapped. And `/limits` answered a
 * wallet that had never granted anything with `revoked: true` — "permission is off" — which is the
 * sentence for a user who took their permission back.
 *
 * Run with the executor up: npm run test:live
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const BASE = process.env.EXPO_PUBLIC_API_URL ?? 'http://localhost:8788';
const TOKEN_SCRIPT = fileURLToPath(new URL('../e2e-token.ts', import.meta.url));
const OWNER_EMAIL = process.env.E2E_PRIVY_EMAIL ?? 'test-8958@privy.io';
const OTHER_EMAIL = process.env.E2E_PRIVY_EMAIL_2 ?? 'test-0356@privy.io';

const tokens = { owner: '', other: '' };

async function ask(who: keyof typeof tokens, path: string) {
  const res = await fetch(`${BASE}${path}`, { headers: { authorization: `Bearer ${tokens[who]}` } });
  return { status: res.status, body: (await res.json().catch(() => null)) as Record<string, unknown> | null };
}

beforeAll(() => {
  tokens.owner = execFileSync('npx', ['tsx', TOKEN_SCRIPT, OWNER_EMAIL], { encoding: 'utf8' }).trim();
  tokens.other = execFileSync('npx', ['tsx', TOKEN_SCRIPT, OTHER_EMAIL], { encoding: 'utf8' }).trim();
}, 60_000);

describe('answers that are not substitutes', () => {
  it("an id that is not in the wallet's book is 404, not its first position", async () => {
    const res = await ask('owner', `/positions/${randomUUID()}`);
    expect(res.status, JSON.stringify(res.body)).toBe(404);
    expect(res.body?.error).toBe('not_found');
  });

  it('a wallet that never granted a permission is "not granted", not "revoked"', async () => {
    const wallet = await ask('other', '/wallet');
    expect(wallet.body, 'this case needs the second test account to have a wallet registered').not.toBeNull();

    const res = await ask('other', '/limits');
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toMatchObject({ granted: false, revoked: false, dailyCapUsd: 0, remainingUsd: 0 });
  });
});
