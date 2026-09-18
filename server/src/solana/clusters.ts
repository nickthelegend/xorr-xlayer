/**
 * Cluster definitions and environment layering for xorr-solana (PLAN.md §0.2, §3.1, §8.1).
 *
 * Replaces EVM chain definitions for Solana deployments. Master switch: XORR_CHAIN
 * (e.g. 'solana-fork', 'solana-devnet', 'solana-localnet', 'solana-mainnet').
 *
 * Every environment is explicitly named. Unknown XORR_CHAIN values refuse boot immediately,
 * and mainnet additionally requires ALLOW_MAINNET=yes.
 */

export type SolanaClusterKey =
  | 'solana-localnet'
  | 'solana-devnet'
  | 'solana-fork'
  | 'solana-mainnet';

// Deliberately not exported: `money.ts` owns the exported `MoneyClass`, and naming it
// here as well would make the `export *` barrel in `index.ts` ambiguous (TS2308).
type MoneyClass = 'real' | 'test' | 'copy';

export interface ClusterConfig {
  key: SolanaClusterKey;
  name: string;
  money: MoneyClass;
  defaultRpc: string;
  usdcMint: string;
  wsolMint: string;
  decimals: {
    usdc: number;
    sol: number;
  };
  requiresAllowMainnet?: boolean;
}

export const SOLANA_MINTS = {
  // Mainnet / Fork USDC
  mainnetUsdc: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
  // Devnet USDC (Circle official)
  devnetUsdc: '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU',
  // Native Wrapped SOL
  wsol: 'So11111111111111111111111111111111111111112',
} as const;

/** Program and mint addresses the Solana layer addresses by name. */
export const DEFAULT_MINTS = {
  USDC: SOLANA_MINTS.mainnetUsdc,
  USDT: 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB',
  WSOL: SOLANA_MINTS.wsol,
  JUPITER_V6: 'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4',
  MEMO_V2: 'MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr',
  TOKEN_PROGRAM: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
  TOKEN_2022_PROGRAM: 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb',
  ASSOCIATED_TOKEN_PROGRAM: 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL',
} as const;

export const CLUSTERS: Record<SolanaClusterKey, ClusterConfig> = {
  'solana-localnet': {
    key: 'solana-localnet',
    name: 'Solana Localnet',
    money: 'copy',
    defaultRpc: 'http://127.0.0.1:8899',
    usdcMint: SOLANA_MINTS.mainnetUsdc,
    wsolMint: SOLANA_MINTS.wsol,
    decimals: { usdc: 6, sol: 9 },
  },
  'solana-devnet': {
    key: 'solana-devnet',
    name: 'Solana Devnet',
    money: 'test',
    defaultRpc: 'https://api.devnet.solana.com',
    usdcMint: SOLANA_MINTS.devnetUsdc,
    wsolMint: SOLANA_MINTS.wsol,
    decimals: { usdc: 6, sol: 9 },
  },
  'solana-fork': {
    key: 'solana-fork',
    name: 'Solana Mainnet Fork',
    money: 'copy',
    defaultRpc: 'http://127.0.0.1:8899',
    usdcMint: SOLANA_MINTS.mainnetUsdc,
    wsolMint: SOLANA_MINTS.wsol,
    decimals: { usdc: 6, sol: 9 },
  },
  'solana-mainnet': {
    key: 'solana-mainnet',
    name: 'Solana Mainnet',
    money: 'real',
    defaultRpc: 'https://api.mainnet-beta.solana.com',
    usdcMint: SOLANA_MINTS.mainnetUsdc,
    wsolMint: SOLANA_MINTS.wsol,
    decimals: { usdc: 6, sol: 9 },
    requiresAllowMainnet: true,
  },
};

export function isSolanaCluster(chain: string): chain is SolanaClusterKey {
  return Object.prototype.hasOwnProperty.call(CLUSTERS, chain);
}

/**
 * Validate that the specified cluster key is recognized. Throws if unknown.
 */
export function assertKnownCluster(key: string | undefined): asserts key is SolanaClusterKey {
  if (!key || !isSolanaCluster(key)) {
    throw new Error(
      `Unknown XORR_CHAIN '${key ?? ''}'. Must be one of: ${Object.keys(CLUSTERS).join(', ')}. Server refuses boot.`,
    );
  }
}

/**
 * Mainnet protection: refuses boot if mainnet is selected without ALLOW_MAINNET=yes.
 */
export function assertMainnetAllowed(key: SolanaClusterKey): void {
  if (CLUSTERS[key].requiresAllowMainnet && process.env.ALLOW_MAINNET !== 'yes') {
    throw new Error(
      `XORR_CHAIN=${key} is real-money mainnet. Boots require ALLOW_MAINNET=yes. Refusing boot.`,
    );
  }
}

/**
 * The selected cluster, falling back to the fork when XORR_CHAIN is unset or unrecognized.
 * Does not assert mainnet permission — `getClusterKey` does that.
 */
export function activeClusterKey(): SolanaClusterKey {
  const asked = process.env.XORR_CHAIN ?? process.env.EXPO_PUBLIC_XORR_CHAIN ?? 'solana-fork';
  return isSolanaCluster(asked) ? asked : 'solana-fork';
}

/**
 * The active cluster key, refusing real-money mainnet without ALLOW_MAINNET=yes.
 */
export function getClusterKey(): SolanaClusterKey {
  const key = activeClusterKey();
  assertMainnetAllowed(key);
  return key;
}

export const CLUSTER_KEY = getClusterKey();

/**
 * Where a cluster's RPC actually lives, once the environment has had its say.
 * `getClusterConfig` and `rpcUrl` share this so the two cannot drift apart.
 */
function resolveRpc(key: SolanaClusterKey): string {
  if (key === 'solana-fork') {
    return process.env.FORK_RPC ?? process.env.SOLANA_RPC_URL ?? CLUSTERS[key].defaultRpc;
  }
  return process.env.SOLANA_RPC_URL ?? CLUSTERS[key].defaultRpc;
}

export function getClusterConfig(key: SolanaClusterKey = activeClusterKey()): ClusterConfig {
  const config = CLUSTERS[key];
  if (!config) throw new Error(`Unknown Solana cluster: ${key}`);
  const rpc = resolveRpc(key);
  return rpc === config.defaultRpc ? config : { ...config, defaultRpc: rpc };
}

/**
 * Get active RPC URL for the current or specified cluster.
 */
export function rpcUrl(key: SolanaClusterKey = activeClusterKey()): string {
  return resolveRpc(key);
}
