/**
 * MoonPay fiat on-ramp integration for Solana USDC deposits (PLAN.md §5, §8.5).
 *
 * Provides dev sandbox on-ramp flows for funding a wallet with USDC on Solana.
 * Keys are passed via server-side environment variables or public client env,
 * sandbox mode is strictly enforced, and secret keys are NEVER committed.
 */
import { Platform } from 'react-native';
import * as WebBrowser from 'expo-web-browser';
import { api } from '@/data/api';

export type MoonPayConfig = {
  environment: 'sandbox' | 'production';
  currencyCode: string;
  baseCurrencyCode: string;
  apiKey: string;
  sandboxUrl: string;
};

export type MoonPayUrlResponse = {
  status: 'ok' | 'error';
  url: string;
  environment: string;
  currencyCode: string;
  walletAddress: string;
  detail?: string;
};

/**
 * Fetch public MoonPay configuration from the executor.
 */
export async function fetchMoonPayConfig(): Promise<MoonPayConfig> {
  return api.get<MoonPayConfig>('/deposit/moonpay/config');
}

/**
 * Request a signed MoonPay sandbox buy URL from the executor.
 */
export async function fetchMoonPayDepositUrl(params: {
  walletAddress: string;
  baseCurrencyAmount?: number;
  currencyCode?: string;
}): Promise<string> {
  const res = await api.post<MoonPayUrlResponse>('/deposit/moonpay/url', {
    walletAddress: params.walletAddress,
    baseCurrencyAmount: params.baseCurrencyAmount ?? 100,
    currencyCode: params.currencyCode ?? 'usdc_sol',
  });
  if (res.status !== 'ok' || !res.url) {
    throw new Error(res.detail ?? 'Failed to generate MoonPay checkout URL');
  }
  return res.url;
}

/**
 * Open the MoonPay buy widget or browser checkout.
 * On web, tries to use the @moonpay/moonpay-js overlay SDK, falling back to window.open.
 * On mobile/native, opens via in-app browser with WebBrowser.openBrowserAsync.
 */
export async function openMoonPayBuy(params: {
  walletAddress: string;
  baseCurrencyAmount?: number;
  currencyCode?: string;
}): Promise<void> {
  const checkoutUrl = await fetchMoonPayDepositUrl(params);

  if (Platform.OS === 'web') {
    try {
      const { loadMoonPay } = await import('@moonpay/moonpay-js');
      const moonPaySdk = await loadMoonPay('v1');
      if (moonPaySdk && typeof window !== 'undefined') {
        const config = await fetchMoonPayConfig().catch(() => ({
          apiKey: 'pk_test_xorr_dev_sandbox',
        }));
        const widget = moonPaySdk({
          flow: 'buy',
          environment: 'sandbox',
          variant: 'overlay',
          params: {
            apiKey: config.apiKey,
            currencyCode: params.currencyCode ?? 'usdc_sol',
            walletAddress: params.walletAddress,
            baseCurrencyAmount: (params.baseCurrencyAmount ?? 100).toString(),
            baseCurrencyCode: 'usd',
          },
        });
        if (widget) {
          widget.show();
          return;
        }
      }
    } catch {
      // If SDK loading fails on web, fallback to opening URL
    }

    if (typeof window !== 'undefined') {
      window.open(checkoutUrl, '_blank');
      return;
    }
  }

  // Native (iOS/Android)
  await WebBrowser.openBrowserAsync(checkoutUrl);
}
