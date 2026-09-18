/**
 * A money action's key reaches the wire, and what the executor says about a key reaches the screen (FEATURES.md #29).
 *
 * The real transport and the real repositories. `fetch` is replaced by a recorder that answers as the executor would, and
 * the Privy token getter by a constant because its module reaches the native runtime; nothing between a screen's call and
 * `fetch` is stubbed.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetAuthKnowledge, setAuthKnowledge } from '@/auth/authState';
import { api } from './api';
import { errorText } from './apiError';
import { requestFaucet } from './deposit';
import { intentKeys, outcomeKnown } from './intentKey';
import { LocalRepositories } from './local';
import { system } from './system';

vi.mock('@/auth/token', () => ({ accessToken: async () => 'session-token' }));

type Sent = { url: string; method: string; headers: Record<string, string> };
let sent: Sent[] = [];

/** The executor answering every request with one status and body, and remembering what it was sent. */
function executorAnswers(status: number, body: unknown) {
  vi.stubGlobal('fetch', async (url: string, init: RequestInit = {}) => {
    sent.push({ url, method: init.method ?? 'GET', headers: { ...(init.headers as Record<string, string>) } });
    return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  });
}

beforeEach(() => {
  sent = [];
  setAuthKnowledge('signed-in');
});

afterEach(() => {
  vi.unstubAllGlobals();
  resetAuthKnowledge();
});

describe('a money action carries its key to the executor', () => {
  it('an order', async () => {
    executorAnswers(200, { status: 'filled', units: 0.1, price: 2500 });
    await LocalRepositories.orders.place({ symbol: 'WETH', usd: 250 }, { idempotencyKey: 'order-key' });
    expect(sent).toHaveLength(1);
    expect(sent[0]?.url).toMatch(/\/orders$/);
    expect(sent[0]?.method).toBe('POST');
    expect(sent[0]?.headers['idempotency-key']).toBe('order-key');
  });

  it('a sale or a close', async () => {
    executorAnswers(200, { status: 'closed', symbol: 'WETH', units: 0.1, usd: 250, txHash: '0xabc' });
    await LocalRepositories.portfolio.close({ symbol: 'WETH', fraction: 0.5 }, { idempotencyKey: 'close-key' });
    expect(sent[0]?.url).toMatch(/\/positions\/close$/);
    expect(sent[0]?.headers['idempotency-key']).toBe('close-key');
  });

  it('a swap', async () => {
    executorAnswers(200, {
      status: 'filled',
      from: 'USDC',
      to: 'WETH',
      sold: 100,
      received: 0.04,
      usd: 100,
      venue: null,
      txHash: '0xabc',
    });
    await system.swap({ from: 'USDC', to: 'WETH', amount: '100', slippagePct: 0.3 }, { idempotencyKey: 'swap-key' });
    expect(sent[0]?.url).toMatch(/\/swap$/);
    expect(sent[0]?.headers['idempotency-key']).toBe('swap-key');
  });

  it('a faucet claim', async () => {
    executorAnswers(200, { status: 'sent' });
    await requestFaucet({ idempotencyKey: 'faucet-key' });
    expect(sent[0]?.url).toMatch(/\/faucet$/);
    expect(sent[0]?.headers['idempotency-key']).toBe('faucet-key');
  });

  it('with the key a screen’s keys chose, sent again when the order is retried after a gateway timeout', async () => {
    const keys = intentKeys();
    const buy = () =>
      keys.send({ side: 'buy', symbol: 'WETH', usd: 250 }, (idempotencyKey) =>
        LocalRepositories.orders.place({ symbol: 'WETH', usd: 250 }, { idempotencyKey }),
      );
    executorAnswers(504, {});
    await expect(buy()).rejects.toMatchObject({ status: 504 });
    executorAnswers(200, { status: 'filled', units: 0.1, price: 2500 });
    await expect(buy()).resolves.toMatchObject({ status: 'filled' });
    expect(sent).toHaveLength(2);
    expect(sent[0]?.headers['idempotency-key']).toMatch(/^[0-9a-f]{32,}$/);
    expect(sent[1]?.headers['idempotency-key']).toBe(sent[0]?.headers['idempotency-key']);
  });

  it('and nothing unkeyed carries one: not a read, not another write', async () => {
    executorAnswers(200, []);
    await api.get('/positions');
    await api.post('/alerts/a1', { enabled: true });
    await requestFaucet();
    expect(sent).toHaveLength(3);
    for (const request of sent) expect(request.headers).not.toHaveProperty('idempotency-key');
  });
});

describe('what the executor says about a key reaches the screen as its own sentence', () => {
  const calls: [string, () => Promise<unknown>][] = [
    ['/orders', () => LocalRepositories.orders.place({ symbol: 'WETH', usd: 250 }, { idempotencyKey: 'k' })],
    ['/positions/close', () => LocalRepositories.portfolio.close({ symbol: 'WETH', fraction: 1 }, { idempotencyKey: 'k' })],
    ['/swap', () => system.swap({ from: 'USDC', to: 'WETH', amount: '100' }, { idempotencyKey: 'k' })],
    ['/faucet', () => requestFaucet({ idempotencyKey: 'k' })],
  ];

  it.each(calls)('a key already used for another request, on %s', async (path, call) => {
    const sentence = `That key was already used for POST ${path === '/orders' ? '/swap' : '/orders'}.`;
    executorAnswers(422, { error: 'idempotency_key_reused', message: sentence });
    const failure = await call().then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(errorText(failure)).toBe(sentence);
  });

  it.each(calls)('the same request while the first is still running, on %s', async (_, call) => {
    executorAnswers(409, { error: 'request_in_flight', message: 'An identical request is still being processed.' });
    const failure = await call().then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(errorText(failure)).toBe('An identical request is still being processed.');
    expect(outcomeKnown(failure)).toBe(false);
  });
});
