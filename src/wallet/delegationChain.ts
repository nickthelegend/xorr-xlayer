/**
 * The permission as the chain holds it, and where a person's grant or stop may go (FEATURES.md #1, #24).
 *
 * Every user-signed delegation transaction took its destination from the executor: `/delegation/params` named the
 * contract a grant approves tokens to and the one a stop revokes. Two things followed from that. A server that named
 * another address would have had the wallet approve its tokens there. And a stop needed the server to answer, so with
 * the executor down the one control that must always work did not — against the claim, in the grant hook's own
 * header, that stopping takes effect without any server being reachable.
 *
 * So the destination is checked against the chain and against the build:
 *   - a grant goes only to a contract that has code, and that the build's pinned address agrees with;
 *   - a stop goes to the contract that holds this wallet's live policy, found by reading `policyOf` on each candidate,
 *     so a stale or wrong address is never "revoked" by a transaction that lands and does nothing;
 *   - and a stop is confirmed from the chain after it lands, not from a server's record of it.
 *
 * And where the executor cannot be asked at all, a screen reads the permission here itself (`standingOnChain`).
 */
import { isAddressEqual, type Address, type Hex, type PublicClient, type TransactionReceipt } from 'viem';
import { readAgain, receiptOf } from './receipt';

/** `XorrDelegation.policyOf` — the getter the contract exposes for exactly this. */
export const POLICY_ABI = [
  {
    type: 'function',
    name: 'policyOf',
    stateMutability: 'view',
    inputs: [{ name: 'owner', type: 'address' }],
    outputs: [
      { name: 'delegate', type: 'address' },
      { name: 'dailyCap', type: 'uint256' },
      { name: 'expiresAt', type: 'uint64' },
      { name: 'revoked', type: 'bool' },
    ],
  },
] as const;

/** The reads this needs, from the chain the build settles on (`chainAccess`). */
export type ChainReader = Pick<PublicClient, 'getCode' | 'readContract' | 'getTransactionReceipt'>;

export type OnChainPolicy = { delegate: Address; dailyCap: bigint; expiresAt: bigint; revoked: boolean };

const NO_ADDRESS = '0x0000000000000000000000000000000000000000';

/** How long a stop waits for its receipt before saying it could not confirm. The fork mines at once; X Layer in seconds. */
const RECEIPT_TIMEOUT_MS = 60_000;

const hasCode = (code: Hex | undefined) => Boolean(code && code !== '0x');

/**
 * A grant, and the approvals before it, may go only to a contract — and, when the build pins one, only to that one.
 * Throws before anything is signed.
 */
export async function assertGrantDestination(
  reader: Pick<ChainReader, 'getCode'>,
  named: Address,
  pinned: Address | undefined,
): Promise<void> {
  if (pinned && !isAddressEqual(named, pinned)) {
    throw new Error('The server named a different contract from the one this app trusts, so nothing was signed.');
  }
  if (!hasCode(await reader.getCode({ address: named }))) {
    throw new Error('There is no contract at the address the server named, so nothing was signed.');
  }
}

/** This wallet's policy on `contract`, or null where there is no contract or it never granted there. */
export async function readPolicy(
  reader: ChainReader,
  contract: Address,
  owner: Address,
  /** Read as of this block rather than the node's latest: after a transaction, the block it landed in. */
  blockNumber?: bigint,
): Promise<OnChainPolicy | null> {
  if (!hasCode(await reader.getCode({ address: contract, blockNumber }))) return null;
  const [delegate, dailyCap, expiresAt, revoked] = (await reader.readContract({
    address: contract,
    abi: POLICY_ABI,
    functionName: 'policyOf',
    args: [owner],
    blockNumber,
  })) as readonly [Address, bigint, bigint, boolean];
  if (isAddressEqual(delegate, NO_ADDRESS)) return null;
  return { delegate, dailyCap, expiresAt, revoked };
}

/**
 * This wallet's permission at one contract, as the chain holds it — for a screen whose executor did not answer
 * (FEATURES.md #1).
 *
 * Safety read the permission from the executor alone, so with the executor down it said "Couldn’t read your permission"
 * and hid the stop: the one control built to need no server, unreachable exactly when there was none. The chain can be
 * asked the same question directly.
 *
 * `live` is a policy the contract would spend under now — not revoked and, by the contract's own test
 * (`block.timestamp >= expiresAt` refuses), not expired. `none` is no contract to ask, no code there, or no grant there.
 * A read that fails is `unreadable` and never `none`: a permission nobody could look at is not an absent one.
 */
export type ChainStanding =
  | { kind: 'live' | 'revoked' | 'expired'; contract: Address; policy: OnChainPolicy }
  | { kind: 'none' }
  | { kind: 'unreadable' };

export async function standingOnChain(
  reader: ChainReader,
  owner: Address,
  contract: Address | undefined,
  now: number,
): Promise<ChainStanding> {
  if (!contract) return { kind: 'none' };
  let policy: OnChainPolicy | null;
  try {
    policy = await readPolicy(reader, contract, owner);
  } catch {
    return { kind: 'unreadable' };
  }
  if (!policy) return { kind: 'none' };
  // Revoked before expired, in the contract's own order: a stopped permission is stopped whatever its clock says.
  if (policy.revoked) return { kind: 'revoked', contract, policy };
  if (BigInt(Math.floor(now / 1000)) >= policy.expiresAt) return { kind: 'expired', contract, policy };
  return { kind: 'live', contract, policy };
}

/**
 * The contract a stop must go to: the first candidate holding a policy for `owner` that is not already revoked.
 *
 * Candidates are tried in order — the build's pinned contract before the executor's answer, so a stop never waits on
 * the server when the build already knows. One that cannot be read is passed over rather than trusted; if none can be
 * read at all, that is said, because "nothing to stop" would be a claim about a permission nobody looked at.
 */
export async function contractToStop(
  reader: ChainReader,
  owner: Address,
  candidates: readonly (Address | undefined)[],
): Promise<Address | undefined> {
  const seen = new Set<string>();
  let unreadable: unknown;
  let answered = false;
  for (const candidate of candidates) {
    if (!candidate || seen.has(candidate.toLowerCase())) continue;
    seen.add(candidate.toLowerCase());
    try {
      const policy = await readPolicy(reader, candidate, owner);
      answered = true;
      if (policy && !policy.revoked) return candidate;
    } catch (e) {
      unreadable = e;
    }
  }
  if (!answered && unreadable !== undefined) {
    throw new Error('The chain could not be read, so the stop was not sent. Try again in a moment.');
  }
  return undefined;
}

/** After a stop is sent: the chain says whether it took, or this throws. */
export async function confirmStopped(reader: ChainReader, contract: Address, owner: Address, txHash: Hex): Promise<void> {
  let receipt: TransactionReceipt;
  try {
    receipt = await receiptOf(reader, txHash, { timeoutMs: RECEIPT_TIMEOUT_MS });
  } catch {
    // Not "nothing was sent", which is what a timeout reads as elsewhere: this one was.
    throw new Error('The stop was sent, and the chain has not confirmed it yet. Check Safety again in a minute.');
  }
  if (receipt.status !== 'success') {
    throw new Error('The stop reverted on the chain, so the permission did not change.');
  }
  /*
   * As of the block the stop landed in, asked again while a node has not reached it (2026-09-26): read at "latest", a
   * node a block behind still holds the live policy, and this would have called a stop that landed a failure.
   */
  const policy = await readAgain(() => readPolicy(reader, contract, owner, receipt.blockNumber));
  if (!policy?.revoked) {
    throw new Error('The stop landed, but the chain does not show the permission revoked.');
  }
}
