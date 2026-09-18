import { describe, expect, it, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';
import {
  moonpayRoutes,
  buildMoonPayUrl,
  signMoonPayUrl,
  getMoonPayApiKey,
} from './moonpay.js';

describe('MoonPay integration', () => {
  // An X Layer (EVM) wallet: the only kind of address the executor's validator accepts now.
  const testWallet = '0x95A0b368588713011a15f4b1041423f31B08e615';

  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('builds a sandbox buy URL targeting usdc_sol on Solana', () => {
    const url = buildMoonPayUrl({
      walletAddress: testWallet,
      apiKey: 'pk_test_sample',
      baseCurrencyAmount: 150,
    });

    expect(url).toContain('https://buy-sandbox.moonpay.com');
    expect(url).toContain('apiKey=pk_test_sample');
    expect(url).toContain('currencyCode=usdc_sol');
    expect(url).toContain(`walletAddress=${testWallet}`);
    expect(url).toContain('baseCurrencyAmount=150');
    expect(url).toContain('baseCurrencyCode=usd');
  });

  it('signs url with HMAC-SHA256 signature when secretKey is present', () => {
    const secret = 'sk_test_secret_key_123';
    const signed = buildMoonPayUrl({
      walletAddress: testWallet,
      apiKey: 'pk_test_sample',
      secretKey: secret,
    });

    expect(signed).toContain('&signature=');
  });

  it('GET /deposit/moonpay/config returns sandbox config', async () => {
    const app = new Hono();
    app.route('/', moonpayRoutes);

    const res = await app.request('/deposit/moonpay/config');
    expect(res.status).toBe(200);

    const body = (await res.json()) as Record<string, any>;
    expect(body.environment).toBe('sandbox');
    expect(body.currencyCode).toBe('usdc_sol');
    expect(body.baseCurrencyCode).toBe('usd');
    expect(body.sandboxUrl).toBe('https://buy-sandbox.moonpay.com');
  });

  it('POST /deposit/moonpay/url validates address and returns URL', async () => {
    const app = new Hono();
    app.route('/', moonpayRoutes);

    const res = await app.request('/deposit/moonpay/url', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        walletAddress: testWallet,
        baseCurrencyAmount: 200,
      }),
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, any>;
    expect(body.status).toBe('ok');
    expect(body.environment).toBe('sandbox');
    expect(body.currencyCode).toBe('usdc_sol');
    expect(body.walletAddress).toBe(testWallet);
    expect(body.url).toContain('https://buy-sandbox.moonpay.com');
    expect(body.url).toContain('currencyCode=usdc_sol');
  });

  it('POST /deposit/moonpay/url rejects a Solana address, which no X Layer wallet has', async () => {
    const app = new Hono();
    app.route('/', moonpayRoutes);

    const res = await app.request('/deposit/moonpay/url', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ walletAddress: '7v91N7iZEdMoQg6zJ5pA9oG3eF1n3hXyZ1W2v3u4t5s6' }),
    });

    expect(res.status).toBe(400);
  });

  it('POST /deposit/moonpay/url rejects invalid address', async () => {
    const app = new Hono();
    app.route('/', moonpayRoutes);

    const res = await app.request('/deposit/moonpay/url', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        walletAddress: 'invalid-not-an-address',
      }),
    });

    expect(res.status).toBe(400);
  });
});
