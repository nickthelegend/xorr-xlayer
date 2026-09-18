/**
 * FEATURES.md #1 and #24 — a stop that needs no server, and a grant that goes only where the build trusts, on a fork.
 *
 * `src/wallet/delegationChain.ts` decides where a person's grant and stop may go by reading the chain: a destination has
 * to have code, a grant's has to be the build's pinned contract, and a stop goes to the candidate holding this wallet's
 * live policy and is confirmed from the chain after it lands. This runs those functions against a local anvil forked
 * from the hosted X Layer fork — the real deployment's contract, and the owner's live permission — and never touches the
 * hosted fork itself:
 *
 *   1. a grant to another contract, or to an address with no code, is refused before anything could be signed;
 *   2. a stale pinned address is passed over and the stop is found on the contract holding the live policy, and the
 *      functions that decide it take a chain reader and nothing else — no executor is asked;
 *   3. a mined transaction that revoked nothing is not taken for a stop;
 *   4. the owner's revoke is confirmed from the chain, and afterwards there is nothing left to stop.
 *
 * The owner's transactions are sent by impersonation. Signing them with a Privy wallet is what
 * `tools/prove-user-signing.ts` proves; this proves where they go and how a stop is known to have happened.
 *
 * The contract is `PROOF_DELEGATION` when set, else the one the executor reports (`PROOF_EXECUTOR`), else the hosted
 * X Layer fork's deployment. Where the owner holds no live permission there — no grant has been signed on the X Layer
 * fork yet — the owner grants one on the LOCAL copy by impersonation first (`PROOF_GRANT=no` refuses instead), so there
 * is a stop to prove; the hosted fork is still never sent anything.
 *
 *   anvil --fork-url https://xlayer-fork-production.up.railway.app --port 8562 --silent &
 *   PROOF_RPC=http://127.0.0.1:8562 server/node_modules/.bin/tsx tools/prove-stop-without-server.ts
 *
 * Refuses any node that is not anvil, or that is not a copy of X Layer.
 */
import {
  createPublicClient,
  createTestClient,
  createWalletClient,
  encodeFunctionData,
  getAddress,
  http,
  keccak256,
  parseEther,
  toHex,
  type Address,
  type Hex,
} from 'viem';
import { xLayer, xLayerTestnet } from 'viem/chains';
import { assertGrantDestination, confirmStopped, contractToStop, readPolicy } from '../src/wallet/delegationChain';

const RPC = process.env.PROOF_RPC ?? 'http://127.0.0.1:8562';
/** Only to learn which contract the hosted fork runs; the decisions below never ask it anything. */
const EXECUTOR = (process.env.PROOF_EXECUTOR ?? 'https://executor-fork-production-2db8.up.railway.app').replace(/\/+$/, '');
/** The hosted X Layer fork's delegation, used when neither PROOF_DELEGATION nor the executor names one. */
const HOSTED_DELEGATION = '0xf50a4ec95c07e497095ddad99a006cf44ceb7819';
/** X Layer mainnet's settlement venues (server/src/evm/chains.ts SETTLEMENT_VENUES), for a grant made on the local copy. */
const XLAYER_VENUES: Address[] = [
  '0x4f0C28f5926AFDA16bf2506D5D9e57Ea190f9bcA',
  '0x7c5bee2a8091c3ef39072f64f18fac913060aeaf',
  '0x8b773D83bc66Be128c60e07E17C8901f7a64F000',
  '0xE3F3Caefdd7180F884c01E57f65Df979Af84f116',
];
/** A synthetic delegate for that grant: derived from a fixed phrase, controlled by no key, only ever named on anvil. */
const SYNTHETIC_DELEGATE = getAddress(`0x${keccak256(toHex('xorr proof delegate')).slice(-40)}`);
/** The owner whose live permission is stopped — on the local copy of the fork, never on the hosted one. */
const OWNER = getAddress(process.env.PROOF_OWNER ?? '0x95A0b368588713011a15f4b1041423f31B08e615');
/** An address with nothing deployed on it, standing in for a stale pin. */
const STALE = getAddress(process.env.PROOF_STALE ?? '0x000000000000000000000000000000000000dEaD');

const REVOKE_ABI = [{ type: 'function', name: 'revoke', stateMutability: 'nonpayable', inputs: [], outputs: [] }] as const;
const GRANT_ABI = [
  {
    type: 'function',
    name: 'grant',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'delegate', type: 'address' },
      { name: 'dailyCap', type: 'uint256' },
      { name: 'expiresAt', type: 'uint64' },
      { name: 'venues', type: 'address[]' },
    ],
    outputs: [],
  },
] as const;

let failures = 0;
const check = (ok: boolean, what: string) => {
  if (!ok) failures++;
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${what}`);
};
const rejectsWith = (p: Promise<unknown>, pattern: RegExp) =>
  p.then(
    () => false,
    (e: unknown) => pattern.test(e instanceof Error ? e.message : String(e)),
  );

/** Which X Layer the copy is of, read from the node before any client is built for it. */
async function chainOf(rpc: string) {
  const id = await createPublicClient({ transport: http(rpc) }).getChainId();
  const known = [xLayer, xLayerTestnet].find((c) => c.id === id);
  if (!known) {
    console.error(`Refusing: ${rpc} is chain ${id}, not a copy of X Layer (196) or its testnet (1952).`);
    process.exit(1);
  }
  // A fork of X Layer IS X Layer: same id and contracts, only the node differs (src/chain.ts withRpc).
  return { ...known, rpcUrls: { default: { http: [rpc] }, public: { http: [rpc] } } };
}

/** The contract to prove against: named, reported by the executor, or the hosted fork's deployment. */
async function delegationContract(): Promise<{ address: Address; from: string }> {
  if (process.env.PROOF_DELEGATION) return { address: getAddress(process.env.PROOF_DELEGATION), from: 'PROOF_DELEGATION' };
  const health = (await fetch(`${EXECUTOR}/health`, { signal: AbortSignal.timeout(15_000) })
    .then((r) => (r.ok ? r.json() : null))
    .catch(() => null)) as { delegation?: string } | null;
  if (health?.delegation) return { address: getAddress(health.delegation), from: EXECUTOR };
  return { address: getAddress(HOSTED_DELEGATION), from: `the hosted X Layer fork's deployment (${EXECUTOR} did not answer)` };
}

async function main() {
  const probe = createPublicClient({ transport: http(RPC) });
  const client = String(await probe.request({ method: 'web3_clientVersion' }));
  if (!client.startsWith('anvil')) {
    console.error(`Refusing: ${RPC} answers as ${client}, not anvil.`);
    process.exit(1);
  }
  const chain = await chainOf(RPC);
  const reader = createPublicClient({ chain, transport: http(RPC) });
  const test = createTestClient({ mode: 'anvil', chain, transport: http(RPC) });
  const { address: CONTRACT, from } = await delegationContract();
  console.log(`anvil ${RPC}, a copy of ${chain.name} (${chain.id})\ncontract ${CONTRACT} (from ${from})\nowner    ${OWNER}\n`);

  let before = await readPolicy(reader, CONTRACT, OWNER);
  const live = async (p: typeof before) => p !== null && !p.revoked && p.expiresAt > (await reader.getBlock()).timestamp;
  if (!(await live(before))) {
    if (process.env.PROOF_GRANT === 'no') {
      console.error(`The owner holds no live permission on ${CONTRACT}, so there is no stop to prove. Grant one, then rerun.`);
      process.exit(1);
    }
    // On this local copy only: the owner signs a day's permission to a synthetic delegate, by impersonation.
    await test.impersonateAccount({ address: OWNER });
    await test.setBalance({ address: OWNER, value: parseEther('1') });
    const granting = createWalletClient({ account: OWNER, chain, transport: http(RPC) });
    const now = (await reader.getBlock()).timestamp;
    const grant = await granting.sendTransaction({
      to: CONTRACT,
      data: encodeFunctionData({ abi: GRANT_ABI, functionName: 'grant', args: [SYNTHETIC_DELEGATE, 100_000_000n, now + 86_400n, chain.id === xLayer.id ? XLAYER_VENUES : []] }),
    });
    const landed = await reader.waitForTransactionReceipt({ hash: grant });
    await test.stopImpersonatingAccount({ address: OWNER });
    before = await readPolicy(reader, CONTRACT, OWNER);
    if (landed.status !== 'success' || !(await live(before))) {
      console.error(`The owner held no live permission, and the grant on the local copy did not make one: ${grant}`);
      process.exit(1);
    }
    console.log(`no live permission on the copy, so the owner granted one there by impersonation: ${grant}\n`);
  }
  if (!before) throw new Error('unreachable: a live permission was just read');
  console.log(`live permission: cap ${before.dailyCap} (6dp), expires ${new Date(Number(before.expiresAt) * 1000).toISOString()}\n`);

  console.log('1. a grant goes only where the build trusts');
  check(
    await rejectsWith(assertGrantDestination(reader, CONTRACT, STALE), /different contract/),
    'refused: the server names the live contract and the build pins another',
  );
  check(
    await rejectsWith(assertGrantDestination(reader, OWNER, OWNER), /no contract/),
    'refused: an address with no contract, even when it is the pin',
  );
  check(
    await assertGrantDestination(reader, CONTRACT, CONTRACT).then(
      () => true,
      () => false,
    ),
    'allowed: the pinned contract, which has code on the chain',
  );

  console.log('\n2. a stop finds the live permission on the chain');
  check(
    (await contractToStop(reader, OWNER, [STALE, CONTRACT])) === CONTRACT,
    'a stale pin with nothing on it is passed over; the stop goes to the contract holding the policy',
  );
  check(
    (await contractToStop(reader, OWNER, [CONTRACT, undefined])) === CONTRACT,
    'with the pin right, the executor is never needed',
  );

  await test.impersonateAccount({ address: OWNER });
  const owner = createWalletClient({ account: OWNER, chain, transport: http(RPC) });

  console.log('\n3. a transaction that revoked nothing is not a stop');
  const noop: Hex = await owner.sendTransaction({ to: OWNER, value: 0n });
  check(
    await rejectsWith(confirmStopped(reader, CONTRACT, OWNER, noop), /does not show/),
    'refused: mined, and the policy is still live',
  );

  console.log('\n4. the owner stops it, and the chain says so');
  const stop: Hex = await owner.sendTransaction({
    to: CONTRACT,
    data: encodeFunctionData({ abi: REVOKE_ABI, functionName: 'revoke' }),
  });
  check(
    await confirmStopped(reader, CONTRACT, OWNER, stop).then(
      () => true,
      (e: unknown) => {
        console.log(`       ${e instanceof Error ? e.message : String(e)}`);
        return false;
      },
    ),
    `confirmed from the chain: ${stop}`,
  );
  check((await readPolicy(reader, CONTRACT, OWNER))?.revoked === true, 'policyOf(owner) reads revoked');
  check((await contractToStop(reader, OWNER, [CONTRACT])) === undefined, 'afterwards there is nothing left to stop');
  await test.stopImpersonatingAccount({ address: OWNER });

  console.log(failures ? `\n${failures} check(s) FAILED` : '\nevery check passed');
  process.exit(failures ? 1 : 0);
}

main().catch((e: unknown) => {
  console.error(e instanceof Error ? e.message : String(e));
  process.exit(1);
});
