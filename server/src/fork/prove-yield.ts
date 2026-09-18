/**
 * Tier 4 — idle cash to yield — end to end on a fork of X Layer mainnet (PLAN.md P2.14, D15).
 *
 * Nothing here is simulated. The owner is a fresh key that signs its own approvals, grant and withdrawal; the executor's
 * own strategy path (`runStrategy` → `planYieldRotation` → `chooseSettlement` → `spend`) runs a `yield-rotation` strategy
 * row exactly as the scheduler would, against the fork's real Uniswap v3 pools and Aave v3 reserve state. Every claim is
 * read back from the chain and the database. The fork's only liberty is the owner's starting USDC, sent from the
 * fork-only reserve (`fork/anvil.ts`).
 *
 *   0. the owner approves every token the grant asks for (USDT0 among them) and grants with the CURRENT
 *      `SETTLEMENT_VENUES`, which name Aave's pool;
 *   1. run one: USDT0 out-earns USDC on Aave, so idle USDC is swapped to USDT0 through Uniswap — the owner holds USDT0;
 *   2. run two (the next day's run): that USDT0 is supplied to Aave on the owner's behalf — the OWNER holds aUSDT0, the
 *      delegation holds nothing, and the supply is recorded as one;
 *   3. the owner withdraws with the calldata `/yield/withdraw-calldata` builds, signed by the owner, and the executor
 *      records it as the exit from Aave in USDT0.
 *
 * Run (anvil forking X Layer, `npm run setup:fork` done):
 *   cd server && set -a && . ../.env && . ./.env.fork && set +a && npx tsx src/fork/prove-yield.ts
 */
import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { Hono } from 'hono';
import {
  createPublicClient,
  createWalletClient,
  decodeFunctionData,
  erc20Abi,
  formatUnits,
  http,
  maxUint256,
  parseAbi,
  parseEther,
  parseUnits,
  toHex,
  type Address,
  type Hex,
} from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { xLayer } from 'viem/chains';
import { FORK_USDC_RESERVE, anvil, dealErc20 } from './anvil.js';

const RPC = process.env.FORK_RPC ?? 'http://127.0.0.1:8545';
const chain = { ...xLayer, rpcUrls: { default: { http: [RPC] }, public: { http: [RPC] } } };
const pub = createPublicClient({ chain, transport: http(RPC), cacheTime: 0 });
const WITHDRAW = parseAbi(['function withdraw(address asset, uint256 amount, address to) returns (uint256)']);

let failures = 0;
function check(ok: boolean, what: string, detail = ''): boolean {
  if (!ok) failures += 1;
  console.log(`${ok ? '  ✓' : '  ✗'} ${what}${detail ? `  — ${detail}` : ''}`);
  return ok;
}
/** A step the rest stands on: when it fails, nothing after it would prove anything. */
function need(ok: boolean, what: string, detail = ''): void {
  if (!check(ok, what, detail)) throw new Error(`stopped at: ${what}`);
}

async function main() {
  if (process.env.XORR_CHAIN !== 'xlayer-fork') throw new Error('Run with XORR_CHAIN=xlayer-fork (source .env.fork).');
  const node = String(await anvil(RPC, 'web3_clientVersion', []));
  if (!/^anvil\//i.test(node)) throw new Error(`${RPC} is "${node}", not anvil. This only runs against a fork.`);
  if ((await pub.getChainId()) !== xLayer.id) throw new Error(`${RPC} is not a fork of X Layer mainnet (chain 196).`);

  // Imported after the guard: these read XORR_CHAIN, the delegation address and DATABASE_URL at load.
  const { AAVE_V3_POOL, ADDRESSES, APPROVABLE_TOKENS, SETTLEMENT_VENUES, CHAIN_KEY } = await import('../evm/chains.js');
  const { DELEGATION_ABI, DELEGATION_ADDRESS, delegatePublicKey, isVenueAllowed } = await import('../evm/delegation.js');
  const { runStrategy } = await import('../executor/run.js');
  const { usdt0Reserve, usdcReserve } = await import('../market/yield.js');
  const { market } = await import('../routes/market.js');
  const { recordWithdrawal } = await import('../routes/withdrawals.js');
  const { query, one, pool } = await import('../db/index.js');

  try {
    const code = await pub.getCode({ address: DELEGATION_ADDRESS });
    if (!code || code === '0x') throw new Error(`No XorrDelegation at ${DELEGATION_ADDRESS}. Run npm run setup:fork first.`);
    if (!AAVE_V3_POOL) throw new Error('AAVE_V3_POOL is null on xlayer-fork — the chain config is wrong.');
    const POOL = AAVE_V3_POOL;
    const USDC = ADDRESSES.usdc as Address;
    const USDT0 = ADDRESSES.usdt0 as Address;
    const earn = await usdt0Reserve(0);
    const cash = await usdcReserve(0);
    const A_USDT0 = earn.aToken;
    const bal = (token: Address, who: Address) =>
      pub.readContract({ address: token, abi: erc20Abi, functionName: 'balanceOf', args: [who] });
    const pct = (apy: number) => `${(apy * 100).toFixed(3)}%`;

    console.log(`\nTier 4 on a fork of X Layer — block ${await pub.getBlockNumber()}`);
    console.log(`  delegation ${DELEGATION_ADDRESS}\n  delegate   ${delegatePublicKey}\n  Aave pool  ${POOL}`);
    console.log(`  venues     ${SETTLEMENT_VENUES.join(', ')}`);
    console.log(`  Aave v3 on X Layer pays ${pct(earn.apy)} on USDT0 (aToken ${A_USDT0}), ${pct(cash.apy)} on USDC\n`);
    need(SETTLEMENT_VENUES.includes(POOL), 'the venues a grant names include Aave’s X Layer pool');
    need(
      APPROVABLE_TOKENS.some((t) => t.symbol === 'USDT0' && t.address === USDT0),
      'the tokens a grant approves include USDT0',
    );

    // ── 0. The owner: a fresh key, funded, approving and granting for itself ─────────────────────
    console.log('0. The owner');
    const ownerAccount = privateKeyToAccount(generatePrivateKey());
    const owner = ownerAccount.address;
    const ownerWallet = createWalletClient({ account: ownerAccount, chain, transport: http(RPC) });
    await anvil(RPC, 'anvil_setBalance', [owner, toHex(parseEther('1'))]);
    await dealErc20({ rpc: RPC, token: USDC, holder: FORK_USDC_RESERVE, amount: parseUnits('1000000', 6) });
    await anvil(RPC, 'anvil_impersonateAccount', [FORK_USDC_RESERVE]);
    await anvil(RPC, 'anvil_setBalance', [FORK_USDC_RESERVE, toHex(parseEther('1'))]);
    let fundTx: Hex;
    try {
      const reserve = createWalletClient({ account: FORK_USDC_RESERVE, chain, transport: http(RPC) });
      fundTx = await reserve.writeContract({ address: USDC, abi: erc20Abi, functionName: 'transfer', args: [owner, parseUnits('1000', 6)] });
      await pub.waitForTransactionReceipt({ hash: fundTx });
    } finally {
      await anvil(RPC, 'anvil_stopImpersonatingAccount', [FORK_USDC_RESERVE]).catch(() => undefined);
    }
    console.log(`  owner ${owner}`);
    need((await bal(USDC, owner)) === parseUnits('1000', 6), 'owner holds 1,000 of Circle’s USDC', fundTx);

    const send = async (label: string, tx: Promise<Hex>): Promise<Hex> => {
      const hash = await tx;
      const r = await pub.waitForTransactionReceipt({ hash });
      need(r.status === 'success', label, hash);
      return hash;
    };
    for (const t of APPROVABLE_TOKENS) {
      await send(
        `owner approves ${t.symbol} to the delegation`,
        ownerWallet.writeContract({ address: t.address, abi: erc20Abi, functionName: 'approve', args: [DELEGATION_ADDRESS, maxUint256] }),
      );
    }
    const now = (await pub.getBlock()).timestamp;
    await send(
      'owner grants $1,000/day for 7 days, on the current SETTLEMENT_VENUES',
      ownerWallet.writeContract({
        address: DELEGATION_ADDRESS,
        abi: DELEGATION_ABI,
        functionName: 'grant',
        args: [delegatePublicKey as Address, parseUnits('1000', 6), now + 7n * 86_400n, [...SETTLEMENT_VENUES]],
      }),
    );
    need(await isVenueAllowed(owner, POOL), 'the chain says the delegation may call Aave’s pool for this owner');

    // The wallet as sign-in writes it, and the strategy as the app writes it.
    const walletId = randomUUID();
    const userId = `prove-yield:${owner.toLowerCase()}`;
    await query(`INSERT INTO wallets (id, user_id, address, kind, cluster) VALUES ($1, $2, $3, 'embedded', $4)`, [
      walletId,
      userId,
      owner,
      CHAIN_KEY,
    ]);
    const strategyId = randomUUID();
    await query(
      `INSERT INTO strategies (id, wallet_id, kind, state, label, symbol, params, cadence, next_run_at, daily_allocation_usd)
       VALUES ($1,$2,'yield-rotation','live','Idle cash to Aave','USDC',$3,'daily',now(),$4)`,
      [strategyId, walletId, JSON.stringify({ usd: 100, keepCashUsd: 900, minMoveUsd: 25 }), 250],
    );
    type Row = Parameters<typeof runStrategy>[0];
    const row = async () => (await one<Row>(`SELECT * FROM strategies WHERE id = $1`, [strategyId]))!;
    const delegationEmpty = async () =>
      (await bal(USDC, DELEGATION_ADDRESS)) === 0n &&
      (await bal(USDT0, DELEGATION_ADDRESS)) === 0n &&
      (await bal(A_USDT0, DELEGATION_ADDRESS)) === 0n;

    // ── 1. Run one: idle USDC → USDT0 through Uniswap ──────────────────────────────────────────
    console.log('\n1. First run — $100 of idle USDC (keeping $900) is swapped to USDT0');
    const usdc0 = await bal(USDC, owner);
    const today = new Date();
    const first = await runStrategy(await row(), today);
    const swapped = first.status === 'filled' ? first : null;
    need(!!swapped, 'the run filled', swapped ? swapped.signature : JSON.stringify(first));
    const usdt0Held = await bal(USDT0, owner);
    check(usdc0 - (await bal(USDC, owner)) === parseUnits('100', 6), 'exactly $100 of USDC left the owner');
    check(usdt0Held > parseUnits('99.5', 6), 'the owner holds the USDT0', `${formatUnits(usdt0Held, 6)} USDT0`);
    check(await delegationEmpty(), 'the delegation holds nothing');
    const run1 = await one<{ venue: string; side: string; status: string }>(
      `SELECT venue, side, status FROM strategy_runs WHERE id = $1`,
      [swapped!.runId],
    );
    check(run1?.venue === 'uniswap-v3' && run1.side === 'buy', 'recorded as a Uniswap v3 buy of USDT0', JSON.stringify(run1));
    const why1 = await one<{ detail: string }>(`SELECT detail FROM audit_log WHERE wallet_id = $1 AND signature = $2`, [
      walletId,
      swapped!.signature,
    ]);
    check(/next run supplies it/.test(why1?.detail ?? ''), 'the activity row says why', why1?.detail);

    // ── 2. Run two (the next day's run): USDT0 → Aave, aUSDT0 to the OWNER ─────────────────────
    console.log('\n2. Next run — the USDT0 is supplied to Aave on the owner’s behalf');
    const aBefore = await bal(A_USDT0, owner);
    const tomorrow = new Date(today.getTime() + 86_400_000);
    const second = await runStrategy(await row(), tomorrow);
    const supplied = second.status === 'filled' ? second : null;
    need(!!supplied, 'the run filled', supplied ? supplied.signature : JSON.stringify(second));
    const aHeld = (await bal(A_USDT0, owner)) - aBefore;
    const supplyReceipt = await pub.getTransactionReceipt({ hash: supplied!.signature as Hex });
    check(supplyReceipt.to?.toLowerCase() === DELEGATION_ADDRESS.toLowerCase(), 'sent through the delegation, signed by the delegate');
    // The run supplies what it holds, held to the run's $100 budget: the swap's few cents over $100 stay as dust.
    const suppliedRaw = usdt0Held > parseUnits('100', 6) ? parseUnits('100', 6) : usdt0Held;
    const left = await bal(USDT0, owner);
    check(left === usdt0Held - suppliedRaw, 'the owner’s USDT0 was supplied, up to the run’s $100', `${formatUnits(left, 6)} USDT0 left`);
    check(aHeld * 10_000n >= suppliedRaw * 9_999n, 'the OWNER holds aUSDT0 for it', `${formatUnits(aHeld, 6)} aUSDT0 for ${formatUnits(suppliedRaw, 6)} USDT0`);
    check(await delegationEmpty(), 'the delegation holds nothing — no USDC, USDT0 or aUSDT0');
    const run2 = await one<{ venue: string; side: string; usd: string }>(
      `SELECT venue, side, usd::text FROM strategy_runs WHERE id = $1`,
      [supplied!.runId],
    );
    check(run2?.venue === 'aave' && run2.side === 'supply', 'recorded as a supply to Aave', JSON.stringify(run2));
    const audit2 = await one<{ action: string; kind: string }>(
      `SELECT action, kind FROM audit_log WHERE wallet_id = $1 AND signature = $2`,
      [walletId, supplied!.signature],
    );
    check(audit2?.kind === 'yield' && /USDT0 to Aave on X Layer/.test(audit2.action), 'the activity row names it', audit2?.action);
    const book = await one<{ units: string }>(`SELECT units::text FROM positions WHERE wallet_id = $1 AND symbol = 'USDT0'`, [walletId]);
    check(
      !!book && Math.abs(Number(book.units) - Number(formatUnits(left, 6))) < 1e-6,
      'the supplied USDT0 left the book, which now matches the wallet',
      `${book?.units} USDT0 booked`,
    );
    const remaining = (await pub.readContract({
      address: DELEGATION_ADDRESS,
      abi: DELEGATION_ABI,
      functionName: 'remainingToday',
      args: [owner],
    })) as bigint;
    check(
      remaining === parseUnits('900', 6) - suppliedRaw,
      'both legs counted against the on-chain cap, the supply in USDT0’s own 6-decimal units',
      `$${formatUnits(remaining, 6)} left today`,
    );

    // ── 3. The owner withdraws, with the calldata the executor builds ───────────────────────────
    console.log('\n3. The owner withdraws USDT0 from Aave');
    const app = new Hono();
    app.use('*', async (c, next) => {
      c.set('user' as never, { userId } as never);
      await next();
    });
    app.route('/', market);
    const position = (await (await app.request('/yield/position')).json()) as Record<string, unknown>;
    check(
      position.available === true && Number(position.suppliedUsd) > 99 && position.symbol === 'USDT0',
      '/yield/position shows the supply',
      `${position.suppliedUsd} USD supplied at ${pct(Number(position.apy))}`,
    );
    const exit = (await (
      await app.request('/yield/withdraw-calldata', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ usd: null }),
      })
    ).json()) as { to: Address; data: Hex; isMax: boolean; asset: string };
    const exitArgs = decodeFunctionData({ abi: WITHDRAW, data: exit.data }).args as readonly [Address, bigint, Address];
    need(
      exit.to === POOL && exitArgs[0] === USDT0 && exitArgs[1] === maxUint256 && exitArgs[2] === owner,
      'the calldata withdraws all USDT0, from the X Layer pool, to the owner',
      `withdraw(${exitArgs[0]}, max, ${exitArgs[2]})`,
    );
    const usdt0Before = await bal(USDT0, owner);
    const aAtExit = await bal(A_USDT0, owner);
    const gas = await pub.estimateGas({ account: owner, to: exit.to, data: exit.data });
    const exitTx = await send(
      'the owner signed the withdrawal',
      ownerWallet.sendTransaction({ to: exit.to, data: exit.data, gas: (gas * 13n) / 10n }),
    );
    const back = (await bal(USDT0, owner)) - usdt0Before;
    check((await bal(A_USDT0, owner)) === 0n, 'the aUSDT0 balance is zero, not dust');
    check(back >= aAtExit, 'the owner holds the USDT0 again, with any interest', `${formatUnits(back, 6)} USDT0 back`);
    check(await delegationEmpty(), 'the delegation still holds nothing');
    const recorded = await recordWithdrawal((await one(`SELECT * FROM wallets WHERE id = $1`, [walletId]))!, exitTx);
    const aave = recorded.body.aave as { symbol: string; amount: string } | null;
    check(
      recorded.body.status === 'confirmed' && aave?.symbol === 'USDT0' && Number(aave.amount) === Number(formatUnits(back, 6)),
      'recorded as the exit from Aave, in USDT0',
      JSON.stringify(aave),
    );

    console.log('\n  transactions:');
    console.log(`    fund      ${fundTx}`);
    console.log(`    swap      ${swapped!.signature}`);
    console.log(`    supply    ${supplied!.signature}`);
    console.log(`    withdraw  ${exitTx}`);
  } finally {
    await pool.end().catch(() => undefined);
  }
}

try {
  await main();
} catch (e) {
  failures += 1;
  console.log(`\n${e instanceof Error ? e.message : String(e)}`);
}
console.log(failures === 0 ? '\nALL CHECKS PASSED\n' : `\n${failures} CHECK(S) FAILED\n`);
process.exit(failures === 0 ? 0 : 1);
