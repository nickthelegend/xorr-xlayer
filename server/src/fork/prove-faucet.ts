/**
 * The faucet on a Base fork, proven through a running executor (PLAN.md 4.4).
 *
 * What it shows, in order:
 *
 *   1. The test account signs in with a real Privy token, and its wallet is registered with the executor.
 *   2. `GET /faucet` says what one request sends, and that this wallet may ask.
 *   3. `POST /faucet` sends it. The receipt, read from the fork rather than taken from the executor, carries a USDC
 *      `Transfer` from Aave's reserve to the wallet for exactly that amount; the wallet's USDC rises by it, the reserve's
 *      falls by it, and the wallet's ETH ends at or above the floor and never below where it started.
 *   4. A second `POST /faucet` is refused with when the wallet may ask again, and nothing moves.
 *   5. `GET /faucet` agrees, and `GET /wallet/funds` — what the deposit screen polls — reads what the fork reads.
 *
 *   FORK_RPC=http://127.0.0.1:8551 FAUCET_EXECUTOR=http://127.0.0.1:8793 \
 *   npx tsx --env-file=.env server/src/fork/prove-faucet.ts
 *
 * Point it at an executor started with `XORR_CHAIN=xlayer-fork` on the same fork. It refuses any node that is not anvil. A
 * wallet's claim lasts a day, so a second run inside one proves only the refusal.
 */
import 'dotenv/config';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  createPublicClient,
  erc20Abi,
  formatEther,
  formatUnits,
  http,
  isAddressEqual,
  parseEther,
  parseEventLogs,
  type Address,
  type Hex,
} from 'viem';
import { base } from 'viem/chains';

const RPC = process.env.FORK_RPC;
const EXECUTOR = process.env.FAUCET_EXECUTOR;
if (!RPC) throw new Error('FORK_RPC is required: the anvil fork the executor settles on');
if (!EXECUTOR) throw new Error('FAUCET_EXECUTOR is required: an executor started with XORR_CHAIN=xlayer-fork on that fork');

const USDC: Address = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
/** Aave v3's aUSDC reserve: the holder the executor's faucet moves USDC from. */
const HOLDER: Address = '0x4e65fE4DbA92790696d040ac24Aa414708F5c0AB';
const EMAIL = process.env.E2E_PRIVY_EMAIL ?? 'test-8958@privy.io';
const TOKEN_SCRIPT = fileURLToPath(new URL('../e2e-token.ts', import.meta.url));

const chain = { ...base, rpcUrls: { default: { http: [RPC] }, public: { http: [RPC] } } };
const pub = createPublicClient({ chain, transport: http(RPC), cacheTime: 0 });

const node = await pub.request({ method: 'web3_clientVersion' });
if (!/^anvil\//i.test(node)) {
  throw new Error(`${RPC} answers as "${node}", not anvil. This proof moves tokens and runs only on a fork.`);
}

type Json = Record<string, unknown> | null;
type Answer = { status: number; retryAfter: string | null; body: Json };

/** A field deep in a response, or undefined. */
const field = (body: Json, ...path: string[]): unknown =>
  path.reduce<unknown>((v, k) => (v !== null && typeof v === 'object' ? (v as Record<string, unknown>)[k] : undefined), body);

// A bearer credential for the test account: held in memory, never printed.
const token = execFileSync('npx', ['tsx', TOKEN_SCRIPT, EMAIL], { encoding: 'utf8' }).trim();

async function call(method: 'GET' | 'POST', path: string): Promise<Answer> {
  const res = await fetch(`${EXECUTOR}${path}`, {
    method,
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: method === 'POST' ? '{}' : undefined,
  });
  return { status: res.status, retryAfter: res.headers.get('retry-after'), body: (await res.json().catch(() => null)) as Json };
}

function show(label: string, answer: Answer): void {
  const retry = answer.retryAfter ? ` (retry-after ${answer.retryAfter}s)` : '';
  console.log(`\n${label} → ${answer.status}${retry}\n${JSON.stringify(answer.body, null, 2)}`);
}

let failures = 0;
function check(what: string, ok: boolean, detail = ''): void {
  if (!ok) failures += 1;
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${what}${detail ? ` — ${detail}` : ''}`);
}

const usdcOf = (owner: Address) => pub.readContract({ address: USDC, abi: erc20Abi, functionName: 'balanceOf', args: [owner] });
const usdc = (raw: bigint) => `${formatUnits(raw, 6)} USDC`;
const eth = (wei: bigint) => `${formatEther(wei)} OKB`;

console.log(`fork ${RPC} · ${node} · chain ${await pub.getChainId()} · block ${await pub.getBlockNumber()}`);
console.log(`executor ${EXECUTOR} · account ${EMAIL}`);

/* ── 1. The wallet, registered. ── */
let registered = await call('GET', '/wallet');
if (!registered.body) registered = await call('POST', '/wallet/create');
const owner = field(registered.body, 'address') as Address | undefined;
if (!owner) throw new Error(`no wallet for ${EMAIL}: ${registered.status} ${JSON.stringify(registered.body)}`);
console.log(`wallet ${owner}`);

/* ── 2. What the faucet offers. ── */
const offer = await call('GET', '/faucet');
show('GET /faucet', offer);
check('the fork faucet can send', field(offer.body, 'available') === true, String(field(offer.body, 'detail')));
check('and this wallet may ask', field(offer.body, 'wallet', 'canAsk') === true);

/* ── 3. The send, checked against the fork itself. ── */
const [usdcBefore, ethBefore, reserveBefore] = await Promise.all([
  usdcOf(owner),
  pub.getBalance({ address: owner }),
  usdcOf(HOLDER),
]);
console.log(`\nbefore  wallet ${usdc(usdcBefore)}, ${eth(ethBefore)} · reserve ${usdc(reserveBefore)}`);

const sent = await call('POST', '/faucet');
show('POST /faucet', sent);
check('it sent', sent.status === 200 && field(sent.body, 'status') === 'sent');
if (sent.status !== 200) process.exit(1);

const txHash = field(sent.body, 'txHash') as Hex;
const amount = BigInt(String(field(sent.body, 'usdc', 'raw')));
const receipt = await pub.getTransactionReceipt({ hash: txHash });
const transfers = parseEventLogs({ abi: erc20Abi, eventName: 'Transfer', logs: receipt.logs }).filter((log) =>
  isAddressEqual(log.address, USDC),
);
console.log(`\nreceipt ${txHash} · block ${receipt.blockNumber} · ${receipt.status}`);
for (const t of transfers) {
  console.log(`  USDC Transfer  from ${t.args.from}  to ${t.args.to}  value ${usdc(t.args.value)}  (log ${t.logIndex})`);
}
check('the receipt, read from the fork, succeeded', receipt.status === 'success');
check(
  'it carries a USDC Transfer from Aave’s reserve to the wallet for exactly the amount sent',
  transfers.some((t) => isAddressEqual(t.args.from, HOLDER) && isAddressEqual(t.args.to, owner) && t.args.value === amount),
  usdc(amount),
);

const [usdcAfter, ethAfter, reserveAfter] = await Promise.all([usdcOf(owner), pub.getBalance({ address: owner }), usdcOf(HOLDER)]);
console.log(`after   wallet ${usdc(usdcAfter)}, ${eth(ethAfter)} · reserve ${usdc(reserveAfter)}`);
check('the wallet’s USDC rose by exactly that', usdcAfter - usdcBefore === amount, `${usdc(usdcBefore)} → ${usdc(usdcAfter)}`);
check('the reserve’s fell by exactly that', reserveBefore - reserveAfter === amount, `${usdc(reserveBefore)} → ${usdc(reserveAfter)}`);
const floor = parseEther(String(field(sent.body, 'eth', 'floor')));
check(
  'the wallet’s ETH is at the floor or above, and not below where it started',
  ethAfter >= floor && ethAfter >= ethBefore,
  `${eth(ethBefore)} → ${eth(ethAfter)}, floor ${eth(floor)}`,
);

/* ── 4. A second request inside the day. ── */
const again = await call('POST', '/faucet');
show('POST /faucet, again', again);
check(
  'it is refused, with when the wallet may ask again',
  again.status === 409 && field(again.body, 'reason') === 'claimed_recently' && field(again.body, 'nextAt') === field(sent.body, 'nextAt'),
  new Date(Number(field(again.body, 'nextAt'))).toISOString(),
);
check('and nothing moved', (await usdcOf(owner)) === usdcAfter);

/* ── 5. The status, and the balance read the deposit screen polls. ── */
const status = await call('GET', '/faucet');
show('GET /faucet, after', status);
check(
  'the status agrees: not until then',
  field(status.body, 'wallet', 'canAsk') === false && field(status.body, 'wallet', 'nextAt') === field(sent.body, 'nextAt'),
);

const funds = await call('GET', '/wallet/funds');
show('GET /wallet/funds', funds);
const ethNow = await pub.getBalance({ address: owner });
check(
  'it reads what the fork reads',
  field(funds.body, 'usdc', 'raw') === usdcAfter.toString() && field(funds.body, 'eth', 'raw') === ethNow.toString(),
);

console.log(failures === 0 ? '\nall checks passed' : `\n${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
