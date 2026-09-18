/**
 * Tokenized equities on Solana: Backed Finance xStocks (PLAN.md §8.4).
 *
 * Backed Finance issues tokenized equities on Solana under the SPL Token-2022 program.
 * Tickers carry the `x` suffix (NVDAx, TSLAx, AAPLx, MSFTx, etc.).
 *
 * Every address is the real Solana mainnet mint for that asset.
 * Pricing is derived from real Jupiter quotes (USDC -> xStock).
 */
import { PublicKey } from '@solana/web3.js';
import { query } from '../db/index.js';

/**
 * What the underlying listing is, in GICS sector names.
 *
 * `Index funds` is not a GICS sector and is not pretending to be one. SPYx and QQQx track baskets
 * that span every sector on this list, so filing them under any single one would be a claim about
 * their holdings that is simply false. They get a bucket that says what they are.
 */
export type XStockSector =
  | 'Technology'
  | 'Communication Services'
  | 'Consumer Discretionary'
  | 'Financials'
  | 'Index funds';

export type XStockToken = {
  /** The on-chain symbol (e.g. NVDAx, TSLAx). */
  symbol: string;
  /** The underlying listed company. */
  name: string;
  /** Solana mint base58 address. */
  address: string;
  decimals: number;
  /**
   * The sector of the company this token tracks.
   *
   * Reference data about the listing, like `name` beside it — not a market observation. It is the
   * one fact a browsable catalog needs that no price feed carries, and it never goes stale in the
   * way a number does.
   */
  sector: XStockSector;
};

export const XSTOCKS: Record<string, XStockToken> = {
  NVDAx: {
    symbol: 'NVDAx',
    name: 'NVIDIA Corporation xStock',
    address: 'Xsc9qvGR1efVDFGLrVsmkzv3qi45LTBjeUKSPmx9qEh',
    decimals: 8,
    sector: 'Technology',
  },
  TSLAx: {
    symbol: 'TSLAx',
    name: 'Tesla Inc. xStock',
    address: 'XsDoVfqeBukxuZHWhdvWHBhgEHjGNst4MLodqsJHzoB',
    decimals: 8,
    sector: 'Consumer Discretionary',
  },
  AAPLx: {
    symbol: 'AAPLx',
    name: 'Apple Inc. xStock',
    address: 'XsbEhLAtcf6HdfpFZ5xEMdqW8nfAvcsP5bdudRLJzJp',
    decimals: 8,
    sector: 'Technology',
  },
  MSFTx: {
    symbol: 'MSFTx',
    name: 'Microsoft Corporation xStock',
    address: 'XspzcW1PRtgf6Wj92HCiZdjzKCyFekVD8P5Ueh3dRMX',
    decimals: 8,
    sector: 'Technology',
  },
  AMZNx: {
    symbol: 'AMZNx',
    name: 'Amazon.com Inc. xStock',
    address: 'Xs3eBt7uRfJX8QUs4suhyU8p2M6DoUDrJyWBa8LLZsg',
    decimals: 8,
    sector: 'Consumer Discretionary',
  },
  GOOGLx: {
    symbol: 'GOOGLx',
    name: 'Alphabet Inc. xStock',
    address: 'XsCPL9dNWBMvFtTmwcCA5v3xWPSMEBCszbQdiLLq6aN',
    decimals: 8,
    sector: 'Communication Services',
  },
  METAx: {
    symbol: 'METAx',
    name: 'Meta Platforms Inc. xStock',
    address: 'Xsa62P5mvPszXL1krVUnU5ar38bBSVcWAB6fmPCo5Zu',
    decimals: 8,
    sector: 'Communication Services',
  },
  MSTRx: {
    symbol: 'MSTRx',
    name: 'MicroStrategy Inc. xStock',
    address: 'XsP7xzNPvEHS1m6qfanPUGjNmdnmsLKEoNAnHjdxxyZ',
    decimals: 8,
    sector: 'Technology',
  },
  COINx: {
    symbol: 'COINx',
    name: 'Coinbase Global Inc. xStock',
    address: 'Xs7ZdzSHLU9ftNJsii5fCeJhoRWSC32SQGzGQtePxNu',
    decimals: 8,
    sector: 'Financials',
  },
  SPYx: {
    symbol: 'SPYx',
    name: 'SPDR S&P 500 ETF Trust xStock',
    address: 'XsoCS1TfEyfFhfvj8EtZ528L3CaKBDBRqRapnBbDF2W',
    decimals: 8,
    sector: 'Index funds',
  },
  QQQx: {
    symbol: 'QQQx',
    name: 'Invesco QQQ Trust xStock',
    address: 'Xs8S1uUs1zvS2p7iwtsG3b6fkhpvmwz4GYU3gWAmWHZ',
    decimals: 8,
    sector: 'Index funds',
  },
};

/**
 * Case-insensitive lookup for xStock symbol.
 */
export function xStockKey(symbol: string): string | undefined {
  const want = symbol.trim().toUpperCase();
  return Object.keys(XSTOCKS).find((k) => k.toUpperCase() === want);
}

export function isXStock(symbol: string): boolean {
  return xStockKey(symbol) !== undefined;
}

const PROBE_USD = 1_000;
const cache = new Map<string, { at: number; price: number }>();
const TTL_MS = 30_000;

export function clearXStockPriceCache(): void {
  cache.clear();
}

/**
 * Calculate tokenized equity price in USD from Jupiter quotes.
 */
export async function xStockPriceUsd(symbol: string): Promise<number | null> {
  const key = xStockKey(symbol);
  if (!key) return null;
  const token = XSTOCKS[key];
  if (!token) return null;

  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.price;

  const { quote } = await import('./jupiter.js');
  const q = await quote({
    inSymbolOrMint: 'USDC',
    outSymbolOrMint: token.address,
    amountUnits: PROBE_USD * 1e6, // 1000 USDC
  }).catch(() => null);

  if (!q || !(Number(q.outAmount) > 0)) return null;

  const outTokens = Number(q.outAmount) / 10 ** token.decimals;
  const price = PROBE_USD / outTokens;
  cache.set(key, { at: Date.now(), price });
  recordObservation(key, price);
  return price;
}

export function recordObservation(symbol: string, usd: number): void {
  if (!(usd > 0)) return;
  void query(`INSERT INTO price_observations (symbol, usd) VALUES ($1, $2) ON CONFLICT DO NOTHING`, [
    symbol,
    usd,
  ]).catch(() => undefined);
}

let functional: Promise<boolean> | undefined;

/**
 * Check if xStocks actually function on this cluster.
 */
export function xStocksFunctional(): Promise<boolean> {
  functional ??= (async () => {
    try {
      const { connection } = await import('../solana/connection.js');
      const probeMint = new PublicKey(XSTOCKS.NVDAx!.address);
      const acc = await connection.getAccountInfo(probeMint);
      return acc !== null;
    } catch {
      return false;
    }
  })();
  return functional;
}

export function resetXStocksFunctional(): void {
  functional = undefined;
}
