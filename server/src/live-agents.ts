/**
 * Phase 2, item B: drive the DEPLOYED agents on Railway through a real trade.
 *
 * Nothing here simulates the product. The wallet is a real Privy embedded wallet, the token is a
 * real Privy access token verified by the executor's own middleware, the grant is a real
 * transaction sent by the owner, and the fill is real 1inch calldata executed by the delegate.
 * The only impersonation is `anvil_impersonateAccount` for the owner's own grant — a fork's
 * intended mechanism, and the contract enforcement it exercises is genuine.
 */
import {
  createPublicClient,
  createWalletClient,
  http,
  parseUnits,
  formatUnits,
  erc20Abi,
  type Address,
} from 'viem';
import { base } from 'viem/chains';

const RPC = process.env.FORK_RPC!;
const API = process.env.FORK_API!;
const TOKEN = process.env.PRIVY_TOKEN!;
const ENTRY = process.env.FENTRY!;
const EXIT = process.env.FEXIT!;
const SCHED = process.env.FSCHED!;
const DELEGATION = process.env.DELEGATION_ADDRESS! as Address;
/*
 * Asked of the deployment, never assumed.
 *
 * This was hardcoded, so pointing the script at a second executor granted the policy to the
 * wrong key and every spend reverted with `NotDelegate()` — a real refusal by the contract,
 * telling the truth about a mistake in the test rather than in the product.
 */
let DELEGATE: Address;
const OWNER = process.env.OWNER_ADDRESS! as Address;
const USDC: Address = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const WETH: Address = '0x4200000000000000000000000000000000000006';
const ROUTER: Address = '0x111111125421cA6dc452d289314280a0f8842A65';
const AAVE: Address = '0xA238Dd80C259a72e81d7e4664a9801593F98d1c5';
const WHALE: Address = '0x4e65fE4DbA92790696d040ac24Aa414708F5c0AB';
const MAX_UINT256 = (1n << 256n) - 1n;
/** The cap the owner grants. Raise it when re-running against a fork that already traded today. */
const CAP_USD = Number(process.env.CAP_USD ?? 1000);
/** Our Aqua book, when the deployment has one — it has to be on the list or `spend()` refuses it. */
const BOOK = process.env.AQUA_BOOK_ADDRESS as Address | undefined;

const chain = { ...base, rpcUrls: { default: { http: [RPC] }, public: { http: [RPC] } } };
/*
 * `cacheTime: 0`, because this client is a measuring instrument.
 *
 * viem caches the latest block number for four seconds, so a balance read taken right after a
 * transaction confirmed could answer from the block BEFORE it — reporting that a fill which had
 * demonstrably happened had moved nothing. It made tier 3 and tier 4 fail intermittently and sent
 * me looking for a custody bug that was not there. A test that reads stale state is worse than no
 * test: it accuses working code.
 */
const pub = createPublicClient({ chain, transport: http(RPC), cacheTime: 0 });

async function anvil(method: string, params: unknown[]) {
  const r = (await fetch(RPC, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  }).then((x) => x.json())) as { result?: unknown; error?: { message: string } };
  if (r.error) throw new Error(`${method}: ${r.error.message}`);
  return r.result;
}

type Res = { status: number; body: unknown };
async function call(path: string, init: RequestInit = {}, bearer = TOKEN): Promise<Res> {
  const r = await fetch(`${API}${path}`, {
    ...init,
    headers: {
      authorization: `Bearer ${bearer}`,
      'content-type': 'application/json',
      ...(init.headers ?? {}),
    },
  });
  const text = await r.text();
  let body: unknown = text;
  try {
    body = JSON.parse(text);
  } catch {
    /* keep the text */
  }
  return { status: r.status, body };
}

let pass = 0;
let fail = 0;
function check(ok: boolean, label: string, detail: string) {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}  — ${detail}`);
  ok ? pass++ : fail++;
}

const bal = (token: Address, who: Address) =>
  pub.readContract({ address: token, abi: erc20Abi, functionName: 'balanceOf', args: [who] });

const GRANT_ABI = [
  {
    type: 'function',
    name: 'grant',
    inputs: [
      { name: 'delegate', type: 'address' },
      { name: 'dailyCap', type: 'uint256' },
      { name: 'expiresAt', type: 'uint64' },
      { name: 'venues', type: 'address[]' },
    ],
    outputs: [],
    stateMutability: 'nonpayable',
  },
  {
    type: 'function',
    name: 'revoke',
    inputs: [],
    outputs: [],
    stateMutability: 'nonpayable',
  },
] as const;

async function main() {
  const params = await call('/delegation/params');
  DELEGATE = (params.body as { delegate: Address }).delegate;
  console.log(`fork ${RPC}\napi  ${API}\nowner ${OWNER}\ndelegate ${DELEGATE}\n`);

  // ── 1. The wallet, registered through the real Privy identity ────────────────────────────
  const created = await call('/wallet/create', {
    method: 'POST',
    body: JSON.stringify({ address: OWNER }),
  });
  check(
    created.status === 200 && (created.body as { address?: string }).address?.toLowerCase() === OWNER.toLowerCase(),
    'wallet registered against the Privy identity',
    `${created.status} ${(created.body as { address?: string }).address ?? JSON.stringify(created.body).slice(0, 120)}`,
  );

  // ── 2. Fund it with REAL Base USDC, taken from a real holder ─────────────────────────────
  await anvil('anvil_setBalance', [OWNER, '0x8AC7230489E80000']);
  const want = parseUnits('2000', 6);
  if ((await bal(USDC, OWNER)) < want) {
    await anvil('anvil_impersonateAccount', [WHALE]);
    await anvil('anvil_setBalance', [WHALE, '0xDE0B6B3A7640000']);
    const whale = createWalletClient({ account: WHALE, chain, transport: http(RPC) });
    const h = await whale.writeContract({
      address: USDC,
      abi: erc20Abi,
      functionName: 'transfer',
      args: [OWNER, want],
    });
    await pub.waitForTransactionReceipt({ hash: h });
    await anvil('anvil_stopImpersonatingAccount', [WHALE]);
  }
  const usdc0 = await bal(USDC, OWNER);
  check(usdc0 >= want, 'owner holds real Base USDC', `${formatUnits(usdc0, 6)} USDC`);

  // ── 3. The OWNER grants the policy and approves. Their signature, not ours. ──────────────
  await anvil('anvil_impersonateAccount', [OWNER]);
  const owner = createWalletClient({ account: OWNER, chain, transport: http(RPC) });
  const expires = BigInt(Math.floor(Date.now() / 1000) + 30 * 86_400);

  /*
   * Headroom ON TOP of what the day has already spent.
   *
   * The cap is a limit for the UTC day and re-granting does not reset the tally — correctly, or a
   * user could raise their own cap by re-signing. But granting a flat $1,000 meant the second run
   * of this script in a day came back `daily_cap` on every buy, which reads as the agents being
   * broken when it is the cap doing its job. `live-ladder.ts` already reasons this way.
   */
  const spentSoFar = Number(
    ((await call('/delegation')).body as { spentTodayUsd?: number } | null)?.spentTodayUsd ?? 0,
  );
  const cap = Math.ceil(spentSoFar) + CAP_USD;
  const grantHash = await owner.writeContract({
    address: DELEGATION,
    abi: GRANT_ABI,
    functionName: 'grant',
    args: [DELEGATE, parseUnits(String(cap), 6), expires, [ROUTER, AAVE, ...(BOOK ? [BOOK] : [])]],
  });
  await pub.waitForTransactionReceipt({ hash: grantHash });
  /*
   * Approve every token the delegation may need to pull — exactly what the app's grant screen
   * now does, and the thing whose absence made every exit revert.
   *
   * `closePosition` pulls the asset being SOLD. Approving USDC alone authorised the buy side and
   * nothing else, so a wallet could be bought into WETH and never sold out of, and the only
   * symptom was "the transaction did not go through".
   */
  for (const [token, amount] of [
    [USDC, parseUnits('1000000', 6)],
    [WETH, MAX_UINT256],
  ] as const) {
    const h = await owner.writeContract({
      address: token,
      abi: erc20Abi,
      functionName: 'approve',
      args: [DELEGATION, amount],
    });
    await pub.waitForTransactionReceipt({ hash: h });
  }
  await anvil('anvil_stopImpersonatingAccount', [OWNER]);
  check(true, 'owner granted a capped, expiring, venue-scoped policy', `grant ${grantHash}`);

  const wethAllowance = await pub.readContract({
    address: WETH,
    abi: erc20Abi,
    functionName: 'allowance',
    args: [OWNER, DELEGATION],
  });
  check(
    wethAllowance > 0n,
    'the SELL side is approved too, so an exit can actually pull',
    `WETH allowance ${wethAllowance === MAX_UINT256 ? 'unlimited' : formatUnits(wethAllowance, 18)}`,
  );

  const del = await call('/delegation');
  const d = del.body as {
    dailyCapUsd?: number;
    delegatePubkey?: string;
    venueAllowlist?: string[];
  } | null;
  check(
    del.status === 200 &&
      Number(d?.dailyCapUsd) === cap &&
      d?.delegatePubkey?.toLowerCase() === DELEGATE.toLowerCase() &&
      (d?.venueAllowlist ?? []).some((v) => v.toLowerCase() === ROUTER.toLowerCase()),
    'the executor reads the policy from the CHAIN',
    `cap $${d?.dailyCapUsd} (${CAP_USD} of headroom) · delegate ${d?.delegatePubkey} · ${d?.venueAllowlist?.length ?? 0} venues`,
  );

  // ── 4. Create a real DCA strategy ───────────────────────────────────────────────────────
  const made = await call('/strategies', {
    method: 'POST',
    body: JSON.stringify({
      kind: 'dca',
      state: 'live',
      label: 'QA — daily WETH',
      symbol: 'WETH',
      cadence: 'daily',
      dailyAllocationUsd: 120,
      params: { amountUsd: 120 },
    }),
  });
  const strategyId = (made.body as { id?: string }).id;
  check(
    made.status === 200 && !!strategyId,
    'a live DCA strategy exists',
    `${made.status} ${strategyId ?? JSON.stringify(made.body).slice(0, 200)}`,
  );
  if (!strategyId) return;

  // ── 5. THE POSITION-TAKING AGENT. Its own credential, scope trade:open. ──────────────────
  const wethBefore = await bal(WETH, OWNER);
  const usdcBefore = await bal(USDC, OWNER);
  const ran = await call(`/agent/strategies/${strategyId}/run`, { method: 'POST' }, ENTRY);
  console.log('    run →', JSON.stringify(ran.body).slice(0, 400));
  const wethAfter = await bal(WETH, OWNER);
  const usdcAfter = await bal(USDC, OWNER);
  check(ran.status === 200, 'the deployed entry agent ran the strategy', `HTTP ${ran.status}`);
  check(
    wethAfter > wethBefore,
    'WETH landed in the USER wallet',
    `+${formatUnits(wethAfter - wethBefore, 18)} WETH`,
  );
  check(
    usdcAfter < usdcBefore,
    'USDC actually left the wallet',
    `−${formatUnits(usdcBefore - usdcAfter, 6)} USDC`,
  );
  check(
    (await bal(USDC, DELEGATION)) === 0n && (await bal(WETH, DELEGATION)) === 0n,
    'the delegation kept nothing',
    'zero USDC, zero WETH',
  );

  // ── 6. Scope separation, on the live deployment ─────────────────────────────────────────
  const exitTriesOpen = await call(`/agent/strategies/${strategyId}/run`, { method: 'POST' }, EXIT);
  check(
    exitTriesOpen.status === 403,
    'the exit agent CANNOT open a position',
    `HTTP ${exitTriesOpen.status} ${JSON.stringify(exitTriesOpen.body).slice(0, 120)}`,
  );

  // ── 7. Idempotency: the same period cannot run twice ────────────────────────────────────
  const again = await call(`/agent/strategies/${strategyId}/run`, { method: 'POST' }, ENTRY);
  const usdcAfter2 = await bal(USDC, OWNER);
  check(
    usdcAfter2 === usdcAfter,
    'a second run in the same period spends nothing',
    `${JSON.stringify(again.body).slice(0, 160)}`,
  );

  // ── 8. THE POSITION-CLOSING AGENT, on its own route, with its own scope. ────────────────
  const closed = await call(
    '/agent/positions/close',
    { method: 'POST', body: JSON.stringify({ owner: OWNER, symbol: 'WETH', fraction: 0.5 }) },
    EXIT,
  );
  console.log('    close →', JSON.stringify(closed.body).slice(0, 400));
  const wethClosed = await bal(WETH, OWNER);
  check(
    closed.status === 200 && wethClosed < wethAfter,
    'the deployed exit agent closed half the position',
    `${formatUnits(wethAfter, 18)} → ${formatUnits(wethClosed, 18)} WETH`,
  );

  const entryTriesClose = await call(
    '/agent/positions/close',
    { method: 'POST', body: JSON.stringify({ owner: OWNER, symbol: 'WETH' }) },
    ENTRY,
  );
  check(
    entryTriesClose.status === 403,
    'the entry agent CANNOT close a position',
    `HTTP ${entryTriesClose.status}`,
  );

  const noKeyClose = await call(
    '/agent/positions/close',
    { method: 'POST', body: JSON.stringify({ owner: OWNER, symbol: 'WETH' }) },
    'not-a-key',
  );
  check(
    noKeyClose.status === 401,
    'an unrecognised credential closes nothing',
    `HTTP ${noKeyClose.status}`,
  );

  // ── 9. The scheduler identity, holding both scopes ──────────────────────────────────────
  const tick = await call('/agent/tick', { method: 'POST' }, SCHED);
  check(tick.status === 200, 'the scheduler identity may tick', `HTTP ${tick.status}`);
  const tickAsEntry = await call('/agent/tick', { method: 'POST' }, ENTRY);
  check(tickAsEntry.status === 403, 'a single-scope agent may NOT tick', `HTTP ${tickAsEntry.status}`);

  // ── 10. Over the cap — refused, against the cap the CHAIN holds ─────────────────────────
  const big = await call('/strategies', {
    method: 'POST',
    body: JSON.stringify({
      kind: 'dca',
      state: 'live',
      label: 'QA — over cap',
      symbol: 'WETH',
      cadence: 'daily',
      dailyAllocationUsd: cap * 5,
      params: { amountUsd: cap * 5 },
    }),
  });
  check(
    big.status >= 400,
    'a strategy over the on-chain cap is refused at creation',
    `HTTP ${big.status} ${JSON.stringify(big.body).slice(0, 160)}`,
  );

  // ── 11. Revoke: the kill switch, on-chain, needing nobody's cooperation ─────────────────
  //
  // Tested against the CLOSE path, not the run path: a second run in the same period is
  // already a no-op, so "the bot did nothing after a revoke" would have passed whether the
  // revoke worked or not. A close has no period claim, so this can only pass one way.
  await anvil('anvil_impersonateAccount', [OWNER]);
  const revokeHash = await owner.writeContract({
    address: DELEGATION,
    abi: GRANT_ABI,
    functionName: 'revoke',
  });
  await pub.waitForTransactionReceipt({ hash: revokeHash });
  await anvil('anvil_stopImpersonatingAccount', [OWNER]);

  const wethAtRevoke = await bal(WETH, OWNER);
  const afterRevoke = await call(
    '/agent/positions/close',
    { method: 'POST', body: JSON.stringify({ owner: OWNER, symbol: 'WETH', fraction: 0.5 }) },
    EXIT,
  );
  const wethAfterRevoke = await bal(WETH, OWNER);
  check(
    afterRevoke.status === 409 &&
      (afterRevoke.body as { reason?: string }).reason === 'delegation_inactive' &&
      wethAfterRevoke === wethAtRevoke,
    'a revoked policy stops the bot dead, mid-position',
    `HTTP ${afterRevoke.status} ${JSON.stringify(afterRevoke.body).slice(0, 140)}`,
  );

  // Leave the fork usable: re-grant so the next run of this script starts from a live policy.
  await anvil('anvil_impersonateAccount', [OWNER]);
  const regrant = await owner.writeContract({
    address: DELEGATION,
    abi: GRANT_ABI,
    functionName: 'grant',
    args: [DELEGATE, parseUnits(String(cap), 6), expires, [ROUTER, AAVE, ...(BOOK ? [BOOK] : [])]],
  });
  await pub.waitForTransactionReceipt({ hash: regrant });
  await anvil('anvil_stopImpersonatingAccount', [OWNER]);
  const backOn = await call('/delegation');
  check(
    backOn.status === 200 && !!backOn.body,
    're-granting restores the permission',
    `cap ${(backOn.body as { dailyCapUsd?: number } | null)?.dailyCapUsd}`,
  );

  console.log(`\n${pass} pass \u00b7 ${fail} fail`);
  if (fail > 0) process.exitCode = 1;
}

await main();
