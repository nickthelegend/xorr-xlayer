/**
 * Ship makers onto a fork that is already running (PLAN.md 3.1, 3.2, 3.15).
 *
 * A rebuild ships an Aqua book and a SwapVM program itself (`npm run rebuild:fork`). This is for a fork that is
 * up and has lost them, or never had them.
 *
 *   FORK_RPC=… XORR_CHAIN=base-fork AQUA_BOOK_ADDRESS=… SWAPVM_BOOK_ADDRESS=… npm run ship:makers [-- --aqua | --swapvm]
 *   FORK_RPC=… XORR_CHAIN=base-fork EXECUTOR_URL=… OPERATOR_TOKEN=… npm run ship:makers -- --limit
 *
 * With no flag it ships both books. Limit orders go out only with `--limit`: they are published to a running executor
 * with its operator token, which a rebuild does not have.
 */
import 'dotenv/config';
import { formatUnits, parseUnits, type Address } from 'viem';
import { limitOrderBody, newLimitOrderMaker, shipAquaBook, shipSwapVmProgram, signLimitOrder } from './makers.js';

const rpc = process.env.FORK_RPC;
if (!rpc) throw new Error('FORK_RPC is required: the fork to ship to');
const flags = new Set(process.argv.slice(2));
const both = !flags.has('--aqua') && !flags.has('--swapvm') && !flags.has('--limit');

if (both || flags.has('--aqua')) {
  const book = process.env.AQUA_BOOK_ADDRESS as Address | undefined;
  if (!book) throw new Error('AQUA_BOOK_ADDRESS is required to ship an Aqua book');
  const { priceOf } = await import('../market/prices.js');
  const shipped = await shipAquaBook({ rpc, book, priceUsd: await priceOf('WETH') });
  console.log(
    `Aqua book       ${formatUnits(shipped.weth, 18)} WETH / ${formatUnits(shipped.usdc, 6)} USDC · maker ${shipped.maker} · tx ${shipped.tx}`,
  );
}

if (both || flags.has('--swapvm')) {
  const book = process.env.SWAPVM_BOOK_ADDRESS as Address | undefined;
  if (!book) throw new Error('SWAPVM_BOOK_ADDRESS is required to ship a SwapVM program');
  const { quote } = await import('../venues/oneinch.js');
  const reference = await quote({ inSymbol: 'USDC', outSymbol: 'WETH', amount: 50 });
  const shipped = await shipSwapVmProgram({ rpc, book, wethPerUsdc: reference.outAmount / 50 });
  console.log(
    `SwapVM program  ${shipped.bytes} bytes · ${formatUnits(shipped.usdc, 6)} USDC / ${formatUnits(shipped.weth, 18)} WETH · until ${new Date(shipped.deadline * 1000).toISOString()} · maker ${shipped.maker} · tx ${shipped.tx}`,
  );
}

if (flags.has('--limit')) {
  /*
   * Limit orders (PLAN.md 3.15): a fresh maker signs two WETH → USDC orders a little over the market and publishes them
   * to the executor, which checks each against the router before listing it. Both settings are read by name and never
   * printed; the operator token is a credential.
   */
  const executor = process.env.EXECUTOR_URL;
  const token = process.env.OPERATOR_TOKEN;
  if (!executor) throw new Error('EXECUTOR_URL is required to publish limit orders: the executor that lists them');
  if (!token) throw new Error('OPERATOR_TOKEN is required to publish limit orders: POST /limit-orders is operator-only');
  const { priceOf } = await import('../market/prices.js');
  const price = await priceOf('WETH');

  // The maker's asks: a quarter and three quarters of a percent over the market, so each sits near the price.
  const offers = [
    { weth: parseUnits('0.02', 18), premium: 0.0025 },
    { weth: parseUnits('0.05', 18), premium: 0.0075 },
  ];
  const maker = await newLimitOrderMaker({ rpc, weth: offers.reduce((sum, o) => sum + o.weth, 0n) });
  const chainId = await maker.pub.getChainId();
  // The fork's clock, which the router checks expiry against, not this machine's.
  const now = (await maker.pub.getBlock()).timestamp;

  for (const [i, offer] of offers.entries()) {
    const takingAmount = BigInt(Math.round(Number(formatUnits(offer.weth, 18)) * price * (1 + offer.premium) * 1e6));
    const signed = await signLimitOrder({
      account: maker.account,
      chainId,
      makingAmount: offer.weth,
      takingAmount,
      expiration: now + 7n * 86_400n,
      nonce: BigInt(i),
    });
    const res = await fetch(`${executor.replace(/\/$/, '')}/limit-orders`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify(limitOrderBody(signed.order, signed.signature)),
    });
    const answer = await res.text();
    if (!res.ok) throw new Error(`POST /limit-orders answered ${res.status}: ${answer}`);
    console.log(
      `Limit order     ${formatUnits(offer.weth, 18)} WETH for ${formatUnits(takingAmount, 6)} USDC · maker ${maker.maker} · ${signed.hash}`,
    );
  }
}
