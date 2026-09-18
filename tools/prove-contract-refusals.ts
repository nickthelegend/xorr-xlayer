/**
 * docs/TESTPLAN.md C04, C05, C06, C07, C09 and C11 — the delegation and the audit anchor refuse what they must, as
 * deployed on X Layer.
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
 * Two ways to run it.
 *
 * With the executor (`PROOF_TOKEN` set): the executor's reads are the owner's own, so they take the owner's Privy access
 * token, which is never printed. The contract, the owner, the delegate, the venues and the anchor all come from it, and
 * C11 compares its trail with the chain:
 *
 *   anvil --fork-url https://xlayer-fork-production.up.railway.app --port 8563 --silent &
 *   PROOF_TOKEN=$(cd server && npx tsx --env-file=../.env src/e2e-token.ts <email> | tail -n 1) \
 *   PROOF_LOCAL_RPC=http://127.0.0.1:8563 server/node_modules/.bin/tsx tools/prove-contract-refusals.ts
 *
 * From the chain alone (no `PROOF_TOKEN` — the executor is not asked anything): the contract is `PROOF_DELEGATION`, the
 * anchor `PROOF_ANCHOR` (both default to the hosted X Layer fork's deployment), the owner `PROOF_OWNER`, and the venues
 * are X Layer's settlement venues (server/src/evm/chains.ts SETTLEMENT_VENUES). The contract's own settlement token is
 * checked against X Layer's USDC. Where the owner holds no live permission on the chain, C05 and C04 need one: with
 * `PROOF_LOCAL_RPC` the owner grants one on the local copy by impersonation (to `PROOF_DELEGATE`, a synthetic delegate),
 * so every check still runs without anything sent to the chain under test; without it only what needs no permission runs.
 *
 *   server/node_modules/.bin/tsx tools/prove-contract-refusals.ts                      # read-only, the hosted fork
 *   PROOF_LOCAL_RPC=http://127.0.0.1:8563 server/node_modules/.bin/tsx tools/prove-contract-refusals.ts
 *
 * `PROOF_EXECUTOR` and `PROOF_RPC` default to the hosted X Layer fork; any EVM chain an executor runs on is pointed at
 * the same way. Refuses a local node that is not anvil, or that copies a different chain.
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
  keccak256,
  parseAbi,
  parseEther,
  toHex,
  type Address,
  type PublicClient,
} from 'viem';

const EXECUTOR = (process.env.PROOF_EXECUTOR ?? 'https://executor-fork-production-2db8.up.railway.app').replace(/\/+$/, '');
const RPC = process.env.PROOF_RPC ?? 'https://xlayer-fork-production.up.railway.app';
const LOCAL_RPC = process.env.PROOF_LOCAL_RPC;
const TOKEN = process.env.PROOF_TOKEN;

/** The hosted X Layer fork's deployment — the chain-only defaults. */
const HOSTED_DELEGATION = '0xf50a4ec95c07e497095ddad99a006cf44ceb7819';
const HOSTED_ANCHOR = '0x9d22e2b3e1d31a6973b6395cbb6d369ef8b6cf12';

/** Circle's native USDC on X Layer (server/src/evm/chains.ts): mainnet and its fork, and the testnet. */
const XLAYER_USDC: Record<number, Address> = {
  196: '0xB6CEceAB302E2E4948951eE7843FC24E92933061',
  1952: '0xDec90b78111Ba2fc6FC6d84d8B9ec159A2d4b9B3',
};
/** Tether's USD₮0 on X Layer mainnet: any output other than the token spent satisfies the named-output rule. */
const XLAYER_USDT0: Address = '0x779Ded0c9e1022225f8E0630b35a9b54bE713736';
/**
 * X Layer mainnet's settlement venues (server/src/evm/chains.ts SETTLEMENT_VENUES): Uniswap v3 SwapRouter02, the OKX DEX
 * router and its approval contract, and Aave v3's Pool. The testnet has none of them.
 */
const XLAYER_VENUES: Address[] = [
  '0x4f0C28f5926AFDA16bf2506D5D9e57Ea190f9bcA',
  '0x7c5bee2a8091c3ef39072f64f18fac913060aeaf',
  '0x8b773D83bc66Be128c60e07E17C8901f7a64F000',
  '0xE3F3Caefdd7180F884c01E57f65Df979Af84f116',
];

/** A venue nobody allows: nothing is deployed there. */
const CONTROL = getAddress('0x000000000000000000000000000000000000dEaD');

/**
 * The delegate a chain-only run grants to on its local copy. Derived from a fixed phrase so every run agrees on it; no key
 * controls it, and it is only ever impersonated on anvil.
 */
const SYNTHETIC_DELEGATE = getAddress(`0x${keccak256(toHex('xorr proof delegate')).slice(-40)}`);

const DELEGATION = parseAbi([
  'function SETTLEMENT_TOKEN() view returns (address)',
  'function policyOf(address owner) view returns (address delegate, uint256 dailyCap, uint64 expiresAt, bool revoked)',
  'function remainingToday(address owner) view returns (uint256)',
  'function isVenueAllowed(address owner, address venue) view returns (bool)',
  'function spend(address owner, address token, address venue, uint256 amount, address tokenOut, uint256 minOut, bytes data) returns (bytes)',
  'function closePosition(address owner, address token, address venue, uint256 amount, address tokenOut, uint256 minOut, bytes data) returns (bytes)',
  'function grant(address delegate, uint256 dailyCap, uint64 expiresAt, address[] venues)',
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

/** What the checks are run against: from the executor, or from the chain and the environment alone. */
type Subject = {
  source: string;
  contract: Address;
  owner: Address;
  token: Address;
  other: Address;
  venues: Address[];
  /** The executor's delegate, where there is an executor to name it. */
  expectedDelegate?: Address;
  /** `/audit/anchor` as the executor shows it, or just the anchor contract and, when known, who anchors. */
  anchors: { contract: Address; anchoredBy?: Address; shown?: AnchorState } | null;
};

let failures = 0;
const check = (ok: boolean, what: string, observed: string) => {
  if (!ok) failures++;
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${what}\n       ${observed}`);
};
const skipped = (what: string, why: string) => console.log(`  --   ${what}\n       not run: ${why}`);

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

/** Everything from the executor: the owner's wallet, the parameters the grant was built from, and the anchor it shows. */
async function fromExecutor(): Promise<Subject> {
  const health = await executor<Health>('/health', false);
  const wallet = await executor<{ address: string } | null>('/wallet');
  if (!wallet) {
    console.error('The account behind PROOF_TOKEN has no wallet on this executor.');
    process.exit(1);
  }
  const params = await executor<Params>('/delegation/params');
  const anchors = await executor<AnchorState>('/audit/anchor');
  const token = getAddress(params.token);
  // Any output other than the token spent satisfies the named-output rule; the refusals below come before any transfer.
  const other = params.tokens.map((t) => getAddress(t.address)).find((a) => a !== token);
  if (!other) {
    console.error(`${EXECUTOR} names no token other than ${token} to trade into.`);
    process.exit(1);
  }
  console.log(`executor ${EXECUTOR}: ${health.chain} at ${health.version.slice(0, 7)}`);
  return {
    source: 'the executor',
    contract: getAddress(health.delegation),
    owner: getAddress(wallet.address),
    token,
    other,
    venues: params.venues.map((v) => getAddress(typeof v === 'string' ? v : v.address)),
    expectedDelegate: getAddress(params.delegate),
    anchors: anchors.configured
      ? { contract: getAddress(anchors.contract), anchoredBy: getAddress(anchors.anchoredBy), shown: anchors }
      : null,
  };
}

/** Everything from the chain and the environment: no executor is asked. */
async function fromChain(reader: PublicClient, chainId: number): Promise<Subject> {
  const contract = getAddress(process.env.PROOF_DELEGATION ?? HOSTED_DELEGATION);
  const anchor = getAddress(process.env.PROOF_ANCHOR ?? HOSTED_ANCHOR);
  const owner = getAddress(process.env.PROOF_OWNER ?? '0x95A0b368588713011a15f4b1041423f31B08e615');
  const code = await reader.getCode({ address: contract });
  if (!code || code === '0x') {
    console.error(`There is no contract at ${contract} on ${RPC}.`);
    process.exit(1);
  }
  const token = getAddress(await reader.readContract({ address: contract, abi: DELEGATION, functionName: 'SETTLEMENT_TOKEN' }));
  console.log(`no PROOF_TOKEN: reading the chain alone — ${EXECUTOR} is not asked anything`);
  console.log('\nthe deployment');
  const usdc = XLAYER_USDC[chainId];
  check(
    usdc !== undefined && token === getAddress(usdc),
    "the delegation settles in X Layer's USDC",
    `SETTLEMENT_TOKEN() = ${token} on chain ${chainId}${usdc ? `; X Layer USDC is ${usdc}` : ' — not an X Layer chain id'}`,
  );
  const anchorCode = await reader.getCode({ address: anchor });
  check(Boolean(anchorCode && anchorCode !== '0x'), 'the audit anchor is deployed', `${anchor}: ${anchorCode ? (anchorCode.length - 2) / 2 : 0} bytes`);
  return {
    source: 'the chain',
    contract,
    owner,
    token,
    other: XLAYER_USDT0,
    venues: chainId === 196 ? XLAYER_VENUES.map((v) => getAddress(v)) : [],
    anchors: anchorCode && anchorCode !== '0x' ? { contract: anchor, anchoredBy: process.env.PROOF_ANCHORER ? getAddress(process.env.PROOF_ANCHORER) : undefined } : null,
  };
}

function xlayerCopy(id: number, rpc: string) {
  return defineChain({
    id,
    name: 'X Layer (local copy)',
    nativeCurrency: { name: 'OKB', symbol: 'OKB', decimals: 18 },
    rpcUrls: { default: { http: [rpc] } },
  });
}

/** An anvil at `rpc`, reset to a fresh copy of the chain under test, refusing anything else. */
async function freshCopy(rpc: string, chainId: number) {
  const chain = xlayerCopy(chainId, rpc);
  const local = createPublicClient({ chain, transport: http(rpc, { timeout: 60_000 }) });
  const client = String(await local.request({ method: 'web3_clientVersion' }));
  if (!client.startsWith('anvil')) {
    console.error(`Refusing: ${rpc} answers as ${client}, not anvil.`);
    process.exit(1);
  }
  const test = createTestClient({ mode: 'anvil', chain, transport: http(rpc, { timeout: 60_000 }) });
  // A fresh copy of the chain as it is now, so nothing an earlier run did there is what gets measured.
  await test.reset({ jsonRpcUrl: RPC });
  if ((await local.getChainId()) !== chainId) {
    console.error(`Refusing: ${rpc} is not a copy of chain ${chainId}.`);
    process.exit(1);
  }
  return { chain, local, test };
}

/**
 * On a local copy only: the owner grants the synthetic delegate a day's permission over every venue, by impersonation.
 * This is what lets a chain-only run prove C04/C05 for an owner who holds no permission on the chain under test.
 */
async function grantOnCopy(rpc: string, chainId: number, s: Subject, delegate: Address): Promise<void> {
  const chain = xlayerCopy(chainId, rpc);
  const local = createPublicClient({ chain, transport: http(rpc, { timeout: 60_000 }) });
  const test = createTestClient({ mode: 'anvil', chain, transport: http(rpc, { timeout: 60_000 }) });
  const now = (await local.getBlock()).timestamp;
  await test.impersonateAccount({ address: s.owner });
  await test.setBalance({ address: s.owner, value: parseEther('1') });
  const owner = createWalletClient({ account: s.owner, chain, transport: http(rpc) });
  const hash = await owner.sendTransaction({
    to: s.contract,
    data: encodeFunctionData({
      abi: DELEGATION,
      functionName: 'grant',
      args: [delegate, 100_000_000n, now + 86_400n, s.venues],
    }),
  });
  const receipt = await local.waitForTransactionReceipt({ hash });
  await test.stopImpersonatingAccount({ address: s.owner });
  if (receipt.status !== 'success') {
    console.error(`The grant on the local copy did not land: ${hash}`);
    process.exit(1);
  }
}

async function main() {
  const rpcReader = createPublicClient({ transport: http(RPC, { timeout: 30_000 }) });
  const chainId = await rpcReader.getChainId();
  const s = TOKEN ? await fromExecutor() : await fromChain(rpcReader, chainId);

  // Where the owner holds no permission on the chain under test, a chain-only run with a local copy grants one THERE.
  let reader: PublicClient = rpcReader;
  let grantedOnCopy: Address | undefined;
  const onChain = await rpcReader.readContract({ address: s.contract, abi: DELEGATION, functionName: 'policyOf', args: [s.owner] });
  const liveOnChain = !onChain[3] && (await rpcReader.getBlock()).timestamp < onChain[2];
  if (!liveOnChain && !TOKEN && LOCAL_RPC && s.venues.length > 0) {
    grantedOnCopy = getAddress(process.env.PROOF_DELEGATE ?? SYNTHETIC_DELEGATE);
    const { local } = await freshCopy(LOCAL_RPC, chainId);
    await grantOnCopy(LOCAL_RPC, chainId, s, grantedOnCopy);
    reader = local as PublicClient;
    console.log(
      `\n${s.owner} holds no live permission on ${RPC}; on the local copy ${LOCAL_RPC} it granted ${grantedOnCopy} ` +
        `a day's $100 cap over ${s.venues.length} venues, by impersonation — nothing was sent to ${RPC}`,
    );
  }

  const blockNumber = await reader.getBlockNumber();
  const block = await reader.getBlock({ blockNumber });
  console.log(`\nchain ${chainId}, block ${blockNumber}\ncontract ${s.contract}\nowner    ${s.owner}\n`);

  const [delegate, dailyCap, expiresAt, revoked] = await reader.readContract({
    address: s.contract,
    abi: DELEGATION,
    functionName: 'policyOf',
    args: [s.owner],
    blockNumber,
  });
  const live = !revoked && block.timestamp < expiresAt;
  if (!live && TOKEN) {
    console.error(`The owner holds no live permission on ${s.contract}, so there is nothing for it to refuse. Grant one, then rerun.`);
    process.exit(1);
  }
  const remaining = await reader.readContract({
    address: s.contract,
    abi: DELEGATION,
    functionName: 'remainingToday',
    args: [s.owner],
    blockNumber,
  });
  const allowed = await Promise.all(
    [...s.venues, CONTROL].map((v) =>
      reader.readContract({ address: s.contract, abi: DELEGATION, functionName: 'isVenueAllowed', args: [s.owner, v], blockNumber }),
    ),
  );
  const venue = s.venues.find((_, i) => allowed[i]);
  const controlAllowed = allowed[s.venues.length];
  console.log(
    live
      ? `live permission: cap ${dailyCap}, ${remaining} left today, expires ${iso(expiresAt)}, delegate ${delegate}\n`
      : `no live permission for this owner (delegate ${delegate}, revoked ${revoked}, expires ${iso(expiresAt)})\n`,
  );

  const spendBy = (account: Address, to: Address, amount: bigint) =>
    refusal(
      reader.simulateContract({
        address: s.contract,
        abi: DELEGATION,
        functionName: 'spend',
        args: [s.owner, s.token, to, amount, s.other, 1n, '0x'],
        account,
        blockNumber,
      }),
    );

  console.log('the delegation, as deployed');
  if (s.expectedDelegate) check(getAddress(delegate) === s.expectedDelegate, "the policy's delegate is the executor's", `${delegate}`);
  // With no permission the policy's delegate is the zero address, and any real caller is still not it.
  const notDelegate = await spendBy(CONTROL, venue ?? CONTROL, 1n);
  check(is(notDelegate, 'NotDelegate'), 'C07 a spend from an address that is not the delegate reverts', said(notDelegate));
  if (live) {
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
      check(false, 'C04 a venue the owner allows, to spend over the cap at', `none of ${s.venues.join(', ') || '(no venues)'} is allowed`);
    }
  } else {
    const why = `${s.owner} holds no live permission here${LOCAL_RPC ? '' : ' — set PROOF_LOCAL_RPC to grant one on a local copy'}`;
    skipped('C05 a spend by the delegate to a venue the owner did not allow reverts', why);
    skipped("C04 a spend by the delegate one unit over what is left of today's cap reverts", why);
  }

  console.log('\nthe audit anchor');
  if (!s.anchors) {
    if (TOKEN) check(false, 'C11 the executor anchors its trail', 'configured false');
    else skipped('C11 the audit anchor refuses what it must', 'no anchor contract with code');
  } else {
    const anchorContract = s.anchors.contract;
    // Who anchors matters for the series read; an empty head is refused whoever sends it.
    const anchorer = s.anchors.anchoredBy ?? CONTROL;
    const latest = await reader.readContract({
      address: anchorContract,
      abi: ANCHOR,
      functionName: 'latest',
      args: [anchorer, s.owner],
      blockNumber,
    });
    const count = await reader.readContract({
      address: anchorContract,
      abi: ANCHOR,
      functionName: 'count',
      args: [anchorer, s.owner],
      blockNumber,
    });
    if (s.anchors.shown) {
      const agrees = (a: AnchorRecord | null) =>
        a !== null &&
        a.head.toLowerCase() === latest.head.toLowerCase() &&
        BigInt(a.entryCount) === latest.entryCount &&
        BigInt(a.blockNo) === latest.blockNo;
      // The chain is read after the executor, so an anchor that landed in between is asked about once more.
      const shown = agrees(s.anchors.shown.latest) ? s.anchors.shown : await executor<AnchorState>('/audit/anchor');
      check(
        agrees(shown.latest),
        'C11 the latest anchor on the chain is the one /audit/anchor shows',
        `head ${latest.head} at entry ${latest.entryCount}, block ${latest.blockNo}; ${count} anchors`,
      );
      // `ahead` is given only when the executor's row at the anchored length still hashes to that head.
      check(
        ['match', 'ahead'].includes(shown.state) && latest.entryCount <= BigInt(shown.entryCount),
        "C11 the executor's trail agrees with it",
        `${shown.state}, ${shown.entryCount} entries held`,
      );
    } else {
      console.log(`  ${count} anchor(s) by ${anchorer} about ${s.owner} on the chain${s.anchors.anchoredBy ? '' : ' (PROOF_ANCHORER not set)'}`);
    }
    if (latest.entryCount > 0n) {
      const backwards = await refusal(
        reader.simulateContract({
          address: anchorContract,
          abi: ANCHOR,
          functionName: 'anchor',
          args: [s.owner, latest.head, latest.entryCount - 1n],
          account: anchorer,
          blockNumber,
        }),
      );
      check(
        is(backwards, 'CountWentBackwards', String(latest.entryCount), String(latest.entryCount - 1n)),
        'C11 an anchor whose count goes backwards reverts',
        said(backwards),
      );
    } else {
      skipped('C11 an anchor whose count goes backwards reverts', `no anchor by ${anchorer} about ${s.owner} to go back from`);
    }
    const empty = await refusal(
      reader.simulateContract({
        address: anchorContract,
        abi: ANCHOR,
        functionName: 'anchor',
        args: [s.owner, `0x${'00'.repeat(32)}`, latest.entryCount],
        account: anchorer,
        blockNumber,
      }),
    );
    check(is(empty, 'EmptyHead'), 'C11 an anchor with an empty head reverts', said(empty));
  }

  if (LOCAL_RPC && (live || grantedOnCopy)) {
    await localCopy(LOCAL_RPC, {
      chainId,
      contract: s.contract,
      owner: s.owner,
      delegate: getAddress(delegate),
      token: s.token,
      other: s.other,
      venue: venue ?? CONTROL,
      expiresAt,
      regrant: grantedOnCopy ? (rpc: string) => grantOnCopy(rpc, chainId, s, grantedOnCopy!) : undefined,
    });
  } else if (!LOCAL_RPC) {
    console.log('\nC06 and C09 not run: set PROOF_LOCAL_RPC to an anvil forked from this chain');
  } else {
    console.log('\nC06 and C09 not run: there is no permission to end, on the chain or on a local copy');
  }

  console.log(failures ? `\n${failures} check(s) FAILED` : '\nevery check that ran passed');
  process.exit(failures ? 1 : 0);
}

async function localCopy(
  rpc: string,
  p: {
    chainId: number;
    contract: Address;
    owner: Address;
    delegate: Address;
    token: Address;
    other: Address;
    venue: Address;
    expiresAt: bigint;
    /** A chain-only run's grant, made again after every reset — it exists only on the local copy. */
    regrant?: (rpc: string) => Promise<void>;
  },
) {
  const { chain, local, test } = await freshCopy(rpc, p.chainId);
  if (p.regrant) await p.regrant(rpc);
  const [, , expiresAt] = await local.readContract({ address: p.contract, abi: DELEGATION, functionName: 'policyOf', args: [p.owner] });
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

  console.log(`\non a fresh local copy, a minute past the permission's expiry (${iso(expiresAt)})`);
  await test.reset({ jsonRpcUrl: RPC });
  if (p.regrant) await p.regrant(rpc);
  const [, , expiresAgain, revokedOnCopy] = await local.readContract({
    address: p.contract,
    abi: DELEGATION,
    functionName: 'policyOf',
    args: [p.owner],
  });
  await test.setNextBlockTimestamp({ timestamp: expiresAgain + 60n });
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
