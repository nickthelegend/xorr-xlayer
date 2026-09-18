/**
 * Fork end-to-end: a real delegated purchase of a tokenized share on a Base mainnet fork.
 *
 * This is the whole thesis in one script, with nothing simulated except the chain being local:
 *   1. deploy XorrDelegation to the fork
 *   2. fund a fresh owner EOA with real USDC, taken from a real holder by impersonation
 *   3. the OWNER — not us — grants a capped, expiring, venue-allowlisted policy and approves
 *   4. the DELEGATE signs `spend()` with real 1inch calldata
 *   5. real router execution against real Base liquidity
 *   6. assert the bought token landed in the USER's wallet, and that the contract kept nothing
 *
 * Run: npx tsx server/src/fork-e2e.ts [SYMBOL]   (anvil --fork-url https://mainnet.base.org)
 */
import 'dotenv/config';
import {
  createPublicClient,
  createWalletClient,
  http,
  parseUnits,
  formatUnits,
  erc20Abi,
  type Address,
  type Hex,
} from 'viem';
import { privateKeyToAccount, generatePrivateKey } from 'viem/accounts';
import { base } from 'viem/chains';
import { buildSwap, canonicalSymbol, TOKENS } from './venues/oneinch.js';
import { STOCKS, stockKey } from './venues/stocks.js';

const RPC = process.env.FORK_RPC ?? 'http://127.0.0.1:8545';
const USDC: Address = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const ROUTER: Address = '0x111111125421cA6dc452d289314280a0f8842A65';
const SYMBOL = process.argv[2] ?? 'NVDAc';
const SPEND_USD = 250;
const CAP_USD = 1_000;

const chain = { ...base, rpcUrls: { default: { http: [RPC] }, public: { http: [RPC] } } };
const pub = createPublicClient({ chain, transport: http(RPC) });

const rpc = (method: string, params: unknown[]) =>
  fetch(RPC, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  }).then((r) => r.json() as Promise<{ result?: unknown; error?: { message: string } }>);

async function anvil(method: string, params: unknown[]) {
  const r = await rpc(method, params);
  if (r.error) throw new Error(`${method}: ${r.error.message}`);
  return r.result;
}

/** Fund `to` with USDC by taking it from an address that already holds a lot of it. */
async function fundUsdc(to: Address, amount: bigint) {
  // Aave v3's aUSDC reserve on Base — a real contract holding tens of millions of real USDC.
  const whale: Address = '0x4e65fE4DbA92790696d040ac24Aa414708F5c0AB';
  const held = await pub.readContract({
    address: USDC, abi: erc20Abi, functionName: 'balanceOf', args: [whale],
  });
  if (held < amount) throw new Error(`whale holds ${held}, need ${amount}`);

  await anvil('anvil_impersonateAccount', [whale]);
  await anvil('anvil_setBalance', [whale, '0xDE0B6B3A7640000']); // 1 ETH for gas
  const w = createWalletClient({ account: whale, chain, transport: http(RPC) });
  const h = await w.writeContract({ address: USDC, abi: erc20Abi, functionName: 'transfer', args: [to, amount] });
  await pub.waitForTransactionReceipt({ hash: h });
  await anvil('anvil_stopImpersonatingAccount', [whale]);
}

function tokenAddressOf(t: { address: Address }): Address {
  return t.address;
}

function must(label: string, cond: boolean, detail = '') {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${detail ? `  — ${detail}` : ''}`);
  if (!cond) process.exitCode = 1;
}

const DELEGATION_ABI = [
  { type: 'constructor', stateMutability: 'nonpayable', inputs: [{ name: 'settlementToken', type: 'address' }] },
  { type: 'function', name: 'grant', stateMutability: 'nonpayable',
    inputs: [{ name: 'delegate', type: 'address' }, { name: 'dailyCap', type: 'uint256' },
             { name: 'expiresAt', type: 'uint64' }, { name: 'venues', type: 'address[]' }], outputs: [] },
  // `tokenOut`/`minOut`: the owner's balance of what the trade buys must rise by the floor (PLAN.md 1.4).
  { type: 'function', name: 'spend', stateMutability: 'nonpayable',
    inputs: [{ name: 'owner', type: 'address' }, { name: 'token', type: 'address' },
             { name: 'venue', type: 'address' }, { name: 'amount', type: 'uint256' },
             { name: 'tokenOut', type: 'address' }, { name: 'minOut', type: 'uint256' },
             { name: 'data', type: 'bytes' }], outputs: [{ type: 'bytes' }] },
  { type: 'function', name: 'remainingToday', stateMutability: 'view',
    inputs: [{ name: 'owner', type: 'address' }], outputs: [{ type: 'uint256' }] },
] as const;

async function main() {
  // Canonical on both sides: this script is run by hand and the symbol comes off the command line.
  const token = TOKENS[canonicalSymbol(SYMBOL)] ?? STOCKS[stockKey(SYMBOL) ?? SYMBOL];
  if (!token) throw new Error(`Unknown symbol ${SYMBOL}`);

  /*
   * Ondo's tokenized equities cannot run on a fork at all.
   *
   * Their account code is the single byte 0xef — they are implemented natively inside the Base
   * node, not in EVM bytecode — so anvil and revm both halt with OpcodeNotFound the moment
   * anything touches them, including a plain balanceOf. They quote honestly against live Base and
   * can only be filled there.
   *
   * The tokenized-equity path is proved instead in contracts/test/XorrStocks.fork.t.sol, which
   * buys Backed's bNVDA (ordinary bytecode, real supply) through Aqua under a delegation policy.
   */
  const code = await pub.getBytecode({ address: tokenAddressOf(token) });
  if (!code || code.length <= 4) {
    console.error(
      `\n${SYMBOL} has no EVM bytecode on this chain (code: ${code ?? '0x'}).\n` +
        `Ondo's equities are native to the Base node, so no fork can execute them.\n` +
        `For the tokenized-equity path run:\n` +
        `  forge test --match-contract XorrStocksFork --fork-url $BASE_RPC\n`,
    );
    process.exitCode = 1;
    return;
  }
  const tokenAddress = tokenAddressOf(token);
  const decimals = token.decimals;

  console.log(`\nfork ${RPC}  block ${await pub.getBlockNumber()}  buying ${SPEND_USD} USDC of ${SYMBOL}\n`);

  // Fresh keys per run: nothing here is reused, and nothing is a well-known test key.
  const owner = privateKeyToAccount(generatePrivateKey());
  const delegate = privateKeyToAccount(generatePrivateKey());
  const deployer = privateKeyToAccount(generatePrivateKey());
  for (const a of [owner, delegate, deployer]) {
    await anvil('anvil_setBalance', [a.address, '0x8AC7230489E80000']); // 10 ETH
  }

  // 1. Deploy XorrDelegation from compiled artifact.
  const artifact = JSON.parse(
    await (await import('node:fs/promises')).readFile(
      new URL('../../contracts/out/XorrDelegation.sol/XorrDelegation.json', import.meta.url), 'utf8',
    ),
  ) as { bytecode: { object: Hex } };
  const deployWallet = createWalletClient({ account: deployer, chain, transport: http(RPC) });
  const deployHash = await deployWallet.deployContract({
    abi: DELEGATION_ABI, bytecode: artifact.bytecode.object, args: [USDC],
  });
  const { contractAddress } = await pub.waitForTransactionReceipt({ hash: deployHash });
  const delegation = contractAddress as Address;
  must('XorrDelegation deployed to the fork', !!delegation, delegation);

  // 2. Real USDC, taken from a real holder.
  const spend = parseUnits(String(SPEND_USD), 6);
  await fundUsdc(owner.address, parseUnits(String(CAP_USD), 6));
  const startUsdc = await pub.readContract({ address: USDC, abi: erc20Abi, functionName: 'balanceOf', args: [owner.address] });
  must('owner funded with real Base USDC', startUsdc >= spend, `${formatUnits(startUsdc, 6)} USDC`);

  // 3. The OWNER grants the policy and the approval. The bot cannot do this for them.
  const ownerWallet = createWalletClient({ account: owner, chain, transport: http(RPC) });
  const expiresAt = BigInt(Math.floor(Date.now() / 1000) + 7 * 86_400);
  await pub.waitForTransactionReceipt({
    hash: await ownerWallet.writeContract({
      address: delegation, abi: DELEGATION_ABI, functionName: 'grant',
      args: [delegate.address, parseUnits(String(CAP_USD), 6), expiresAt, [ROUTER]],
    }),
  });
  await pub.waitForTransactionReceipt({
    hash: await ownerWallet.writeContract({
      address: USDC, abi: erc20Abi, functionName: 'approve', args: [delegation, parseUnits(String(CAP_USD), 6)],
    }),
  });
  const remaining = await pub.readContract({ address: delegation, abi: DELEGATION_ABI, functionName: 'remainingToday', args: [owner.address] });
  must('policy on chain, cap readable', remaining === parseUnits(String(CAP_USD), 6), `${formatUnits(remaining, 6)} USDC left today`);

  // 4. Real 1inch calldata, receiver = the user.
  const swap = await buildSwap({
    inSymbol: 'USDC', outSymbol: SYMBOL, amount: SPEND_USD,
    from: delegation, receiver: owner.address,
  });
  must('1inch returned router calldata', swap.to.toLowerCase() === ROUTER.toLowerCase(), swap.to);

  // 5. The DELEGATE spends. This is the transaction a scheduled strategy signs at 3am.
  const delegateWallet = createWalletClient({ account: delegate, chain, transport: http(RPC) });
  const spendHash = await delegateWallet.writeContract({
    address: delegation, abi: DELEGATION_ABI, functionName: 'spend',
    args: [owner.address, USDC, swap.to, spend, tokenAddress, swap.minOut, swap.data],
  });
  const receipt = await pub.waitForTransactionReceipt({ hash: spendHash });
  must('delegate executed spend() on chain', receipt.status === 'success', `${spendHash} gas ${receipt.gasUsed}`);

  // 6. Where the money went.
  const [endUsdc, bought, strandedIn, strandedOut] = await Promise.all([
    pub.readContract({ address: USDC, abi: erc20Abi, functionName: 'balanceOf', args: [owner.address] }),
    pub.readContract({ address: tokenAddress, abi: erc20Abi, functionName: 'balanceOf', args: [owner.address] }),
    pub.readContract({ address: USDC, abi: erc20Abi, functionName: 'balanceOf', args: [delegation] }),
    pub.readContract({ address: tokenAddress, abi: erc20Abi, functionName: 'balanceOf', args: [delegation] }),
  ]);
  must('USDC actually left the wallet', startUsdc - endUsdc === spend, `-${formatUnits(spend, 6)} USDC`);
  must(`${SYMBOL} landed in the USER's wallet`, bought > 0n, `${formatUnits(bought, decimals)} ${SYMBOL}`);
  must('delegation contract kept no USDC', strandedIn === 0n, `${formatUnits(strandedIn, 6)}`);
  must(`delegation contract kept no ${SYMBOL}`, strandedOut === 0n, `${formatUnits(strandedOut, decimals)}`);

  const left = await pub.readContract({ address: delegation, abi: DELEGATION_ABI, functionName: 'remainingToday', args: [owner.address] });
  must('daily cap decremented by the spend', left === parseUnits(String(CAP_USD - SPEND_USD), 6), `${formatUnits(left, 6)} USDC left`);

  // 7. The cap is a real wall, not a label.
  const over = await buildSwap({ inSymbol: 'USDC', outSymbol: SYMBOL, amount: CAP_USD, from: delegation, receiver: owner.address });
  let blocked = false;
  try {
    await pub.simulateContract({
      account: delegate, address: delegation, abi: DELEGATION_ABI, functionName: 'spend',
      args: [owner.address, USDC, over.to, parseUnits(String(CAP_USD), 6), tokenAddress, over.minOut, over.data],
    });
  } catch { blocked = true; }
  must('a spend past the daily cap reverts', blocked);

  const impliedPrice = SPEND_USD / Number(formatUnits(bought, decimals));
  console.log(`\n  ${SYMBOL} filled at ~$${impliedPrice.toFixed(2)} / share\n`);
}

await main();
