/**
 * Solana Connection client and explorer formatting (PLAN.md §0.2, §8.1).
 */
import { Connection, type Commitment } from '@solana/web3.js';
import {
  activeClusterKey,
  assertKnownCluster,
  assertMainnetAllowed,
  getClusterConfig,
  rpcUrl,
  type SolanaClusterKey,
} from './clusters.js';

/*
 * Enforce cluster validity on module import: a `solana-*` chain this layer does not know
 * refuses boot here rather than silently trading on the wrong chain.
 *
 * An EVM chain is not an error — `evm/chains.ts` makes the mirror-image call, treating a Solana
 * cluster as "EVM inactive". Asserting unconditionally here refused boot on every EVM chain,
 * which is a hybrid repo's whole point.
 */
const ASKED = process.env.XORR_CHAIN ?? 'solana-fork';
if (ASKED.startsWith('solana-')) {
  assertKnownCluster(ASKED);
}
assertMainnetAllowed(activeClusterKey());

const DEFAULT_COMMITMENT: Commitment = 'confirmed';

export function createConnection(
  customRpc?: string,
  commitment: Commitment = DEFAULT_COMMITMENT,
): Connection {
  return new Connection(customRpc ?? rpcUrl(), {
    commitment,
    confirmTransactionInitialTimeout: 30_000,
  });
}

/**
 * Singleton connection for the active cluster.
 */
export const connection: Connection = createConnection();

let cachedConnection: Connection | undefined;
let cachedRpc: string | undefined;

/**
 * The shared connection for a cluster, or for an explicit RPC URL. Cached per endpoint.
 */
export function getConnection(target?: string | SolanaClusterKey): Connection {
  const cluster =
    typeof target === 'string' && target.startsWith('solana-')
      ? (target as SolanaClusterKey)
      : activeClusterKey();
  const config = getClusterConfig(cluster);

  if (config.money === 'real' && process.env.ALLOW_MAINNET !== 'yes') {
    throw new Error('Solana mainnet requires ALLOW_MAINNET=yes to operate with real funds.');
  }

  const endpoint =
    typeof target === 'string' && !target.startsWith('solana-') ? target : rpcUrl(cluster);

  if (cachedConnection && cachedRpc === endpoint) {
    return cachedConnection;
  }

  cachedConnection = new Connection(endpoint, {
    commitment: DEFAULT_COMMITMENT,
    confirmTransactionInitialTimeout: 30_000,
  });
  cachedRpc = endpoint;
  return cachedConnection;
}

export function explorerTx(signature: string, cluster: SolanaClusterKey = activeClusterKey()): string {
  const config = getClusterConfig(cluster);
  if (config.key === 'solana-mainnet') {
    return `https://explorer.solana.com/tx/${signature}`;
  }
  if (config.key === 'solana-devnet') {
    return `https://explorer.solana.com/tx/${signature}?cluster=devnet`;
  }
  // Fork or localnet: use custom RPC parameter
  const rpc = encodeURIComponent(config.defaultRpc);
  return `https://explorer.solana.com/tx/${signature}?cluster=custom&customUrl=${rpc}`;
}

export function explorerAddress(address: string, cluster: SolanaClusterKey = activeClusterKey()): string {
  const config = getClusterConfig(cluster);
  if (config.key === 'solana-mainnet') {
    return `https://explorer.solana.com/address/${address}`;
  }
  if (config.key === 'solana-devnet') {
    return `https://explorer.solana.com/address/${address}?cluster=devnet`;
  }
  const rpc = encodeURIComponent(config.defaultRpc);
  return `https://explorer.solana.com/address/${address}?cluster=custom&customUrl=${rpc}`;
}

/**
 * Wait for transaction confirmation with slot details.
 */
export async function waitForTx(
  sig: string,
  conn: Connection = connection,
  commitment: Commitment = 'confirmed',
): Promise<{ signature: string; slot: number; err: unknown | null }> {
  const latest = await conn.getLatestBlockhash(commitment);
  const res = await conn.confirmTransaction(
    {
      signature: sig,
      blockhash: latest.blockhash,
      lastValidBlockHeight: latest.lastValidBlockHeight,
    },
    commitment,
  );
  const status = await conn.getSignatureStatus(sig, { searchTransactionHistory: true });
  return {
    signature: sig,
    slot: status.value?.slot ?? 0,
    err: res.value.err,
  };
}
