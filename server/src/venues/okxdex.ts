/**
 * OKX DEX aggregator on X Layer — the second venue (PLAN.md P2.8, 2026-09-19).
 *
 * OKX's aggregator (OnchainOS DEX API v6) routes across X Layer's liquidity. It is only a candidate when this deployment
 * has an API key (`OKX_API_KEY`, `OKX_SECRET_KEY`, `OKX_PASSPHRASE` from https://web3.okx.com/onchainos/dev-portal):
 * without one, `okxConfigured()` is false and Uniswap v3 settles alone — nothing here pretends to have quoted.
 *
 * One thing makes it different from Uniswap: OKX's router pulls the input token through a separate approval contract
 * (`OKX_APPROVE_SPENDER`, X Layer: 0x8b773D83bc66Be128c60e07E17C8901f7a64F000 per OKX's DEX contract page), not through
 * the router itself. So a leg through OKX names that spender, and the delegation contract approves the spender, not the
 * call target (`spendVia`/`closePositionVia` in `contracts/src/XorrDelegation.sol`). The spender must be on the owner's
 * venue allowlist like the router is.
 *
 * Auth, from OKX's API-access docs: `OK-ACCESS-KEY`, `OK-ACCESS-PASSPHRASE`, `OK-ACCESS-TIMESTAMP` (ISO-8601 UTC, within
 * 30 s of OKX's clock), and `OK-ACCESS-SIGN` = base64(HMAC-SHA256(secret, timestamp + METHOD + requestPath + body)), where
 * the request path of a GET includes its query string.
 */
import { createHmac } from 'node:crypto';
import { getAddress, isAddress, type Address, type Hex } from 'viem';
import { TOKENS, canonicalSymbol } from './tokens.js';
import { OKX_DEX_APPROVE_SPENDER, OKX_DEX_ROUTER } from '../evm/chains.js';

const BASE_URL = process.env.OKX_DEX_BASE_URL ?? 'https://web3.okx.com';
const API_PATH = '/api/v6/dex/aggregator';
/** X Layer mainnet — quotes are a mainnet question even for a fork of it. */
const CHAIN_INDEX = '196';
const TIMEOUT_MS = 12_000;

export const OKX_VENUE_NAME = 'OKX DEX';

/** OKX's approval contract on X Layer — the address the delegation approves (`spendVia`). Lives in `evm/chains.ts`. */
export const OKX_APPROVE_SPENDER: Address = getAddress(OKX_DEX_APPROVE_SPENDER);

/** OKX's DEX router on X Layer, for the grant's venue list. A swap's own `tx.to` is what is actually called. */
export const OKX_ROUTER: Address = getAddress(OKX_DEX_ROUTER);

type Creds = { key: string; secret: string; passphrase: string };

function creds(): Creds | null {
  const key = process.env.OKX_API_KEY;
  const secret = process.env.OKX_SECRET_KEY;
  const passphrase = process.env.OKX_PASSPHRASE;
  return key && secret && passphrase ? { key, secret, passphrase } : null;
}

/** Whether this deployment can ask OKX at all. */
export function okxConfigured(): boolean {
  return creds() !== null;
}

/** The signature OKX checks: base64(HMAC-SHA256(secret, timestamp + METHOD + requestPath + body)). */
export function okxSign(secret: string, timestamp: string, method: 'GET' | 'POST', requestPath: string, body = ''): string {
  return createHmac('sha256', secret).update(`${timestamp}${method}${requestPath}${body}`).digest('base64');
}

export class OkxDexError extends Error {
  constructor(
    message: string,
    readonly code?: string,
  ) {
    super(message);
    this.name = 'OkxDexError';
  }
}

/** One signed GET. Throws `OkxDexError` with OKX's own code and message on a refusal. */
export async function okxGet<T>(endpoint: string, params: Record<string, string>): Promise<T> {
  const c = creds();
  if (!c) throw new OkxDexError('OKX DEX is not configured: set OKX_API_KEY, OKX_SECRET_KEY and OKX_PASSPHRASE');
  const query = new URLSearchParams(params).toString();
  const requestPath = `${API_PATH}${endpoint}${query ? `?${query}` : ''}`;
  const timestamp = new Date().toISOString();
  const res = await fetch(`${BASE_URL}${requestPath}`, {
    headers: {
      'OK-ACCESS-KEY': c.key,
      'OK-ACCESS-PASSPHRASE': c.passphrase,
      'OK-ACCESS-TIMESTAMP': timestamp,
      'OK-ACCESS-SIGN': okxSign(c.secret, timestamp, 'GET', requestPath),
      'Content-Type': 'application/json',
    },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const body = (await res.json().catch(() => null)) as { code?: string; msg?: string; data?: T } | null;
  if (!res.ok || !body || body.code !== '0' || body.data === undefined) {
    throw new OkxDexError(`OKX DEX ${endpoint} refused: ${body?.msg || `HTTP ${res.status}`}`, body?.code);
  }
  return body.data;
}

function tokenAddress(symbol: string): Address {
  const t = TOKENS[canonicalSymbol(symbol)];
  if (!t) throw new OkxDexError(`No token registry entry for ${symbol}`);
  return t.address;
}

type SwapData = {
  routerResult?: { toTokenAmount?: string };
  tx?: { to?: string; data?: string; value?: string; minReceiveAmount?: string };
};

export type OkxRoute = { to: Address; data: Hex; value: string; spender: Address; minOut: bigint; expectedOut: bigint };

/** Parse OKX's `/swap` answer into a route, refusing anything incomplete rather than filling in a guess. */
export function parseOkxSwap(data: SwapData[] | SwapData, slippagePct: number): OkxRoute {
  const d = Array.isArray(data) ? data[0] : data;
  const tx = d?.tx;
  if (!tx?.to || !isAddress(tx.to) || !tx.data || !/^0x[0-9a-fA-F]*$/.test(tx.data)) {
    throw new OkxDexError('OKX DEX returned no transaction for this route');
  }
  const expected = d?.routerResult?.toTokenAmount;
  if (!expected || !/^\d+$/.test(expected)) throw new OkxDexError('OKX DEX returned no output amount for this route');
  const expectedOut = BigInt(expected);
  const floorFromSlippage = (expectedOut * BigInt(Math.floor((1 - slippagePct / 100) * 1_000_000))) / 1_000_000n;
  // OKX's own minimum when it states one, never looser than the tolerance the leg was given.
  const stated = tx.minReceiveAmount && /^\d+$/.test(tx.minReceiveAmount) ? BigInt(tx.minReceiveAmount) : 0n;
  const minOut = stated > floorFromSlippage ? stated : floorFromSlippage;
  if (minOut <= 0n) throw new OkxDexError('OKX DEX route delivers nothing at this size');
  return {
    to: getAddress(tx.to),
    data: tx.data as Hex,
    value: tx.value && /^\d+$/.test(tx.value) ? tx.value : '0',
    spender: OKX_APPROVE_SPENDER,
    minOut,
    expectedOut,
  };
}

/**
 * A swap route through OKX DEX: calldata for its router, sent BY the delegation contract (`from`) and paying the OWNER
 * (`receiver`). Throws where OKX has no route or is not configured.
 */
export async function okxRoute(params: {
  inSymbol: string;
  outSymbol: string;
  amountRaw: bigint;
  from: Address;
  receiver: Address;
  slippagePct: number;
}): Promise<OkxRoute> {
  if (params.amountRaw <= 0n) throw new OkxDexError('A swap needs an amount above zero');
  const data = await okxGet<SwapData[]>('/swap', {
    chainIndex: CHAIN_INDEX,
    amount: params.amountRaw.toString(),
    swapMode: 'exactIn',
    fromTokenAddress: tokenAddress(params.inSymbol),
    toTokenAddress: tokenAddress(params.outSymbol),
    // OKX takes the tolerance as a percentage string, e.g. "0.5" for 0.5%.
    slippagePercent: String(params.slippagePct),
    userWalletAddress: params.from,
    swapReceiverAddress: params.receiver,
  });
  return parseOkxSwap(data, params.slippagePct);
}

/** OKX's quote for a size, in the output token's raw units — for comparing venues on a screen. */
export async function okxQuoteRaw(inSymbol: string, outSymbol: string, amountRaw: bigint): Promise<bigint> {
  const data = await okxGet<{ toTokenAmount?: string }[]>('/quote', {
    chainIndex: CHAIN_INDEX,
    amount: amountRaw.toString(),
    swapMode: 'exactIn',
    fromTokenAddress: tokenAddress(inSymbol),
    toTokenAddress: tokenAddress(outSymbol),
  });
  const out = data[0]?.toTokenAmount;
  if (!out || !/^\d+$/.test(out)) throw new OkxDexError('OKX DEX returned no quote for this size');
  return BigInt(out);
}
