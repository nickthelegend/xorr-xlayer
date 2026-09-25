/**
 * The permission on a PUBLIC chain: X Layer testnet (1952), against the deployed, source-verified contract
 * (`contracts/deployments/xlayer-testnet.json`). Every step is a real transaction anyone can open on OKLink.
 *
 * The testnet has no DEX, so nothing fills here — fills are proven on the fork (`prove-xlayer.ts`). What this proves is
 * the part that has to hold on a real network: the owner grants, the chain says exactly what was granted, the
 * contract refuses the bot outside it, and one owner signature ends it.
 *
 *   1. a fresh owner key (funded with a little test OKB by the deployer) approves testnet USDC and grants the
 *      executor's delegate $100/day for 7 days, venue list empty — the testnet has no venue;
 *   2. `policyOf` reads back exactly that;
 *   3. the DELEGATE's `spend` to a venue the owner never allowed is refused by the contract (`eth_call`, nothing sent);
 *   4. the owner revokes, and `policyOf` says revoked.
 *
 * `PROVE_KEEP=1` stops after step 3 and LEAVES the permission standing, which is the only way this public chain has
 * something live to read: every other run revokes at the end, so `/verify?owner=…` on the testnet deployment skipped
 * "the permission is read from the chain" for want of any wallet that held one (2026-09-20). Run it once that way and
 * put the owner address in the submission, so a judge can check the claim against a chain with an explorer. The
 * permission expires on its own in seven days, which is the point of having an expiry.
 *
 * Run: cd server && set -a && . ./.env.deployer && set +a && npx tsx src/prove-testnet.ts
 * Reads the testnet delegate's address from the deployed executor's `/delegation/params` (or TESTNET_DELEGATE).
 */
import {
  BaseError,
  ContractFunctionRevertedError,
  createPublicClient,
  createWalletClient,
  erc20Abi,
  getAddress,
  http,
  maxUint256,
  parseEther,
  parseUnits,
  type Address,
  type Hex,
} from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { xLayerTestnet } from 'viem/chains';

const RPC = process.env.XLAYER_TESTNET_RPC ?? 'https://testrpc.xlayer.tech';
const EXECUTOR = process.env.TESTNET_EXECUTOR ?? 'https://executor-testnet-production.up.railway.app';
const DELEGATION: Address = '0x0b8363E351588c4De2c5CeD667b7a2ef53F9E6B2';
const USDC: Address = '0xDec90b78111Ba2fc6FC6d84d8B9ec159A2d4b9B3';
const EXPLORER = 'https://www.oklink.com/xlayer-test/tx/';

const ABI = [
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
  { type: 'function', name: 'revoke', stateMutability: 'nonpayable', inputs: [], outputs: [] },
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
  {
    type: 'function',
    name: 'spend',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'owner', type: 'address' },
      { name: 'token', type: 'address' },
      { name: 'venue', type: 'address' },
      { name: 'amount', type: 'uint256' },
      { name: 'tokenOut', type: 'address' },
      { name: 'minOut', type: 'uint256' },
      { name: 'data', type: 'bytes' },
    ],
    outputs: [{ name: 'result', type: 'bytes' }],
  },
  { type: 'error', name: 'VenueNotAllowed', inputs: [{ name: 'venue', type: 'address' }] },
  { type: 'error', name: 'NotDelegate', inputs: [] },
  { type: 'error', name: 'PolicyRevoked', inputs: [] },
] as const;

const pub = createPublicClient({ chain: xLayerTestnet, transport: http(RPC) });
let failures = 0;
const check = (ok: boolean, what: string, detail = '') => {
  if (!ok) failures += 1;
  console.log(`${ok ? '  ✓' : '  ✗'} ${what}${detail ? `  — ${detail}` : ''}`);
};

/** X Layer testnet's RPC can answer a read from before a transaction it has already receipted; wait until it has caught up. */
async function settled<T>(read: () => Promise<T>, done: (v: T) => boolean): Promise<T> {
  let v = await read();
  for (let i = 0; i < 15 && !done(v); i += 1) {
    await new Promise((r) => setTimeout(r, 2_000));
    v = await read();
  }
  return v;
}

async function revertName(call: () => Promise<unknown>): Promise<string> {
  try {
    await call();
    return 'did not revert';
  } catch (e) {
    const r = e instanceof BaseError ? e.walk((x) => x instanceof ContractFunctionRevertedError) : null;
    return r instanceof ContractFunctionRevertedError ? (r.data?.errorName ?? 'reverted') : String(e).slice(0, 120);
  }
}

async function main() {
  if ((await pub.getChainId()) !== 1952) throw new Error(`${RPC} is not X Layer testnet.`);
  const funder = process.env.DEPLOYER_PRIVATE_KEY as Hex | undefined;
  if (!funder) throw new Error('Load server/.env.deployer first: the deployer pays the owner its gas.');

  const params = await fetch(`${EXECUTOR}/delegation/params`).then((r) => (r.ok ? r.json() : null)).catch(() => null);
  const delegate = getAddress(
    process.env.TESTNET_DELEGATE ??
      (params as { delegate?: string } | null)?.delegate ??
      '0x19033937953479E8F7b0237eB48ee87Be1D1c8ae',
  );

  const owner = privateKeyToAccount(generatePrivateKey());
  const ownerWallet = createWalletClient({ account: owner, chain: xLayerTestnet, transport: http(RPC) });
  const funderWallet = createWalletClient({ account: privateKeyToAccount(funder), chain: xLayerTestnet, transport: http(RPC) });
  console.log(`\nX Layer testnet — delegation ${DELEGATION}\n  owner    ${owner.address} (fresh)\n  delegate ${delegate}\n`);

  const send = async (label: string, hash: Hex) => {
    const r = await pub.waitForTransactionReceipt({ hash });
    check(r.status === 'success', label, `${EXPLORER}${hash}`);
    return r;
  };

  await send('deployer sends the owner 0.005 test OKB for gas', await funderWallet.sendTransaction({ to: owner.address, value: parseEther('0.005') }));
  await settled(() => pub.getBalance({ address: owner.address }), (b) => b > 0n);

  await send(
    'owner approves testnet USDC to the delegation',
    await ownerWallet.writeContract({ address: USDC, abi: erc20Abi, functionName: 'approve', args: [DELEGATION, maxUint256] }),
  );
  const expiresAt = BigInt(Math.floor(Date.now() / 1000) + 7 * 86_400);
  await send(
    'owner grants the delegate $100/day for 7 days (no venue: the testnet has no DEX)',
    await ownerWallet.writeContract({
      address: DELEGATION,
      abi: ABI,
      functionName: 'grant',
      args: [delegate, parseUnits('100', 6), expiresAt, []],
    }),
  );

  const policy = await settled(
    () => pub.readContract({ address: DELEGATION, abi: ABI, functionName: 'policyOf', args: [owner.address] }),
    (p) => p[0] !== '0x0000000000000000000000000000000000000000',
  );
  check(
    getAddress(policy[0]) === delegate && policy[1] === parseUnits('100', 6) && policy[2] === expiresAt && !policy[3],
    'the chain holds exactly that permission',
    `delegate ${policy[0]}, cap ${Number(policy[1]) / 1e6} USDC/day, expires ${new Date(Number(policy[2]) * 1000).toISOString()}`,
  );

  const venue: Address = '0x000000000000000000000000000000000000dEaD';
  const refused = await revertName(() =>
    pub.simulateContract({
      account: delegate,
      address: DELEGATION,
      abi: ABI,
      functionName: 'spend',
      args: [owner.address, USDC, venue, parseUnits('10', 6), USDC, 1n, '0x'],
    }),
  );
  check(refused === 'VenueNotAllowed', 'the delegate is refused a venue the owner never allowed', refused);

  const stranger = await revertName(() =>
    pub.simulateContract({
      account: owner.address,
      address: DELEGATION,
      abi: ABI,
      functionName: 'spend',
      args: [owner.address, USDC, venue, parseUnits('10', 6), USDC, 1n, '0x'],
    }),
  );
  check(stranger === 'NotDelegate', 'anyone but the delegate is refused outright', stranger);

  if (process.env.PROVE_KEEP === '1') {
    console.log(
      [
        '',
        '  PROVE_KEEP=1 — the permission is left STANDING, and revoke is not proven on this run.',
        `  owner   ${owner.address}`,
        `  verify  ${(process.env.TESTNET_EXECUTOR ?? 'https://executor-testnet-production.up.railway.app').replace(/\/+$/, '')}/verify?owner=${owner.address}`,
        '  It expires on its own; nothing holds funds, and the owner key was never written down.',
        '',
      ].join('\n'),
    );
    console.log(failures === 0 ? 'ALL CHECKS PASSED\n' : `${failures} CHECK(S) FAILED\n`);
    process.exit(failures === 0 ? 0 : 1);
  }

  await send('owner revokes — one signature, no server', await ownerWallet.writeContract({ address: DELEGATION, abi: ABI, functionName: 'revoke' }));
  const after = await settled(
    () => pub.readContract({ address: DELEGATION, abi: ABI, functionName: 'policyOf', args: [owner.address] }),
    (p) => p[3],
  );
  check(after[3], 'the chain says revoked');
  const afterRevoke = await revertName(() =>
    pub.simulateContract({
      account: delegate,
      address: DELEGATION,
      abi: ABI,
      functionName: 'spend',
      args: [owner.address, USDC, venue, parseUnits('10', 6), USDC, 1n, '0x'],
    }),
  );
  check(afterRevoke === 'PolicyRevoked', 'and the delegate is refused from then on', afterRevoke);

  console.log(failures === 0 ? '\nALL CHECKS PASSED\n' : `\n${failures} CHECK(S) FAILED\n`);
  process.exit(failures === 0 ? 0 : 1);
}

await main();
