/**
 * Fork end-to-end for tier 4: idle USDC supplied to real Aave v3 under a real delegation.
 *
 * The point of a separate script from `fork-e2e.ts` is that this proves a DIFFERENT claim. That one
 * shows the delegation can buy through a router. This one shows the same permission layer works for
 * a venue that is not a router at all — the money leaves the wallet, earns, and the receipt for it
 * belongs to the user and not to us, because `supply()` names the recipient.
 *
 * The assertions that matter are the negative ones. A venue that is not on the allowlist must be
 * refused, a supply past the cap must revert, and the delegation contract must hold nothing when
 * the dust settles. Anything can move money; the product is what stops it.
 *
 * Run: npx tsx server/src/fork-yield.ts   (anvil --fork-url https://mainnet.base.org)
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
import { supplyCalldata, withdrawCalldata, AAVE_POOL } from './venues/aave.js';

const RPC = process.env.FORK_RPC ?? 'http://127.0.0.1:8545';
const USDC: Address = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const ROUTER: Address = '0x111111125421cA6dc452d289314280a0f8842A65';
const SUPPLY_USD = 400;
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

function must(label: string, cond: boolean, detail = '') {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${detail ? `  — ${detail}` : ''}`);
  if (!cond) process.exitCode = 1;
}

const DELEGATION_ABI = [
  { type: 'constructor', stateMutability: 'nonpayable', inputs: [{ name: 'settlementToken', type: 'address' }] },
  { type: 'function', name: 'grant', stateMutability: 'nonpayable',
    inputs: [{ name: 'delegate', type: 'address' }, { name: 'dailyCap', type: 'uint256' },
             { name: 'expiresAt', type: 'uint64' }, { name: 'venues', type: 'address[]' }], outputs: [] },
  // `tokenOut`/`minOut`: the owner's balance of what the call produces must rise by the floor (PLAN.md 1.4).
  { type: 'function', name: 'spend', stateMutability: 'nonpayable',
    inputs: [{ name: 'owner', type: 'address' }, { name: 'token', type: 'address' },
             { name: 'venue', type: 'address' }, { name: 'amount', type: 'uint256' },
             { name: 'tokenOut', type: 'address' }, { name: 'minOut', type: 'uint256' },
             { name: 'data', type: 'bytes' }], outputs: [{ type: 'bytes' }] },
  { type: 'function', name: 'closePosition', stateMutability: 'nonpayable',
    inputs: [{ name: 'owner', type: 'address' }, { name: 'token', type: 'address' },
             { name: 'venue', type: 'address' }, { name: 'amount', type: 'uint256' },
             { name: 'tokenOut', type: 'address' }, { name: 'minOut', type: 'uint256' },
             { name: 'data', type: 'bytes' }], outputs: [{ type: 'bytes' }] },
  { type: 'function', name: 'remainingToday', stateMutability: 'view',
    inputs: [{ name: 'owner', type: 'address' }], outputs: [{ type: 'uint256' }] },
  { type: 'function', name: 'isVenueAllowed', stateMutability: 'view',
    inputs: [{ name: 'owner', type: 'address' }, { name: 'venue', type: 'address' }],
    outputs: [{ type: 'bool' }] },
] as const;

const POOL_ABI = [
  { type: 'function', name: 'getReserveData', stateMutability: 'view',
    inputs: [{ name: 'asset', type: 'address' }],
    outputs: [{ type: 'tuple', components: [
      { name: 'configuration', type: 'uint256' }, { name: 'liquidityIndex', type: 'uint128' },
      { name: 'currentLiquidityRate', type: 'uint128' }, { name: 'variableBorrowIndex', type: 'uint128' },
      { name: 'currentVariableBorrowRate', type: 'uint128' }, { name: 'currentStableBorrowRate', type: 'uint128' },
      { name: 'lastUpdateTimestamp', type: 'uint40' }, { name: 'id', type: 'uint16' },
      { name: 'aTokenAddress', type: 'address' }, { name: 'stableDebtTokenAddress', type: 'address' },
      { name: 'variableDebtTokenAddress', type: 'address' }, { name: 'interestRateStrategyAddress', type: 'address' },
      { name: 'accruedToTreasury', type: 'uint128' }, { name: 'unbacked', type: 'uint128' },
      { name: 'isolationModeTotalDebt', type: 'uint128' }] }] },
] as const;

async function main() {
  console.log(`\nfork ${RPC}  block ${await pub.getBlockNumber()}  supplying ${SUPPLY_USD} USDC to Aave v3\n`);

  // The reserve, read from the pool rather than assumed. This is also the check the planner makes
  // before it moves anything: a zeroed struct means "not listed", not "0% today".
  const reserve = await pub.readContract({
    address: AAVE_POOL, abi: POOL_ABI, functionName: 'getReserveData', args: [USDC],
  });
  const aToken = reserve.aTokenAddress;
  must('Aave lists a live USDC reserve on this chain', reserve.lastUpdateTimestamp > 0, `aToken ${aToken}`);

  const owner = privateKeyToAccount(generatePrivateKey());
  const delegate = privateKeyToAccount(generatePrivateKey());
  const deployer = privateKeyToAccount(generatePrivateKey());
  for (const a of [owner, delegate, deployer]) {
    await anvil('anvil_setBalance', [a.address, '0x8AC7230489E80000']);
  }

  // 1. Deploy the delegation.
  const artifact = JSON.parse(
    await (await import('node:fs/promises')).readFile(
      new URL('../../contracts/out/XorrDelegation.sol/XorrDelegation.json', import.meta.url), 'utf8',
    ),
  ) as { bytecode: { object: Hex } };
  const deployWallet = createWalletClient({ account: deployer, chain, transport: http(RPC) });
  const { contractAddress } = await pub.waitForTransactionReceipt({
    hash: await deployWallet.deployContract({ abi: DELEGATION_ABI, bytecode: artifact.bytecode.object, args: [USDC] }),
  });
  const delegation = contractAddress as Address;
  must('XorrDelegation deployed to the fork', !!delegation, delegation);

  // 2. Real USDC from a real holder. The aToken itself custodies the reserve's underlying, so it
  //    is the largest honest source of USDC on this chain.
  const need = parseUnits(String(CAP_USD), 6);
  await anvil('anvil_impersonateAccount', [aToken]);
  await anvil('anvil_setBalance', [aToken, '0xDE0B6B3A7640000']);
  await pub.waitForTransactionReceipt({
    hash: await createWalletClient({ account: aToken, chain, transport: http(RPC) }).writeContract({
      address: USDC, abi: erc20Abi, functionName: 'transfer', args: [owner.address, need],
    }),
  });
  await anvil('anvil_stopImpersonatingAccount', [aToken]);
  const startUsdc = await pub.readContract({ address: USDC, abi: erc20Abi, functionName: 'balanceOf', args: [owner.address] });
  must('owner funded with real Base USDC', startUsdc >= need, `${formatUnits(startUsdc, 6)} USDC`);

  // 3. The OWNER grants — allowlisting the POOL, not the router. This is the user's decision and
  //    the bot cannot make it for them.
  const ownerWallet = createWalletClient({ account: owner, chain, transport: http(RPC) });
  /*
   * Expiry comes from the CHAIN's clock, not this machine's.
   *
   * `block.timestamp` is what the contract compares against, and a fork's clock is whatever the
   * last test left it at. Taking the expiry from `Date.now()` reverted with "expiry in the past"
   * on a fork another run had warped forward — the grant was fine, the reference frame was wrong.
   */
  const chainNow = (await pub.getBlock()).timestamp;
  await pub.waitForTransactionReceipt({
    hash: await ownerWallet.writeContract({
      address: delegation, abi: DELEGATION_ABI, functionName: 'grant',
      args: [delegate.address, need, chainNow + BigInt(7 * 86_400), [AAVE_POOL]],
    }),
  });
  await pub.waitForTransactionReceipt({
    hash: await ownerWallet.writeContract({
      address: USDC, abi: erc20Abi, functionName: 'approve', args: [delegation, need],
    }),
  });
  const poolAllowed = await pub.readContract({ address: delegation, abi: DELEGATION_ABI, functionName: 'isVenueAllowed', args: [owner.address, AAVE_POOL] });
  const routerAllowed = await pub.readContract({ address: delegation, abi: DELEGATION_ABI, functionName: 'isVenueAllowed', args: [owner.address, ROUTER] });
  must('the Aave Pool is on the owner’s allowlist', poolAllowed === true);
  must('a venue they did NOT grant is not allowed', routerAllowed === false, '1inch router, ungranted in this run');

  // 4. The delegate supplies. This is the transaction a scheduled tier-4 strategy signs.
  const amountRaw = parseUnits(String(SUPPLY_USD), 6);
  const data = supplyCalldata({ asset: USDC, amountRaw, owner: owner.address });
  const delegateWallet = createWalletClient({ account: delegate, chain, transport: http(RPC) });
  const receipt = await pub.waitForTransactionReceipt({
    hash: await delegateWallet.writeContract({
      address: delegation, abi: DELEGATION_ABI, functionName: 'spend',
      // The aToken is what a supply produces; a basis point of room for Aave's ray rounding.
      args: [owner.address, USDC, AAVE_POOL, amountRaw, aToken, (amountRaw * 9_999n) / 10_000n, data],
    }),
  });
  must('delegate supplied through spend()', receipt.status === 'success', `${receipt.transactionHash} gas ${receipt.gasUsed}`);

  // 5. Where the money went.
  const [endUsdc, aBal, strandedUsdc, strandedA] = await Promise.all([
    pub.readContract({ address: USDC, abi: erc20Abi, functionName: 'balanceOf', args: [owner.address] }),
    pub.readContract({ address: aToken, abi: erc20Abi, functionName: 'balanceOf', args: [owner.address] }),
    pub.readContract({ address: USDC, abi: erc20Abi, functionName: 'balanceOf', args: [delegation] }),
    pub.readContract({ address: aToken, abi: erc20Abi, functionName: 'balanceOf', args: [delegation] }),
  ]);
  must('USDC actually left the wallet', startUsdc - endUsdc === amountRaw, `-${formatUnits(amountRaw, 6)} USDC`);
  /*
   * 1:1 to within a wei, not exactly 1:1.
   *
   * aUSDC is a scaled-balance token: the stored balance is `amount rayDiv liquidityIndex` and
   * reading it multiplies back, so a $400 supply reads as 399.999999 — sometimes 399.999998, since
   * each of the two roundings can lose a unit. That is Aave's rounding and it always rounds toward
   * the pool. Asserting exact equality failed for a supply that was completely correct, which is
   * the wrong lesson to take from a red test.
   *
   * The tolerance is a millionth of a dollar, not a percentage, and that is the point: it is loose
   * enough for integer rounding and far too tight to hide a fee. Aave taking even a single basis
   * point of this supply would be 4,000 units and would fail here.
   */
  const DUST = 10n;
  must(
    'the aToken landed in the USER’s wallet 1:1',
    amountRaw - aBal <= DUST && aBal > 0n,
    `${formatUnits(aBal, 6)} aUSDC for ${formatUnits(amountRaw, 6)} supplied (${amountRaw - aBal} units of rounding)`,
  );
  must('delegation contract kept no USDC', strandedUsdc === 0n, formatUnits(strandedUsdc, 6));
  must('delegation contract kept no aUSDC', strandedA === 0n, formatUnits(strandedA, 6));

  const left = await pub.readContract({ address: delegation, abi: DELEGATION_ABI, functionName: 'remainingToday', args: [owner.address] });
  must('daily cap decremented by the supply', left === need - amountRaw, `${formatUnits(left, 6)} USDC left today`);

  /*
   * 6. It is actually earning.
   *
   * A year of fork time, then read the balance again — aUSDC rebases, so the balance growing IS
   * the interest. Without this the test proves only that money moved.
   *
   * Snapshotted, because the clock is shared. `evm_increaseTime` is not scoped to this script: it
   * moved the whole anvil a year into the future and every policy granted against wall-clock time
   * — including the ones the running server had already issued — instantly read as expired. A test
   * that has to run first to be correct is not a test. Revert puts the clock back.
   */
  const snapshot = await anvil('evm_snapshot', []);
  await anvil('evm_increaseTime', [365 * 86_400]);
  await anvil('evm_mine', []);
  const grown = await pub.readContract({ address: aToken, abi: erc20Abi, functionName: 'balanceOf', args: [owner.address] });
  const earned = Number(formatUnits(grown - aBal, 6));
  must('the supplied balance earns over time', grown > aBal, `+$${earned.toFixed(2)} after a year of fork time`);
  await anvil('evm_revert', [snapshot]);
  const clockBack = (await pub.getBlock()).timestamp;
  must('the fork clock is left where it was found', clockBack - chainNow < 3_600n, `${clockBack - chainNow}s elapsed`);

  // 7. The cap is a wall. Supplying more than remains must revert.
  let capped = false;
  try {
    await pub.simulateContract({
      account: delegate, address: delegation, abi: DELEGATION_ABI, functionName: 'spend',
      args: [owner.address, USDC, AAVE_POOL, need, aToken, (need * 9_999n) / 10_000n, supplyCalldata({ asset: USDC, amountRaw: need, owner: owner.address })],
    });
  } catch { capped = true; }
  must('a supply past the daily cap reverts', capped);

  // 8. The allowlist is a wall. The same calldata to an ungranted venue must be refused BEFORE any
  //    money moves — this is the check that makes "only venues you approved" true rather than a
  //    sentence on a screen.
  let refused = false;
  try {
    await pub.simulateContract({
      account: delegate, address: delegation, abi: DELEGATION_ABI, functionName: 'spend',
      args: [owner.address, USDC, ROUTER, parseUnits('1', 6), aToken, 1n, data],
    });
  } catch { refused = true; }
  must('the same supply to an ungranted venue is refused', refused, 'VenueNotAllowed');

  /*
   * 9. The user can get it back, WITHOUT the bot.
   *
   * The first version of this routed the withdrawal through `closePosition`, and it reverted: the
   * contract pulls the token it is closing, and the owner had only ever approved USDC. The fix is
   * not to add an aToken approval to the grant — it is to notice what the revert was telling us.
   *
   * Burning your own aTokens needs no approval from anyone. The user calls the Pool directly, with
   * one signature, and the delegation is not in the path at all. Granting the bot the power to
   * move the receipt token would buy nothing and would weaken the one promise this app makes
   * loudest: it cannot move your money out. So the bot's tier-4 permission is supply-only, and
   * this asserts the exit is genuinely the user's.
   */
  const withdrawRaw = parseUnits('100', 6);
  const before = await pub.readContract({ address: USDC, abi: erc20Abi, functionName: 'balanceOf', args: [owner.address] });
  /*
   * An explicit gas limit, because the estimate is measurably not enough.
   *
   * This assertion failed about one run in three, and `eth_call` succeeded every single time —
   * which is the signature of running out of gas rather than reverting. Instrumenting it caught
   * the proof: one run estimated 172,488 and used 177,503. Aave accrues interest on withdraw, and
   * when the block timestamp moves between the estimate and the mine it writes a slot the estimate
   * never priced. The buffer is not superstition; it is that slot.
   */
  const withdrawData = withdrawCalldata({ asset: USDC, amountRaw: withdrawRaw, owner: owner.address });
  const wReceipt = await pub.waitForTransactionReceipt({
    hash: await ownerWallet.sendTransaction({
      to: AAVE_POOL,
      data: withdrawData,
      gas: (await pub.estimateGas({ account: owner.address, to: AAVE_POOL, data: withdrawData })) * 2n,
    }),
  });
  const after = await pub.readContract({ address: USDC, abi: erc20Abi, functionName: 'balanceOf', args: [owner.address] });
  must(
    'the user can withdraw straight from Aave, no delegation involved',
    wReceipt.status === 'success' && after - before === withdrawRaw,
    `tx ${wReceipt.status}, +${formatUnits(after - before, 6)} USDC`,
  );

  // And the bot cannot do it for them, because it was never given the receipt token to move.
  let botCannotWithdraw = false;
  try {
    await pub.simulateContract({
      account: delegate, address: delegation, abi: DELEGATION_ABI, functionName: 'closePosition',
      args: [owner.address, aToken, AAVE_POOL, withdrawRaw, USDC, (withdrawRaw * 9_999n) / 10_000n, withdrawCalldata({ asset: USDC, amountRaw: withdrawRaw, owner: owner.address })],
    });
  } catch { botCannotWithdraw = true; }
  must('the bot cannot pull the position out on its own', botCannotWithdraw, 'no aToken approval was ever granted');

  const capAfter = await pub.readContract({ address: delegation, abi: DELEGATION_ABI, functionName: 'remainingToday', args: [owner.address] });
  must('the user’s own withdrawal does not touch the spending cap', capAfter === left, `${formatUnits(capAfter, 6)} USDC still available`);

  console.log(
    `\n  $${SUPPLY_USD} supplied, $${earned.toFixed(2)} earned over a simulated year, ` +
      `$${formatUnits(withdrawRaw, 6)} withdrawn by the user on demand.\n`,
  );
}

await main();
