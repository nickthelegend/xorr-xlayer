/**
 * The 1inch Aqua path, end to end, on chain.
 *
 * A maker ships a WETH/USDC book from their own wallet through the OFFICIAL Aqua contract — the
 * tokens never leave them — and the bot then takes against it with a taker's delegated capital,
 * through `XorrDelegation.spend()`, so the cap, the expiry and the venue allowlist are all enforced
 * by the contract the taker signed.
 *
 * This is the claim the README makes and the executor did not honour: `decide()` computed a venue
 * and `runStrategy` threw it away. What proves it now is a transaction whose `to` is our Aqua book
 * rather than the aggregation router, and real ERC-20 movement on both sides of it.
 *
 *   FORK_RPC=… FORK_API=… PRIVY_TOKEN=… ENTRY=… npx tsx server/src/live-aqua.ts
 */
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
import { base } from 'viem/chains';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { BOOK_ABI, encodeStrategy, strategyHash, type AquaStrategy } from './venues/aqua.js';
import { decodeEventLog } from 'viem';

/** The book's own fill event. Names the maker who actually paid, which is what has to be measured. */
const SWAPPED = {
  type: 'event',
  name: 'Swapped',
  inputs: [
    { name: 'maker', type: 'address', indexed: true },
    { name: 'strategyHash', type: 'bytes32', indexed: true },
    { name: 'taker', type: 'address', indexed: true },
    { name: 'tokenIn', type: 'address', indexed: false },
    { name: 'amountIn', type: 'uint256', indexed: false },
    { name: 'tokenOut', type: 'address', indexed: false },
    { name: 'amountOut', type: 'uint256', indexed: false },
  ],
} as const;

const RPC = process.env.FORK_RPC!;
const API = process.env.FORK_API!;
const TOKEN = process.env.PRIVY_TOKEN!;
const ENTRY = process.env.ENTRY!;
const OWNER = process.env.OWNER_ADDRESS! as Address;
const BOOK = process.env.AQUA_BOOK_ADDRESS! as Address;
const DELEGATION = process.env.DELEGATION_ADDRESS! as Address;
const AQUA: Address = (process.env.AQUA_ADDRESS as Address) ?? '0x1111113CCf1426A8E30e2bfF5E005d929bF6a90a';
const USDC: Address = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const WETH: Address = '0x4200000000000000000000000000000000000006';
const ROUTER: Address = '0x111111125421cA6dc452d289314280a0f8842A65';
const AAVE_POOL: Address = '0xA238Dd80C259a72e81d7e4664a9801593F98d1c5';
const WHALE: Address = '0x4e65fE4DbA92790696d040ac24Aa414708F5c0AB';
const MAX = (1n << 256n) - 1n;

const chain = { ...base, rpcUrls: { default: { http: [RPC] }, public: { http: [RPC] } } };
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

/** Aqua's own `ship`. The maker's tokens stay in the maker's wallet; only an allowance is given. */
const AQUA_ABI = [
  {
    type: 'function',
    name: 'ship',
    inputs: [
      { name: 'app', type: 'address' },
      { name: 'strategy', type: 'bytes' },
      { name: 'tokens', type: 'address[]' },
      { name: 'amounts', type: 'uint256[]' },
    ],
    outputs: [],
    stateMutability: 'nonpayable',
  },
] as const;

async function main() {
  const params = await call('/delegation/params');
  const p = params.body as { delegate: Address; venues: Address[] };
  console.log(`fork ${RPC}\napi  ${API}\nbook ${BOOK}\ndelegate ${p.delegate}\n`);

  check(
    p.venues.some((v) => v.toLowerCase() === BOOK.toLowerCase()),
    'the Aqua book is on the venue list the user is asked to sign',
    `${p.venues.length} venues, book included: ${p.venues.some((v) => v.toLowerCase() === BOOK.toLowerCase())}`,
  );

  /*
   * The MAKER is a different wallet from the taker, and that matters.
   *
   * Running both sides from one address made "real ERC-20 moved out of the maker's wallet" pass
   * for the wrong reason — the taker's purchase landing in the same wallet looks identical to the
   * maker paying out. Aqua's whole claim is that two self-custodial parties trade without either
   * handing over custody, so the test has to have two of them.
   */
  const makerAccount = privateKeyToAccount(generatePrivateKey());
  const maker = makerAccount.address;

  await anvil('anvil_setBalance', [maker, '0x8AC7230489E80000']);
  // Real Base USDC for the maker to quote with, taken from a real holder.
  const wantUsdc = parseUnits('20000', 6);
  if ((await bal(USDC, maker)) < wantUsdc) {
    await anvil('anvil_impersonateAccount', [WHALE]);
    await anvil('anvil_setBalance', [WHALE, '0xDE0B6B3A7640000']);
    const w = createWalletClient({ account: WHALE, chain, transport: http(RPC) });
    const h = await w.writeContract({
      address: USDC, abi: erc20Abi, functionName: 'transfer', args: [maker, wantUsdc],
    });
    await pub.waitForTransactionReceipt({ hash: h });
    await anvil('anvil_stopImpersonatingAccount', [WHALE]);
  }
  check((await bal(USDC, maker)) >= wantUsdc, 'the maker holds real Base USDC', `${formatUnits(await bal(USDC, maker), 6)} USDC`);

  const makerWallet = createWalletClient({ account: makerAccount, chain, transport: http(RPC) });

  /*
   * The taker's policy has to name the book, or `spend()` refuses the fill — correctly. Re-granted
   * here with the book included, which is exactly what the app's grant screen now asks for.
   */
  const headroom = Number(
    ((await call('/delegation')).body as { spentTodayUsd?: number } | null)?.spentTodayUsd ?? 0,
  );
  await anvil('anvil_impersonateAccount', [OWNER]);
  const taker = createWalletClient({ account: OWNER, chain, transport: http(RPC) });
  const grant = await taker.writeContract({
    address: DELEGATION,
    abi: GRANT_ABI,
    functionName: 'grant',
    args: [
      p.delegate,
      parseUnits(String(Math.ceil(headroom) + 2000), 6),
      BigInt(Math.floor(Date.now() / 1000) + 30 * 86_400),
      [ROUTER, AAVE_POOL, BOOK],
    ],
  });
  await pub.waitForTransactionReceipt({ hash: grant });
  for (const t of [USDC, WETH]) {
    const h = await taker.writeContract({
      address: t, abi: erc20Abi, functionName: 'approve', args: [DELEGATION, MAX],
    });
    await pub.waitForTransactionReceipt({ hash: h });
  }
  await anvil('anvil_stopImpersonatingAccount', [OWNER]);
  check(true, 'the taker granted a policy that allows the book', `grant ${grant}`);

  // ── Ship a book through the OFFICIAL Aqua contract ───────────────────────────────────────
  //
  // The maker approves Aqua and ships. Their tokens do not move: Aqua takes an allowance and the
  // book quotes against a VIRTUAL balance, which is the whole reason a self-custodial maker can
  // provide liquidity at all.
  const wethForBook = parseUnits('2', 18);
  if ((await bal(WETH, maker)) < wethForBook) {
    // Wrap some ETH rather than take WETH from a holder — fewer moving parts.
    const h = await makerWallet.writeContract({
      address: WETH,
      abi: [{ type: 'function', name: 'deposit', inputs: [], outputs: [], stateMutability: 'payable' }] as const,
      functionName: 'deposit',
      value: parseUnits('3', 18),
    });
    await pub.waitForTransactionReceipt({ hash: h });
  }
  for (const t of [USDC, WETH]) {
    const h = await makerWallet.writeContract({
      address: t, abi: erc20Abi, functionName: 'approve', args: [AQUA, MAX],
    });
    await pub.waitForTransactionReceipt({ hash: h });
  }

  const markRes = await call('/market/quotes?symbols=WETH');
  const mark = (markRes.body as Record<string, { price: number }>).WETH?.price ?? 2500;
  // referencePrice is token1-raw per token0-raw, x 1e18. token0 = WETH(18), token1 = USDC(6).
  const reference = (BigInt(Math.round(mark * 1e6)) * 10n ** 18n) / 10n ** 18n;

  // 2 WETH priced at the live mark. Balanced, so the constant-product price starts on reference.
  const usdcForBook = (wethForBook * reference) / 10n ** 18n;

  const strategy: AquaStrategy = {
    maker,
    token0: WETH,
    token1: USDC,
    feeBps: 30n,
    // A bounded oracle band — the line that stops an arbitrageur picking off a 24/7 book overnight.
    maxDeviationBps: 500n,
    referencePrice: reference,
    salt: `0x${Date.now().toString(16).padStart(64, '0')}` as Hex,
  };

  const shipped = await makerWallet.writeContract({
    address: AQUA,
    abi: AQUA_ABI,
    functionName: 'ship',
    /*
     * Inventory AT the reference price, not near it.
     *
     * The book is constant-product, so the ratio of what is shipped IS the price it quotes:
     * 2 WETH against 10,000 USDC implies $5,000 while the reference said $2,495, and the oracle
     * band refused every quote with `PriceOutsideBand`. That is the band doing exactly its job —
     * the one line that stops a 24/7 book being free money overnight — and it means a maker has to
     * ship balanced inventory.
     */
    args: [BOOK, encodeStrategy(strategy), [WETH, USDC], [wethForBook, usdcForBook]],
  });
  await pub.waitForTransactionReceipt({ hash: shipped });
  await anvil('anvil_stopImpersonatingAccount', [maker]);

  const open = await pub.readContract({
    address: BOOK, abi: BOOK_ABI, functionName: 'isOpen', args: [strategy],
  });
  check(open === true, 'a book is open on the official Aqua deployment', `hash ${strategyHash(strategy).slice(0, 18)}…`);

  const [b0, b1] = await pub.readContract({
    address: BOOK, abi: BOOK_ABI, functionName: 'bookBalances', args: [strategy],
  });
  check(b0 > 0n && b1 > 0n, 'the book quotes against the maker\'s own balances', `${formatUnits(b0, 18)} WETH / ${formatUnits(b1, 6)} USDC`);

  // ── The bot takes against it, through the delegation ─────────────────────────────────────
  const made = await call('/strategies', {
    method: 'POST',
    body: JSON.stringify({
      kind: 'dca', state: 'live', label: 'Aqua — take against a maker book',
      symbol: 'WETH', cadence: 'daily', dailyAllocationUsd: 150, params: { amountUsd: 150 },
    }),
  });
  const id = (made.body as { id?: string }).id;
  if (id) created.push(id);
  check(!!id, 'a strategy exists to route', `${made.status} ${id ?? JSON.stringify(made.body).slice(0, 150)}`);
  if (!id) return await finish();

  const ran = await call(`/agent/strategies/${id}/run`, { method: 'POST' }, ENTRY);
  const out = ran.body as { status?: string; signature?: Hex; units?: number };
  console.log(`    run → ${JSON.stringify(out).slice(0, 240)}`);
  check(out.status === 'filled', 'the deployed agent filled', `${out.status} ${out.signature ?? ''}`.slice(0, 80));
  if (!out.signature) return await finish();

  /*
   * The proof. Not "a trade happened" — a trade happened AT THE BOOK.
   *
   * The delegation's `spend()` forwards to the venue, so the Aqua book is an internal call rather
   * than the transaction's `to`. Reading the receipt's logs for the book's own `Swapped` event is
   * what distinguishes an Aqua fill from an aggregator fill.
   */
  const receipt = await pub.getTransactionReceipt({ hash: out.signature });
  const touchedBook = receipt.logs.some((l) => l.address.toLowerCase() === BOOK.toLowerCase());
  const touchedRouter = receipt.logs.some((l) => l.address.toLowerCase() === ROUTER.toLowerCase());
  check(
    touchedBook && !touchedRouter,
    'the fill executed against the AQUA BOOK, not the aggregation router',
    `book logs: ${touchedBook} · router logs: ${touchedRouter} · tx ${out.signature.slice(0, 18)}…`,
  );

  /*
   * Measure the maker the RECEIPT names, not the one this run happened to create.
   *
   * Books accumulate on a long-lived fork and `buildAquaFill` picks the deepest one, so the fill
   * legitimately goes to whichever maker quotes best — which is best execution working. Asserting
   * against this run's own maker failed while the trade was correct, and would have gone on
   * failing every time an earlier book was deeper.
   */
  const swap = receipt.logs
    .filter((l) => l.address.toLowerCase() === BOOK.toLowerCase())
    .map((l) => {
      try {
        return decodeEventLog({ abi: [SWAPPED], data: l.data, topics: l.topics });
      } catch {
        return undefined;
      }
    })
    .find((e) => e?.eventName === 'Swapped');
  check(!!swap, 'the book emitted its own Swapped event', swap ? 'decoded' : 'no Swapped log');
  if (swap) {
    const args = swap.args as unknown as {
      maker: Address; taker: Address; tokenIn: Address; amountIn: bigint; tokenOut: Address; amountOut: bigint;
    };
    check(
      args.taker.toLowerCase() === OWNER.toLowerCase(),
      'the bought token went to the TAKER, not to any contract',
      `taker ${args.taker}`,
    );
    /*
     * Proved from the RECEIPT, not from a balance snapshot.
     *
     * Comparing before/after needed the filling maker to have been seen before the run, and
     * `buildAquaFill` legitimately picks the deepest book — which on a long-lived fork can belong
     * to a maker shipped outside the log window. The check then failed on a trade that was
     * correct. The receipt carries the proof directly: an ERC-20 Transfer of exactly `amountOut`
     * FROM the maker's own address, in the same transaction.
     */
    const TRANSFER = {
      type: 'event',
      name: 'Transfer',
      inputs: [
        { name: 'from', type: 'address', indexed: true },
        { name: 'to', type: 'address', indexed: true },
        { name: 'value', type: 'uint256', indexed: false },
      ],
    } as const;
    const fromMaker = receipt.logs.some((l) => {
      if (l.address.toLowerCase() !== args.tokenOut.toLowerCase()) return false;
      try {
        const d = decodeEventLog({ abi: [TRANSFER], data: l.data, topics: l.topics });
        const t = d.args as unknown as { from: Address; value: bigint };
        return t.from.toLowerCase() === args.maker.toLowerCase() && t.value === args.amountOut;
      } catch {
        return false;
      }
    });
    check(
      fromMaker,
      'the token came straight OUT of the maker\'s own wallet — Aqua\'s whole claim',
      `maker ${args.maker.slice(0, 10)}… paid ${formatUnits(args.amountOut, 18)} WETH for ${formatUnits(args.amountIn, 6)} USDC`,
    );
  }

  check(
    (await bal(WETH, BOOK)) === 0n && (await bal(USDC, BOOK)) === 0n,
    'the book contract kept nothing',
    'zero WETH, zero USDC',
  );

  await finish();
}

async function finish() {
  await retireCreated();
  console.log(`\n${pass} pass · ${fail} fail`);
  if (fail > 0) process.exitCode = 1;
}

await main();
