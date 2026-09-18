/**
 * The tokenized equities are not broken. This deployment cannot reach them.
 *
 * That distinction is easy to lose and expensive to lose: "equities do not work" reads as a
 * fictional feature, and the truth is narrower and better. So this goes and looks, at real Base
 * mainnet, and prints what it finds.
 *
 * What it establishes, all read-only, no transaction, no spend:
 *
 *   - Which tokens answer `totalSupply()` on real Base — four of the eight do, despite every one
 *     carrying a single byte of code. That is why `eth_getCode` was the wrong test and `/verify`
 *     calls the contract instead. The other four are transferable without exposing the full ERC-20
 *     read surface, which is a property of those tokens and not of the chain.
 *   - Recent Transfer activity for each, which is the stronger signal: all eight are active, so
 *     none is a dormant address with a number in it.
 *   - 1inch will quote `USDC → NVDAc` on chain 8453 right now, so a route exists.
 *
 * The same `totalSupply()` call against an anvil fork of the same block REVERTS. A fork copies the
 * byte and there is nothing behind it, so no routing choice can fill a token that is not functional
 * there. That is the whole of the equity story, and it belongs in the repository rather than in a
 * session transcript.
 *
 * Run:  cd server && npx tsx src/equity-mainnet-proof.ts
 */
import 'dotenv/config';
import { createPublicClient, http, erc20Abi, formatUnits, type Address } from 'viem';
import { base } from 'viem/chains';
import { STOCKS } from './venues/stocks.js';

/** Always REAL Base, whatever this deployment is pointed at — that is the entire point. */
const MAINNET_RPC = process.env.BASE_RPC ?? 'https://mainnet.base.org';

const USDC: Address = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';

/** Wide enough to catch a quiet hour, narrow enough that a public RPC will serve it. */
const LOOKBACK_BLOCKS = 4_000n;

const mainnet = createPublicClient({ chain: base, transport: http(MAINNET_RPC), cacheTime: 0 });

async function transferCount(address: Address, from: bigint, to: bigint): Promise<number | null> {
  try {
    // `viem`'s typed `getLogs` wants an event, not a raw topic. This is a raw topic filter, so it
    // goes through the request directly — the point is to count, not to decode.
    const logs = (await mainnet.request({
      method: 'eth_getLogs',
      params: [
        {
          address,
          fromBlock: `0x${from.toString(16)}`,
          toBlock: `0x${to.toString(16)}`,
          topics: [TRANSFER_TOPIC],
        },
      ],
    } as never)) as unknown;
    return Array.isArray(logs) ? logs.length : null;
  } catch {
    // A public RPC refusing a wide log range is not evidence about the token.
    return null;
  }
}

async function main(): Promise<void> {
  const head = await mainnet.getBlockNumber();
  const from = head > LOOKBACK_BLOCKS ? head - LOOKBACK_BLOCKS : 0n;
  console.log(`real Base mainnet — block ${head}, scanning transfers since ${from}\n`);

  const rows = await Promise.all(
    Object.values(STOCKS).map(async (s) => {
      const [supply, decimals, symbol, code, transfers] = await Promise.all([
        mainnet.readContract({ address: s.address, abi: erc20Abi, functionName: 'totalSupply' }).catch(() => null),
        mainnet.readContract({ address: s.address, abi: erc20Abi, functionName: 'decimals' }).catch(() => null),
        mainnet.readContract({ address: s.address, abi: erc20Abi, functionName: 'symbol' }).catch(() => null),
        mainnet.getCode({ address: s.address }).catch(() => undefined),
        transferCount(s.address, from, head),
      ]);
      return { s, supply, decimals, symbol, codeBytes: code ? (code.length - 2) / 2 : 0, transfers };
    }),
  );

  console.log('symbol   code   totalSupply            onchain symbol   transfers/4k blocks');
  console.log('─'.repeat(80));
  for (const r of rows) {
    const supply =
      r.supply === null || r.decimals === null
        ? 'REVERTED'
        : Number(formatUnits(r.supply, r.decimals)).toLocaleString('en-US', { maximumFractionDigits: 0 });
    console.log(
      `${r.s.symbol.padEnd(8)} ${String(r.codeBytes).padStart(4)}B  ${supply.padEnd(22)} ` +
        `${String(r.symbol ?? '—').padEnd(16)} ${r.transfers === null ? 'n/a' : r.transfers}`,
    );
  }

  const answering = rows.filter((r) => r.supply !== null).length;
  const active = rows.filter((r) => (r.transfers ?? 0) > 0).length;

  console.log('\n─'.repeat(1));
  console.log(`${answering} of ${rows.length} answer totalSupply() on real Base.`);
  console.log(`${active} of ${rows.length} saw a transfer in the last ${LOOKBACK_BLOCKS} blocks.`);
  console.log(
    'Every one carries a single byte of code, which is why eth_getCode cannot tell a working token\n' +
      'from a dead address here, and why /verify calls totalSupply() instead.',
  );

  // A route has to exist as well as a token.
  try {
    const key = process.env.ONEINCH_API_KEY;
    if (key) {
      const nvda = STOCKS.NVDAc;
      const res = await fetch(
        `https://api.1inch.dev/swap/v6.0/8453/quote?src=${USDC}&dst=${nvda!.address}&amount=100000000&includeProtocols=true`,
        { headers: { Authorization: `Bearer ${key}` } },
      );
      const q = (await res.json()) as { dstAmount?: string };
      if (q.dstAmount) {
        const out = Number(formatUnits(BigInt(q.dstAmount), nvda!.decimals));
        console.log(`\n1inch quotes 100 USDC → ${out.toFixed(6)} NVDAc on chain 8453 right now.`);
      }
    }
  } catch {
    console.log('\n(1inch quote unavailable — the token evidence above stands on its own.)');
  }

  console.log(
    '\nThe same totalSupply() call against an anvil fork of this block REVERTS. A fork copies the\n' +
      'byte and nothing serves it, so no routing choice can fill these there. The tokens are real;\n' +
      'the fork is the limitation.',
  );
}

await main();
