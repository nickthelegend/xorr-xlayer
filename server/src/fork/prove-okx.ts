/**
 * OKX DEX, end to end, on a fork of X Layer mainnet (PLAN.md P2.8 — the live half it was waiting on a key for).
 *
 * The executor's own order path (`placeOrder` → `runStrategy` → `chooseSettlement`) asks Uniswap v3 and OKX DEX what
 * each would deliver, and settles where the owner receives the most — OKX only when its route would actually fill on
 * this chain (`viaWouldFill`). OKX's route is its real `/swap` answer from the live API, signed with this deployment's
 * key; the fill goes through `XorrDelegation.spendVia`, which approves OKX's approval contract for exactly the amount and
 * resets it to zero in the same transaction.
 *
 *   1. a $50 buy of NVDAx — where OKX's quote beats Uniswap's — settles through OKX DEX, into the OWNER's wallet;
 *   2. the delegation holds nothing afterwards, and leaves no approval standing to OKX's contract;
 *   3. the position is sold back to USDC outside the cap, through whichever venue pays more for it.
 *
 * Run against a FRESH fork, so its pools match the market OKX quotes (anvil forking X Layer, `npm run setup:fork` done,
 * OKX_API_KEY / OKX_SECRET_KEY / OKX_PASSPHRASE set):
 *   cd server && set -a && . ../.env && . ./.env.fork && set +a && npx tsx src/fork/prove-okx.ts
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
import { FORK_USDC_RESERVE, anvil, dealErc20 } from './anvil.js';

const RPC = process.env.FORK_RPC ?? 'http://127.0.0.1:8545';
const chain = { ...xLayer, rpcUrls: { default: { http: [RPC] }, public: { http: [RPC] } } };
const pub = createPublicClient({ chain, transport: http(RPC) });
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

  const { ADDRESSES, SETTLEMENT_VENUES, CHAIN_KEY } = await import('../evm/chains.js');
  const { DELEGATION_ABI, DELEGATION_ADDRESS, delegatePublicKey } = await import('../evm/delegation.js');
  const { okxConfigured, OKX_APPROVE_SPENDER, OKX_ROUTER } = await import('../venues/okxdex.js');
  const { STOCKS } = await import('../venues/stocks.js');
  const { placeOrder } = await import('../executor/order.js');
  const { placeSwap } = await import('../executor/swap.js');
  const { one, pool } = await import('../db/index.js');

  if (!okxConfigured()) throw new Error('OKX_API_KEY, OKX_SECRET_KEY and OKX_PASSPHRASE are needed: this proves the OKX venue.');
  const USDC = ADDRESSES.usdc as Address;
  const NVDAX = STOCKS.NVDAx!.address;
  const bal = (token: Address, who: Address) =>
    pub.readContract({ address: token, abi: erc20Abi, functionName: 'balanceOf', args: [who] });
  const allowance = (token: Address) =>
    pub.readContract({ address: token, abi: erc20Abi, functionName: 'allowance', args: [DELEGATION_ADDRESS, OKX_APPROVE_SPENDER] });

  console.log(`\nOKX DEX on a fork of X Layer — block ${await pub.getBlockNumber()}`);
  const venues = SETTLEMENT_VENUES.map((v) => v.toLowerCase());
  check(
    venues.includes(OKX_ROUTER.toLowerCase()) && venues.includes(OKX_APPROVE_SPENDER.toLowerCase()),
    "a grant's venues include OKX's router and its approval contract",
    `${OKX_ROUTER} · ${OKX_APPROVE_SPENDER}`,
  );

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

  const send = async (label: string, tx: Promise<Hex>): Promise<Hex> => {
    const hash = await tx;
    const r = await pub.waitForTransactionReceipt({ hash, ...RECEIPT });
    check(r.status === 'success', label, hash);
    return hash;
  };
  for (const [token, name] of [[USDC, 'USDC'], [NVDAX, 'NVDAx']] as const) {
    await send(
      `owner approves ${name} to the delegation`,
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

  const { query } = await import('../db/index.js');
  const walletId = randomUUID();
  await query(`INSERT INTO wallets (id, user_id, address, kind, cluster) VALUES ($1, $2, $3, 'embedded', $4)`, [
    walletId,
    `prove-okx:${owner.toLowerCase()}`,
    owner,
    CHAIN_KEY,
  ]);
  const w = await one<Parameters<typeof placeOrder>[0]>(`SELECT * FROM wallets WHERE id = $1`, [walletId]);
  if (!w) throw new Error('wallet row not written');

  // ── 1. A buy OKX pays more for settles through OKX ──────────────────────────────────────────────
  console.log('\n1. $50 of NVDAx');
  const usdc0 = await bal(USDC, owner);
  const buy = await placeOrder(w, 'NVDAx', 50, 'prove-okx · $50 of NVDAx');
  const filled = buy.placed && buy.outcome.status === 'filled' ? buy.outcome : null;
  check(!!filled, 'the executor filled it', filled ? filled.signature : JSON.stringify(buy).slice(0, 300));
  const run = filled
    ? await one<{ venue: string | null }>(`SELECT venue FROM strategy_runs WHERE id = $1`, [filled.runId])
    : null;
  check(run?.venue === 'okx-dex', 'it settled through OKX DEX', `venue ${run?.venue ?? '—'}`);
  if (filled) {
    const receipt = await pub.getTransactionReceipt({ hash: filled.signature as Hex });
    const touchedOkx = receipt.logs.some((l) => l.address.toLowerCase() === OKX_ROUTER.toLowerCase()) ||
      (await pub.getTransaction({ hash: filled.signature as Hex })).input.toLowerCase().includes(OKX_ROUTER.slice(2).toLowerCase());
    check(touchedOkx, "the transaction carried OKX's router call", filled.signature);
  }
  const shares = await bal(NVDAX, owner);
  check(shares > 0n, 'the owner holds NVDAx', `${formatUnits(shares, 18)} NVDAx`);
  check(usdc0 - (await bal(USDC, owner)) === parseUnits('50', 6), 'exactly $50 of USDC left the owner');

  // ── 2. Nothing parked, nothing left approved ────────────────────────────────────────────────────
  console.log('\n2. what the delegation keeps');
  check((await bal(USDC, DELEGATION_ADDRESS)) === 0n && (await bal(NVDAX, DELEGATION_ADDRESS)) === 0n, 'the delegation holds nothing');
  check((await allowance(USDC)) === 0n, "no USDC approval is left standing to OKX's approval contract");

  // ── 3. Sold back, outside the cap ───────────────────────────────────────────────────────────────
  console.log('\n3. sell the NVDAx back to USDC');
  const usdc1 = await bal(USDC, owner);
  const sell = await placeSwap(w, { from: 'NVDAx', to: 'USDC', amount: formatUnits(shares, 18) });
  check(sell.body.status === 'filled', 'the close filled', String(sell.body.txHash ?? sell.body.detail ?? sell.body.reason));
  const sold = await one<{ venue: string | null }>(
    `SELECT r.venue FROM strategy_runs r JOIN strategies s ON s.id = r.strategy_id
      WHERE s.wallet_id = $1 AND r.status = 'filled' ORDER BY r.finished_at DESC LIMIT 1`,
    [walletId],
  );
  check((await bal(NVDAX, owner)) === 0n, 'the position is closed on chain', `through ${sold?.venue ?? '—'}`);
  const proceeds = (await bal(USDC, owner)) - usdc1;
  check(proceeds > parseUnits('48', 6), 'the proceeds reached the owner', `$${formatUnits(proceeds, 6)} back for $50`);
  check((await allowance(NVDAX)) === 0n, "no NVDAx approval is left standing to OKX's approval contract");
  const remaining = await pub.readContract({ address: DELEGATION_ADDRESS, abi: DELEGATION_ABI, functionName: 'remainingToday', args: [owner] });
  check(remaining === parseUnits('50', 6), 'the close did not spend the cap', `$${formatUnits(remaining as bigint, 6)} left today`);

  await pool.end();
  console.log(failures === 0 ? '\nALL CHECKS PASSED\n' : `\n${failures} CHECK(S) FAILED\n`);
  process.exit(failures === 0 ? 0 : 1);
}

await main();
