/**
 * MoonPay fiat on-ramp integration for Solana USDC deposits (PLAN.md §5, §8.5).
 *
 * Keys are accessed strictly via environment variables (MOONPAY_API_KEY, MOONPAY_SECRET_KEY),
 * sandbox mode is enforced, and secret keys are never exposed to clients or committed.
 */
import { Hono, type Context } from 'hono';
import { z } from 'zod';
import crypto from 'node:crypto';
import { currentWallet } from './wallet-context.js';
import { append } from '../audit/log.js';
import { isValidAddress, formatAddress } from '../withdrawals/allowlist.js';

export const moonpayRoutes = new Hono();

const MOONPAY_SANDBOX_BASE = 'https://buy-sandbox.moonpay.com';
const DEFAULT_SANDBOX_API_KEY = 'pk_test_xorr_dev_sandbox';

export function getMoonPayApiKey(): string {
  return (
    process.env.MOONPAY_API_KEY ??
    process.env.EXPO_PUBLIC_MOONPAY_API_KEY ??
    DEFAULT_SANDBOX_API_KEY
  );
}

export function signMoonPayUrl(urlToSign: string, secretKey?: string): string {
  const secret = secretKey ?? process.env.MOONPAY_SECRET_KEY;
  if (!secret) return urlToSign;

  const signature = crypto
    .createHmac('sha256', secret)
    .update(urlToSign)
    .digest('base64');

  const separator = urlToSign.includes('?') ? '&' : '?';
  return `${urlToSign}${separator}signature=${encodeURIComponent(signature)}`;
}

export function buildMoonPayUrl(params: {
  walletAddress: string;
  currencyCode?: string;
  baseCurrencyCode?: string;
  baseCurrencyAmount?: number;
  apiKey?: string;
  secretKey?: string;
}): string {
  const apiKey = params.apiKey ?? getMoonPayApiKey();
  const currencyCode = params.currencyCode ?? 'usdc_sol';
  const baseCurrencyCode = params.baseCurrencyCode ?? 'usd';
  const amount = params.baseCurrencyAmount ?? 100;

  const searchParams = new URLSearchParams({
    apiKey,
    currencyCode,
    baseCurrencyCode,
    baseCurrencyAmount: amount.toString(),
    walletAddress: params.walletAddress,
  });

  const unsignedUrl = `${MOONPAY_SANDBOX_BASE}?${searchParams.toString()}`;
  return signMoonPayUrl(unsignedUrl, params.secretKey);
}

const MoonPayUrlInput = z.object({
  walletAddress: z.string().trim().refine((addr) => isValidAddress(addr), {
    message: 'Must be a valid Solana base58 or EVM address',
  }),
  currencyCode: z.string().optional().default('usdc_sol'),
  baseCurrencyCode: z.string().optional().default('usd'),
  baseCurrencyAmount: z.number().positive().optional().default(100),
});

/**
 * GET /deposit/moonpay/config
 * Returns client-safe configuration for MoonPay dev sandbox.
 */
moonpayRoutes.get('/deposit/moonpay/config', (c) => {
  return c.json({
    environment: 'sandbox',
    currencyCode: 'usdc_sol',
    baseCurrencyCode: 'usd',
    apiKey: getMoonPayApiKey(),
    sandboxUrl: MOONPAY_SANDBOX_BASE,
  });
});

/**
 * POST /deposit/moonpay/url
 * Returns a signed MoonPay sandbox checkout URL for the user's wallet.
 */
moonpayRoutes.post('/deposit/moonpay/url', async (c) => {
  const body = await c.req.json().catch(() => ({}));
  let targetAddress = body.walletAddress;
  if (!targetAddress) {
    try {
      const wallet = await currentWallet(c);
      targetAddress = wallet?.address;
    } catch {
      // Not authenticated or no wallet
    }
  }

  if (!targetAddress) {
    return c.json(
      {
        status: 'error',
        detail: 'walletAddress is required, or user must be signed in with a wallet.',
      },
      400,
    );
  }

  const parseResult = MoonPayUrlInput.safeParse({
    ...body,
    walletAddress: targetAddress,
  });

  if (!parseResult.success) {
    const detail = parseResult.error.issues?.[0]?.message ?? parseResult.error.message ?? 'Invalid input';
    return c.json(
      {
        status: 'error',
        detail,
      },
      400,
    );
  }

  const input = parseResult.data;
  const formattedAddress = formatAddress(input.walletAddress);
  const url = buildMoonPayUrl({
    walletAddress: formattedAddress,
    currencyCode: input.currencyCode,
    baseCurrencyCode: input.baseCurrencyCode,
    baseCurrencyAmount: input.baseCurrencyAmount,
  });

  return c.json({
    status: 'ok',
    environment: 'sandbox',
    currencyCode: input.currencyCode,
    walletAddress: formattedAddress,
    url,
  });
});

/**
 * POST /deposit/moonpay/webhook
 * Handles simulated sandbox transaction webhooks.
 */
moonpayRoutes.post('/deposit/moonpay/webhook', async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const event = body.data || body;

  const status = event.status || body.status;
  const walletAddress = event.walletAddress || body.walletAddress;
  const currencyCode = event.cryptoCurrency?.code || body.currencyCode || 'usdc_sol';
  const amount = event.baseCurrencyAmount || body.amount || 100;

  if (status === 'completed' && walletAddress) {
    let walletId = 'moonpay-deposit';
    try {
      const wallet = await currentWallet(c);
      if (wallet?.id) walletId = wallet.id;
    } catch {
      // Ignore
    }

    await append({
      walletId,
      agent: 'MoonPay',
      action: 'Fiat deposit completed',
      detail: `Deposited $${amount} via MoonPay sandbox (${currencyCode} on Solana) to ${walletAddress}`,
      kind: 'trade',
      payload: {
        provider: 'moonpay',
        environment: 'sandbox',
        currencyCode,
        walletAddress,
        amount,
        txId: event.id || body.id,
      },
    }).catch(() => undefined);
  }

  return c.json({ received: true });
});
