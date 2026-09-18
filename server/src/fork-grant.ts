/**
 * Grant a delegation on the fork, on behalf of a wallet whose key we do not have.
 *
 * On a real chain the USER signs this — that is the entire safety story and it is not negotiable.
 * On a fork we can impersonate the account, which is what makes the fork useful as a demo: the
 * same `grant` transaction, the same contract, the same enforcement, without needing the user's
 * embedded wallet to be present.
 *
 * Run: npx tsx server/src/fork-grant.ts <ownerAddress> [capUsd]
 */
import 'dotenv/config';
import { createPublicClient, createWalletClient, http, parseUnits, erc20Abi, type Address } from 'viem';
import { xLayer } from 'viem/chains';

const RPC = process.env.FORK_RPC ?? 'http://127.0.0.1:8545';
/** Circle's native USDC on X Layer — the settlement token. */
const USDC: Address = '0xB6CEceAB302E2E4948951eE7843FC24E92933061';

const chain = { ...xLayer, rpcUrls: { default: { http: [RPC] }, public: { http: [RPC] } } };
const pub = createPublicClient({ chain, transport: http(RPC) });

const ABI = [
  { type: 'function', name: 'grant', stateMutability: 'nonpayable',
    inputs: [{ name: 'delegate', type: 'address' }, { name: 'dailyCap', type: 'uint256' },
             { name: 'expiresAt', type: 'uint64' }, { name: 'venues', type: 'address[]' }], outputs: [] },
  { type: 'function', name: 'remainingToday', stateMutability: 'view',
    inputs: [{ name: 'owner', type: 'address' }], outputs: [{ type: 'uint256' }] },
] as const;

const rpc = (m: string, p: unknown[]) =>
  fetch(RPC, { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: m, params: p }) }).then((r) => r.json());

async function main() {
  // From the arguments, or the environment `npm run rebuild:fork` runs it in (PLAN.md 3.2).
  const owner = (process.argv[2] ?? process.env.OWNER_ADDRESS) as Address;
  const capUsd = Number(process.argv[3] ?? process.env.FORK_GRANT_CAP_USD ?? 100);
  const delegation = process.env.DELEGATION_ADDRESS as Address;
  const delegate = process.env.XORR_DELEGATE_ADDRESS as Address | undefined;
  if (!owner || !delegation) throw new Error('usage: fork-grant.ts <owner> [capUsd]; DELEGATION_ADDRESS must be set');

  const { delegatePublicKey } = await import('./evm/delegation.js');
  const { SETTLEMENT_VENUES, APPROVABLE_TOKENS } = await import('./evm/chains.js');
  const bot = delegate ?? (delegatePublicKey as Address);

  await rpc('anvil_impersonateAccount', [owner]);
  await rpc('anvil_setBalance', [owner, '0x8AC7230489E80000']);
  const w = createWalletClient({ account: owner, chain, transport: http(RPC) });

  const cap = parseUnits(String(capUsd), 6);
  /*
   * The venues come from the shared list, not a literal.
   *
   * A literal list once granted a single router, so a run reached the chain and died inside `spend()`
   * as VenueNotAllowed — for a permission the app's own grant screen says it asks for. One list,
   * read here and by `/delegation/params`, is what keeps the fork honest about what a real user
   * would have signed.
   *
   * The expiry is taken from the CHAIN's clock: the contract compares against `block.timestamp`,
   * and a fork's clock is wherever the last test left it.
   */
  const chainNow = (await pub.getBlock()).timestamp;
  const h1 = await w.writeContract({
    address: delegation, abi: ABI, functionName: 'grant',
    args: [bot, cap, chainNow + BigInt(7 * 86_400), [...SETTLEMENT_VENUES]],
  });
  await pub.waitForTransactionReceipt({ hash: h1 });

  const h2 = await w.writeContract({
    address: USDC, abi: erc20Abi, functionName: 'approve', args: [delegation, cap * 30n],
  });
  await pub.waitForTransactionReceipt({ hash: h2 });

  /*
   * Approve the assets a stop-loss might have to SELL, not just the USDC it spends.
   *
   * A stop that needs a fresh signature at the moment it fires is a stop that does not fire — the
   * user is asleep, which is the entire premise. So the approval has to exist before it is needed.
   * The blast radius is unchanged: the delegation can still only move funds to an allowlisted
   * venue and still cannot send anywhere it chooses.
   *
   * Every token on the list `/delegation/params` hands the app's grant, and every wrapped xStock: on a fork of X Layer
   * the wrappers are ordinary contracts with their real state, so a position bought in one can be sold out of it.
   * Approving one asset alone once left a bought position unsellable: the panic flatten's leg reverted with
   * SafeTransferFromFailed (2026-09-15).
   */
  const { STOCKS } = await import('./venues/stocks.js');
  const sellable = [...APPROVABLE_TOKENS.map((t) => t.address), ...Object.values(STOCKS).map((s) => s.address)];
  for (const address of sellable.filter((a) => a.toLowerCase() !== USDC.toLowerCase())) {
    const h = await w.writeContract({
      address, abi: erc20Abi, functionName: 'approve', args: [delegation, 2n ** 255n],
    });
    await pub.waitForTransactionReceipt({ hash: h });
  }
  await rpc('anvil_stopImpersonatingAccount', [owner]);

  const remaining = await pub.readContract({
    address: delegation, abi: ABI, functionName: 'remainingToday', args: [owner],
  });
  console.log(`granted on the fork`);
  console.log(`  owner     ${owner}`);
  console.log(`  delegate  ${bot}`);
  console.log(`  cap       $${capUsd}/day, ${Number(remaining) / 1e6} remaining today`);
  console.log(`  grant tx  ${h1}`);
}

await main();
