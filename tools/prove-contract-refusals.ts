/**
 * docs/TESTPLAN.md C04, C05, C06, C07, C09 and C11 — the delegation and the audit anchor refuse what they must, as
 * deployed.
 *
 * On the chain an executor settles on, read at one block and asked with `eth_call`, so nothing is sent:
 *
 *   C07  a spend from anyone but the delegate reverts `NotDelegate`;
 *   C05  a spend by the delegate to a venue the owner did not allow reverts `VenueNotAllowed(venue)`;
 *   C04  a spend one unit over what is left of today's cap reverts `DailyCapExceeded(requested, remaining)`;
 *   C11  the latest anchor on the chain is the one `/audit/anchor` shows, the executor's trail agrees with it, and an
 *        anchor whose count goes backwards, or whose head is empty, reverts.
 *
 * With `PROOF_LOCAL_RPC`, an anvil forked from that chain, the owner's permission is ended there, never on the chain the
 * executor uses:
 *
 *   C06  after the owner's `revoke()` a spend reverts `PolicyRevoked` and nothing is left of today's cap; on a fresh copy
 *        a minute past the policy's expiry, `PolicyExpired`;
 *   C09  `closePosition()` reverts the same way, so a stop ends stop-losses too.
 *
 * The executor's reads are the owner's own, so they take the owner's Privy access token, which is never printed:
 *
 *   anvil --fork-url https://base-fork-production.up.railway.app --port 8563 --silent &
 *   PROOF_TOKEN=$(cd server && npx tsx --env-file=../.env src/e2e-token.ts <email> | tail -n 1) \
 *   PROOF_LOCAL_RPC=http://127.0.0.1:8563 server/node_modules/.bin/tsx tools/prove-contract-refusals.ts
 *
 * `PROOF_EXECUTOR` and `PROOF_RPC` default to the hosted fork; any EVM chain an executor runs on is pointed at the same
 * way. Refuses a local node that is not anvil, or that copies a different chain.
 */
import {
  BaseError,
  ContractFunctionRevertedError,
  createPublicClient,
  createTestClient,
  createWalletClient,
  defineChain,
  encodeFunctionData,
  getAddress,
  http,
  parseAbi,
  parseEther,
  type Address,
} from 'viem';

const EXECUTOR = (process.env.PROOF_EXECUTOR ?? 'https://executor-fork-production.up.railway.app').replace(/\/+$/, '');
const RPC = process.env.PROOF_RPC ?? 'https://base-fork-production.up.railway.app';
const LOCAL_RPC = process.env.PROOF_LOCAL_RPC;
const TOKEN = process.env.PROOF_TOKEN;

/** A venue nobody allows: nothing is deployed there. */
const CONTROL = getAddress('0x000000000000000000000000000000000000dEaD');

const DELEGATION = parseAbi([
  'function policyOf(address owner) view returns (address delegate, uint256 dailyCap, uint64 expiresAt, bool revoked)',
  'function remainingToday(address owner) view returns (uint256)',
  'function isVenueAllowed(address owner, address venue) view returns (bool)',
  'function spend(address owner, address token, address venue, uint256 amount, address tokenOut, uint256 minOut, bytes data) returns (bytes)',
  'function closePosition(address owner, address token, address venue, uint256 amount, address tokenOut, uint256 minOut, bytes data) returns (bytes)',
  'function revoke()',
  'error NotDelegate()',
  'error PolicyRevoked()',
  'error PolicyExpired()',
  'error VenueNotAllowed(address venue)',
  'error DailyCapExceeded(uint256 requested, uint256 remaining)',
  'error ZeroAmount()',
  'error VenueCallFailed()',
  'error InvalidTokenOut()',
  'error ZeroMinOut()',
  'error OutputNotReceived(uint256 received, uint256 minOut)',
  'error SettlementTokenNotClosable()',
]);

const ANCHOR = parseAbi([
  'struct Anchor { bytes32 head; uint64 entryCount; uint64 at; uint64 blockNo; }',
  'function latest(address anchorer, address subject) view returns (Anchor)',
  'function count(address anchorer, address subject) view returns (uint256)',
  'function anchor(address subject, bytes32 head, uint64 entryCount)',
  'error EmptyHead()',
  'error CountWentBackwards(uint64 previous, uint64 attempted)',
]);

type Health = { chain: string; version: string; delegation: string };
type Params = { delegate: string; token: string; venues: (string | { address: string })[]; tokens: { address: string }[] };
type AnchorRecord = { head: string; entryCount: number; blockNo: number };
type AnchorState = {
  configured: boolean;
  contract: string;
  anchoredBy: string;
  state: string;
  entryCount: number;
  latest: AnchorRecord | null;
};

let failures = 0;
const check = (ok: boolean, what: string, observed: string) => {
  if (!ok) failures++;
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${what}\n       ${observed}`);
};

type Refusal = { error: string; args: string[] };

/** What a call reverted with, by the contract's own error, or why there is no such answer. */
async function refusal(call: Promise<unknown>): Promise<Refusal | string> {
  try {
    await call;
    return 'no revert';
  } catch (e) {
    const reverted = e instanceof BaseError ? e.walk((x) => x instanceof ContractFunctionRevertedError) : null;
    if (reverted instanceof ContractFunctionRevertedError && reverted.data) {
      return { error: reverted.data.errorName, args: (reverted.data.args ?? []).map(String) };
    }
    return e instanceof BaseError ? e.shortMessage : String(e);
  }
}
const said = (r: Refusal | string) => (typeof r === 'string' ? r : `${r.error}(${r.args.join(', ')})`);
const is = (r: Refusal | string, error: string, ...args: string[]) =>
  typeof r !== 'string' && r.error === error && args.every((a, i) => r.args[i]?.toLowerCase() === a.toLowerCase());
const iso = (seconds: bigint) => new Date(Number(seconds) * 1000).toISOString();

async function executor<T>(path: string, signedIn = true): Promise<T> {
  const res = await fetch(`${EXECUTOR}${path}`, {
    headers: signedIn ? { authorization: `Bearer ${TOKEN}` } : {},
    signal: AbortSignal.timeout(45_000),
  });
  if (!res.ok) throw new Error(`${EXECUTOR}${path} answered ${res.status}`);
  return (await res.json()) as T;
}

async function main() {
  if (!TOKEN) {
    console.error("PROOF_TOKEN is not set: the executor's reads are the owner's own permission and trail.");
    process.exit(1);
  }
  const health = await executor<Health>('/health', false);
  const wallet = await executor<{ address: string } | null>('/wallet');
  if (!wallet) {
    console.error('The account behind PROOF_TOKEN has no wallet on this executor.');
    process.exit(1);
  }
  const params = await executor<Params>('/delegation/params');
  const anchors = await executor<AnchorState>('/audit/anchor');

  const owner = getAddress(wallet.address);
  const contract = getAddress(health.delegation);
  const token = getAddress(params.token);
  const venues = params.venues.map((v) => getAddress(typeof v === 'string' ? v : v.address));
  // Any output other than the token spent satisfies the named-output rule; the refusals below come before any transfer.
  const other = params.tokens.map((t) => getAddress(t.address)).find((a) => a !== token);
  if (!other) {
    console.error(`${EXECUTOR} names no token other than ${token} to trade into.`);
    process.exit(1);
  }

  const reader = createPublicClient({ transport: http(RPC, { timeout: 30_000 }) });
  const chainId = await reader.getChainId();
  const blockNumber = await reader.getBlockNumber();
  const block = await reader.getBlock({ blockNumber });
  console.log(`executor ${EXECUTOR}: ${health.chain} at ${health.version.slice(0, 7)}`);
  console.log(`chain ${chainId}, block ${blockNumber}\ncontract ${contract}\nowner    ${owner}\n`);

  const [delegate, dailyCap, expiresAt, revoked] = await reader.readContract({
    address: contract,
    abi: DELEGATION,
    functionName: 'policyOf',
    args: [owner],
    blockNumber,
  });
  if (revoked || block.timestamp >= expiresAt) {
    console.error(`The owner holds no live permission on ${contract}, so there is nothing for it to refuse. Grant one, then rerun.`);
    process.exit(1);
  }
  const remaining = await reader.readContract({
    address: contract,
    abi: DELEGATION,
    functionName: 'remainingToday',
    args: [owner],
    blockNumber,
  });
  const allowed = await Promise.all(
    [...venues, CONTROL].map((v) =>
      reader.readContract({ address: contract, abi: DELEGATION, functionName: 'isVenueAllowed', args: [owner, v], blockNumber }),
    ),
  );
  const venue = venues.find((_, i) => allowed[i]);
  const controlAllowed = allowed[venues.length];
  console.log(`live permission: cap ${dailyCap}, ${remaining} left today, expires ${iso(expiresAt)}, delegate ${delegate}\n`);

  const spendBy = (account: Address, to: Address, amount: bigint) =>
    refusal(
      reader.simulateContract({
        address: contract,
        abi: DELEGATION,
        functionName: 'spend',
        args: [owner, token, to, amount, other, 1n, '0x'],
        account,
        blockNumber,
      }),
    );

  console.log('the delegation, as deployed');
  check(getAddress(delegate) === getAddress(params.delegate), "the policy's delegate is the executor's", `${delegate}`);
  const notDelegate = await spendBy(CONTROL, venue ?? CONTROL, 1n);
  check(is(notDelegate, 'NotDelegate'), 'C07 a spend from an address that is not the delegate reverts', said(notDelegate));
  const notAllowed = await spendBy(delegate, CONTROL, 1n);
  check(
    controlAllowed === false && is(notAllowed, 'VenueNotAllowed', CONTROL),
    'C05 a spend by the delegate to a venue the owner did not allow reverts',
    said(notAllowed),
  );
  if (venue) {
    const over = remaining + 1n;
    const overCap = await spendBy(delegate, venue, over);
    check(
      is(overCap, 'DailyCapExceeded', String(over), String(remaining)),
      "C04 a spend by the delegate one unit over what is left of today's cap reverts",
      said(overCap),
    );
  } else {
    check(false, 'C04 a venue the owner allows, to spend over the cap at', `none of ${venues.join(', ')} is allowed`);
  }

  console.log('\nthe audit anchor');
  if (!anchors.configured) {
    check(false, 'C11 the executor anchors its trail', `configured ${anchors.configured}`);
  } else {
    const anchorContract = getAddress(anchors.contract);
    const anchorer = getAddress(anchors.anchoredBy);
    const onChain = await reader.readContract({
      address: anchorContract,
      abi: ANCHOR,
      functionName: 'latest',
      args: [anchorer, owner],
      blockNumber,
    });
    const count = await reader.readContract({
      address: anchorContract,
      abi: ANCHOR,
      functionName: 'count',
      args: [anchorer, owner],
      blockNumber,
    });
    const agrees = (a: AnchorRecord | null) =>
      a !== null &&
      a.head.toLowerCase() === onChain.head.toLowerCase() &&
      BigInt(a.entryCount) === onChain.entryCount &&
      BigInt(a.blockNo) === onChain.blockNo;
    // The chain is read after the executor, so an anchor that landed in between is asked about once more.
    const shown = agrees(anchors.latest) ? anchors : await executor<AnchorState>('/audit/anchor');
    check(
      agrees(shown.latest),
      'C11 the latest anchor on the chain is the one /audit/anchor shows',
      `head ${onChain.head} at entry ${onChain.entryCount}, block ${onChain.blockNo}; ${count} anchors`,
    );
    // `ahead` is given only when the executor's row at the anchored length still hashes to that head.
    check(
      ['match', 'ahead'].includes(shown.state) && onChain.entryCount <= BigInt(shown.entryCount),
      "C11 the executor's trail agrees with it",
      `${shown.state}, ${shown.entryCount} entries held`,
    );
    if (onChain.entryCount > 0n) {
      const backwards = await refusal(
        reader.simulateContract({
          address: anchorContract,
          abi: ANCHOR,
          functionName: 'anchor',
          args: [owner, onChain.head, onChain.entryCount - 1n],
          account: anchorer,
          blockNumber,
        }),
      );
      check(
        is(backwards, 'CountWentBackwards', String(onChain.entryCount), String(onChain.entryCount - 1n)),
        'C11 an anchor whose count goes backwards reverts',
        said(backwards),
      );
    }
    const empty = await refusal(
      reader.simulateContract({
        address: anchorContract,
        abi: ANCHOR,
        functionName: 'anchor',
        args: [owner, `0x${'00'.repeat(32)}`, onChain.entryCount],
        account: anchorer,
        blockNumber,
      }),
    );
    check(is(empty, 'EmptyHead'), 'C11 an anchor with an empty head reverts', said(empty));
  }

  if (LOCAL_RPC) {
    await localCopy(LOCAL_RPC, { chainId, contract, owner, delegate, token, other, venue: venue ?? CONTROL, expiresAt });
  } else {
    console.log('\nC06 and C09 not run: set PROOF_LOCAL_RPC to an anvil forked from this chain');
  }

  console.log(failures ? `\n${failures} check(s) FAILED` : '\nevery check passed');
  process.exit(failures ? 1 : 0);
}

async function localCopy(
  rpc: string,
  p: { chainId: number; contract: Address; owner: Address; delegate: Address; token: Address; other: Address; venue: Address; expiresAt: bigint },
) {
  const chain = defineChain({
    id: p.chainId,
    name: 'local copy',
    nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
    rpcUrls: { default: { http: [rpc] } },
  });
  const local = createPublicClient({ chain, transport: http(rpc, { timeout: 60_000 }) });
  const client = String(await local.request({ method: 'web3_clientVersion' }));
  if (!client.startsWith('anvil')) {
    console.error(`Refusing: ${rpc} answers as ${client}, not anvil.`);
    process.exit(1);
  }
  const test = createTestClient({ mode: 'anvil', chain, transport: http(rpc, { timeout: 60_000 }) });
  // A fresh copy of the chain as it is now, so nothing an earlier run did there is what gets measured.
  await test.reset({ jsonRpcUrl: RPC });
  if ((await local.getChainId()) !== p.chainId) {
    console.error(`Refusing: ${rpc} is not a copy of chain ${p.chainId}.`);
    process.exit(1);
  }
  const asDelegate = {
    spend: () =>
      refusal(
        local.simulateContract({
          address: p.contract,
          abi: DELEGATION,
          functionName: 'spend',
          args: [p.owner, p.token, p.venue, 1n, p.other, 1n, '0x'],
          account: p.delegate,
        }),
      ),
    close: () =>
      refusal(
        local.simulateContract({
          address: p.contract,
          abi: DELEGATION,
          functionName: 'closePosition',
          args: [p.owner, p.other, p.venue, 1n, p.token, 1n, '0x'],
          account: p.delegate,
        }),
      ),
  };

  console.log(`\non a local copy (${rpc}), the owner ends the permission`);
  await test.impersonateAccount({ address: p.owner });
  await test.setBalance({ address: p.owner, value: parseEther('1') });
  const owner = createWalletClient({ account: p.owner, chain, transport: http(rpc) });
  const hash = await owner.sendTransaction({
    to: p.contract,
    data: encodeFunctionData({ abi: DELEGATION, functionName: 'revoke' }),
  });
  const receipt = await local.waitForTransactionReceipt({ hash });
  const [, , , revoked] = await local.readContract({
    address: p.contract,
    abi: DELEGATION,
    functionName: 'policyOf',
    args: [p.owner],
  });
  check(receipt.status === 'success' && revoked, "C06 the owner's revoke() lands", `receipt ${receipt.status}, revoked ${revoked}`);
  await test.stopImpersonatingAccount({ address: p.owner });
  const spendRevoked = await asDelegate.spend();
  check(is(spendRevoked, 'PolicyRevoked'), 'C06 a spend by the delegate after the revoke reverts', said(spendRevoked));
  const left = await local.readContract({
    address: p.contract,
    abi: DELEGATION,
    functionName: 'remainingToday',
    args: [p.owner],
  });
  check(left === 0n, "C06 nothing is left of today's cap", `${left}`);
  const closeRevoked = await asDelegate.close();
  check(is(closeRevoked, 'PolicyRevoked'), 'C09 closing a position after the revoke reverts', said(closeRevoked));

  console.log(`\non a fresh local copy, a minute past the permission's expiry (${iso(p.expiresAt)})`);
  await test.reset({ jsonRpcUrl: RPC });
  const [, , , revokedOnCopy] = await local.readContract({
    address: p.contract,
    abi: DELEGATION,
    functionName: 'policyOf',
    args: [p.owner],
  });
  await test.setNextBlockTimestamp({ timestamp: p.expiresAt + 60n });
  await test.mine({ blocks: 1 });
  const spendExpired = await asDelegate.spend();
  check(
    !revokedOnCopy && is(spendExpired, 'PolicyExpired'),
    'C06 a spend by the delegate after the permission expires reverts, with nothing revoked',
    `${said(spendExpired)}; revoked ${revokedOnCopy}`,
  );
  const closeExpired = await asDelegate.close();
  check(is(closeExpired, 'PolicyExpired'), 'C09 closing a position after the permission expires reverts', said(closeExpired));
}

main().catch((e: unknown) => {
  console.error(e instanceof Error ? e.message : String(e));
  process.exit(1);
});
