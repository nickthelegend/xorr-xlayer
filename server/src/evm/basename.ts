/**
 * Basenames — Base's own naming, resolved on Base.
 *
 * Every screen that shows a wallet shows `0x95A0…e615`, which is unreadable and, worse, unverifiable
 * at a glance: two addresses that differ in the middle look identical when truncated. A Basename is
 * the Base-native fix, and resolving it is a read of a Base contract — the same class of thing this
 * app already does everywhere else.
 *
 * Reverse resolution is ENS-shaped but NOT ENS: the node is namehashed under `.<coinType>.reverse`
 * with Base's coin type rather than under `.addr.reverse`, and it answers from Base's own L2
 * resolver, not from Ethereum mainnet. Using viem's `getEnsName` here would silently ask the wrong
 * chain and return null for every name that exists.
 */
import { namehash, type Address } from 'viem';
import { publicClient } from './client.js';
import { IS_BASE_MAINNET_STATE } from './chains.js';

/** Base's L2 resolver. Basenames are a Base mainnet deployment; there is none on Sepolia. */
export const L2_RESOLVER: Address = '0xC6d566A56A1aFf6508b41f6c90ff131615583BCD';

/**
 * Base's reverse namespace.
 *
 * ENS reverse records live under `.addr.reverse`; Base's live under the hex of its chain-scoped
 * coin type, `0x80002105` — which is 2147492101, Base's coin type under ENSIP-11. Getting this
 * wrong does not error, it just resolves nothing, which is why it is written out rather than
 * inlined.
 */
const BASE_REVERSE_SUFFIX = '80002105.reverse';

const RESOLVER_ABI = [
  {
    type: 'function',
    name: 'name',
    stateMutability: 'view',
    inputs: [{ name: 'node', type: 'bytes32' }],
    outputs: [{ type: 'string' }],
  },
  {
    type: 'function',
    name: 'addr',
    stateMutability: 'view',
    inputs: [{ name: 'node', type: 'bytes32' }],
    outputs: [{ type: 'address' }],
  },
] as const;

/**
 * A name only changes when someone sets one, so this is cached for the process lifetime — but
 * `null` is cached too, and deliberately: most addresses have no Basename, and re-asking the chain
 * on every render of every screen for an answer that is almost always "no" is a lot of RPC for
 * nothing.
 */
const cache = new Map<string, string | null>();

/** The Basename for an address, or null. Never throws — a missing name is not an error. */
export async function basenameOf(address: Address): Promise<string | null> {
  const key = address.toLowerCase();
  const hit = cache.get(key);
  if (hit !== undefined) return hit;

  // Basenames exist on Base mainnet (and therefore on a fork of it). Anywhere else the resolver
  // has no code and the call would revert, so answer honestly instead of pretending.
  if (!IS_BASE_MAINNET_STATE) {
    cache.set(key, null);
    return null;
  }

  try {
    const node = namehash(`${key.slice(2)}.${BASE_REVERSE_SUFFIX}`);
    const name = await publicClient.readContract({
      address: L2_RESOLVER,
      abi: RESOLVER_ABI,
      functionName: 'name',
      args: [node],
    });
    const result = name && name.length > 0 ? name : null;
    cache.set(key, result);
    return result;
  } catch {
    // A resolver that is unreachable or has no record is the same outcome for the caller: no name.
    cache.set(key, null);
    return null;
  }
}

/** Forward resolution, so a user can send to `someone.base.eth` instead of pasting 42 characters. */
export async function addressOfBasename(name: string): Promise<Address | null> {
  if (!IS_BASE_MAINNET_STATE) return null;
  try {
    const addr = await publicClient.readContract({
      address: L2_RESOLVER,
      abi: RESOLVER_ABI,
      functionName: 'addr',
      args: [namehash(name)],
    });
    return addr && addr !== '0x0000000000000000000000000000000000000000' ? addr : null;
  } catch {
    return null;
  }
}

/** Testing only. */
export function clearBasenameCache(): void {
  cache.clear();
}
