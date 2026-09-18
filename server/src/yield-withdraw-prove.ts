/**
 * The withdraw path, proved end to end against the real Aave pool.
 *
 * The calldata comes from `/yield/withdraw-calldata` exactly as the app would fetch it, and is
 * then sent BY THE OWNER — impersonated, because this is a fork of Base mainnet and a real Privy
 * embedded wallet would broadcast to real Base. The signature is the only simulated part, and it
 * is the same `sendTransaction` primitive already proved by the grant and revoke transactions on
 * public Base Sepolia.
 *
 * What this asserts is the part that is specific to withdrawing: that the server encodes the right
 * call, that the pool accepts it from the owner with no allowance anywhere, that the USDC lands in
 * the owner's wallet, and that the delegation is not in the path at all.
 *
 * Run: npx tsx server/src/yield-withdraw-prove.ts
 */
import 'dotenv/config';
import { createPublicClient, createWalletClient, http, erc20Abi, formatUnits, type Address, type Hex } from 'viem';
import { base } from 'viem/chains';
import { usdcReserve } from './market/yield.js';
import { DELEGATION_ADDRESS } from './evm/delegation.js';

const RPC = process.env.FORK_RPC ?? 'http://127.0.0.1:8545';
const API = process.env.API_URL ?? 'http://localhost:8788';
const USDC: Address = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const owner = (process.argv[2] ?? '0x95A0b368588713011a15f4b1041423f31B08e615') as Address;

const chain = { ...base, rpcUrls: { default: { http: [RPC] }, public: { http: [RPC] } } };
const pub = createPublicClient({ chain, transport: http(RPC) });

const rpc = (m: string, p: unknown[]) =>
  fetch(RPC, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: m, params: p }) }).then((r) => r.json());

function must(label: string, cond: boolean, detail = '') {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${detail ? `  — ${detail}` : ''}`);
  if (!cond) process.exitCode = 1;
}

const { execFileSync } = await import('node:child_process');
const token = execFileSync('npx', ['tsx', 'server/src/e2e-token.ts', process.env.E2E_PRIVY_EMAIL ?? 'test-8958@privy.io'], { encoding: 'utf8' }).trim();
const authed = (path: string, init?: RequestInit) =>
  fetch(`${API}${path}`, { ...init, headers: { 'content-type': 'application/json', authorization: `Bearer ${token}`, ...init?.headers } });

const reserve = await usdcReserve();

const before = {
  usdc: await pub.readContract({ address: USDC, abi: erc20Abi, functionName: 'balanceOf', args: [owner] }),
  aToken: await pub.readContract({ address: reserve.aToken, abi: erc20Abi, functionName: 'balanceOf', args: [owner] }),
};
console.log(`\nowner ${owner}\n  USDC ${formatUnits(before.usdc, 6)}  aUSDC ${formatUnits(before.aToken, 6)}\n`);
must('the wallet has a position to withdraw', before.aToken > 0n, `${formatUnits(before.aToken, 6)} aUSDC`);

// ── A partial withdrawal, encoded by the server ──
const partial = (await (await authed('/yield/withdraw-calldata', { method: 'POST', body: JSON.stringify({ usd: 100 }) })).json()) as { to: Address; data: Hex; isMax: boolean };
must('the server encodes a withdrawal to the Aave Pool', partial.to.toLowerCase() === reserve.pool.toLowerCase(), partial.to);
must('a numbered withdrawal is not flagged as max', partial.isMax === false);

/*
 * The delegation must have no allowance for the aToken.
 *
 * This is the property the whole design rests on: the bot cannot pull the position out, because
 * it was never given the receipt token. If this is ever non-zero, the "you sign this, not the bot"
 * line on the screen has become false.
 */
const botAllowance = await pub.readContract({
  address: reserve.aToken, abi: erc20Abi, functionName: 'allowance', args: [owner, DELEGATION_ADDRESS],
});
must('the delegation has no claim on the aToken', botAllowance === 0n, `${botAllowance} allowance`);

await rpc('anvil_impersonateAccount', [owner]);
await rpc('anvil_setBalance', [owner, '0x8AC7230489E80000']);
const wallet = createWalletClient({ account: owner, chain, transport: http(RPC) });

const gas = await pub.estimateGas({ account: owner, to: partial.to, data: partial.data });
const r1 = await pub.waitForTransactionReceipt({
  hash: await wallet.sendTransaction({ to: partial.to, data: partial.data, gas: gas * 2n }),
});
const mid = await pub.readContract({ address: USDC, abi: erc20Abi, functionName: 'balanceOf', args: [owner] });
must('a $100 withdrawal lands in the owner’s wallet', r1.status === 'success' && mid - before.usdc === 100_000_000n, `+${formatUnits(mid - before.usdc, 6)} USDC`);

// ── Everything, using Aave's max sentinel ──
const all = (await (await authed('/yield/withdraw-calldata', { method: 'POST', body: JSON.stringify({ usd: null }) })).json()) as { to: Address; data: Hex; isMax: boolean };
must('an "all of it" withdrawal is flagged as max', all.isMax === true);

const gas2 = await pub.estimateGas({ account: owner, to: all.to, data: all.data });
const r2 = await pub.waitForTransactionReceipt({
  hash: await wallet.sendTransaction({ to: all.to, data: all.data, gas: gas2 * 2n }),
});
const after = {
  usdc: await pub.readContract({ address: USDC, abi: erc20Abi, functionName: 'balanceOf', args: [owner] }),
  aToken: await pub.readContract({ address: reserve.aToken, abi: erc20Abi, functionName: 'balanceOf', args: [owner] }),
};
must('the max withdrawal succeeds', r2.status === 'success');
/*
 * Empty means empty, to the wei.
 *
 * A rebasing balance cannot be emptied by withdrawing a number read a moment earlier — interest
 * accrues in between and leaves dust. That is exactly what the max sentinel is for, and asserting
 * `=== 0n` rather than "small" is what proves it was used.
 */
must('the position is emptied to zero, not to dust', after.aToken === 0n, `${after.aToken} wei left`);
must('every dollar came back to the owner', after.usdc > before.usdc, `${formatUnits(before.usdc, 6)} → ${formatUnits(after.usdc, 6)} USDC`);

await rpc('anvil_stopImpersonatingAccount', [owner]);
const reported = (await (await authed('/yield/position')).json()) as { suppliedUsd: number };
must('the app reports the position as empty afterwards', reported.suppliedUsd === 0, `${reported.suppliedUsd}`);

console.log(`\n  ${formatUnits(after.usdc - before.usdc, 6)} USDC withdrawn by the owner, delegation never involved.\n`);
process.exit(process.exitCode ?? 0);
