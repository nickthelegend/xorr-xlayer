/**
 * Real supply yield, read on chain — Aave v3 on X Layer (PLAN.md P2.14, D15).
 *
 * Tier 4 moves idle cash to yield, and the number the app shows for it is the one the pool is paying: each reserve's
 * `currentLiquidityRate`, read from the Pool contract, never a constant. On X Layer the pool pays on USDT0 (~3.4% when
 * this was written) and next to nothing on USDC, so tier 4 earns on USDT0 (owner decision D15) and USDC's rate is shown
 * beside it, which is the reason the swap is worth making.
 *
 * Where the rate is READ and where money can MOVE are separate questions, as they are for prices:
 *
 *   - The rate is a mainnet question. On X Layer mainnet and its fork it is read from the chain the executor settles on
 *     (on a fork, the fork's own reserve state); on the testnet, which has no lending pool, it is read from mainnet and
 *     said to be for reference only.
 *   - Whether anything can be supplied is `aavePoolIsDeployedHere()`: false without an RPC call where the chain has no
 *     pool (`AAVE_V3_POOL` is null), and otherwise the pool's code, checked once.
 */
import { createPublicClient, http, type Address } from 'viem';
import { xLayer } from 'viem/chains';
import { pastTheThrottle } from '../evm/throttle.js';
import { AAVE_V3_POOL, AAVE_V3_POOL_MAINNET, IS_MAINNET_STATE, QUOTE_ADDRESSES, chain } from '../evm/chains.js';
import { publicClient } from '../evm/client.js';

/** The reserves this app reads: the one tier 4 earns on, and the settlement token it is compared against. */
export type YieldAsset = 'USDT0' | 'USDC';
export const YIELD_ASSETS: readonly YieldAsset[] = ['USDT0', 'USDC'];

/** What tier 4 supplies (D15). */
export const EARNING_ASSET: YieldAsset = 'USDT0';

/** X Layer MAINNET addresses, always — the reserve is asked about the asset it actually lists. */
const ASSET_ADDRESS: Record<YieldAsset, Address> = {
  USDT0: QUOTE_ADDRESSES.usdt0,
  USDC: QUOTE_ADDRESSES.usdc,
};

/** Aave stores rates in ray — 27 decimals — as a per-second rate annualised linearly. */
const RAY = 10n ** 27n;
const SECONDS_PER_YEAR = 31_536_000;

const POOL_ABI = [
  {
    type: 'function',
    name: 'getReserveData',
    stateMutability: 'view',
    inputs: [{ name: 'asset', type: 'address' }],
    outputs: [
      {
        type: 'tuple',
        components: [
          { name: 'configuration', type: 'uint256' },
          { name: 'liquidityIndex', type: 'uint128' },
          { name: 'currentLiquidityRate', type: 'uint128' },
          { name: 'variableBorrowIndex', type: 'uint128' },
          { name: 'currentVariableBorrowRate', type: 'uint128' },
          { name: 'currentStableBorrowRate', type: 'uint128' },
          { name: 'lastUpdateTimestamp', type: 'uint40' },
          { name: 'id', type: 'uint16' },
          { name: 'aTokenAddress', type: 'address' },
          { name: 'stableDebtTokenAddress', type: 'address' },
          { name: 'variableDebtTokenAddress', type: 'address' },
          { name: 'interestRateStrategyAddress', type: 'address' },
          { name: 'accruedToTreasury', type: 'uint128' },
          { name: 'unbacked', type: 'uint128' },
          { name: 'isolationModeTotalDebt', type: 'uint128' },
        ],
      },
    ],
  },
] as const;

/**
 * The client the rate is read with. See the file header: the settlement chain where it has the pool, mainnet otherwise.
 */
let referenceClient: ReturnType<typeof createPublicClient> | undefined;
function rateClient(): Pick<typeof publicClient, 'readContract'> {
  if (IS_MAINNET_STATE) return publicClient;
  referenceClient ??= createPublicClient({
    chain: xLayer,
    transport: http(process.env.XLAYER_RPC ?? 'https://rpc.xlayer.tech'),
  });
  return referenceClient;
}

export type SupplyYield = {
  /** The asset tier 4 supplies — USDT0. */
  symbol: string;
  /** Compounded APY as a fraction, e.g. 0.034 for 3.4%. */
  estimatedApy: number;
  feed: 'live';
  source: string;
  note: string;
  /**
   * Whether the strategy this rate advertises can run on the chain the executor trades. The same check
   * `planYieldRotation` makes before supplying, so the screen and the planner cannot disagree.
   */
  availableHere: boolean;
  /** Every reserve read, the earning one first, so a screen can show why USDT0 and not USDC. */
  reserves: { symbol: YieldAsset; apy: number; aToken: Address; asset: Address }[];
};

/**
 * One reserve, as Aave reports it: its rate, and the receipt token a supplier holds. Reading the aToken from the reserve
 * rather than hardcoding it means the strategy cannot quietly credit the wrong receipt token if Aave migrates one.
 */
export type Reserve = {
  symbol: YieldAsset;
  /** Compounded APY as a fraction. Zero is a real answer (USDC on X Layer is close to it); a missing reserve throws. */
  apy: number;
  /** The receipt token the supplier holds. */
  aToken: Address;
  asset: Address;
  pool: Address;
  decimals: 6;
};

/**
 * Each reserve, reused for a minute (PLAN.md 2.4). A lending rate a minute old is still the rate; a read that failed is
 * not kept, and `maxAgeMs = 0` asks now, for a caller whose job is to prove the read works.
 */
const RESERVE_TTL_MS = 60_000;
const reserveCache = new Map<YieldAsset, { at: number; value: Promise<Reserve> }>();

export function reserveOf(symbol: YieldAsset, maxAgeMs = RESERVE_TTL_MS): Promise<Reserve> {
  const hit = reserveCache.get(symbol);
  if (hit && Date.now() - hit.at < maxAgeMs) return hit.value;
  const entry = { at: Date.now(), value: readReserve(symbol) };
  reserveCache.set(symbol, entry);
  entry.value.catch(() => {
    if (reserveCache.get(symbol) === entry) reserveCache.delete(symbol);
  });
  return entry.value;
}

/** The reserve tier 4 supplies to. */
export const usdt0Reserve = (maxAgeMs?: number) => reserveOf('USDT0', maxAgeMs);
/** The settlement token's reserve, the rate USDT0 is compared against. */
export const usdcReserve = (maxAgeMs?: number) => reserveOf('USDC', maxAgeMs);

/** Testing only: forgets every reserve, and whether this chain has a pool. */
export function clearReserveCache(): void {
  reserveCache.clear();
  deployedHere = undefined;
}

async function readReserve(symbol: YieldAsset): Promise<Reserve> {
  const asset = ASSET_ADDRESS[symbol];
  const pool = AAVE_V3_POOL_MAINNET as Address;
  // Through the throttle guard: a public endpoint answers a rate limit as an error inside a 200 that viem does not retry.
  const data = await pastTheThrottle(() =>
    rateClient().readContract({ address: pool, abi: POOL_ABI, functionName: 'getReserveData', args: [asset] }),
  );

  // Aave returns a ZEROED struct for an asset it does not list, rather than reverting. That is "no reserve", not "0%".
  if (data.lastUpdateTimestamp === 0 || data.aTokenAddress === '0x0000000000000000000000000000000000000000') {
    throw new Error(`Aave v3 on X Layer has no ${symbol} reserve at ${pool}`);
  }

  // currentLiquidityRate is an annualised per-second rate in ray, compounded per second the way app.aave.com shows it.
  const apr = Number((data.currentLiquidityRate * 1_000_000_000n) / RAY) / 1_000_000_000;
  const perSecond = apr / SECONDS_PER_YEAR;
  const apy = (1 + perSecond) ** SECONDS_PER_YEAR - 1;
  // A dollar money market pays zero or more, and nothing near 100%. Outside that the decode is wrong, not the market.
  if (!Number.isFinite(apy) || apy < 0 || apy > 1) {
    throw new Error(`Implausible Aave ${symbol} rate: ${apy}`);
  }

  return { symbol, apy, aToken: data.aTokenAddress, asset, pool, decimals: 6 };
}

/** The rate tier 4 earns, with USDC's beside it when it could be read. */
export async function supplyYield(): Promise<SupplyYield> {
  const earning = await reserveOf(EARNING_ASSET);
  const others = await Promise.all(
    YIELD_ASSETS.filter((s) => s !== EARNING_ASSET).map((s) => reserveOf(s).catch(() => null)),
  );
  const availableHere = await aavePoolIsDeployedHere();
  const pct = (apy: number) => `${(apy * 100).toFixed(2)}%`;
  const usdc = others.find((r) => r?.symbol === 'USDC');
  return {
    symbol: EARNING_ASSET,
    estimatedApy: earning.apy,
    feed: 'live',
    source: `Aave v3 Pool ${AAVE_V3_POOL_MAINNET} on X Layer`,
    note: availableHere
      ? `Idle cash is supplied to Aave v3 on X Layer as USDT0${usdc ? `, which pays ${pct(earning.apy)} against ${pct(usdc.apy)} on USDC` : ''}. The rate floats; it is not a promise.`
      : `There is no lending pool on ${chain.name}, which is what this build trades, so nothing can be supplied here. This is X Layer mainnet's published rate, shown for reference.`,
    availableHere,
    reserves: [earning, ...others.filter((r): r is Reserve => r !== null)].map((r) => ({
      symbol: r.symbol,
      apy: r.apy,
      aToken: r.aToken,
      asset: r.asset,
    })),
  };
}

/**
 * Is there actually an Aave pool on the chain the executor trades?
 *
 * No pool configured for this chain is `false` without asking anything. Otherwise the pool's code, cached because it is a
 * property of the deployment — and a read that fails throws and is not remembered, so one RPC hiccup cannot hide a fork's
 * supplied balance for the life of the process.
 */
let deployedHere: boolean | undefined;
export async function aavePoolIsDeployedHere(): Promise<boolean> {
  if (!AAVE_V3_POOL) return false;
  if (deployedHere !== undefined) return deployedHere;
  const code = await publicClient.getCode({ address: AAVE_V3_POOL });
  deployedHere = (code?.length ?? 0) > 4;
  return deployedHere;
}

/** Plain words for a chain with no lending pool, used by every yield path that refuses for that reason. */
export function noLendingPoolHere(): string {
  return `There is no lending pool on ${chain.name}, so idle cash cannot be put to work here. Nothing moved.`;
}
