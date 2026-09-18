/**
 * An upstream's refusal keeps its reason (PLAN.md 3.16).
 *
 * `getJson` threw "400 for <url>" and dropped the body, so 1inch refusing a quote reached the screen as a bare status —
 * a dust amount and a token 1inch does not know looked the same. The reason 1inch gives in words now comes with it;
 * anything that is not a named JSON field stays out.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getJson, resetBreakers } from './get.js';

const answer = (status: number, body: string, type = 'application/json') =>
  vi.fn(async () => new Response(body, { status, headers: { 'content-type': type } }));

describe("an upstream's refusal", () => {
  beforeEach(() => {
    vi.stubEnv('HTTP_MIN_SPACING_MS', '0');
    vi.stubEnv('HTTP_MAX_ATTEMPTS', '1');
    vi.stubEnv('HTTP_BACKOFF_BASE_MS', '0');
    resetBreakers();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it("carries 1inch's own description", async () => {
    vi.stubGlobal('fetch', answer(400, JSON.stringify({ error: 'Bad Request', description: 'insufficient liquidity', statusCode: 400 })));
    await expect(getJson('https://reason-test.invalid/quote-1')).rejects.toThrow(
      /^400 .*for https:\/\/reason-test\.invalid\/quote-1 — insufficient liquidity$/,
    );
  });

  it('falls back to a message or an error field, on one line', async () => {
    vi.stubGlobal('fetch', answer(422, JSON.stringify({ message: 'address   not\n supported' })));
    await expect(getJson('https://reason-test.invalid/history-1')).rejects.toThrow(/— address not supported$/);
    vi.stubGlobal('fetch', answer(404, JSON.stringify({ error: 'Not found' })));
    await expect(getJson('https://reason-test.invalid/token-1')).rejects.toThrow(/— Not found$/);
  });

  it('keeps an HTML page, a body with no named reason, and an empty body out of the message', async () => {
    vi.stubGlobal('fetch', answer(403, '<html><body>Forbidden by gateway</body></html>', 'text/html'));
    await expect(getJson('https://reason-test.invalid/html-1')).rejects.toThrow(/^403 .*for https:\/\/reason-test\.invalid\/html-1$/);
    vi.stubGlobal('fetch', answer(400, JSON.stringify({ statusCode: 400 })));
    await expect(getJson('https://reason-test.invalid/nameless-1')).rejects.toThrow(/nameless-1$/);
    vi.stubGlobal('fetch', answer(400, ''));
    await expect(getJson('https://reason-test.invalid/empty-1')).rejects.toThrow(/empty-1$/);
  });

  it('cuts a long reason to 200 characters', async () => {
    vi.stubGlobal('fetch', answer(400, JSON.stringify({ description: 'x'.repeat(500) })));
    const err = await getJson('https://reason-test.invalid/long-1').catch((e: Error) => e);
    expect((err as Error).message.split(' — ')[1]).toHaveLength(200);
  });
});
