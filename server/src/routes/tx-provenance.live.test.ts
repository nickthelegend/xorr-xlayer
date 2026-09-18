/**
 * LIVE — a hash the chain has never seen must never reach the append-only trail.
 *
 * `/delegation/record` validated the SHAPE of `txHash` and then swallowed the receipt lookup with
 * `.catch(() => undefined)`. The policy read that followed passed on the strength of an earlier,
 * genuine grant — so any well-formed 32-byte string was accepted and written as "Trading
 * permission granted", carrying an explorer link to nothing. Proven with
 * `0x1234…1234`, which the app accepted and `cast tx` reports as "tx not found".
 *
 * The trail is append-only, so an entry like that cannot be withdrawn. The check has to sit before
 * the write, and this is the test that keeps it there.
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
const req = (path: string, body: unknown) =>
  fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });

beforeAll(() => {
  token = execFileSync('npx', ['tsx', TOKEN_SCRIPT, TEST_EMAIL], { encoding: 'utf8' }).trim();
  expect(token.length).toBeGreaterThan(100);
});

/** Well-formed, 32 bytes, and not a transaction on any chain this executor talks to. */
const NOT_A_TX = '0x1234567890123456789012345678901234567890123456789012345678901234';

describe('the trail only carries hashes that can be looked up', () => {
  it('refuses to record a grant against a transaction that does not exist', async () => {
    const res = await req('/delegation/record', {
      txHash: NOT_A_TX,
      dailyCapUsd: 100,
      expiresAt: Date.now() + 86_400_000,
    });
    expect(res.status, 'a non-existent transaction was accepted').toBe(400);
    const body = (await res.json()) as { error?: string; message?: string };
    expect(body.error).toBe('tx_not_found');
    // The refusal has to say what is wrong, not just refuse.
    expect(body.message ?? '').toMatch(/not on this chain|looked up/i);
  }, 90_000);

  it('refuses to record a revoke against a transaction that does not exist', async () => {
    const res = await req('/delegation/revoke', { txHash: NOT_A_TX });
    // `still_active` is also a correct refusal — it means the chain has not been revoked, which is
    // checked first. Either way the fake hash must not be written.
    expect([400]).toContain(res.status);
    const body = (await res.json()) as { error?: string };
    expect(['tx_not_found', 'still_active']).toContain(body.error);
  }, 90_000);

  it('still refuses a malformed hash at the schema, before any chain call', async () => {
    for (const bad of ['0xabc', 'not-a-hash', '0x', '']) {
      const res = await req('/delegation/record', {
        txHash: bad,
        dailyCapUsd: 100,
        expiresAt: Date.now() + 86_400_000,
      });
      expect(res.status, `"${bad}" was accepted`).toBe(400);
      const body = (await res.json()) as { error?: string };
      expect(body.error).toBe('invalid_request');
    }
  }, 90_000);
});
