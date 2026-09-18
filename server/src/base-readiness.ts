/**
 * Is this build actually ready to run on Base mainnet?
 *
 * Every environment before this one has been a stand-in. Base Sepolia has no 1inch liquidity and no
 * tokenized equities; the fork has both, and is a copy. This asks the real chain the questions the
 * executor will ask it in production, and answers them with what came back.
 *
 * **Read-only, by construction.** It signs nothing, sends nothing, and holds no key. Running it
 * costs nothing but RPC calls, which is what makes it safe to run before deciding to go live —
 * a readiness check you cannot afford to run is not a readiness check.
 *
 * It does NOT deploy the delegation contract, and reports its absence as the blocker it is. That
 * deployment spends real gas and is a decision for a person.
 *
 *   XORR_CHAIN=base ALLOW_MAINNET=yes npx tsx src/base-readiness.ts
 */
import 'dotenv/config';
import { erc20Abi, formatUnits, type Address } from 'viem';
import { publicClient } from './evm/client.js';
import {
  ADDRESSES,
  AAVE_V3_POOL,
  CHAIN_KEY,
  SETTLEMENT_VENUES,
  chain,
  explorerTx,
  rpcUrl,
} from './evm/chains.js';
import { TOKENS, quote } from './venues/oneinch.js';
import { STOCKS } from './venues/stocks.js';
import { usdcSupplyYield } from './market/yield.js';

type Check = { name: string; ok: boolean; detail: string; blocking: boolean };
const checks: Check[] = [];

/**
 * Spacing between reads.
 *
 * `https://mainnet.base.org` is the free public endpoint and throttles after a short burst — this
 * check made about fifteen sequential contract reads and rate-limited itself from the sixth
 * onwards, reporting real, deployed tokens as failures. A readiness check whose own request rate
 * produces its findings is reporting its own bug.
 *
 * Deliberately not removed by pointing at a paid RPC: running on the endpoint a first deployment
 * would actually use is the point, and the throttle is a real property of it.
 */
const SPACING_MS = Number(process.env.READINESS_SPACING_MS ?? 350);
const space = () => new Promise((r) => setTimeout(r, SPACING_MS));

/** One error line, not a viem stack. The reason matters; the calldata does not. */
function reason(e: unknown): string {
  const m = e instanceof Error ? e.message : String(e);
  if (/over rate limit|429|too many requests/i.test(m)) return 'rate limited by the RPC';
  return m.split('\n')[0]!.slice(0, 120);
}

function record(name: string, ok: boolean, detail: string, blocking = true) {
  checks.push({ name, ok, detail, blocking });
  const mark = ok ? '  ok  ' : blocking ? ' FAIL ' : ' warn ';
  console.log(`${mark} ${name.padEnd(34)} ${detail}`);
}

async function main() {
  console.log(`\n  Base readiness — chain "${CHAIN_KEY}" via ${rpcUrl}\n`);

  if (CHAIN_KEY !== 'base') {
    console.log(
      `  This is pointed at "${CHAIN_KEY}", not Base mainnet. Re-run with XORR_CHAIN=base` +
        ' ALLOW_MAINNET=yes to check the real thing.\n',
    );
  }

  /* The chain itself. Wrong id means every address below is about a different chain. */
  try {
    const [id, block] = await Promise.all([
      publicClient.getChainId(),
      publicClient.getBlockNumber(),
    ]);
    record(
      'chain',
      id === chain.id,
      id === chain.id
        ? `id ${id} at block ${block}`
        : `expected ${chain.id}, got ${id} — this RPC is not the chain we configured`,
    );
  } catch (e) {
    record('chain', false, `unreachable: ${reason(e)}`);
  }

  /*
   * Every token the executor trades, in ONE request.
   *
   * This was fourteen sequential `readContract` calls and the public endpoint throttled it from
   * the sixth onwards — so real, deployed tokens were reported as unreachable by a check that had
   * caused the outage itself. Base has Multicall3 and viem batches through it automatically, which
   * is also how the app reads balances: a readiness check should ask the chain the way the product
   * asks it, not in a way the product never would.
   *
   * A successful `decimals()` is proof of code at the address, so the separate `getCode` per token
   * is gone with it.
   */
  const erc20s = Object.entries(TOKENS).filter(([symbol]) => symbol !== 'ETH');
  try {
    const results = await publicClient.multicall({
      contracts: erc20s.map(([, t]) => ({
        address: t.address,
        abi: erc20Abi,
        functionName: 'decimals' as const,
      })),
      allowFailure: true,
    });
    erc20s.forEach(([symbol, t], i) => {
      const r = results[i];
      const ok = r?.status === 'success';
      const decimals = ok ? Number(r.result) : undefined;
      record(
        `token ${symbol}`,
        ok && decimals === t.decimals,
        !ok
          ? 'no ERC-20 answering at that address'
          : decimals === t.decimals
            ? `${decimals} decimals`
            : `registry says ${t.decimals} decimals, chain says ${decimals}`,
        // An equity that does not exist is not a reason to refuse to launch — `/market/tradable`
        // already drops it. A settlement token that does not exist is.
        !(symbol in STOCKS),
      );
    });
  } catch (e) {
    record('tokens', false, reason(e));
  }

  /* Every venue the grant allows has to be a contract, or the user is signing away nothing. */
  for (const venue of SETTLEMENT_VENUES) {
    await space();
    try {
      const code = await publicClient.getCode({ address: venue });
      record(`venue ${venue.slice(0, 10)}…`, !!code && code !== '0x', `${(code?.length ?? 2) / 2 - 1} bytes`);
    } catch (e) {
      record(`venue ${venue.slice(0, 10)}…`, false, reason(e));
    }
  }

  /* Aave, because tier 4 supplies idle cash to it and a wrong pool address loses money quietly. */
  await space();
  try {
    const y = await usdcSupplyYield();
    record(
      'aave supply rate',
      y.estimatedApy > 0,
      `${(y.estimatedApy * 100).toFixed(2)}% at ${AAVE_V3_POOL.slice(0, 10)}… (${y.source})`,
    );
  } catch (e) {
    record('aave supply rate', false, reason(e));
  }

  /* A real route for a real size. This is the claim the whole product rests on. */
  await space();
  try {
    const q = await quote({ inSymbol: 'USDC', outSymbol: 'WETH', amount: 100 });
    record(
      '1inch route USDC→WETH',
      q.outAmount > 0,
      `100 USDC → ${q.outAmount.toFixed(6)} WETH via ${q.venues.join(', ') || 'unnamed venue'}`,
    );
  } catch (e) {
    record('1inch route USDC→WETH', false, reason(e));
  }

  /* The delegation contract. Absent on mainnet until someone deploys it, and that is a decision. */
  const delegation = process.env.DELEGATION_ADDRESS as Address | undefined;
  if (!delegation) {
    record('delegation contract', false, 'DELEGATION_ADDRESS is not set for this chain');
  } else {
    await space();
    try {
      const code = await publicClient.getCode({ address: delegation });
      const bytes = (code?.length ?? 2) / 2 - 1;
      record(
        'delegation contract',
        bytes > 0,
        bytes > 0
          ? `${bytes} bytes at ${delegation}`
          : `nothing deployed at ${delegation} on this chain — deploy it before going live`,
      );
    } catch (e) {
      record('delegation contract', false, reason(e));
    }
  }

  /* Explorer links have to point somewhere real, or the audit trail is unverifiable. */
  const sample = explorerTx('0x' + '11'.repeat(32));
  record(
    'explorer links',
    sample.startsWith('https://'),
    sample.startsWith('https://') ? sample.slice(0, 46) + '…' : `labelled "${sample.split(':')[0]}" — no public explorer`,
    CHAIN_KEY === 'base',
  );

  /*
   * The endpoint is itself a readiness question. The public Base RPC is fine for a check like this
   * with spacing and is not fine for an executor that reads balances on every screen load.
   */
  if (/mainnet\.base\.org/.test(rpcUrl)) {
    record(
      'rpc provider',
      false,
      'BASE_RPC is the free public endpoint, which throttles under normal app load — set a dedicated provider before going live',
      false,
    );
  }

  const failed = checks.filter((c) => !c.ok && c.blocking);
  const warned = checks.filter((c) => !c.ok && !c.blocking);
  console.log(
    `\n  ${checks.filter((c) => c.ok).length} ok · ${failed.length} blocking · ${warned.length} non-blocking\n`,
  );
  if (failed.length > 0) {
    console.log('  Blocking:');
    for (const f of failed) console.log(`    - ${f.name}: ${f.detail}`);
    console.log();
  }
  process.exitCode = failed.length > 0 ? 1 : 0;
}

void main();
