import { describe, expect, it, vi, beforeEach } from 'vitest';
import { fetchMoonPayConfig, fetchMoonPayDepositUrl, openMoonPayBuy } from './moonpay';
import { api } from '@/data/api';
import * as WebBrowser from 'expo-web-browser';

vi.mock('@/data/api', () => ({
  api: {
    get: vi.fn(),
    post: vi.fn(),
  },
}));

vi.mock('expo-web-browser', () => ({
  openBrowserAsync: vi.fn(),
}));

describe('MoonPay client deposit helper', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('fetchMoonPayConfig calls /deposit/moonpay/config', async () => {
    vi.mocked(api.get).mockResolvedValueOnce({
      environment: 'sandbox',
      currencyCode: 'usdc_sol',
      baseCurrencyCode: 'usd',
      apiKey: 'pk_test_sample',
      sandboxUrl: 'https://buy-sandbox.moonpay.com',
    });

    const config = await fetchMoonPayConfig();
    expect(api.get).toHaveBeenCalledWith('/deposit/moonpay/config');
    expect(config.currencyCode).toBe('usdc_sol');
    expect(config.environment).toBe('sandbox');
  });

  it('fetchMoonPayDepositUrl posts to /deposit/moonpay/url', async () => {
    const testWallet = '7v91N7iZEdMoQg6zJ5pA9oG3eF1n3hXyZ1W2v3u4t5s6';
    const testUrl = 'https://buy-sandbox.moonpay.com?apiKey=pk_test_sample&walletAddress=' + testWallet;
    vi.mocked(api.post).mockResolvedValueOnce({
      status: 'ok',
      url: testUrl,
      environment: 'sandbox',
      currencyCode: 'usdc_sol',
      walletAddress: testWallet,
    });

    const url = await fetchMoonPayDepositUrl({
      walletAddress: testWallet,
      baseCurrencyAmount: 150,
    });

    expect(api.post).toHaveBeenCalledWith('/deposit/moonpay/url', {
      walletAddress: testWallet,
      baseCurrencyAmount: 150,
      currencyCode: 'usdc_sol',
    });
    expect(url).toBe(testUrl);
  });

  it('fetchMoonPayDepositUrl throws if status is not ok', async () => {
    vi.mocked(api.post).mockResolvedValueOnce({
      status: 'error',
      url: '',
      detail: 'Invalid wallet address',
    });

    await expect(
      fetchMoonPayDepositUrl({
        walletAddress: 'invalid',
      }),
    ).rejects.toThrow('Invalid wallet address');
  });
});
