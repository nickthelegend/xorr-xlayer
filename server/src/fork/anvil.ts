/**
 * Talking to an anvil fork of X Layer: its RPC methods, and setting a token balance (2026-09-19).
 *
 * The Base build funded fork wallets by impersonating Aave's USDC reserve — a whale that happened to exist there. On a
 * fork of X Layer there is no such well-known holder, and taking USDC out of a Uniswap pool would move the very prices the
 * demo trades against. So a fork-only reserve address is given a USDC balance by writing the token's storage directly —
 * the technique Foundry's `deal` uses — and every transfer out of it is an ordinary, hash-bearing ERC-20 transfer.
 *
 * The balance slot is found by probing, not assumed: for each candidate mapping slot the value is written, `balanceOf` is
 * read back, and the write is undone unless it is the one that moved the balance. A token whose balance lives nowhere a
 * mapping can reach is refused, saying so.
 */
import { createPublicClient, encodeAbiParameters, erc20Abi, http, keccak256, pad, toHex, type Address, type Hex } from 'viem';

/** One JSON-RPC call to the node, throwing its own error message on a refusal. */
export async function anvil(rpc: string, method: string, params: unknown[]): Promise<unknown> {
  const res = await fetch(rpc, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    signal: AbortSignal.timeout(30_000),
  });
  const body = (await res.json()) as { result?: unknown; error?: { message?: string } };
  if (body.error) throw new Error(`${method}: ${body.error.message ?? 'refused'}`);
  return body.result;
}

/**
 * The fork-only reserve that fork faucets and bootstraps send USDC from: an address no key controls, derived from a fixed
 * phrase so every fork of every deployment agrees on it. Impersonated only on anvil; on a real chain it holds nothing.
 */
export const FORK_USDC_RESERVE: Address = `0x${keccak256(toHex('xorr fork usdc reserve')).slice(-40)}` as Address;

const MAX_PROBED_SLOT = 40;

function mappingSlot(holder: Address, slot: bigint): Hex {
  return keccak256(encodeAbiParameters([{ type: 'address' }, { type: 'uint256' }], [holder, slot]));
}

/** Set `holder`'s balance of `token` to exactly `amount` on the fork at `rpc`. Throws where no slot moves the balance. */
export async function dealErc20(params: { rpc: string; token: Address; holder: Address; amount: bigint }): Promise<void> {
  const { rpc, token, holder, amount } = params;
  const client = createPublicClient({ transport: http(rpc, { retryCount: 0 }) });
  const balance = () => client.readContract({ address: token, abi: erc20Abi, functionName: 'balanceOf', args: [holder] });
  const value = pad(toHex(amount), { size: 32 });
  for (let s = 0n; s <= BigInt(MAX_PROBED_SLOT); s++) {
    const key = mappingSlot(holder, s);
    const before = (await anvil(rpc, 'eth_getStorageAt', [token, key, 'latest'])) as Hex;
    await anvil(rpc, 'anvil_setStorageAt', [token, key, value]);
    if ((await balance()) === amount) return;
    await anvil(rpc, 'anvil_setStorageAt', [token, key, pad(before, { size: 32 })]);
  }
  throw new Error(`No balance slot of ${token} within the first ${MAX_PROBED_SLOT + 1} moved ${holder}'s balance`);
}

/** Raise `holder`'s native balance (OKB on X Layer) to at least `floorWei`; never lowers it. */
export async function topUpNative(rpc: string, holder: Address, floorWei: bigint): Promise<bigint> {
  const client = createPublicClient({ transport: http(rpc, { retryCount: 0 }) });
  const before = await client.getBalance({ address: holder });
  if (before >= floorWei) return 0n;
  await anvil(rpc, 'anvil_setBalance', [holder, toHex(floorWei)]);
  return floorWei - before;
}
