/**
 * A withdrawal, proved end to end on a fork of X Layer against the running executor (PLAN.md 4.9, P2.14).
 *
 * What it shows, in order:
 *
 *   1. The allowlist is the executor's and its clock is the database's. An address added over HTTP is refused — by the
 *      check the app makes before a signature, and by `prepare-all` — for 24 hours after the database wrote it. Adding
 *      it again does not move that clock, and removing it is refused at once.
 *   2. An address whose `usable_at` has passed is usable. A day cannot be waited out here, so the address goes back on
 *      through `addAddress` — the same INSERT the route runs — with an 8-second cooling-off instead of 86 400. It is
 *      refused until the DATABASE's clock passes `usable_at`, and then let through. No clock is moved by anyone.
 *   3. "Withdraw everything", in its order: the TSLAx position sold by the executor under a real grant (`/positions/close`,
 *      signed by the delegate), the Aave USDT0 position exited with `/yield/withdraw-calldata` signed by the owner, and the
 *      whole USDC balance sent to the allowlisted address with the transfer `prepare-all` built, signed by the owner —
 *      each user-signed transaction read back through `/withdrawals/record`.
 *   4. Removed again, it is refused again; added back, it waits a new 24 hours.
 *
 * The owner is a key generated here, standing in for the user's embedded wallet — Privy custodies that one and would
 * broadcast to real X Layer. It is registered for the Privy test account with `bindWallet`, the INSERT `/wallet/connect`
 * runs once Privy has confirmed an address is on the account; that confirmation is the one step skipped, because Privy
 * has never heard of a key made on this machine. Everything after it goes to the executor over HTTP with a real Privy
 * token.
 *
 *   cd server && set -a && . ../.env && . ./.env.fork && set +a && API_URL=http://127.0.0.1:8799 \
 *     npx tsx src/fork/prove-withdrawal.ts
 *
 * The fork's only liberty is the owner's starting USDC, from the fork-only reserve (`fork/anvil.ts`). The TSLAx position
 * and the USDT0 supply are the owner's own: bought through Uniswap v3 and supplied to Aave v3 on the fork.
 *
 * The executor at API_URL must serve the same fork, database and key directory. This refuses any node that is not
 * anvil and any executor that is not on this machine.
 */
import 'dotenv/config';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import {
  createPublicClient,
  createWalletClient,
  decodeFunctionData,
  erc20Abi,
  formatUnits,
  http,
  maxUint256,
  parseAbi,
  parseUnits,
  type Address,
  type Hex,
  type TransactionReceipt,
} from 'viem';
import { xLayer } from 'viem/chains';
import { FORK_USDC_RESERVE, dealErc20 } from './anvil.js';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';

const RPC = process.env.FORK_RPC;
const API = process.env.API_URL;
if (!RPC) throw new Error('FORK_RPC is required: the anvil fork to prove on');
if (!API || !/^http:\/\/(127\.0\.0\.1|localhost):\d+$/.test(API)) {
  throw new Error('API_URL is required, and must be an executor on this machine: this proof writes to its database');
}
if (process.env.XORR_CHAIN !== 'xlayer-fork') {
  throw new Error('XORR_CHAIN=xlayer-fork is required, so the executor modules read the fork');
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

// Imported after the checks: these read XORR_CHAIN, FORK_RPC and DATABASE_URL when they load.
const { DELEGATION_ABI, DELEGATION_ADDRESS, usdToUnits } = await import('../evm/delegation.js');
const { AAVE_V3_POOL, ADDRESSES, SETTLEMENT_VENUES } = await import('../evm/chains.js');
const { delegateAccount } = await import('../evm/client.js');
const { buildSwap } = await import('../venues/uniswap.js');
const { bindWallet } = await import('../auth/walletBinding.js');
const { addAddress } = await import('../withdrawals/allowlist.js');
const { pool, query } = await import('../db/index.js');

if (/^0x0{40}$/.test(DELEGATION_ADDRESS)) throw new Error('DELEGATION_ADDRESS is required: run fork-bootstrap first');

const chain = { ...xLayer, rpcUrls: { default: { http: [RPC] }, public: { http: [RPC] } } };
const pub = createPublicClient({ chain, transport: http(RPC), cacheTime: 0 });
const USDC = ADDRESSES.usdc as Address;
const { STOCKS } = await import('../venues/stocks.js');
/** Wrapped TSLAx: an xStock, priced by the pools that fill it — so the panic preview sees it as a leg to sell. */
const TSLAX = STOCKS.TSLAx!.address;
const USDT0 = ADDRESSES.usdt0 as Address;
if (!AAVE_V3_POOL) throw new Error('AAVE_V3_POOL is null: this chain has no lending pool to exit');
const POOL = AAVE_V3_POOL;
const POOL_ABI = parseAbi([
  'function supply(address asset, uint256 amount, address onBehalfOf, uint16 referralCode)',
  'function withdraw(address asset, uint256 amount, address to) returns (uint256)',
]);

let failures = 0;
function check(what: string, ok: boolean, detail = ''): boolean {
  if (!ok) failures += 1;
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${what}${detail ? ` — ${detail}` : ''}`);
  return ok;
}
/** A step the rest stands on: when it fails, nothing after it would prove anything, so the run stops there. */
function need(what: string, ok: boolean, detail = ''): void {
  if (!check(what, ok, detail)) throw new Error(`stopped at: ${what}`);
}
const usdc = (n: bigint) => `${formatUnits(n, 6)} USDC`;
const iso = (ms: number) => new Date(ms).toISOString();
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const balanceOf = (token: Address, who: Address) =>
  pub.readContract({ address: token, abi: erc20Abi, functionName: 'balanceOf', args: [who] });
const mined = async (hash: Hex) => (await pub.waitForTransactionReceipt({ hash })).status === 'success';

/** A receipt as it is worth reading: every field that says what happened, with the numbers as decimal strings. */
function shown(r: TransactionReceipt) {
  return JSON.stringify(
    {
      transactionHash: r.transactionHash,
      status: r.status,
      blockNumber: r.blockNumber.toString(),
      from: r.from,
      to: r.to,
      gasUsed: r.gasUsed.toString(),
      effectiveGasPrice: r.effectiveGasPrice.toString(),
      logs: r.logs.map((l) => ({ address: l.address, topics: l.topics, data: l.data })),
    },
    null,
    2,
  );
}

/* ── The Privy test account ── */
const TOKEN_SCRIPT = fileURLToPath(new URL('../e2e-token.ts', import.meta.url));
const token = execFileSync('npx', ['tsx', TOKEN_SCRIPT, process.env.E2E_PRIVY_EMAIL ?? 'test-8958@privy.io'], {
  encoding: 'utf8',
}).trim();
// The account's Privy id, from the token's own claims — the `sub` the executor verifies. Used, never printed.
const userId = (JSON.parse(Buffer.from(token.split('.')[1] ?? '', 'base64url').toString('utf8')) as { sub?: string }).sub;
if (!userId) throw new Error('The Privy token carried no subject.');

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- the executor's JSON, asserted field by field below
type Reply = { status: number; body: any };
async function executor(path: string, body?: unknown): Promise<Reply> {
  const res = await fetch(`${API}${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}

async function main(): Promise<void> {
  console.log(`fork ${RPC} · ${node} · chain ${await pub.getChainId()} · block ${await pub.getBlockNumber()}`);
  console.log(`executor ${API} · delegation ${DELEGATION_ADDRESS} · delegate ${delegateAccount.address}\n`);

  /* ── 0. The owner: funded, registered, granted, holding a position and an Aave supply. ── */
  console.log('0. The owner');
  const ownerAccount = privateKeyToAccount(generatePrivateKey());
  const owner = ownerAccount.address;
  const ownerWallet = createWalletClient({ account: ownerAccount, chain, transport: http(RPC) });
  await rpc('anvil_setBalance', [owner, '0x8AC7230489E80000']);
  await dealErc20({ rpc: RPC!, token: USDC, holder: FORK_USDC_RESERVE, amount: parseUnits('1000000', 6) });
  await rpc('anvil_impersonateAccount', [FORK_USDC_RESERVE]);
  await rpc('anvil_setBalance', [FORK_USDC_RESERVE, '0xDE0B6B3A7640000']);
  const reserve = createWalletClient({ account: FORK_USDC_RESERVE, chain, transport: http(RPC) });
  const fundTx = await reserve.writeContract({
    address: USDC,
    abi: erc20Abi,
    functionName: 'transfer',
    args: [owner, parseUnits('1000', 6)],
  });
  await pub.waitForTransactionReceipt({ hash: fundTx });
  await rpc('anvil_stopImpersonatingAccount', [FORK_USDC_RESERVE]);
  console.log(`  owner ${owner} · funded 1000 USDC in ${fundTx}`);

  const bound = await bindWallet({ id: randomUUID(), userId: userId!, address: owner, kind: 'embedded', cluster: 'xlayer-fork' });
  need('registered as the Privy test account’s wallet', bound.status === 'bound');
  const walletId = bound.status === 'bound' ? bound.row.id : '';
  const me = await executor('/wallet');
  need('the executor resolves the Privy token to that wallet', me.status === 200 && me.body?.address === owner, `${me.body?.address}`);

  const chainNow = (await pub.getBlock()).timestamp;
  const grantTx = await ownerWallet.writeContract({
    address: DELEGATION_ADDRESS,
    abi: DELEGATION_ABI,
    functionName: 'grant',
    args: [delegateAccount.address, usdToUnits(1_000), chainNow + 86_400n, [...SETTLEMENT_VENUES]],
  });
  need('the owner signed a grant to the executor’s delegate', await mined(grantTx), grantTx);
  for (const [symbol, asset] of [
    ['USDC', USDC],
    ['TSLAx', TSLAX],
  ] as const) {
    const approveTx = await ownerWallet.writeContract({
      address: asset,
      abi: erc20Abi,
      functionName: 'approve',
      args: [DELEGATION_ADDRESS, maxUint256],
    });
    need(`… and let the delegation pull ${symbol}`, await mined(approveTx), approveTx);
  }
  // A position to sell, bought by the owner itself through Uniswap v3 on the fork.
  const buy = await buildSwap({ inSymbol: 'USDC', outSymbol: 'TSLAx', amount: 50, from: owner, receiver: owner, slippagePct: 1 });
  const letRouterTx = await ownerWallet.writeContract({ address: USDC, abi: erc20Abi, functionName: 'approve', args: [buy.to, parseUnits('50', 6)] });
  need('… the Uniswap router allowed 50 USDC', await mined(letRouterTx), letRouterTx);
  const buyTx = await ownerWallet.sendTransaction({ to: buy.to, data: buy.data });
  need('a position to sell: $50 of TSLAx, bought by the owner', await mined(buyTx) && (await balanceOf(TSLAX, owner)) > 0n, buyTx);
  // And a supply to exit: $300 of USDC swapped to USDT0 by the owner, and supplied to Aave v3 on X Layer.
  const toUsdt0 = await buildSwap({ inSymbol: 'USDC', outSymbol: 'USDT0', amount: 300, from: owner, receiver: owner, slippagePct: 0.5 });
  const letRouter2Tx = await ownerWallet.writeContract({ address: USDC, abi: erc20Abi, functionName: 'approve', args: [toUsdt0.to, parseUnits('300', 6)] });
  need('… the router allowed 300 USDC', await mined(letRouter2Tx), letRouter2Tx);
  const toUsdt0Tx = await ownerWallet.sendTransaction({ to: toUsdt0.to, data: toUsdt0.data });
  need('… swapped to USDT0', await mined(toUsdt0Tx), toUsdt0Tx);
  const usdt0 = await balanceOf(USDT0, owner);
  const letPoolTx = await ownerWallet.writeContract({ address: USDT0, abi: erc20Abi, functionName: 'approve', args: [POOL, usdt0] });
  need(`… the Aave pool allowed ${formatUnits(usdt0, 6)} USDT0`, await mined(letPoolTx), letPoolTx);
  const supplyTx = await ownerWallet.writeContract({
    address: POOL,
    abi: POOL_ABI,
    functionName: 'supply',
    args: [USDT0, usdt0, owner, 0],
  });
  need('… and supplied to Aave on X Layer', await mined(supplyTx), supplyTx);

  /* ── 1. The allowlist, on the executor's clock. ── */
  console.log('\n1. An address added over HTTP');
  const cold = privateKeyToAccount(generatePrivateKey()).address;
  const added = await executor('/withdrawal-addresses', { label: 'Cold storage', address: cold });
  need('added', added.status === 201 && added.body?.status === 'added', JSON.stringify(added.body));
  const first = added.body.entry as { addedAt: number; usableAt: number; usable: boolean };
  check(
    'usable exactly 24 hours after the database wrote it, and not before',
    first.usableAt - first.addedAt === 86_400_000 && first.usable === false,
    `added ${iso(first.addedAt)}, usable ${iso(first.usableAt)}`,
  );
  const checked = await executor('/withdrawal-addresses/check', { address: cold });
  check('the check the app makes before a signature refuses it', checked.status === 409 && checked.body?.reason === 'cooling_off', `${checked.status} ${JSON.stringify(checked.body)}`);
  const unprepared = await executor('/withdrawals/prepare-all', { to: cold, token: 'USDC' });
  check('the executor will not prepare a transfer to it', unprepared.status === 409 && unprepared.body?.reason === 'cooling_off', `${unprepared.status} ${unprepared.body?.detail}`);
  const again = await executor('/withdrawal-addresses', { label: 'Cold storage', address: cold.toLowerCase() });
  check(
    'adding it again is refused, and its clock stays where it was',
    again.status === 409 && again.body?.reason === 'already_listed' && again.body?.entry?.usableAt === first.usableAt,
    `${again.status} ${again.body?.detail}`,
  );
  const removed = await executor('/withdrawal-addresses/remove', { address: cold });
  check('removed', removed.status === 200 && removed.body?.status === 'removed');
  const gone = await executor('/withdrawal-addresses/check', { address: cold });
  check('refused at once as not on the list', gone.status === 409 && gone.body?.reason === 'not_allowlisted', `${gone.status} ${gone.body?.detail}`);

  /* ── 2. An address whose usable_at has passed. ── */
  console.log('\n2. The same address through the same INSERT, with an 8-second cooling-off');
  const short = await addAddress(walletId, { label: 'Cold storage', address: cold }, 8);
  need('added by `addAddress`', short.status === 'added', JSON.stringify(short));
  const shortEntry = short.status === 'added' ? short.entry : undefined;
  console.log(`  added ${iso(shortEntry!.addedAt)}, usable ${iso(shortEntry!.usableAt)}`);
  const early = await executor('/withdrawal-addresses/check', { address: cold });
  check('refused while the database clock is short of usable_at', early.status === 409 && early.body?.reason === 'cooling_off', `${early.status} ${early.body?.detail}`);
  const remaining = await query<{ wait: number }>(
    `SELECT greatest(0, ceil(extract(epoch FROM (usable_at - now())) * 1000))::int AS wait
       FROM withdrawal_addresses WHERE wallet_id = $1 AND address = $2 AND removed_at IS NULL`,
    [walletId, cold],
  );
  const wait = remaining[0]?.wait ?? 0;
  console.log(`  the database says ${wait} ms remain; waiting that long, and half a second more`);
  await sleep(wait + 500);
  const usable = await executor('/withdrawal-addresses/check', { address: cold });
  need('usable once the database clock has passed it', usable.status === 200 && usable.body?.status === 'usable', `${usable.status} ${JSON.stringify(usable.body)}`);
  const listed = await executor('/withdrawal-addresses');
  const row = (listed.body?.addresses ?? []).find((a: { address: string }) => a.address === cold);
  check('the list says so, beside the clock that decided it', row?.usable === true, `serverTime ${iso(listed.body?.serverTime)}, usableAt ${iso(row?.usableAt)}`);

  /* ── 3. Withdraw everything. ── */
  console.log('\n3. Withdraw everything');
  const preview = await executor('/panic/preview');
  need('what would sell was read', preview.status === 200, JSON.stringify(preview.body?.legs));
  for (const leg of preview.body.legs as { symbol: string; units: number; usd: number }[]) {
    const closed = await executor('/positions/close', { symbol: leg.symbol, fraction: 1 });
    need(
      `sold all ${leg.symbol} through the executor, signed by the delegate`,
      closed.status === 200 && closed.body?.status === 'closed',
      `${closed.body?.units} ${leg.symbol} for $${closed.body?.usd} (measured ${closed.body?.measured}) in ${closed.body?.txHash ?? JSON.stringify(closed.body)}`,
    );
  }
  check('no TSLAx left in the wallet', (await balanceOf(TSLAX, owner)) === 0n);

  const position = await executor('/yield/position');
  need('an Aave position to exit', position.status === 200 && position.body?.suppliedUsd > 0, `${position.body?.suppliedUsd} USD supplied`);
  const exit = await executor('/yield/withdraw-calldata', { usd: null });
  const exitArgs = decodeFunctionData({ abi: POOL_ABI, data: exit.body.data as Hex }).args as readonly [Address, bigint, Address];
  need(
    'the executor’s calldata withdraws everything, from the pool, to the owner',
    exit.body.to.toLowerCase() === POOL.toLowerCase() && exitArgs[0] === USDT0 && exitArgs[1] === maxUint256 && exitArgs[2] === owner,
    `withdraw(${exitArgs[0]}, max, ${exitArgs[2]})`,
  );
  const exitGas = await pub.estimateGas({ account: owner, to: exit.body.to as Address, data: exit.body.data as Hex });
  const exitTx = await ownerWallet.sendTransaction({ to: exit.body.to as Address, data: exit.body.data as Hex, gas: (exitGas * 13n) / 10n });
  need('the owner signed the Aave exit', await mined(exitTx), exitTx);
  check('the aToken balance is zero, not dust', (await balanceOf(position.body.aToken as Address, owner)) === 0n);
  const exitRecord = await executor('/withdrawals/record', { txHash: exitTx });
  check(
    'recorded as the exit from Aave, in USDT0',
    exitRecord.body?.status === 'confirmed' && exitRecord.body?.aave?.symbol === 'USDT0',
    JSON.stringify(exitRecord.body),
  );

  const before = { owner: await balanceOf(USDC, owner), cold: await balanceOf(USDC, cold) };
  const prepared = await executor('/withdrawals/prepare-all', { to: cold, token: 'USDC' });
  need('the executor prepared the transfer of the whole balance', prepared.status === 200 && prepared.body?.status === 'prepared', JSON.stringify(prepared.body));
  const transfer = decodeFunctionData({ abi: erc20Abi, data: prepared.body.call.data as Hex });
  const [to, amount] = transfer.args as readonly [Address, bigint];
  need(
    'it decodes to transfer(the allowlisted address, every unit the owner holds)',
    transfer.functionName === 'transfer' && to === cold && amount === before.owner && prepared.body.call.to === USDC,
    `${transfer.functionName}(${to}, ${amount}) on ${prepared.body.call.to}`,
  );
  const sendTx = await ownerWallet.sendTransaction({ to: prepared.body.call.to as Address, data: prepared.body.call.data as Hex });
  const receipt = await pub.waitForTransactionReceipt({ hash: sendTx });
  const after = { owner: await balanceOf(USDC, owner), cold: await balanceOf(USDC, cold) };
  console.log(`\n  the user-signed withdrawal, as the chain recorded it:\n${shown(receipt)}\n`);
  console.log(`  owner ${owner}: ${usdc(before.owner)} → ${usdc(after.owner)}`);
  console.log(`  cold  ${cold}: ${usdc(before.cold)} → ${usdc(after.cold)}`);
  check('the transfer succeeded, signed by the owner', receipt.status === 'success' && receipt.from.toLowerCase() === owner.toLowerCase());
  check('every unit left the owner and arrived at the allowlisted address', after.owner === 0n && after.cold - before.cold === before.owner);
  const sendRecord = await executor('/withdrawals/record', { txHash: sendTx });
  check(
    'recorded as a send to a usable allowlisted address',
    sendRecord.body?.status === 'confirmed' && sendRecord.body?.transfers?.[0]?.usable === true && sendRecord.body?.transfers?.[0]?.label === 'Cold storage',
    JSON.stringify(sendRecord.body),
  );
  const replayed = await executor('/withdrawals/record', { txHash: sendTx });
  check('reported twice, recorded once', replayed.body?.duplicate === true);

  /* ── 4. Removed, and added back. ── */
  console.log('\n4. Removed, then added back');
  const removedAgain = await executor('/withdrawal-addresses/remove', { address: cold });
  check('removed', removedAgain.status === 200);
  const refusedAgain = await executor('/withdrawal-addresses/check', { address: cold });
  check('the check refuses it at once', refusedAgain.status === 409 && refusedAgain.body?.reason === 'not_allowlisted', `${refusedAgain.status} ${refusedAgain.body?.detail}`);
  const unpreparedAgain = await executor('/withdrawals/prepare-all', { to: cold, token: 'USDC' });
  check('so does prepare-all', unpreparedAgain.status === 409 && unpreparedAgain.body?.reason === 'not_allowlisted', `${unpreparedAgain.status}`);
  const back = await executor('/withdrawal-addresses', { label: 'Cold storage', address: cold });
  const backEntry = back.body?.entry as { addedAt: number; usableAt: number; usable: boolean } | undefined;
  check(
    'added back, it waits a whole new 24 hours',
    back.status === 201 && backEntry?.usable === false && backEntry.usableAt - backEntry.addedAt === 86_400_000 && backEntry.usableAt > first.usableAt,
    backEntry ? `usable ${iso(backEntry.usableAt)}` : JSON.stringify(back.body),
  );

  /* ── The trail. ── */
  const trail = await executor('/activity');
  const rows = (Array.isArray(trail.body) ? trail.body : []) as { action: string; kind: string; signature?: string }[];
  console.log('\n  the trail for this wallet, oldest first:');
  for (const r of [...rows].reverse()) console.log(`    ${r.kind.padEnd(5)} ${r.action}${r.signature ? `  ${r.signature}` : ''}`);
}

try {
  await main();
} catch (e) {
  failures += 1;
  console.log(`\n${e instanceof Error ? e.message : String(e)}`);
} finally {
  await pool.end().catch(() => undefined);
}
console.log(failures === 0 ? '\nall checks passed' : `\n${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
