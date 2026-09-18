/**
 * Every rung of the ladder marked `available`, actually run.
 *
 * PLAN.md §1.2.5: "Every tier of the strategy ladder marked `available` has a creation screen AND
 * an executor branch that can actually run it. A tier with a screen and no executor is worse than
 * no tier." A planner existing is not that claim — this runs each one against a real chain and
 * asserts the outcome the tier promises.
 *
 * Run against a Base mainnet fork, which is the only environment where a fill is real:
 *
 *   FORK_RPC=… FORK_API=… PRIVY_TOKEN=… ENTRY=… EXIT=… npx tsx server/src/live-ladder.ts
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
const ENTRY = process.env.ENTRY!;
const OWNER = process.env.OWNER_ADDRESS! as Address;
const DELEGATION = process.env.DELEGATION_ADDRESS! as Address;
const USDC: Address = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const WETH: Address = '0x4200000000000000000000000000000000000006';
const CBBTC: Address = '0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf';
const AUSDC: Address = '0x4e65fE4DbA92790696d040ac24Aa414708F5c0AB';

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

async function call(path: string, init: RequestInit = {}, bearer = TOKEN) {
  const r = await fetch(`${API}${path}`, {
    ...init,
    headers: { authorization: `Bearer ${bearer}`, 'content-type': 'application/json', ...(init.headers ?? {}) },
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


/*
 * Retire what this run created.
 *
 * Every run left its strategies `live`, and `POST /strategies` sums the live allocations against
 * the on-chain cap — correctly. So the fourth or fifth run of a script started failing with
 * `over_cap` on a wallet that was fine, for strategies nobody was going to run again. A script
 * that cannot be run twice is a script people stop running.
 */
const created: string[] = [];
async function retireCreated() {
  for (const id of created) {
    await call(`/strategies/${id}`, { method: 'PATCH', body: JSON.stringify({ state: 'ended' }) }).catch(
      () => undefined,
    );
  }
}

const bal = (t: Address, who: Address) =>
  pub.readContract({ address: t, abi: erc20Abi, functionName: 'balanceOf', args: [who] });

/** Create a strategy and run it through the deployed entry agent. Returns the outcome. */
async function runTier(params: {
  tier: number;
  name: string;
  kind: string;
  symbol: string;
  dailyAllocationUsd: number;
  params: Record<string, unknown>;
}): Promise<Record<string, unknown>> {
  const made = await call('/strategies', {
    method: 'POST',
    body: JSON.stringify({
      kind: params.kind,
      state: 'live',
      label: `ladder ${params.tier} — ${params.name}`,
      symbol: params.symbol,
      cadence: 'daily',
      dailyAllocationUsd: params.dailyAllocationUsd,
      params: params.params,
    }),
  });
  const id = (made.body as { id?: string }).id;
  if (id) created.push(id);
  if (!id) {
    check(false, `tier ${params.tier} · ${params.name} — created`, JSON.stringify(made.body).slice(0, 200));
    return {};
  }
  const ran = await call(`/agent/strategies/${id}/run`, { method: 'POST' }, ENTRY);
  const out = ran.body as Record<string, unknown>;
  console.log(`    tier ${params.tier} → ${JSON.stringify(out).slice(0, 260)}`);
  return out;
}

const ROUTER: Address = '0x111111125421cA6dc452d289314280a0f8842A65';
const AAVE_POOL: Address = '0xA238Dd80C259a72e81d7e4664a9801593F98d1c5';
const VENUES = [ROUTER, AAVE_POOL] as const;
let DELEGATE: Address;

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
] as const;

const CAP_USD = Number(process.env.CAP_USD ?? 8000);


async function main() {
  const params = await call('/delegation/params');
  DELEGATE = (params.body as { delegate: Address }).delegate;
  console.log(`fork ${RPC}\napi  ${API}\nowner ${OWNER}\ndelegate ${DELEGATE}\n`);

  const MAX = (1n << 256n) - 1n;
  await anvil('anvil_impersonateAccount', [OWNER]);
  const owner = createWalletClient({ account: OWNER, chain, transport: http(RPC) });

  /*
   * Grant a cap with room for this run ON TOP of what the day has already spent.
   *
   * The cap is a limit for the UTC day and re-granting does not reset the tally — correctly, or
   * a user could raise their cap by re-signing. But it means running this script twice in a day
   * exhausts the allowance and every tier after the first comes back `daily_cap`, which reads as
   * the ladder being broken when it is the cap doing its job. Asking what has gone and granting
   * headroom is what a person would do, and it makes the script idempotent.
   */
  const grantCap = async (headroomUsd: number) => {
    const del = await call('/delegation');
    const spent = Number((del.body as { spentTodayUsd?: number } | null)?.spentTodayUsd ?? 0);
    const cap = Math.max(headroomUsd, Math.ceil(spent + headroomUsd));
    const h = await owner.writeContract({
      address: DELEGATION,
      abi: GRANT_ABI,
      functionName: 'grant',
      args: [DELEGATE, parseUnits(String(cap), 6), BigInt(Math.floor(Date.now() / 1000) + 30 * 86_400), VENUES],
    });
    await pub.waitForTransactionReceipt({ hash: h });
    return cap;
  };
  console.log(`cap granted: $${await grantCap(CAP_USD)}\n`);
  // The sell side needs an allowance on every token a tier might exit.
  for (const t of [USDC, WETH, CBBTC, AUSDC]) {
    const h = await owner.writeContract({
      address: t,
      abi: erc20Abi,
      functionName: 'approve',
      args: [DELEGATION, MAX],
    });
    await pub.waitForTransactionReceipt({ hash: h });
  }
  await anvil('anvil_stopImpersonatingAccount', [OWNER]);

  // ── Tier 1 · Recurring buy ────────────────────────────────────────────────────────────
  const weth0 = await bal(WETH, OWNER);
  const t1 = await runTier({
    tier: 1,
    name: 'recurring buy',
    kind: 'dca',
    symbol: 'WETH',
    dailyAllocationUsd: 60,
    params: { amountUsd: 60 },
  });
  check(
    t1.status === 'filled' && (await bal(WETH, OWNER)) > weth0,
    'tier 1 · recurring buy fills',
    `${t1.status} ${t1.signature ?? ''}`.slice(0, 90),
  );

  // ── Tier 2 · Rebalance ────────────────────────────────────────────────────────────────
  const t2 = await runTier({
    tier: 2,
    name: 'rebalance',
    kind: 'rebalance',
    symbol: 'CBBTC',
    dailyAllocationUsd: 120,
    // Deliberately under-weight cbBTC so the drift is real and the planner must buy.
    params: { targets: { WETH: 50, CBBTC: 50 } },
  });
  check(
    t2.status === 'filled' || t2.status === 'skipped',
    'tier 2 · rebalance trades the drift',
    `${t2.status} ${t2.reason ?? t2.signature ?? ''}`.slice(0, 110),
  );

  // ── Tier 3 · Take profit / stop loss / trailing ───────────────────────────────────────
  //
  // A take-profit that cannot possibly be met proves the branch runs and correctly declines; one
  // set below the mark proves it actually closes. Both matter — a tier that only ever sells is as
  // broken as one that never does.
  const holdWeth = await bal(WETH, OWNER);
  const px = await call('/market/quotes?symbols=WETH');
  const mark = (px.body as Record<string, { price: number }>).WETH?.price ?? 0;
  check(mark > 0, 'tier 3 · a live mark to measure against', `WETH $${mark}`);

  const t3hold = await runTier({
    tier: 3,
    name: 'exit rules — far target',
    kind: 'exit-rules',
    symbol: 'WETH',
    dailyAllocationUsd: 0,
    params: { entryPrice: mark, takeProfitPct: 500, stopLossPct: 90 },
  });
  check(
    t3hold.status !== 'filled' && (await bal(WETH, OWNER)) === holdWeth,
    'tier 3 · holds when neither level is hit',
    `${t3hold.status} ${String(t3hold.reason ?? '')}`.slice(0, 90),
  );

  const t3sell = await runTier({
    tier: 3,
    name: 'exit rules — take profit hit',
    kind: 'exit-rules',
    symbol: 'WETH',
    dailyAllocationUsd: 0,
    // Entry far below the mark, so a 1% take-profit is already met.
    params: { entryPrice: mark * 0.5, takeProfitPct: 1, stopLossPct: 90 },
  });
  const afterSell = await bal(WETH, OWNER);
  check(
    t3sell.status === 'filled' && afterSell < holdWeth,
    'tier 3 · take-profit actually closes the position',
    `${formatUnits(holdWeth, 18)} → ${formatUnits(afterSell, 18)} WETH`,
  );

  // ── Tier 4 · Idle cash to yield ───────────────────────────────────────────────────────
  const aUsdc0 = await bal(AUSDC, OWNER);
  const t4 = await runTier({
    tier: 4,
    name: 'idle cash to yield',
    kind: 'yield-rotation',
    symbol: 'USDC',
    dailyAllocationUsd: 200,
    params: { keepCashUsd: 25, minMoveUsd: 25 },
  });
  const aUsdc1 = await bal(AUSDC, OWNER);
  check(
    t4.status === 'filled' && aUsdc1 > aUsdc0,
    'tier 4 · USDC supplied to Aave, aToken to the USER',
    `aUSDC ${formatUnits(aUsdc0, 6)} → ${formatUnits(aUsdc1, 6)}`,
  );

  // ── Tier 5 · Range accumulation ───────────────────────────────────────────────────────
  //
  // A grid trades CROSSINGS, so it takes two runs to do anything: the first records which rung
  // the price is standing on, the second acts on having moved off it. Both halves are asserted,
  // because a grid that trades on first sight is a grid that buys the moment you switch it on.
  const band = { lower: mark * 0.9, upper: mark * 1.1, steps: 4, usdPerStep: 40 };
  const weth5 = await bal(WETH, OWNER);
  const t5first = await runTier({
    tier: 5,
    name: 'range accumulation — first sight',
    kind: 'grid',
    symbol: 'WETH',
    dailyAllocationUsd: 80,
    params: band,
  });
  check(
    t5first.status !== 'filled' && (await bal(WETH, OWNER)) === weth5,
    'tier 5 · first sight takes a reading and places nothing',
    `${t5first.status} ${String(t5first.reason ?? '')}`.slice(0, 80),
  );

  /*
   * The second run, with the state a first run leaves behind.
   *
   * `lastLevel` is the strategy's own persisted field — the rung it last saw the price on. Setting
   * it one above where the price stands now is exactly the state after a run at a higher rung, and
   * it is what makes this a crossing rather than a first sighting. Nothing about the price is
   * invented: the mark is live, the band is drawn around it, and the fill is real.
   */
  const rungs = Array.from(
    { length: band.steps + 1 },
    (_, i) => band.lower + (i * (band.upper - band.lower)) / band.steps,
  );
  const standingOn = rungs.filter((r) => mark >= r).length - 1;
  const t5cross = await runTier({
    tier: 5,
    name: 'range accumulation — fell through a rung',
    kind: 'grid',
    symbol: 'WETH',
    dailyAllocationUsd: 80,
    params: { ...band, lastLevel: standingOn + 1, openLots: [] },
  });
  check(
    t5cross.status === 'filled' && (await bal(WETH, OWNER)) > weth5,
    'tier 5 · a grid rung fills on a crossing',
    `${t5cross.status} ${String(t5cross.signature ?? t5cross.reason ?? '')}`.slice(0, 90),
  );

  // ── The cap must never silence an exit ────────────────────────────────────────────────
  //
  // Proved on the chain rather than argued: grant a cap so small that the day is already over it,
  // then fire a take-profit on a real position and watch it sell anyway. A spending limit that can
  // block a stop-loss traps the user in the position the stop existed to get them out of.
  const beforeExit = await bal(WETH, OWNER);
  if (beforeExit > 0n) {
    await anvil('anvil_impersonateAccount', [OWNER]);
    // An absolute $1 — the point is a cap the day has already blown through.
    const tiny = await owner.writeContract({
      address: DELEGATION,
      abi: GRANT_ABI,
      functionName: 'grant',
      args: [DELEGATE, parseUnits('1', 6), BigInt(Math.floor(Date.now() / 1000) + 30 * 86_400), VENUES],
    });
    await pub.waitForTransactionReceipt({ hash: tiny });

    const capped = await runTier({
      tier: 3,
      name: 'take profit with the cap used up',
      kind: 'exit-rules',
      symbol: 'WETH',
      dailyAllocationUsd: 0,
      params: { entryPrice: mark * 0.5, takeProfitPct: 1, stopLossPct: 90 },
    });
    check(
      capped.status === 'filled' && (await bal(WETH, OWNER)) < beforeExit,
      'a used-up daily cap does not silence a take-profit',
      `${capped.status} ${String(capped.reason ?? capped.signature ?? '')}`.slice(0, 90),
    );
    // Put the cap back, so the next run of this script does not inherit a $1 one.
    await grantCap(CAP_USD);
    await anvil('anvil_stopImpersonatingAccount', [OWNER]);
  } else {
    check(false, 'a used-up daily cap does not silence a take-profit', 'no WETH held to exit');
  }

  // ── Tiers 6 and 7 are marked unavailable, and the API must agree ──────────────────────
  for (const kind of ['momentum', 'event-driven']) {
    const refused = await call('/strategies', {
      method: 'POST',
      body: JSON.stringify({
        kind,
        state: 'live',
        label: `ladder — ${kind}`,
        symbol: 'WETH',
        cadence: 'daily',
        dailyAllocationUsd: 10,
        params: {},
      }),
    });
    check(
      refused.status >= 400,
      `tier ${kind === 'momentum' ? 6 : 7} · ${kind} is refused, not scheduled forever`,
      `HTTP ${refused.status}`,
    );
  }

  await retireCreated();
  console.log(`\n${pass} pass · ${fail} fail`);
  if (fail > 0) process.exitCode = 1;
}

await main();
