/**
 * A 1inch limit order, signed by a maker and taken through the permission, on a Base fork (PLAN.md 3.15).
 *
 * What it shows, in order:
 *
 *   1. A fresh owner grants the executor's delegate, with the router on the venue list as every grant has it.
 *   2. A fresh maker wraps WETH, lets the router take it, and signs an all-or-nothing WETH → USDC order.
 *   3. The order's EIP-712 hash is the router's own `hashOrder`, and the signature recovers the maker.
 *   4. Dry runs of `XorrDelegation.spend()` settle what the calldata means, against the deployed router rather than
 *      a reading of its source: which amount `amount` is, what the threshold holds the fill to and how wide it is,
 *      and where `args` sends the maker's WETH.
 *   5. The real fill, sent with `spendAsDelegate` exactly as the executor sends it: the owner's WETH rises by the
 *      making amount, the maker is paid the taking amount, the delegation is left holding nothing, and the order's
 *      nonce bit is spent, so a second take is refused.
 *
 *   XORR_CHAIN=base-fork FORK_RPC=http://127.0.0.1:8549 DELEGATION_ADDRESS=… XORR_KEY_DIR=… \
 *   npx tsx server/src/fork/prove-limit-order.ts
 *
 * Point it at a fork `fork-bootstrap.ts` deployed the delegation to, with the same `XORR_KEY_DIR`, so the delegate the
 * bootstrap funded is the one signing here. It refuses any node that is not anvil: this moves tokens.
 */
import 'dotenv/config';
import {
  BaseError,
  ContractFunctionRevertedError,
  createPublicClient,
  createWalletClient,
  decodeAbiParameters,
  encodeFunctionData,
  erc20Abi,
  formatUnits,
  http,
  parseUnits,
  type Address,
  type Hex,
} from 'viem';
import { base } from 'viem/chains';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';

const RPC = process.env.FORK_RPC;
if (!RPC) throw new Error('FORK_RPC is required: the anvil fork to prove on');
if (process.env.XORR_CHAIN !== 'xlayer-fork') {
  throw new Error('XORR_CHAIN=base-fork is required, so the executor modules send to the fork');
}

async function rpc(method: string, params: unknown[] = []): Promise<unknown> {
  const r = (await fetch(RPC!, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  }).then((x) => x.json())) as { result?: unknown; error?: { message: string } };
  if (r.error) throw new Error(`${method}: ${r.error.message}`);
  return r.result;
}

const node = String(await rpc('web3_clientVersion'));
if (!node.toLowerCase().startsWith('anvil')) {
  throw new Error(`${RPC} answers as "${node}", not anvil. This script moves tokens and runs only on a fork.`);
}

// Imported after the checks: these read XORR_CHAIN and FORK_RPC when they load.
const lop = await import('../venues/limit-orders.js');
const { DELEGATION_ABI, DELEGATION_ADDRESS, readPolicy, spendAsDelegate, usdToUnits, waitForTx } = await import(
  '../evm/delegation.js'
);
const { SETTLEMENT_VENUES } = await import('../evm/chains.js');
const { delegateAccount } = await import('../evm/client.js');
const { USDC, WETH, newLimitOrderMaker, signLimitOrder } = await import('./makers.js');
const { priceOf } = await import('../market/prices.js');

if (/^0x0{40}$/.test(DELEGATION_ADDRESS)) throw new Error('DELEGATION_ADDRESS is required: run fork-bootstrap first');

const chain = { ...base, rpcUrls: { default: { http: [RPC] }, public: { http: [RPC] } } };
const pub = createPublicClient({ chain, transport: http(RPC), cacheTime: 0 });
const CHAIN_ID = await pub.getChainId();
/** Aave v3's aUSDC reserve: a real holder of real USDC, impersonated to fund the owner on the fork. */
const WHALE: Address = '0x4e65fE4DbA92790696d040ac24Aa414708F5c0AB';

let failures = 0;
function check(what: string, ok: boolean, detail = ''): void {
  if (!ok) failures += 1;
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${what}${detail ? ` — ${detail}` : ''}`);
}
const weth = (n: bigint) => `${formatUnits(n, 18)} WETH`;
const usdc = (n: bigint) => `${formatUnits(n, 6)} USDC`;

console.log(`fork ${RPC} · ${node} · chain ${CHAIN_ID} · block ${await pub.getBlockNumber()}`);
console.log(`delegation ${DELEGATION_ADDRESS} · delegate ${delegateAccount.address} · router ${lop.LOP_ROUTER}\n`);

/* ── 1. The owner, funded and granted. ── */
const ownerAccount = privateKeyToAccount(generatePrivateKey());
const owner = ownerAccount.address;
const ownerWallet = createWalletClient({ account: ownerAccount, chain, transport: http(RPC) });
await rpc('anvil_setBalance', [owner, '0x8AC7230489E80000']);
await rpc('anvil_impersonateAccount', [WHALE]);
await rpc('anvil_setBalance', [WHALE, '0xDE0B6B3A7640000']);
const whale = createWalletClient({ account: WHALE, chain, transport: http(RPC) });
const fundTx = await whale.writeContract({
  address: USDC,
  abi: erc20Abi,
  functionName: 'transfer',
  args: [owner, parseUnits('1000', 6)],
});
await pub.waitForTransactionReceipt({ hash: fundTx });
await rpc('anvil_stopImpersonatingAccount', [WHALE]);

const chainNow = (await pub.getBlock()).timestamp;
const grantTx = await ownerWallet.writeContract({
  address: DELEGATION_ADDRESS,
  abi: DELEGATION_ABI,
  functionName: 'grant',
  args: [delegateAccount.address, usdToUnits(500), chainNow + 86_400n, [...SETTLEMENT_VENUES]],
});
check('grant mined', (await pub.waitForTransactionReceipt({ hash: grantTx })).status === 'success', grantTx);
check(
  'the router is on the venue list the grant signed',
  SETTLEMENT_VENUES.some((v) => v.toLowerCase() === lop.LOP_ROUTER.toLowerCase()),
);
console.log(`owner ${owner} · funded ${fundTx}\n`);

/* ── 2. The maker, and its order. ── */
const price = await priceOf('WETH');
const makingAmount = parseUnits('0.05', 18);
// The maker's ask: a quarter of a percent over the market.
const takingAmount = BigInt(Math.round(0.05 * price * 1.0025 * 1e6));
const maker = await newLimitOrderMaker({ rpc: RPC, weth: makingAmount });
// At least 256, so the nonce and the invalidator slot it lives in are different numbers.
const nonce = 1_000_003n;
const { order, signature, hash } = await signLimitOrder({
  account: maker.account,
  chainId: CHAIN_ID,
  makingAmount,
  takingAmount,
  expiration: chainNow + 3_600n,
  nonce,
});
console.log(`maker ${maker.maker} · wrap ${maker.wrapTx} · approve router ${maker.approveTx}`);
console.log(`order ${hash}: ${weth(makingAmount)} for ${usdc(takingAmount)} (WETH at ${price}) · nonce ${nonce}\n`);

/* ── 3. The hash and the signature. ── */
const routerHash = await pub.readContract({
  address: lop.LOP_ROUTER,
  abi: lop.LOP_ABI,
  functionName: 'hashOrder',
  args: [lop.orderArg(order)],
});
check("the EIP-712 hash is the router's hashOrder", routerHash === hash, routerHash);
const signer = await lop.recoverOrderSigner(order, signature, CHAIN_ID);
check('the signature recovers the maker', signer === maker.maker, signer);
const traits = lop.readMakerTraits(order.makerTraits);
check(
  'the traits read back as signed',
  traits.nonce === nonce && traits.expiration === chainNow + 3_600n && traits.noPartialFills && traits.allowedSender === 0n,
);

const approveTx = await ownerWallet.writeContract({
  address: USDC,
  abi: erc20Abi,
  functionName: 'approve',
  args: [DELEGATION_ADDRESS, takingAmount],
});
await pub.waitForTransactionReceipt({ hash: approveTx });

/* ── 4. What the calldata means, asked of the deployed router. ── */
console.log('\ndry runs of spend(owner, USDC, router, takingAmount, WETH, makingAmount, fillOrderArgs(…)):');
const SPEND_ABI = [...DELEGATION_ABI, ...lop.LOP_ERRORS] as const;
const { r, vs } = lop.compactSignature(signature);
const STRANGER: Address = '0x000000000000000000000000000000000000dEaD';

async function dryRun(takerTraits: bigint, args: Hex) {
  const data = encodeFunctionData({
    abi: lop.LOP_ABI,
    functionName: 'fillOrderArgs',
    args: [lop.orderArg(order), r, vs, takingAmount, takerTraits, args],
  });
  try {
    const { result } = await pub.simulateContract({
      account: delegateAccount,
      address: DELEGATION_ADDRESS,
      abi: SPEND_ABI,
      functionName: 'spend',
      args: [owner, USDC, lop.LOP_ROUTER, takingAmount, WETH, makingAmount, data],
    });
    const [making, taking, orderHash] = decodeAbiParameters(
      [{ type: 'uint256' }, { type: 'uint256' }, { type: 'bytes32' }],
      result,
    );
    return { ok: true as const, making, taking, orderHash };
  } catch (e) {
    // A custom error by its name; a plain `Error(string)` revert — a token's own refusal — by its sentence.
    const reverted = e instanceof BaseError ? e.walk((x) => x instanceof ContractFunctionRevertedError) : undefined;
    const reason =
      reverted instanceof ContractFunctionRevertedError ? (reverted.reason ?? reverted.data?.errorName) : undefined;
    return { ok: false as const, error: reason ?? (e instanceof Error ? e.message.split('\n')[0] : String(e)) };
  }
}
const said = (x: Awaited<ReturnType<typeof dryRun>>) =>
  x.ok ? `fills ${weth(x.making)} for ${usdc(x.taking)}` : `reverts ${x.error}`;

const asBuilt = await dryRun(lop.buildTakerTraits({ threshold: makingAmount, argsHasTarget: true }), owner);
check(
  '`amount` is the taking amount when MAKER_AMOUNT is clear: the whole order for its whole taking amount',
  asBuilt.ok && asBuilt.making === makingAmount && asBuilt.taking === takingAmount && asBuilt.orderHash === hash,
  said(asBuilt),
);
const makerAmount = await dryRun(lop.buildTakerTraits({ threshold: 0n, argsHasTarget: true, makerAmount: true }), owner);
check(
  'with MAKER_AMOUNT set the same number is read as WETH wei, a part fill the order refuses',
  !makerAmount.ok && makerAmount.error === 'PartialFillNotAllowed',
  said(makerAmount),
);
const oneMore = await dryRun(lop.buildTakerTraits({ threshold: makingAmount + 1n, argsHasTarget: true }), owner);
check(
  'the threshold is the least WETH out: one wei above the order is refused by the router',
  !oneMore.ok && oneMore.error === 'MakingAmountTooLow',
  said(oneMore),
);
const bit184 = await dryRun(makingAmount | (1n << 184n) | lop.TAKER_TRAITS.ARGS_HAS_TARGET, owner);
check('bit 184 is outside the threshold mask: it fills as if absent', bit184.ok, said(bit184));
const bit183 = await dryRun(makingAmount | (1n << 183n) | lop.TAKER_TRAITS.ARGS_HAS_TARGET, owner);
check(
  'bit 183 is inside it: the threshold becomes huge and the router refuses',
  !bit183.ok && bit183.error === 'MakingAmountTooLow',
  said(bit183),
);
const noTarget = await dryRun(lop.buildTakerTraits({ threshold: makingAmount }), '0x');
check(
  'without ARGS_HAS_TARGET the WETH goes to the caller, the delegation, and spend() refuses',
  !noTarget.ok && noTarget.error === 'OutputNotReceived',
  said(noTarget),
);
const elsewhere = await dryRun(lop.buildTakerTraits({ threshold: makingAmount, argsHasTarget: true }), STRANGER);
check(
  "the first 20 bytes of args are where the WETH goes: naming anyone else fails the owner's output check",
  !elsewhere.ok && elsewhere.error === 'OutputNotReceived',
  said(elsewhere),
);

/* ── 5. The fill, as the executor sends it. ── */
const balance = (token: Address, who: Address) =>
  pub.readContract({ address: token, abi: erc20Abi, functionName: 'balanceOf', args: [who] });
const balances = async () => ({
  ownerWeth: await balance(WETH, owner),
  ownerUsdc: await balance(USDC, owner),
  makerWeth: await balance(WETH, maker.maker),
  makerUsdc: await balance(USDC, maker.maker),
  delegationWeth: await balance(WETH, DELEGATION_ADDRESS),
  delegationUsdc: await balance(USDC, DELEGATION_ADDRESS),
});
const invalidatorWord = (key: bigint) =>
  pub.readContract({ address: lop.LOP_ROUTER, abi: lop.LOP_ABI, functionName: 'bitInvalidatorForOrder', args: [maker.maker, key] });

const fill = lop.buildLimitOrderFill({ order, signature, owner });
const usd = Number(formatUnits(fill.amount, 6));
check('the taking amount survives the dollar figure spendAsDelegate takes', usdToUnits(usd) === fill.amount, `$${usd}`);
const spentBefore = (await readPolicy(owner))?.spentTodayUsd;
const before = await balances();
const wordBefore = await invalidatorWord(nonce);

const fillTx = await spendAsDelegate({
  owner,
  token: fill.token,
  venue: fill.venue,
  usd,
  data: fill.data,
  tokenOut: fill.tokenOut,
  minOut: fill.minOut,
});
const settled = await waitForTx(fillTx);
const receipt = await pub.getTransactionReceipt({ hash: fillTx });
console.log(`\nfill ${fillTx} · block ${receipt.blockNumber} · gas ${receipt.gasUsed}`);
check('the fill mined and succeeded', settled === true);

const after = await balances();
const show = (name: string, a: bigint, b: bigint, fmt: (n: bigint) => string) =>
  console.log(`  ${name.padEnd(16)} ${fmt(a).padStart(26)} → ${fmt(b).padStart(26)}  (${b >= a ? '+' : '−'}${fmt(b >= a ? b - a : a - b)})`);
console.log('balances, before → after:');
show('owner WETH', before.ownerWeth, after.ownerWeth, weth);
show('owner USDC', before.ownerUsdc, after.ownerUsdc, usdc);
show('maker WETH', before.makerWeth, after.makerWeth, weth);
show('maker USDC', before.makerUsdc, after.makerUsdc, usdc);
show('delegation WETH', before.delegationWeth, after.delegationWeth, weth);
show('delegation USDC', before.delegationUsdc, after.delegationUsdc, usdc);

check("the owner's WETH rose by exactly the making amount", after.ownerWeth - before.ownerWeth === makingAmount);
check("the owner's USDC fell by exactly the taking amount", before.ownerUsdc - after.ownerUsdc === takingAmount);
check('the maker received exactly the taking amount', after.makerUsdc - before.makerUsdc === takingAmount);
check('the maker gave exactly the making amount', before.makerWeth - after.makerWeth === makingAmount);
check(
  'the delegation holds nothing after the trade',
  after.delegationWeth === before.delegationWeth && after.delegationUsdc === before.delegationUsdc,
);
const leftApproval = await pub.readContract({
  address: USDC,
  abi: erc20Abi,
  functionName: 'allowance',
  args: [DELEGATION_ADDRESS, lop.LOP_ROUTER],
});
check('no standing approval from the delegation to the router', leftApproval === 0n);
const spentAfter = (await readPolicy(owner))?.spentTodayUsd;
check(
  "spend() counted the taking amount against the owner's daily cap",
  spentBefore !== undefined && spentAfter !== undefined && Math.abs(spentAfter - spentBefore - usd) < 1e-6,
  `$${spentBefore} → $${spentAfter}`,
);

/* ── The nonce, spent. ── */
const wordAfter = await invalidatorWord(nonce);
const bySlot = await invalidatorWord(nonce >> 8n);
console.log(`\nbitInvalidatorForOrder(maker, ${nonce}): 0x${wordBefore.toString(16)} → 0x${wordAfter.toString(16)}`);
check(
  `bit ${nonce & 0xffn} of the word is set after the fill, and was clear before`,
  !lop.nonceSpent(wordBefore, nonce) && lop.nonceSpent(wordAfter, nonce),
);
check(
  `the second argument is the nonce: passing its slot (${nonce >> 8n}) reads another word`,
  !lop.nonceSpent(bySlot, nonce),
  `0x${bySlot.toString(16)}`,
);
const { now, states } = await lop.readOrdersOnChain([order]);
const judged = lop.judgeOrder({ order, now, onChain: states[0]! });
check('the listing reads it as spent', judged.status === 'invalidated', `${judged.status}: ${judged.detail}`);
/*
 * The fill used up the owner's USDC approval, which was for exactly the taking amount. Without renewing it the second
 * take is refused by USDC's own allowance check before the router is reached, which proves nothing about the order.
 */
const reapproveTx = await ownerWallet.writeContract({
  address: USDC,
  abi: erc20Abi,
  functionName: 'approve',
  args: [DELEGATION_ADDRESS, takingAmount],
});
await pub.waitForTransactionReceipt({ hash: reapproveTx });
const again = await dryRun(lop.buildTakerTraits({ threshold: makingAmount, argsHasTarget: true }), owner);
check('a second take is refused by the router', !again.ok && again.error === 'BitInvalidatedOrder', said(again));

console.log(`\n${failures === 0 ? 'every check passed' : `${failures} check(s) failed`}`);
process.exitCode = failures === 0 ? 0 : 1;
