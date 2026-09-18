/**
 * The autonomous agent, end to end, against a running Solana fork.
 *
 * It scans the xStocks universe, prints the grounding each symbol actually has — a live Jupiter
 * price, a second opinion from the Base listing, the mint's own Scaled UI multiplier, the Nasdaq
 * clock — picks a setup, and then places it through the same `guardAndSpend` chokepoint the
 * scheduler uses. Every signature it prints is a signature the validator returned.
 *
 * ## Why it refuses to run without the fork
 *
 * The version of this script that shipped in the original branch printed a made-up base58 prefix
 * with eight random characters glued to it, under the heading "Jupiter swap executed on Solana
 * mainnet-fork", next to a slot number nobody had looked up. It demonstrated nothing, and it read
 * exactly like a demo of something that worked. There is no honest way to show an execution without
 * executing, so with no validator to execute against this exits and says how to start one.
 *
 *   Terminal 1:  cd server && npm run setup:solana-fork
 *   Terminal 2:  cd server && npx tsx scripts/demo-autonomous-agent.ts <wallet-id>
 *
 * The wallet id is a row in `wallets` whose address holds the fork's USDC. `--dry-run` stops after
 * the analysis, which needs the fork for prices but places nothing.
 */
import { isValidatorRunning } from '../src/solana/fork-bootstrap.js';

const money = (n: number | null | undefined) =>
  typeof n === 'number' && Number.isFinite(n) ? `$${n.toFixed(2)}` : 'no price';

/*
 * The agent's own modules load behind the preflight, not above it.
 *
 * `executor/order.ts` throws on import without `ONEINCH_API_KEY` — the routing layer has no
 * offline fallback by design — and a static import here meant that stack trace was the entire
 * output, with no hint of which of the two prerequisites was missing. Dynamic import lets the
 * checks below run first and say so in a sentence.
 */
async function load() {
  const [autonomous, xstocks, nasdaq, balances, connection] = await Promise.all([
    import('../src/bot/autonomous.js'),
    import('../src/venues/xstocks.js'),
    import('../src/market/nasdaq.js'),
    import('../src/solana/balances.js'),
    import('../src/solana/connection.js'),
  ]);
  return { ...autonomous, ...xstocks, ...nasdaq, ...balances, ...connection };
}

async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const walletId = args.find((a) => !a.startsWith('--'));

  if (!process.env.ONEINCH_API_KEY) {
    console.error('ONEINCH_API_KEY is not set.\n');
    console.error('The agent prices the Base listing of each equity through 1inch, which is the');
    console.error('second opinion its off-hours guard measures the Solana pool against. Without');
    console.error('it there is no reference price, and outside Nasdaq hours the guard correctly');
    console.error('refuses every entry — so the demo would show you a refusal, not the agent.\n');
    console.error('Set a real key and run this again.');
    process.exit(1);
  }

  if (!(await isValidatorRunning())) {
    console.error('No Solana fork is answering on the configured RPC.\n');
    console.error('This demo places a real swap and reads real mints, so there is nothing it can');
    console.error('show you without one. Start the fork first:\n');
    console.error('  cd server && npm run setup:solana-fork\n');
    console.error('then run this again.');
    process.exit(1);
  }

  const {
    evaluateBestSetup,
    runAutonomousCycle,
    XSTOCKS,
    xStockPriceUsd,
    getNasdaqSession,
    evaluateOffHoursGuard,
    referencePriceUsd,
    readMintScale,
    explorerTx,
  } = await load();

  console.log('XORR AUTONOMOUS AGENT — BACKED FINANCE xSTOCKS ON SOLANA\n');

  const session = getNasdaqSession();
  console.log(
    `Nasdaq session: ${session.session} (${session.phase}, ${session.easternTime}) — exchange open: ${session.isExchangeOpen}\n`,
  );

  console.log('1. THE UNIVERSE, AND WHAT IS ACTUALLY KNOWN ABOUT EACH SYMBOL\n');
  for (const [symbol, token] of Object.entries(XSTOCKS)) {
    const price = await xStockPriceUsd(symbol).catch(() => null);
    const reference = await referencePriceUsd(symbol);
    const scale = await readMintScale(token.address).catch(() => null);
    const guard = evaluateOffHoursGuard({
      symbol,
      onChainPrice: price ?? 0,
      referencePrice: reference,
    });

    console.log(`  ${symbol.padEnd(6)} ${token.address.slice(0, 8)}...`);
    console.log(`    Jupiter mark:  ${money(price)}`);
    console.log(`    Base listing:  ${money(reference)}`);
    console.log(
      `    Scaled UI:     ${scale ? `x${scale.multiplier}` : 'unread'}${
        scale?.pending
          ? ` -> x${scale.pending.nextMultiplier} at ${new Date(scale.pending.effectiveAtMs).toISOString()}`
          : ''
      }`,
    );
    console.log(
      `    Guard:         ${guard.action}, ${guard.suggestedSlippageBps} bps, drift ${
        guard.spreadBps === null ? 'not measurable' : `${guard.spreadBps} bps`
      }`,
    );
  }

  console.log('\n2. THE SETUP THE CONDITIONS SUPPORT\n');
  const best = await evaluateBestSetup();
  if (!best) {
    console.log('  None. Nothing in the universe reads as a setup right now, so nothing is placed.');
    console.log('  That is the expected answer on a cold fork: the range strategies need recorded');
    console.log('  readings, and the event-driven one needs a projection EDGAR will stand behind.');
    return;
  }

  console.log(`  Symbol:       ${best.symbol}`);
  console.log(`  Strategy:     ${best.strategyKind} (${best.personaName})`);
  console.log(`  Score:        ${best.score}`);
  console.log(`  Condition:    ${best.marketCondition}`);
  console.log(`  Rationale:    ${best.reason}`);
  console.log(`  Entry:        ${money(best.currentPrice)}`);
  console.log(`  Stop:         ${money(best.stopPrice)}`);
  console.log(`  Target:       ${money(best.targetPrice)}`);
  console.log(`  Slippage:     ${best.suggestedSlippageBps} bps`);

  if (dryRun) {
    console.log('\n--dry-run, so nothing is placed.');
    return;
  }

  if (!walletId) {
    console.log('\nNo wallet id given, so nothing is placed.');
    console.log('Pass the id of a `wallets` row funded on the fork to run the full cycle:');
    console.log('  npx tsx scripts/demo-autonomous-agent.ts <wallet-id>');
    return;
  }

  console.log('\n3. EXECUTION THROUGH THE SPEND CHOKEPOINT\n');
  const result = await runAutonomousCycle(walletId);

  if (!result.executed) {
    console.log(`  Refused: ${result.reason}`);
    console.log(`  ${result.detail}`);
    return;
  }

  console.log(`  Filled ${result.receipt.filledUnits} ${result.receipt.symbol} for $${result.receipt.usd}`);
  console.log(`  Fill price:   ${money(result.receipt.fillPrice)}`);
  console.log(`  Signature:    ${result.receipt.signature}`);
  console.log(`  Slot:         ${result.receipt.slot}`);
  console.log(`  Explorer:     ${explorerTx(result.receipt.signature)}`);
  console.log(
    `  Exits:        ${result.exitStrategyId ? `armed (${result.exitStrategyId})` : 'not armed'}`,
  );
  console.log(`  Proposal:     ${result.proposalId}`);
  console.log('\n  The entry notification has been dispatched to the wallet\'s registered devices.');
}

main().catch((err) => {
  console.error('Demo failed:', err);
  process.exit(1);
});
