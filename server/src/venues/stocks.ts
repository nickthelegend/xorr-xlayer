/**
 * Tokenized US equities on X Layer — xStocks (2026-09-19).
 *
 * Backed Finance issues xStocks; X Layer carries them since June 2026. Each comes as a raw token that rebases for
 * corporate actions (`multiplier()`), and an ERC-4626 wrapper whose share never rebases — the wrapper is what trades:
 * the Uniswap v3 pools that hold real liquidity on X Layer are all against wrappers. So the registry's address is the
 * wrapper, and "Buy $50 of TSLAx" is a real swap into the token those pools hold.
 *
 * Every address was read from Backed's public API (`GET https://api.xstocks.fi/api/v2/public/assets/{SYMBOL}`,
 * `deployments[].network == "XLayer"`: `address` = raw, `wrapperAddressV2` = wrapper) and matched on chain: `symbol()`
 * answers `w<ticker>`, the wrapper's `asset()` is the raw token, 18 decimals. The pools are Uniswap v3 pools read from the
 * factory with their live balances on 2026-09-19; tickers whose USDC pool is empty route through USDG.
 */
import type { Address } from 'viem';
import { query } from '../db/index.js';

export type StockToken = {
  /** The symbol the app shows: the ticker with the xStocks `x`. */
  symbol: string;
  /** The listed company or fund. */
  name: string;
  /** The share it tracks, for filings and market hours. */
  ticker: string;
  /** The ERC-4626 wrapper — what trades, what a wallet holds, what the grant approves. */
  address: Address;
  /** The raw rebasing xStock behind the wrapper. */
  raw: Address;
  decimals: number;
  /** The pools to USDC. See `venues/tokens.ts`. */
  toUsdc: { via: string; fee: number }[];
};

const VIA_USDC = [{ via: 'USDC', fee: 500 }];
const VIA_USDG = [
  { via: 'USDG', fee: 500 },
  { via: 'USDC', fee: 100 },
];

export const STOCKS: Record<string, StockToken> = {
  TSLAx: {
    symbol: 'TSLAx',
    name: 'Tesla, Inc.',
    ticker: 'TSLA',
    address: '0xc3fdbe3a68ee5de461d30415a8165cf9aefe1171',
    raw: '0x8aD3c73F833d3F9A523aB01476625F269aEB7Cf0',
    decimals: 18,
    toUsdc: VIA_USDC,
  },
  QQQx: {
    symbol: 'QQQx',
    name: 'Invesco QQQ Trust',
    ticker: 'QQQ',
    address: '0x4c1ae29c159838fc1b224636e28e086eb69101f7',
    raw: '0xa753A7395cAe905Cd615Da0B82A53E0560f250af',
    decimals: 18,
    toUsdc: VIA_USDC,
  },
  GOOGLx: {
    symbol: 'GOOGLx',
    name: 'Alphabet Inc.',
    ticker: 'GOOGL',
    address: '0xf8c5308f80e459bb53d9ebe689854d9cbb2caa6f',
    raw: '0xe92f673Ca36C5E2Efd2DE7628f815f84807e803F',
    decimals: 18,
    toUsdc: VIA_USDC,
  },
  COINx: {
    symbol: 'COINx',
    name: 'Coinbase Global, Inc.',
    ticker: 'COIN',
    address: '0x44c7ed7ffdf8465c9d27f60aec845eed3d49d56e',
    raw: '0x364f210f430eC2448Fc68A49203040F6124096F0',
    decimals: 18,
    toUsdc: VIA_USDC,
  },
  SPYx: {
    symbol: 'SPYx',
    name: 'SPDR S&P 500 ETF Trust',
    ticker: 'SPY',
    address: '0xe7e553cd128f0011777323a0b44a7b96ea1cb540',
    raw: '0x90A2a4c76b5D8c0bc892A69EA28Aa775a8f2dD48',
    decimals: 18,
    toUsdc: VIA_USDG,
  },
  NVDAx: {
    symbol: 'NVDAx',
    name: 'NVIDIA Corporation',
    ticker: 'NVDA',
    address: '0xa8ddb5cd96b5222afe198316e9a57caa642850d5',
    raw: '0xc845b2894dBddd03858fd2D643B4eF725fE0849d',
    decimals: 18,
    toUsdc: VIA_USDG,
  },
  AAPLx: {
    symbol: 'AAPLx',
    name: 'Apple Inc.',
    ticker: 'AAPL',
    address: '0x943bf64d566c32a2bcd41ac92fb63c111cc9de8f',
    raw: '0x9d275685dC284C8eB1C79f6ABA7a63Dc75ec890a',
    decimals: 18,
    toUsdc: VIA_USDG,
  },
  MSFTx: {
    symbol: 'MSFTx',
    name: 'Microsoft Corporation',
    ticker: 'MSFT',
    address: '0x166fbe68274b6a47e025f4ba17388c539f1fa1d0',
    raw: '0x5621737f42dAE558b81269FcB9E9E70c19Aa6b35',
    decimals: 18,
    toUsdc: VIA_USDG,
  },
  METAx: {
    symbol: 'METAx',
    name: 'Meta Platforms, Inc.',
    ticker: 'META',
    address: '0xe840946ffebcd66b7c4e95095effafadfa0d0e56',
    raw: '0x96702be57Cd9777f835117a809C7124fe4ec989A',
    decimals: 18,
    toUsdc: VIA_USDG,
  },
  MSTRx: {
    symbol: 'MSTRx',
    name: 'Strategy Inc.',
    ticker: 'MSTR',
    address: '0x30987adf0b11dc698438a99ba04ec3a1ab2c7eab',
    raw: '0xAE2f842EF90C0d5213259Ab82639D5BBF649b08E',
    decimals: 18,
    toUsdc: VIA_USDG,
  },
  AMZNx: {
    symbol: 'AMZNx',
    name: 'Amazon.com, Inc.',
    ticker: 'AMZN',
    address: '0x910cabde3eba7fc1ce64fd14bd680b9f60fa0f90',
    raw: '0x3557Ba345B01EFa20A1bdDC61F573BFD87195081',
    decimals: 18,
    toUsdc: VIA_USDG,
  },
};

/**
 * Case-insensitively, because the suffix is the whole point and callers lose it: `/price/:symbol` uppercases its
 * parameter, and `TSLAX` must still find `TSLAx`.
 */
export function stockKey(symbol: string): string | undefined {
  const want = symbol.trim().toUpperCase();
  return Object.keys(STOCKS).find((k) => k.toUpperCase() === want);
}

export function isStock(symbol: string): boolean {
  return stockKey(symbol) !== undefined;
}

/** The share a symbol tracks (`TSLAx` → `TSLA`), for SEC filings and market hours. Undefined for anything else. */
export function underlyingTicker(symbol: string): string | undefined {
  const key = stockKey(symbol);
  return key ? STOCKS[key]!.ticker : undefined;
}

/** Big enough that the route is representative, small enough not to move the pools it is measuring. */
const PROBE_USD = 1_000;

const cache = new Map<string, { at: number; price: number }>();
const TTL_MS = 30_000;

/** Testing only — the 30s cache otherwise carries one case's price into the next. */
export function clearStockPriceCache(): void {
  cache.clear();
}

/**
 * What one wrapped xStock is worth, from the pools that would actually fill it: quote $1,000 of USDC in and see how many
 * shares come out. There is no CoinGecko feed for these, and the exchange print would be the wrong number anyway —
 * what a person pays is what the pool gives.
 *
 * `skipPriceImpact` is load-bearing: impact is measured against a mid from `priceOf`, and for an equity `priceOf` comes
 * back here — the cycle that took the Base executor to a fatal 2GB heap.
 */
export async function stockPriceUsd(symbol: string): Promise<number | null> {
  const key = stockKey(symbol);
  if (!key) return null;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.price;

  // Imported here to keep `tokens.ts` → `stocks.ts` free of a load-order cycle through the venue.
  const { quote } = await import('./uniswap.js');
  const q = await quote({ inSymbol: 'USDC', outSymbol: key, amount: PROBE_USD, skipPriceImpact: true }).catch(() => null);
  if (!q || !(q.outAmount > 0)) return null;
  const price = PROBE_USD / q.outAmount;
  cache.set(key, { at: Date.now(), price });
  recordObservation(key, price);
  return price;
}

/**
 * Record what we saw, so these assets build a real series from the first reading. Fire-and-forget: a price read must
 * never fail because a write failed.
 */
export function recordObservation(symbol: string, usd: number): void {
  if (!(usd > 0)) return;
  void query(`INSERT INTO price_observations (symbol, usd) VALUES ($1, $2) ON CONFLICT DO NOTHING`, [symbol, usd]).catch(
    () => undefined,
  );
}

/** The series we have actually seen, oldest first. Empty until something has looked. A read that fails throws. */
export async function observedHistory(symbol: string, hours = 24 * 30): Promise<{ at: number; usd: number }[]> {
  const key = stockKey(symbol);
  if (!key) return [];
  const rows = await query<{ at: Date; usd: string }>(
    `SELECT at, usd FROM price_observations
      WHERE symbol = $1 AND at > now() - ($2 || ' hours')::interval
      ORDER BY at ASC`,
    [key, String(hours)],
  );
  return rows.map((r) => ({ at: new Date(r.at).getTime(), usd: Number(r.usd) }));
}

/**
 * Do the xStocks work on the chain this executor is pointed at? On X Layer mainnet and its fork the wrappers are ordinary
 * ERC-4626 contracts with a supply; on the testnet they have no code. One wrapper answering `totalSupply()` settles it.
 * Cached for the process lifetime: a chain does not stop serving a token halfway through a deployment.
 */
let functional: Promise<boolean> | undefined;

export function equitiesFunctional(): Promise<boolean> {
  functional ??= (async () => {
    const probes = Object.values(STOCKS).slice(0, 3);
    if (probes.length === 0) return false;
    const { publicClient } = await import('../evm/client.js');
    const { erc20Abi } = await import('viem');
    const { pastTheThrottle } = await import('../evm/throttle.js');
    const answers = await Promise.all(
      probes.map((p) =>
        pastTheThrottle(() =>
          publicClient.readContract({ address: p.address, abi: erc20Abi, functionName: 'totalSupply' }),
        ).catch(() => 0n),
      ),
    );
    return answers.some((a) => a > 0n);
  })();
  return functional;
}

/** Testing only — the process-lifetime cache would otherwise carry one case into the next. */
export function resetEquitiesFunctional(): void {
  functional = undefined;
}
