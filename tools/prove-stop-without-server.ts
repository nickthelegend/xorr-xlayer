/**
 * FEATURES.md #1 and #24 — a stop that needs no server, and a grant that goes only where the build trusts, on a fork.
 *
 * `src/wallet/delegationChain.ts` decides where a person's grant and stop may go by reading the chain: a destination has
 * to have code, a grant's has to be the build's pinned contract, and a stop goes to the candidate holding this wallet's
 * live policy and is confirmed from the chain after it lands. This runs those functions against a local anvil forked
 * from the hosted fork — the real deployment's contract and a real owner's live permission — and never touches the
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
 *   anvil --fork-url https://base-fork-production.up.railway.app --port 8562 --silent &
 *   PROOF_RPC=http://127.0.0.1:8562 server/node_modules/.bin/tsx tools/prove-stop-without-server.ts
 *
 * Refuses any node that is not anvil.
 */
import { createPublicClient, createTestClient, createWalletClient, encodeFunctionData, getAddress, http, type Hex } from 'viem';
import { base } from 'viem/chains';
import { assertGrantDestination, confirmStopped, contractToStop, readPolicy } from '../src/wallet/delegationChain';

const RPC = process.env.PROOF_RPC ?? 'http://127.0.0.1:8562';
/** Only to learn which contract the hosted fork runs; the decisions below never ask it anything. */
const EXECUTOR = process.env.PROOF_EXECUTOR ?? 'https://executor-fork-production.up.railway.app';
/** The owner whose live permission is stopped — on the local copy of the fork, never on the hosted one. */
const OWNER = getAddress(process.env.PROOF_OWNER ?? '0x95A0b368588713011a15f4b1041423f31B08e615');
/** An address with nothing deployed on it, standing in for a stale pin. */
const STALE = getAddress(process.env.PROOF_STALE ?? '0x000000000000000000000000000000000000dEaD');

const REVOKE_ABI = [{ type: 'function', name: 'revoke', stateMutability: 'nonpayable', inputs: [], outputs: [] }] as const;

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

const chain = { ...base, rpcUrls: { default: { http: [RPC] }, public: { http: [RPC] } } };
const reader = createPublicClient({ chain, transport: http(RPC) });

async function main() {
  const client = String(await reader.request({ method: 'web3_clientVersion' }));
  if (!client.startsWith('anvil')) {
    console.error(`Refusing: ${RPC} answers as ${client}, not anvil.`);
    process.exit(1);
  }
  const health = (await fetch(`${EXECUTOR}/health`).then((r) => r.json())) as { delegation?: string };
  if (!health.delegation) {
    console.error(`${EXECUTOR} does not report a delegation contract.`);
    process.exit(1);
  }
  const CONTRACT = getAddress(health.delegation);
  console.log(`anvil ${RPC}, forked from the hosted fork\ncontract ${CONTRACT}\nowner    ${OWNER}\n`);

  const before = await readPolicy(reader, CONTRACT, OWNER);
  if (!before || before.revoked) {
    console.error(`The owner holds no live permission on ${CONTRACT}, so there is no stop to prove. Grant one, then rerun.`);
    process.exit(1);
  }
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

  const test = createTestClient({ mode: 'anvil', chain, transport: http(RPC) });
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
