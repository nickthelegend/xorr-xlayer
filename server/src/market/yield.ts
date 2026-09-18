/**
 * Real supply yield, read on chain.
 *
 * The app shipped a "your SOL can earn ~12.6% staking" strip taken from the design handoff. That
 * number was never verified and, after the pivot to Base, staking SOL is not a thing this app can
 * do at all — the client called `/staking/yield`, which did not exist on the server, and rendered
 * "unavailable" forever.
 *
 * This replaces it with a number that is true and checkable: the current USDC supply rate on
 * Aave v3, read straight from the Pool contract. It is what the "stable yield" bucket in a draft
 * portfolio would actually earn, and anyone can verify it against app.aave.com.
 */
import { createPublicClient, http, type Address } from 'viem';
import { pastTheThrottle } from '../evm/throttle.js';
import { base } from 'viem/chains';
import { chain } from '../evm/chains.js';
import { publicClient } from '../evm/client.js';

/** Aave v3 Pool on Base. */
const AAVE_V3_POOL: Address = '0xA238Dd80C259a72e81d7e4664a9801593F98d1c5';

/**
 * USDC on Base MAINNET, written out rather than taken from ADDRESSES.
 *
 * ADDRESSES is chain-aware, and correctly so — but this module deliberately reads mainnet whatever
 * chain the executor trades. Pulling the Sepolia USDC address into a mainnet call asked Aave about
 * an asset it has never heard of, and Aave answers that with a zeroed reserve struct rather than a
 * revert. The result was a confident "0.00% a year", which is worse than an error.
 */
const USDC_BASE_MAINNET: Address = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';

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
 * Aave is only deployed on Base mainnet, so this reads mainnet even when the executor is trading a
 * testnet or a fork. The response says so; a rate presented as local when it is not would be the
 * same class of lie as the 12.6% it replaces.
 */
const client = createPublicClient({
  chain: base,
  transport: http(process.env.BASE_RPC ?? 'https://mainnet.base.org'),
});

export type SupplyYield = {
  symbol: string;
  /** Simple APR as a fraction, e.g. 0.043 for 4.3%. */
  estimatedApy: number;
  feed: 'live';
  source: string;
  note: string;
  /**
   * Whether the strategy this rate advertises can actually run on the chain the executor trades.
   *
   * The rate above is deliberately read from Base mainnet on every build — see the comment on
   * `USDC_BASE_MAINNET`, which explains that asking Sepolia produces a confident 0.00% instead of
   * an error. That is right for the NUMBER and wrong for everything the app then says around it:
   * the home screen offered "Idle USDC can earn about 4.07% a year on Aave" and /strategy/yield
   * would happily build a sweep, on a Sepolia build where `planYieldRotation` refuses every run
   * because there is no Aave pool at that address. The executor already performs exactly this
   * check before supplying; it just never told anyone.
   */
  availableHere: boolean;
};

/**
 * The live USDC reserve, as Aave reports it.
 *
 * Split out from the display rate because tier 4 needs more than a number: it needs to know the
 * reserve exists and which aToken the user will end up holding. Reading the aToken from the
 * reserve rather than hardcoding it means the strategy cannot quietly credit the wrong receipt
 * token if Aave ever migrates one.
 */
export type UsdcReserve = {
  /** Compounded APY as a fraction, e.g. 0.043 for 4.3%. */
  apy: number;
  /** The receipt token the supplier holds. */
  aToken: Address;
  asset: Address;
  pool: Address;
};

/**
 * The reserve, reused for a minute (PLAN.md 2.4).
 *
 * It is a read of the free public Base endpoint behind a throttle guard that backs off and retries,
 * and the balance, yield and tier-4 paths each asked for it again on every request — so every screen
 * paid the round trip, and any back-off the endpoint imposed. A lending rate a minute old is still the
 * rate. A read that failed is not kept, and `maxAgeMs = 0` asks now, for a caller whose job is to prove
 * the read works.
 */
const RESERVE_TTL_MS = 60_000;
let reserveCache: { at: number; value: Promise<UsdcReserve> } | undefined;

export function usdcReserve(maxAgeMs = RESERVE_TTL_MS): Promise<UsdcReserve> {
  if (reserveCache && Date.now() - reserveCache.at < maxAgeMs) return reserveCache.value;
  const entry = { at: Date.now(), value: readUsdcReserve() };
  reserveCache = entry;
  entry.value.catch(() => {
    if (reserveCache === entry) reserveCache = undefined;
  });
  return entry.value;
}

/** Testing only. */
export function clearReserveCache(): void {
  reserveCache = undefined;
}

async function readUsdcReserve(): Promise<UsdcReserve> {
  /*
   * Through the throttle guard, because this reads the FREE public Base endpoint.
   *
   * It answers a rate limit as a JSON-RPC error inside a 200 that viem does not retry, so a burst
   * of reads made this route report "no reserve" about a pool that is very much live — the same
   * wrong-number-that-looks-measured this file's docblock exists to prevent, arriving by a
   * different door.
   */
  const data = await pastTheThrottle(() =>
    client.readContract({
      address: AAVE_V3_POOL,
      abi: POOL_ABI,
      functionName: 'getReserveData',
      args: [USDC_BASE_MAINNET],
    }),
  );

  // currentLiquidityRate is an annualised per-second rate in ray. Aave's own UI compounds it per
  // second; the linear rate is the conservative of the two, so quote that.
  // Aave returns a zeroed struct for an asset it does not list, so a zero rate means "no reserve",
  // not "0% today". Treat it as missing data rather than quoting it.
  if (
    data.lastUpdateTimestamp === 0 ||
    data.aTokenAddress === '0x0000000000000000000000000000000000000000'
  ) {
    throw new Error(`Aave has no USDC reserve at ${AAVE_V3_POOL}`);
  }
  const rateRay = data.currentLiquidityRate;
  const apr = Number((rateRay * 1_000_000n) / RAY) / 1_000_000;

  // Compounded, the way app.aave.com displays it.
  const perSecond = apr / SECONDS_PER_YEAR;
  const apy = (1 + perSecond) ** SECONDS_PER_YEAR - 1;

  if (!Number.isFinite(apy) || apy <= 0 || apy > 1) {
    throw new Error(`Implausible Aave USDC rate: ${apy}`);
  }

  return { apy, aToken: data.aTokenAddress, asset: USDC_BASE_MAINNET, pool: AAVE_V3_POOL };
}

export async function usdcSupplyYield(): Promise<SupplyYield> {
  const reserve = await usdcReserve();
  const availableHere = await aavePoolIsDeployedHere();
  return {
    symbol: 'USDC',
    estimatedApy: reserve.apy,
    feed: 'live',
    source: `Aave v3 Pool ${AAVE_V3_POOL} on Base`,
    note: availableHere
      ? 'Supplying USDC to Aave v3 on Base. The rate floats; it is not a promise.'
      : `Aave v3 is not deployed on ${chain.name}, which is what this build trades, so nothing can be supplied here. This is Base mainnet's published rate, shown for reference.`,
    availableHere,
  };
}

/**
 * Is there actually an Aave pool on the chain the executor trades?
 *
 * The same `getCode` check `planYieldRotation` makes before it will supply anything, so the screen
 * and the planner cannot disagree about whether this strategy is runnable. Cached because it is a
 * property of the deployment, not of the moment — a pool does not appear mid-process.
 */
let deployedHere: boolean | undefined;
export async function aavePoolIsDeployedHere(): Promise<boolean> {
  if (deployedHere !== undefined) return deployedHere;
  // A read that fails throws and is not remembered. Caching it as "no pool" would have hidden a
  // fork's supplied USDC from its balance for the life of the process.
  const code = await publicClient.getCode({ address: AAVE_V3_POOL });
  deployedHere = (code?.length ?? 0) > 4;
  return deployedHere;
}
