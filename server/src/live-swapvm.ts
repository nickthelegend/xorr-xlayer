/**
 * The 1inch SwapVM path, end to end, on chain.
 *
 * `XorrSwapVMBook` was deployed, covered by ten fork tests, and wired into the settlement path
 * ahead of the aggregator — and nothing had ever settled through it. `fillsByVenue` on the fork
 * read `{1inch: 35, aqua: 5}` with no `swapvm` key at all, because discovery needs a maker to have
 * shipped a SwapVM program to Aqua and no maker ever had. The README said "Wired" rather than
 * "Done" for exactly that reason, which was honest and still meant one sponsor claim rested on
 * tests instead of a transaction.
 *
 * This is the maker nobody had written. It ships a real program to the OFFICIAL Aqua deployment
 * with the SwapVM router as the app, proves `openPrograms()` finds it, and then takes against it
 * with delegated capital so the fill runs through `XorrDelegation.spend()` — cap, expiry and venue
 * allowlist all enforced by the contract the taker signed.
 *
 * What separates this from the Aqua script next to it: an Aqua book quotes from a curve the book
 * contract evaluates, and a SwapVM book ships a PROGRAM — the terms compiled to bytecode that the
 * router executes at fill time. So the deadline really expires and the fee really costs, because
 * they are instructions rather than promises. The program is built by the book's own
 * `xycProgram()`, not assembled here; re-deriving bytecode a contract already knows how to emit is
 * how a fill starts failing for reasons nobody can read.
 *
 *   FORK_RPC=… FORK_API=… OWNER_ADDRESS=… DELEGATION_ADDRESS=… SWAPVM_BOOK_ADDRESS=… \
 *   npx tsx server/src/live-swapvm.ts
 */
import {
  createPublicClient,
  createWalletClient,
  http,
  parseUnits,
  formatUnits,
  toFunctionSelector,
  encodeFunctionData,
  decodeAbiParameters,
  parseAbiParameters,
  erc20Abi,
  type Address,
  type Hex,
} from 'viem';
import { base } from 'viem/chains';
import fs from 'node:fs';
import path from 'node:path';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';

const RPC = process.env.FORK_RPC!;
const OWNER = process.env.OWNER_ADDRESS! as Address;
const BOOK = process.env.SWAPVM_BOOK_ADDRESS! as Address;
const DELEGATION = process.env.DELEGATION_ADDRESS! as Address;
const AQUA: Address = (process.env.AQUA_ADDRESS as Address) ?? '0x1111113CCf1426A8E30e2bfF5E005d929bF6a90a';
const USDC: Address = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const WETH: Address = '0x4200000000000000000000000000000000000006';
/** A large USDC holder on Base, used only to fund a throwaway maker on a fork. */
const WHALE: Address = '0x4e65fE4DbA92790696d040ac24Aa414708F5c0AB';
const MAX = (1n << 256n) - 1n;

const chain = { ...base, rpcUrls: { default: { http: [RPC] }, public: { http: [RPC] } } };
const pub = createPublicClient({ chain, transport: http(RPC), cacheTime: 0 });

/** `ISwapVM.Order` — three fields; `traits` is a packed uint256. See the note in venues/swapvm.ts. */
const ORDER_COMPONENTS = [
  { name: 'maker', type: 'address' },
  { name: 'traits', type: 'uint256' },
  { name: 'data', type: 'bytes' },
] as const;

const BOOK_ABI = [
  {
    type: 'function',
    name: 'xycProgram',
    stateMutability: 'view',
    inputs: [
      { name: 'feeBps', type: 'uint256' },
      { name: 'deadline', type: 'uint40' },
      { name: 'salt', type: 'bytes32' },
    ],
    outputs: [{ name: '', type: 'bytes' }],
  },
  {
    type: 'function',
    name: 'orderFor',
    stateMutability: 'pure',
    inputs: [
      { name: 'maker', type: 'address' },
      { name: 'program', type: 'bytes' },
    ],
    outputs: [{ name: '', type: 'tuple', components: ORDER_COMPONENTS }],
  },
  {
    type: 'function',
    name: 'shipArgs',
    stateMutability: 'view',
    inputs: [
      { name: 'order', type: 'tuple', components: ORDER_COMPONENTS },
      { name: 'token0', type: 'address' },
      { name: 'token1', type: 'address' },
      { name: 'amount0', type: 'uint256' },
      { name: 'amount1', type: 'uint256' },
    ],
    outputs: [
      { name: 'app', type: 'address' },
      { name: 'encoded', type: 'bytes' },
      { name: 'tokens', type: 'address[]' },
      { name: 'amounts', type: 'uint256[]' },
    ],
  },
  {
    type: 'function',
    name: 'delegatedFillArgs',
    stateMutability: 'view',
    inputs: [
      { name: 'order', type: 'tuple', components: ORDER_COMPONENTS },
      { name: 'principal', type: 'address' },
      { name: 'tokenIn', type: 'address' },
      { name: 'tokenOut', type: 'address' },
      { name: 'amountIn', type: 'uint256' },
      { name: 'amountOutMin', type: 'uint256' },
    ],
    outputs: [
      { name: 'token', type: 'address' },
      { name: 'venue', type: 'address' },
      { name: 'amount', type: 'uint256' },
      { name: 'data', type: 'bytes' },
    ],
  },
] as const;

const AQUA_ABI = [
  {
    type: 'function',
    name: 'ship',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'app', type: 'address' },
      { name: 'strategy', type: 'bytes' },
      { name: 'tokens', type: 'address[]' },
      { name: 'amounts', type: 'uint256[]' },
    ],
    outputs: [],
  },
] as const;

/*
 * The delegation's ABI is IMPORTED from the executor, not written here.
 *
 * This file used to declare its own, and declared `spend` with eight inputs — the real function
 * takes five. A signature that does not exist on the contract is not a revert with a reason: the
 * call finds no matching selector and dies with empty return data, which the tracer reports as
 * "execution reverted" at depth 0 with no inner frame. It reads exactly like a rejected policy.
 *
 * A hand-copied ABI is a second source of truth for something the contract already defines, and
 * this is what that costs. `DELEGATION_ABI` is imported below, after the env is set.
 */

async function anvil(method: string, params: unknown[]) {
  const r = (await fetch(RPC, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  }).then((x) => x.json())) as { result?: unknown; error?: { message: string } };
  if (r.error) throw new Error(`${method}: ${r.error.message}`);
  return r.result;
}

/**
 * The innermost revert of a failed call, as a reason a human can act on.
 *
 * `spend()` is four contracts deep — delegation → book → SwapVM router → the program — and viem
 * reports the OUTERMOST frame, which for a bubbled revert with no data is the useless string
 * "execution reverted". Anvil keeps the whole call tree, so ask it: the deepest frame with an
 * error is the one that actually refused, and its address says which contract's rules were broken.
 */
async function revertReason(call: { from: Address; to: Address; data: Hex }): Promise<string> {
  let trace: unknown;
  try {
    trace = await anvil('debug_traceCall', [
      { from: call.from, to: call.to, data: call.data },
      'latest',
      { tracer: 'callTracer' },
    ]);
  } catch (e) {
    return `no trace available (${(e as Error).message})`;
  }

  type Frame = { type?: string; to?: string; error?: string; revertReason?: string; calls?: Frame[] };
  const deepest: { frame: Frame; depth: number }[] = [];
  const walk = (f: Frame, depth: number) => {
    if (f.error || f.revertReason) deepest.push({ frame: f, depth });
    for (const c of f.calls ?? []) walk(c, depth + 1);
  };
  walk(trace as Frame, 0);
  if (!deepest.length) return 'the trace shows no reverting frame';

  const worst = deepest.sort((a, b) => b.depth - a.depth)[0];
  if (!worst) return 'the trace shows no reverting frame';
  const { frame } = worst;
  const named = frame.revertReason ?? decodeKnownError(frame as { output?: Hex });
  return `${named ?? frame.error} in ${frame.to} (depth ${worst.depth})`;
}

/**
 * Every custom error declared in this repo's Solidity, keyed by selector.
 *
 * Read from the sources rather than typed out here. A revert in this path can come from our
 * delegation, our book, or the vendored SwapVM router, and that last one alone declares over four
 * hundred — a hand-written subset would name the errors I happened to think of and print a bare
 * selector for the one that actually fired, which is the case that matters. Scanning the tree
 * costs a few hundred milliseconds once and cannot fall out of date.
 */
const ERRORS_BY_SELECTOR = (() => {
  const map = new Map<string, string>();
  const roots = ['contracts/src', 'contracts/lib'];
  const files: string[] = [];
  const walk = (dir: string) => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) walk(full);
      else if (e.name.endsWith('.sol')) files.push(full);
    }
  };
  for (const r of roots) walk(path.resolve(process.cwd(), r));

  for (const f of files) {
    const src = fs.readFileSync(f, 'utf8');
    for (const m of src.matchAll(/error\s+([A-Za-z0-9_]+)\(([^)]*)\)/g)) {
      const params =
        m[2]!.trim() === '' ? [] : m[2]!.split(',').map((x) => x.trim().split(/\s+/)[0] ?? '');
      const sig = `${m[1]}(${params.join(',')})`;
      try {
        map.set(toFunctionSelector(`function ${sig}`), sig);
      } catch {
        // A declaration we cannot canonicalise — a user-defined type in the parameter list, say.
      }
    }
  }
  return map;
})();

/** Name a revert payload, with its arguments when we can read them. */
function decodeKnownError(frame: { output?: Hex }): string | undefined {
  const out = frame.output;
  if (!out || out.length < 10) return undefined;
  const selector = out.slice(0, 10);
  if (selector === toFunctionSelector('function Error(string)')) {
    try {
      return `"${decodeAbiParameters(parseAbiParameters('string'), `0x${out.slice(10)}` as Hex)[0]}"`;
    } catch {
      return 'Error(string)';
    }
  }
  const sig = ERRORS_BY_SELECTOR.get(selector);
  if (!sig) return `unknown error ${selector}`;
  const types = sig.slice(sig.indexOf('(') + 1, -1);
  if (!types) return sig;
  try {
    const args = decodeAbiParameters(parseAbiParameters(types), `0x${out.slice(10)}` as Hex);
    return `${sig.slice(0, sig.indexOf('('))}(${args.map(String).join(', ')})`;
  } catch {
    return sig;
  }
}

let pass = 0;
let fail = 0;
function check(ok: boolean, label: string, detail: string) {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}  — ${detail}`);
  ok ? pass++ : fail++;
}

const bal = (t: Address, who: Address) =>
  pub.readContract({ address: t, abi: erc20Abi, functionName: 'balanceOf', args: [who] });

/*
 * The chain is pinned BEFORE any executor module loads, and it is not a formality.
 *
 * `evm/chains.ts` imports `dotenv/config` and reads `process.env.XORR_CHAIN ?? 'localnet'` at
 * module scope, and the repo's `.env` says `base-sepolia`. So the first run of this script shipped
 * a program to Aqua on the fork and then asked a client pointed at Base Sepolia whether it could
 * see it. Aqua has no code on Sepolia, `eth_getLogs` against an address with no code is a
 * successful empty response, and `openPrograms()` returned `0 open program(s)` — the exact shape of
 * the honest answer "no maker has shipped one". An hour went into the discovery code before the
 * wrong chain surfaced.
 *
 * Every executor import in this file is therefore DYNAMIC and happens after these two lines. A
 * static one would be evaluated before the first statement of the module body and defeat this.
 */
process.env.AQUA_ADDRESS = AQUA;
process.env.XORR_CHAIN = 'base-fork';

async function main() {
  console.log(`fork ${RPC}\nbook ${BOOK}\ndelegation ${DELEGATION}\n`);

  /*
   * The MAKER is a different wallet from the taker, deliberately.
   *
   * Running both sides from one address makes "real ERC-20 left the maker" pass for the wrong
   * reason — the taker's purchase landing in the same wallet is indistinguishable from the maker
   * paying out. The claim is that two self-custodial parties trade without either giving up
   * custody, so there have to be two of them.
   */
  const makerAccount = privateKeyToAccount(generatePrivateKey());
  const maker = makerAccount.address;
  const makerWallet = createWalletClient({ account: makerAccount, chain, transport: http(RPC) });

  // 100 ETH, because the maker wraps most of its inventory and still pays for its own gas.
  await anvil('anvil_setBalance', [maker, '0x56BC75E2D63100000']);

  /*
   * The book is seeded DEEP, and the depth is the point rather than decoration.
   *
   * A constant-product curve moves with every fill, so a shallow book stops being the best price
   * the moment it trades. Seeded at 5,000 USDC, this script's own 150 USDC fill walked the price
   * ~3% — past the 2% edge the maker was quoting — and the executor's next $50 order correctly
   * routed to the aggregator instead. The venue counter stayed empty for a reason that had nothing
   * to do with routing: the book had already been taken.
   *
   * At 50,000 the same fill moves it ~0.3%, so the maker stays competitive across the several
   * orders a real session places. That is what depth is FOR, and it is why a market maker quotes
   * size rather than a single good price.
   */
  const seedUsdc = parseUnits('50000', 6);
  const wantUsdc = seedUsdc + parseUnits('10000', 6);
  if ((await bal(USDC, maker)) < wantUsdc) {
    await anvil('anvil_impersonateAccount', [WHALE]);
    await anvil('anvil_setBalance', [WHALE, '0xDE0B6B3A7640000']);
    const w = createWalletClient({ account: WHALE, chain, transport: http(RPC) });
    const h = await w.writeContract({
      address: USDC, abi: erc20Abi, functionName: 'transfer', args: [maker, wantUsdc],
    });
    await pub.waitForTransactionReceipt({ hash: h });
    await anvil('anvil_stopImpersonatingAccount', [WHALE]);
  }
  check((await bal(USDC, maker)) >= wantUsdc, 'the maker holds real Base USDC', `${formatUnits(await bal(USDC, maker), 6)} USDC`);

  /*
   * The maker's inventory is sized against the AGGREGATOR's live price, not a round number.
   *
   * A book that quotes worse than the market is a book nobody fills, and the executor is right to
   * skip it — that is the entire job of `buildSwapVmFill`'s dry run. The first version of this
   * script seeded 5000 USDC against a flat 2 WETH, which implied $2,500/ETH; the fork's real price
   * was $2,502, so after the 30bp fee the program paid 0.019744 WETH on a $50 order against a
   * 0.019920 floor derived from the aggregator's own quote. The executor declined it and routed to
   * 1inch, correctly, and the venue counter stayed empty for a reason that looked like a bug and
   * was actually a maker quoting a bad price.
   *
   * So the reserves are derived: enough WETH that the curve pays `EDGE` better than the aggregator
   * over this size. That is what a maker who wants flow actually does — quote inside the spread —
   * and it makes the fill a test of routing rather than of luck.
   */
  const EDGE = 0.02;
  const { quote } = await import('./venues/oneinch.js');
  const reference = await quote({ inSymbol: 'USDC', outSymbol: 'WETH', amount: 50 });
  const wethPerUsdc = reference.outAmount / 50;
  const seedWeth = parseUnits(((Number(formatUnits(seedUsdc, 6)) * wethPerUsdc) * (1 + EDGE)).toFixed(18), 18);
  console.log(
    `maker quotes ${(EDGE * 100).toFixed(0)}% inside the aggregator: ` +
      `${formatUnits(seedUsdc, 6)} USDC against ${formatUnits(seedWeth, 18)} WETH\n`,
  );

  if ((await bal(WETH, maker)) < seedWeth) {
    const h = await makerWallet.writeContract({
      address: WETH,
      abi: [{ type: 'function', name: 'deposit', inputs: [], outputs: [], stateMutability: 'payable' }] as const,
      functionName: 'deposit',
      value: seedWeth + parseUnits('1', 18),
    });
    await pub.waitForTransactionReceipt({ hash: h });
  }
  check((await bal(WETH, maker)) >= seedWeth, 'the maker holds WETH to quote with', `${formatUnits(await bal(WETH, maker), 18)} WETH`);

  for (const t of [USDC, WETH]) {
    const h = await makerWallet.writeContract({
      address: t, abi: erc20Abi, functionName: 'approve', args: [AQUA, MAX],
    });
    await pub.waitForTransactionReceipt({ hash: h });
  }

  // ── Build the PROGRAM, from the book rather than by hand ─────────────────────────────────
  const latest = await pub.getBlock();
  const deadline = Number(latest.timestamp) + 3600;
  const salt = `0x${Date.now().toString(16).padStart(64, '0')}` as Hex;

  const program = await pub.readContract({
    address: BOOK, abi: BOOK_ABI, functionName: 'xycProgram', args: [30n, deadline, salt],
  });
  check(program.length > 2, 'the book compiled a SwapVM program', `${(program.length - 2) / 2} bytes of bytecode`);

  const order = await pub.readContract({
    address: BOOK, abi: BOOK_ABI, functionName: 'orderFor', args: [maker, program],
  });

  const [app, encoded, tokens, amounts] = await pub.readContract({
    address: BOOK, abi: BOOK_ABI, functionName: 'shipArgs',
    args: [order, WETH, USDC, seedWeth, seedUsdc],
  });
  check(
    app.toLowerCase() !== BOOK.toLowerCase(),
    'the app is the SwapVM router, not our book',
    `app ${app}`,
  );

  // ── Ship it through the OFFICIAL Aqua deployment ─────────────────────────────────────────
  const wethBefore = await bal(WETH, maker);
  const shipped = await makerWallet.writeContract({
    address: AQUA, abi: AQUA_ABI, functionName: 'ship',
    args: [app, encoded, [...tokens], [...amounts]],
  });
  const shipReceipt = await pub.waitForTransactionReceipt({ hash: shipped });
  check(shipReceipt.status === 'success', 'a SwapVM program is shipped on official Aqua', `tx ${shipped}`);
  check(
    (await bal(WETH, maker)) === wethBefore,
    'shipping moved none of the maker\'s tokens',
    'Aqua takes an allowance; the maker keeps custody',
  );

  // ── Discovery: the executor's own code has to find it ────────────────────────────────────
  const { openPrograms, buildSwapVmFill } = await import('./venues/swapvm.js');
  const { publicClient } = await import('./evm/client.js');
  const { DELEGATION_ABI, delegatePublicKey } = await import('./evm/delegation.js');

  /*
   * Prove the executor's own client is on the chain we just shipped to, instead of trusting the
   * env above to have worked. An empty discovery result is ambiguous by nature; this check is what
   * makes the difference between "nothing is shipped" and "you are looking at the wrong chain"
   * visible without a debugger.
   */
  const seenByExecutor = await publicClient
    .getTransactionReceipt({ hash: shipped })
    .then((r) => r.status === 'success')
    .catch(() => false);
  check(
    seenByExecutor,
    "the executor's own client is on the chain we shipped to",
    `chain ${await publicClient.getChainId()}`,
  );

  const found = await openPrograms();
  const mine = found.find((p) => p.order.maker.toLowerCase() === maker.toLowerCase());
  check(Boolean(mine), 'openPrograms() discovers it from Aqua\'s own logs', `${found.length} open program(s)`);

  // ── The bot takes against it, through the delegation ─────────────────────────────────────
  const amountIn = parseUnits('150', 6);

  /*
   * The grant comes BEFORE the plan, in this script as in life.
   *
   * `buildSwapVmFill` now simulates the real `spend()` to reject programs that cannot fill, and a
   * simulation from a delegate nobody has authorised reverts `NotDelegate` on every candidate —
   * indistinguishable from "no maker is offering". The user grants first, the bot plans second.
   *
   * And the delegate is the EXECUTOR's own, read from the module the executor signs with, rather
   * than a key minted here. A grant to a key this script invented would prove a fill is possible
   * for somebody; using the real identity proves it is possible for the process that has to do it.
   * Anvil lets us send as that address without its key.
   */
  await anvil('anvil_setBalance', [delegatePublicKey, '0x8AC7230489E80000']);
  await anvil('anvil_impersonateAccount', [delegatePublicKey]);

  await anvil('anvil_impersonateAccount', [OWNER]);
  await anvil('anvil_setBalance', [OWNER, '0xDE0B6B3A7640000']);
  const takerOwner = createWalletClient({ account: OWNER, chain, transport: http(RPC) });

  // Only our book is allowlisted: spend() calls the venue, and the venue is the book.
  const grantHash = await takerOwner.writeContract({
    address: DELEGATION, abi: DELEGATION_ABI, functionName: 'grant',
    args: [delegatePublicKey, parseUnits('5000', 6), BigInt(deadline), [BOOK]],
  });
  await pub.waitForTransactionReceipt({ hash: grantHash });

  for (const t of [USDC, WETH]) {
    const h = await takerOwner.writeContract({
      address: t, abi: erc20Abi, functionName: 'approve', args: [DELEGATION, MAX],
    });
    await pub.waitForTransactionReceipt({ hash: h });
  }
  if ((await bal(USDC, OWNER)) < amountIn) {
    await anvil('anvil_impersonateAccount', [WHALE]);
    const w = createWalletClient({ account: WHALE, chain, transport: http(RPC) });
    const h = await w.writeContract({
      address: USDC, abi: erc20Abi, functionName: 'transfer', args: [OWNER, parseUnits('1000', 6)],
    });
    await pub.waitForTransactionReceipt({ hash: h });
    await anvil('anvil_stopImpersonatingAccount', [WHALE]);
  }
  await anvil('anvil_stopImpersonatingAccount', [OWNER]);


  /*
   * The quote the taker brings, computed the way a taker computes one: from the curve the maker
   * shipped. `xycProgram` is a constant-product book with a 30bp fee over the reserves seeded
   * below, so the output is `y·in' / (x + in')` with `in'` net of the fee.
   *
   * Deriving it rather than reading it back from a simulation is what makes the fill a test. If
   * this arithmetic disagrees with the program by more than the slippage allowance, the VM refuses
   * and the run fails — so a passing fill is also evidence that the bytecode prices the way the
   * book says it does.
   */
  const inAfterFee = (amountIn * (10_000n - 30n)) / 10_000n;
  const quotedOut = (seedWeth * inAfterFee) / (seedUsdc + inAfterFee);

  /*
   * Routed through the EXECUTOR's own entry point, not through `delegatedFillArgs` directly.
   *
   * `buildSwapVmFill` is what the settlement path actually calls: it discovers the programs, picks
   * one, derives the floor from the quote and the slippage, and asks the book to encode the call.
   * Reaching past it to the contract would prove the contract works and leave the code that has to
   * find it untested — which is the exact gap this phase exists to close.
   */
  const fillPlan = await buildSwapVmFill({
    owner: OWNER, tokenIn: USDC, tokenOut: WETH, amountIn, slippage: 0.005, quotedOut,
  });
  check(
    Boolean(fillPlan),
    'buildSwapVmFill() plans a fill from what it discovered',
    fillPlan ? `against maker ${fillPlan.order.maker}` : 'no plan — the settlement path would skip SwapVM',
  );
  if (!fillPlan) {
    console.log(`\n${pass} passed, ${fail} failed`);
    process.exit(1);
  }
  const { token, venue, amount, data } = fillPlan;
  /*
   * Aqua is shared and this script has run before, so the program `buildSwapVmFill` picks may be an
   * earlier run's maker rather than this one's. That is the real behaviour — a taker fills against
   * whoever is offering — so the balance assertions below follow the maker it CHOSE.
   */
  const filled = fillPlan.order.maker as Address;
  /*
   * The venue is the BOOK, not the router, and that is the design rather than a near miss.
   * `delegatedFillArgs` returns `address(this)`, because `spend()` calls the venue and only
   * `XorrSwapVMBook.fillForDelegation` may hold the pulled capital long enough to build the taker
   * traits; the book then approves the router and calls `SWAP_VM.swap` itself. Asserting the
   * router here was my own error, and it failed against correct code.
   */
  check(
    venue.toLowerCase() === BOOK.toLowerCase(),
    'the fill is routed through our book, which calls the SwapVM router',
    `venue ${venue}`,
  );
  check(
    data.slice(0, 10) === toFunctionSelector(
      'function fillForDelegation((address,uint256,bytes),address,address,address,uint256,uint256)',
    ),
    'the calldata spend() will run is fillForDelegation',
    `selector ${data.slice(0, 10)}`,
  );

  const takerWethBefore = await bal(WETH, OWNER);
  const makerWethBefore = await bal(WETH, filled);

  const delegate = createWalletClient({ account: delegatePublicKey, chain, transport: http(RPC) });
  // What the fill must deliver to the owner, and the floor the plan was built with (PLAN.md 1.4).
  const spendArgs = [OWNER, token, venue, amount, fillPlan.tokenOut, fillPlan.minOut, data] as const;
  let fill: Hex;
  try {
    fill = await delegate.writeContract({
      address: DELEGATION, abi: DELEGATION_ABI, functionName: 'spend', args: spendArgs,
    });
  } catch (e) {
    const why = await revertReason({
      from: delegatePublicKey,
      to: DELEGATION,
      data: encodeFunctionData({ abi: DELEGATION_ABI, functionName: 'spend', args: spendArgs }),
    });
    check(false, 'the delegation filled through SwapVM', why);
    console.log(`\n${pass} passed, ${fail} failed`);
    process.exit(1);
  }
  const fillReceipt = await pub.waitForTransactionReceipt({ hash: fill });
  check(fillReceipt.status === 'success', 'the delegation filled through SwapVM', `tx ${fill}`);

  const takerGained = (await bal(WETH, OWNER)) - takerWethBefore;
  const makerPaid = makerWethBefore - (await bal(WETH, filled));
  check(takerGained > 0n, 'the taker received real WETH', `+${formatUnits(takerGained, 18)} WETH`);
  check(
    makerPaid > 0n,
    'it came out of the maker\'s own wallet',
    `−${formatUnits(makerPaid, 18)} WETH from ${filled === maker ? 'this run\'s maker' : filled}`,
  );
  check(
    takerGained >= (quotedOut * 995n) / 1000n,
    'the fill cleared at or above the floor the executor set',
    `quoted ${formatUnits(quotedOut, 18)}, got ${formatUnits(takerGained, 18)}`,
  );

  /*
   * The slippage floor, proven by breaking it.
   *
   * A fill that merely SUCCEEDS says nothing about whether the floor is enforced — passing
   * `amountOutMin` proves only that the argument exists. The claim in this file's header is that a
   * SwapVM program enforces its terms INSIDE the VM rather than trusting the submitter, so the way
   * to show it is to ask for more than the curve can pay and watch the router refuse.
   *
   * The floor is set from the fill that just cleared: twice what the same size actually returned is
   * unreachable at this price and reachable at no plausible one, so a success here would mean the
   * threshold is decorative.
   */
  const impossible = quotedOut * 2n;

  /*
   * Two refusals, at two levels, and both matter.
   *
   * The EXECUTOR must decline to plan a fill it knows cannot clear, because the settlement path
   * prefers a SwapVM plan over the aggregator — planning an impossible fill does not mean a worse
   * price, it means no trade at all. `buildSwapVmFill` returning nothing here is what sends the
   * caller to 1inch.
   */
  const noPlan = await buildSwapVmFill({
    owner: OWNER, tokenIn: USDC, tokenOut: WETH, amountIn, slippage: 0.005, quotedOut: impossible,
  });
  check(
    noPlan === undefined,
    'buildSwapVmFill() refuses to plan a fill that cannot clear',
    noPlan ? 'it planned one anyway — the settlement path would lose the trade' : 'the caller falls back to 1inch',
  );

  /*
   * And the VM must refuse it even if something else submits it anyway, because that is the claim
   * this whole phase rests on: the terms are enforced by the router executing the maker's program,
   * not by our willingness to check them. So bypass our own filter, ask the book to encode the
   * impossible fill directly, and watch the official router throw it out.
   */
  const [, badVenue, badAmount, badData] = await pub.readContract({
    address: BOOK, abi: BOOK_ABI, functionName: 'delegatedFillArgs',
    args: [fillPlan.order, OWNER, USDC, WETH, amountIn, (impossible * 995n) / 1000n],
  });
  const badArgs = [OWNER, token, badVenue, badAmount, WETH, (impossible * 995n) / 1000n, badData] as const;
  let refused = false;
  try {
    await pub.simulateContract({
      account: delegatePublicKey,
      address: DELEGATION, abi: DELEGATION_ABI, functionName: 'spend', args: badArgs,
    });
  } catch {
    refused = true;
  }
  const why = refused
    ? await revertReason({
        from: delegatePublicKey,
        to: DELEGATION,
        data: encodeFunctionData({ abi: DELEGATION_ABI, functionName: 'spend', args: badArgs }),
      })
    : 'the fill went through at twice the going rate';
  check(
    refused,
    `a fill floored at ${formatUnits((impossible * 995n) / 1000n, 18)} WETH is refused by the VM, not by us`,
    why,
  );
  check(
    refused && !why.includes('depth 0'),
    'the refusal comes from inside the fill, not from a delegation guard',
    why,
  );

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail > 0) process.exitCode = 1;
}

await main();
