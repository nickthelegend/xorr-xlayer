/**
 * Stand up and bootstrap a Solana mainnet fork with real USDC and xStocks (PLAN.md §11).
 *
 * Runs the bootstrap sequence from server/src/solana/fork-bootstrap.ts:
 * Starts or connects to solana-test-validator, airdrops SOL, funds the dev owner
 * with 25,000 USDC + xStocks (NVDAx), funds the venue vault with liquidity,
 * and writes `.env.fork`.
 *
 * Run: npx tsx infra/solana-fork/fork-bootstrap.ts [devOwnerPubkey]
 */
import { bootstrapFork } from '../../server/src/solana/fork-bootstrap.js';

export * from '../../server/src/solana/fork-bootstrap.js';

if (process.argv[1]?.includes('fork-bootstrap')) {
  const target = process.argv[2] ?? process.env.OWNER_ADDRESS;
  bootstrapFork(target)
    .then(() => process.exit(0))
    .catch((err) => {
      console.error('Bootstrap error:', err);
      process.exit(1);
    });
}
