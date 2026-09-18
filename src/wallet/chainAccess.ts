/**
 * The chain this build settles on, read directly (PLAN.md 4.1).
 *
 * The wallet's own provider answers through Privy's RPC for its chain id, and on a fork build that id is real Base's. So
 * what a person's signature commits to — the nonce, the gas, the fees — and the broadcast of the signed transaction come
 * from this client, pointed at the RPC the build names, and never from the wallet.
 */
import { createPublicClient, http, type Address } from 'viem';
import { activeChain } from '@/chain';
import { LATEST_ANCHOR_ABI, anchorFromChain, type OnChainAnchor } from '@/audit/anchorCheck';

export const chainAccess = createPublicClient({
  chain: activeChain,
  transport: http(activeChain.rpcUrls.default.http[0]),
});

/**
 * The newest anchor `anchorer` has published about `subject`, read from the contract (FEATURES.md #12).
 *
 * The anchor screen had only the executor's word for this: `/audit/anchor` reads the same function and relays what it
 * found. Read here, the executor is trusted to name the contract and its key — which the screen prints in full — and for
 * nothing about what they hold. `null` is "never anchored", which the contract answers with a zero head.
 */
export async function readLatestAnchor(
  contract: Address,
  anchorer: Address,
  subject: Address,
): Promise<OnChainAnchor | null> {
  const latest = await chainAccess.readContract({
    address: contract,
    abi: LATEST_ANCHOR_ABI,
    functionName: 'latest',
    args: [anchorer, subject],
  });
  return anchorFromChain(latest);
}
