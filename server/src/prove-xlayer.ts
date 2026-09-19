/**
 * The product, end to end, on a fork of X Layer mainnet (PLAN.md P3.4).
 *
 * Nothing here is simulated. The owner is a fresh key that signs its own approvals, grant and revoke; the executor's
 * own order path (`placeOrder` → `runStrategy` → `chooseSettlement` → `spend`) prices the trade in X Layer's Uniswap v3
 * pools and settles it through `XorrDelegation`, and every claim below is read back from the chain and the database.
 * The fork's only liberty is the owner's starting USDC, sent from the fork-only reserve (`fork/anvil.ts`).
 *
 *   1. a $50 buy of wrapped TSLAx fills, lands in the OWNER's wallet, and is booked (run, position, audit row);
 *   2. a $60 buy of NVDAx on the same day is refused by the contract's $100 cap, and nothing is sent;
 *   3. the TSLAx position is sold back to USDC through `closePosition`, which never spends the cap;
 *   4. the owner revokes, and the next order is refused before anything is signed.
 *
 * Run (anvil forking X Layer, `npm run setup:fork` done):
 *   cd server && set -a && . ../.env && . ./.env.fork && set +a && npx tsx src/prove-xlayer.ts
 */
import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import {
  createPublicClient,
  createWalletClient,
  erc20Abi,
  formatUnits,
  http,
  maxUint256,
  parseEther,
  parseUnits,
  toHex,
  type Address,
  type Hex,
} from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { xLayer } from 'viem/chains';
import { FORK_USDC_RESERVE, anvil, dealErc20 } from './fork/anvil.js';

const RPC = process.env.FORK_RPC ?? 'http://127.0.0.1:8545';
const chain = { ...xLayer, rpcUrls: { default: { http: [RPC] }, public: { http: [RPC] } } };
const pub = createPublicClient({ chain, transport: http(RPC) });
// See fork-bootstrap.ts: a fork's first touch of a contract waits on X Layer's rate-limited RPC.
const RECEIPT = { timeout: 600_000, pollingInterval: 1_000 } as const;

let failures = 0;
function check(ok: boolean, what: string, detail = ''): void {
  if (!ok) failures += 1;
  console.log(`${ok ? '  ✓' : '  ✗'} ${what}${detail ? `  — ${detail}` : ''}`);
}

async function main() {
  if (process.env.XORR_CHAIN !== 'xlayer-fork') throw new Error('Run with XORR_CHAIN=xlayer-fork (source .env.fork).');
  const node = String(await anvil(RPC, 'web3_clientVersion', []));
  if (!/^anvil\//i.test(node)) throw new Error(`${RPC} is "${node}", not anvil. This only runs against a fork.`);
  if ((await pub.getChainId()) !== xLayer.id) throw new Error(`${RPC} is not a fork of X Layer mainnet (chain 196).`);

  // Imported after the guard: these read XORR_CHAIN and the delegation address at load.
  const { ADDRESSES, SETTLEMENT_VENUES, CHAIN_KEY } = await import('./evm/chains.js');
  const { DELEGATION_ABI, DELEGATION_ADDRESS, delegatePublicKey } = await import('./evm/delegation.js');
  const { STOCKS } = await import('./venues/stocks.js');
  const { placeOrder } = await import('./executor/order.js');
  const { placeSwap } = await import('./executor/swap.js');
  const { query, one, pool } = await import('./db/index.js');

  const code = await pub.getCode({ address: DELEGATION_ADDRESS });
  if (!code || code === '0x') throw new Error(`No XorrDelegation at ${DELEGATION_ADDRESS}. Run npm run setup:fork first.`);
  const USDC = ADDRESSES.usdc as Address;
  const TSLAX = STOCKS.TSLAx!.address;
  const NVDAX = STOCKS.NVDAx!.address;
  const bal = (token: Address, who: Address) =>
    pub.readContract({ address: token, abi: erc20Abi, functionName: 'balanceOf', args: [who] });

  console.log(`\nxorr on a fork of X Layer — block ${await pub.getBlockNumber()}`);
  console.log(`  delegation ${DELEGATION_ADDRESS}\n  delegate   ${delegatePublicKey}\n  venues     ${SETTLEMENT_VENUES.join(', ')}\n`);

  // ── The owner: a fresh key that signs for itself ────────────────────────────────────────────────
  const ownerAccount = privateKeyToAccount(generatePrivateKey());
  const owner = ownerAccount.address;
  const ownerWallet = createWalletClient({ account: ownerAccount, chain, transport: http(RPC) });
  await anvil(RPC, 'anvil_setBalance', [owner, toHex(parseEther('1'))]);
  await dealErc20({ rpc: RPC, token: USDC, holder: FORK_USDC_RESERVE, amount: parseUnits('1000000', 6) });
  await anvil(RPC, 'anvil_impersonateAccount', [FORK_USDC_RESERVE]);
  await anvil(RPC, 'anvil_setBalance', [FORK_USDC_RESERVE, toHex(parseEther('1'))]);
  try {
    const reserve = createWalletClient({ account: FORK_USDC_RESERVE, chain, transport: http(RPC) });
    const h = await reserve.writeContract({ address: USDC, abi: erc20Abi, functionName: 'transfer', args: [owner, parseUnits('1000', 6)] });
    await pub.waitForTransactionReceipt({ hash: h, ...RECEIPT });
  } finally {
    await anvil(RPC, 'anvil_stopImpersonatingAccount', [FORK_USDC_RESERVE]).catch(() => undefined);
  }
  console.log(`owner ${owner}`);
  check((await bal(USDC, owner)) === parseUnits('1000', 6), 'owner holds 1,000 of Circle\'s USDC on X Layer');

  const send = async (label: string, tx: Promise<Hex>): Promise<Hex> => {
    const hash = await tx;
    const r = await pub.waitForTransactionReceipt({ hash, ...RECEIPT });
    check(r.status === 'success', label, hash);
    return hash;
  };
  for (const token of [USDC, TSLAX, NVDAX]) {
    await send(
      `owner approves ${token === USDC ? 'USDC' : token === TSLAX ? 'TSLAx' : 'NVDAx'} to the delegation`,
      ownerWallet.writeContract({ address: token, abi: erc20Abi, functionName: 'approve', args: [DELEGATION_ADDRESS, maxUint256] }),
    );
  }
  const now = (await pub.getBlock()).timestamp;
  await send(
    'owner grants $100/day for 7 days, venues on the shared list',
    ownerWallet.writeContract({
      address: DELEGATION_ADDRESS,
      abi: DELEGATION_ABI,
      functionName: 'grant',
      args: [delegatePublicKey as Address, parseUnits('100', 6), now + 7n * 86_400n, [...SETTLEMENT_VENUES]],
    }),
  );

  // ── The wallet, as the app's sign-in would have created it ─────────────────────────────────────
  const walletId = randomUUID();
  await query(`INSERT INTO wallets (id, user_id, address, kind, cluster) VALUES ($1, $2, $3, 'embedded', $4)`, [
    walletId,
    `prove-xlayer:${owner.toLowerCase()}`,
    owner,
    CHAIN_KEY,
  ]);
  const w = await one<Parameters<typeof placeOrder>[0]>(`SELECT * FROM wallets WHERE id = $1`, [walletId]);
  if (!w) throw new Error('wallet row not written');

  // ── 1. A buy fills, into the owner's wallet ─────────────────────────────────────────────────────
  console.log('\n1. $50 of TSLAx');
  const usdc0 = await bal(USDC, owner);
  const buy = await placeOrder(w, 'TSLAx', 50, 'prove-xlayer · $50 of TSLAx');
  const filled = buy.placed && buy.outcome.status === 'filled' ? buy.outcome : null;
  check(!!filled, 'the executor filled it', filled ? filled.signature : JSON.stringify(buy));
  const shares = await bal(TSLAX, owner);
  check(shares > 0n, 'the owner holds wrapped TSLAx', `${formatUnits(shares, 18)} TSLAx`);
  check(usdc0 - (await bal(USDC, owner)) === parseUnits('50', 6), 'exactly $50 of USDC left the owner');
  check((await bal(TSLAX, DELEGATION_ADDRESS)) === 0n && (await bal(USDC, DELEGATION_ADDRESS)) === 0n, 'the delegation holds nothing');
  if (filled) {
    const run = await one<{ venue: string | null; status: string }>(`SELECT venue, status FROM strategy_runs WHERE id = $1`, [filled.runId]);
    check(run?.status === 'filled', 'the run is recorded as filled', `venue ${run?.venue}`);
    const audit = await one<{ n: string }>(`SELECT count(*)::text AS n FROM audit_log WHERE wallet_id = $1 AND signature = $2`, [walletId, filled.signature]);
    check(audit?.n === '1', 'one audit row carries the transaction hash');
    const pos = await one<{ units: string }>(`SELECT units::text FROM positions WHERE wallet_id = $1 AND symbol = 'TSLAx'`, [walletId]);
    check(!!pos && Number(pos.units) > 0, 'the position is booked', pos ? `${pos.units} units` : 'none');
  }

  // ── 2. The cap refuses, on chain ────────────────────────────────────────────────────────────────
  console.log('\n2. $60 of NVDAx the same day — past the $100 cap');
  const usdc1 = await bal(USDC, owner);
  const over = await placeOrder(w, 'NVDAx', 60, 'prove-xlayer · $60 of NVDAx');
  const refusedOver = !over.placed || over.outcome.status !== 'filled';
  const why = over.placed ? ('reason' in over.outcome ? over.outcome.reason : over.outcome.status) : over.refusal.reason;
  check(refusedOver, 'the order is refused', String(why));
  check((await bal(USDC, owner)) === usdc1 && (await bal(NVDAX, owner)) === 0n, 'no money moved');

  // ── 3. A close sells the position back, outside the cap ─────────────────────────────────────────
  console.log('\n3. sell the TSLAx back to USDC');
  const usdc2 = await bal(USDC, owner);
  const sell = await placeSwap(w, { from: 'TSLAx', to: 'USDC', amount: formatUnits(shares, 18) });
  check(sell.body.status === 'filled', 'the close filled', String(sell.body.txHash ?? sell.body.detail ?? sell.body.reason));
  check((await bal(TSLAX, owner)) === 0n, 'the position is closed on chain');
  const proceeds = (await bal(USDC, owner)) - usdc2;
  check(proceeds > parseUnits('48', 6), 'the proceeds reached the owner', `$${formatUnits(proceeds, 6)} back for $50`);
  const remaining = await pub.readContract({ address: DELEGATION_ADDRESS, abi: DELEGATION_ABI, functionName: 'remainingToday', args: [owner] });
  check(remaining === parseUnits('50', 6), 'the close did not spend the cap', `$${formatUnits(remaining as bigint, 6)} left today`);

  // ── The agent's sweep reads real tables ─────────────────────────────────────────────────────────
  // Against the real schema: a sweep whose query names a column that does not exist threw into an empty wallet list and
  // traded for nobody, silently. It now throws, so this line fails loudly if it ever regresses.
  const { autonomousAgentSweep } = await import('./bot/autonomous.js');
  const swept = await autonomousAgentSweep().then(
    (n) => ({ ok: true, n }),
    (e: unknown) => ({ ok: false, n: e instanceof Error ? e.message : String(e) }),
  );
  check(swept.ok, "the autonomous agent's sweep runs against the real schema", String(swept.n) + (swept.ok ? ' trade(s) this tick' : ''));

  // ── 4. Revoke stops the bot ─────────────────────────────────────────────────────────────────────
  console.log('\n4. the owner revokes');
  await send('owner revokes', ownerWallet.writeContract({ address: DELEGATION_ADDRESS, abi: DELEGATION_ABI, functionName: 'revoke', args: [] }));
  const after = await placeOrder(w, 'TSLAx', 10, 'prove-xlayer · after revoke');
  check(!after.placed, 'the next order is refused before anything is signed', after.placed ? after.outcome.status : after.refusal.reason);

  await pool.end();
  console.log(failures === 0 ? '\nALL CHECKS PASSED\n' : `\n${failures} CHECK(S) FAILED\n`);
  process.exit(failures === 0 ? 0 : 1);
}

await main();
