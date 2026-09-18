/**
 * Settlement on a fork that has aged past its fork block, proven against the chain itself (PLAN.md X77).
 *
 * 1inch prices a route against live Base; a fork's pools stay as they were at its fork block. For a buy through `spend()`
 * and a sale through `closePosition()`, this shows:
 *
 *   1. What 1inch quotes on Base, and what the same route delivers on this fork — a dry run of the call that carries it.
 *   2. Whether the chain accepts the route held to the floor settlement used to take from the quote (the quote less the
 *      leg's tolerance) — once the fork has drifted further than the tolerance, it refuses — and held to what the route
 *      delivers here less the same tolerance, the floor settlement sets now when the aggregator takes the leg.
 *   3. What `chooseSettlement` picks now — the venue and the floor — and that the chain accepts the leg held to that.
 *
 *   XORR_CHAIN=base-fork FORK_RPC=https://base-fork-production.up.railway.app \
 *   npx tsx --env-file=.env --env-file=server/.env.fork server/src/fork/prove-measured-route.ts [owner]
 *
 * The owner needs a live grant on that fork. Every call is a dry run (`eth_call`): nothing is signed or sent.
 */
import { BaseError, ContractFunctionRevertedError, erc20Abi, formatUnits, type Address, type Hex } from 'viem';
import { CHAIN_KEY } from '../evm/chains.js';
import { delegateAccount, publicClient } from '../evm/client.js';
import { DELEGATION_ABI, DELEGATION_ADDRESS, usdToUnits } from '../evm/delegation.js';
import { deliveredOnChain, PRICES_DRIFT } from '../evm/measure-route.js';
import { chooseSettlement, type SettlementSend } from '../executor/settle.js';
import type { TradeIntent } from '../executor/kinds/index.js';
import { buildSwap, quote, slippageFor, SLIPPAGE, TOKENS } from '../venues/oneinch.js';

const OWNER = (process.argv[2] ?? '0x95A0b368588713011a15f4b1041423f31B08e615') as Address;
/** The buy the Railway fork's router refused (PLAN.md X77), and a sale of about the same size. */
const BUY_USD = 15;
const SALE_WETH = 0.004;

if (!PRICES_DRIFT) throw new Error(`XORR_CHAIN=${CHAIN_KEY} is not a fork of Base: there is no drift to prove`);

/** The chain's own answer to the leg held to `minOut`: accepted, or the error it refused with. */
async function chainAnswer(via: SettlementSend['via'], args: readonly [Address, Address, Address, bigint, Address, bigint, Hex]) {
  const call = { account: delegateAccount, address: DELEGATION_ADDRESS, abi: DELEGATION_ABI, args } as const;
  try {
    if (via === 'closePosition') await publicClient.simulateContract({ ...call, functionName: 'closePosition' });
    else await publicClient.simulateContract({ ...call, functionName: 'spend' });
    return 'accepted';
  } catch (e) {
    const reverted = e instanceof BaseError ? e.walk((x) => x instanceof ContractFunctionRevertedError) : undefined;
    if (reverted instanceof ContractFunctionRevertedError) {
      return `refused: ${reverted.data?.errorName ?? reverted.signature ?? reverted.reason ?? reverted.shortMessage}`;
    }
    return `refused: ${e instanceof BaseError ? e.shortMessage : String(e)}`;
  }
}

async function prove(label: string, intent: TradeIntent, send: SettlementSend) {
  const inToken = TOKENS[intent.inSymbol]!;
  const outToken = TOKENS[intent.outSymbol]!;
  const out = (raw: bigint) => `${formatUnits(raw, outToken.decimals)} ${intent.outSymbol}`;
  const isClose = send.via === 'closePosition';

  // 1. What 1inch quotes on Base, and what its route delivers here.
  const quoted = await quote({ inSymbol: intent.inSymbol, outSymbol: intent.outSymbol, amount: intent.amountIn });
  const quotedOut = BigInt(Math.round(quoted.outAmount * 10 ** outToken.decimals));
  const tolerancePct = slippageFor(isClose ? SLIPPAGE.stop : SLIPPAGE.scheduled, quoted.priceImpactPct ?? null);
  const swap = await buildSwap({
    inSymbol: intent.inSymbol,
    outSymbol: intent.outSymbol,
    amount: intent.amountIn,
    amountRaw: intent.amountInRaw,
    from: DELEGATION_ADDRESS,
    receiver: OWNER,
    slippagePct: tolerancePct,
  });
  const delivered = await deliveredOnChain({
    owner: OWNER,
    via: send.via,
    token: inToken.address,
    venue: swap.to,
    amount: send.amount,
    tokenOut: outToken.address,
    data: swap.data,
  });
  const driftBps = Number(((delivered - quotedOut) * 10_000n * 100n) / quotedOut) / 100;
  const less = (raw: bigint) => (raw * BigInt(Math.floor((1 - tolerancePct / 100) * 1_000_000))) / 1_000_000n;
  const args = (minOut: bigint, to: Address, data: Hex) =>
    [OWNER, inToken.address, to, send.amount, outToken.address, minOut, data] as const;

  // 2. The route held to the floor taken from the quote, as settlement set it before X77, and to what it delivers here.
  const quoteFloor = less(quotedOut);
  const underQuoteFloor = await chainAnswer(send.via, args(quoteFloor, swap.to, swap.data));
  const measuredFloor = less(delivered);
  const underMeasuredFloor = await chainAnswer(send.via, args(measuredFloor, swap.to, swap.data));

  // 3. What settlement picks now, and the chain's answer to it.
  const s = await chooseSettlement({
    intent,
    owner: OWNER,
    preferred: undefined,
    isClose,
    delegationFrom: DELEGATION_ADDRESS,
    send,
  });
  const underSettlement = await chainAnswer(send.via, args(s.floor.minOut, s.swap.to, s.swap.data));

  console.log(
    JSON.stringify(
      {
        leg: label,
        via: send.via,
        quotedOnBase: out(quotedOut),
        deliveredOnFork: out(delivered),
        driftBps,
        tolerancePct,
        quoteFloor: { minOut: out(quoteFloor), chain: underQuoteFloor },
        measuredFloor: { minOut: out(measuredFloor), chain: underMeasuredFloor },
        settlement: { venue: s.venue, minOut: out(s.floor.minOut), chain: underSettlement },
      },
      null,
      2,
    ),
  );
  return underSettlement === 'accepted' && underMeasuredFloor === 'accepted';
}

const block = await publicClient.getBlockNumber();
console.log(`${CHAIN_KEY} at block ${block}; owner ${OWNER}; delegation ${DELEGATION_ADDRESS}; delegate ${delegateAccount.address}`);

const buy: TradeIntent = { inSymbol: 'USDC', outSymbol: 'WETH', amountIn: BUY_USD, usd: BUY_USD, because: 'PLAN.md X77 proof' };
let ok = await prove('buy', buy, { via: 'spend', amount: usdToUnits(BUY_USD) });

const held = await publicClient.readContract({ address: TOKENS.WETH!.address, abi: erc20Abi, functionName: 'balanceOf', args: [OWNER] });
const saleRaw = BigInt(Math.round(SALE_WETH * 1e18));
if (held < saleRaw) {
  console.log(`sale: skipped — the owner holds ${formatUnits(held, 18)} WETH, under the ${SALE_WETH} this sells`);
} else {
  const sale: TradeIntent = {
    inSymbol: 'WETH',
    outSymbol: 'USDC',
    amountIn: SALE_WETH,
    amountInRaw: saleRaw,
    usd: 0,
    because: 'PLAN.md X77 proof',
  };
  ok = (await prove('sale', sale, { via: 'closePosition', amount: saleRaw })) && ok;
}

if (!ok) {
  console.error('The chain refused a leg held to a floor settlement would set.');
  process.exit(1);
}
