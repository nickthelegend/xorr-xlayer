/**
 * End-to-end demo proof: ONE real on-chain USDC -> xStock buy on a Solana mainnet fork
 * (PLAN.md §6.3, §8.2, §11, §14).
 *
 * Two different things wear Jupiter's name here, and the distinction is the whole point:
 *
 *   PRICE is always a live quote from Jupiter's off-chain quote API. No on-chain program is
 *         involved in a quote. It is a number over HTTP.
 *   FILL  is one of two on-chain paths, and `venue` on the receipt says which:
 *           `jupiter-route`  the Jupiter v6 program is invoked on-chain, CPIs into the AMM,
 *                            and the pool's own reserves move.
 *           `venue-vault`    a capped SPL delegate transfer, with the asset delivered from the
 *                            venue/maker account at the quoted price (PLAN.md §6.2 option A).
 *                            Legitimate, and NOT a Jupiter swap — no route executes.
 *
 * A reader should never have to infer which one happened, so this tool asserts it and prints it.
 *
 * Proves, against a real solana-test-validator with mainnet state cloned into it:
 *   1. The real mainnet USDC mint and the NVDAx xStock mint (Token-2022) are on the fork — not
 *      stand-ins. The Jupiter v6 program is cloned too, but cloning is not execution: whether it
 *      ran is decided in step 4, from the ledger.
 *   2. The owner grants the bot delegate a capped SPL approval. The SPL Token program is the
 *      authority; no custody moves.
 *   3. A buy through the executor's single spend chokepoint (`guardAndSpend`), where the
 *      DELEGATE signs the transfer out of the owner's account.
 *   4. The fill path, read from the transaction's own logs rather than from a label: a
 *      `jupiter-route` run must show the Jupiter program invoked, `Instruction: Route`, and an
 *      AMM swap. Anyone can check the same claim in ten seconds with
 *      `getSignaturesForAddress(JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4)`.
 *   5. The filled size the executor reports equals the on-chain balance change, scaled-UI
 *      multiplier included — the split/dividend-safe P&L property.
 *
 * Every signature printed is returned by confirmTransaction against the fork and is
 * independently checkable with:
 *   solana confirm -v <signature> --url $FORK_RPC
 *
 * Bring the fork up first (FORK_RPC defaults to http://127.0.0.1:8899; set it to use another port):
 *   npx tsx infra/solana-fork/fork-bootstrap.ts
 * Then:
 *   npx tsx tools/prove-solana-xstock-buy.ts
 *
 * README.md "Verify it yourself" walks through this end to end.
 */
process.env.XORR_CHAIN ??= 'solana-fork';
process.env.FORK_RPC ??= 'http://127.0.0.1:8899';

import { PublicKey } from '@solana/web3.js';
import { createConnection } from '../server/src/solana/connection.js';
import {
  devOwnerKeypair,
  delegateKeypair,
  venueVaultKeypair,
} from '../server/src/solana/keys.js';
import { approveDelegate, readDelegation } from '../server/src/solana/delegation.js';
import { getTokenBalance, readMintScale, ataFor } from '../server/src/solana/balances.js';
import { DEFAULT_MINTS } from '../server/src/solana/clusters.js';
import { guardAndSpend } from '../server/src/executor/place.js';
import { XSTOCKS } from '../server/src/venues/xstocks.js';

const RPC = process.env.FORK_RPC!;
const USDC = new PublicKey(DEFAULT_MINTS.USDC);
const NVDAX = new PublicKey(XSTOCKS.NVDAx!.address);
const SPEND_USD = Number(process.env.PROVE_USD ?? 100);

function line(label: string, value: unknown) {
  console.log(`  ${label.padEnd(26)} ${String(value)}`);
}

async function main() {
  const conn = createConnection(RPC, 'confirmed');
  const owner = devOwnerKeypair();
  const delegate = delegateKeypair();
  const vault = venueVaultKeypair();

  console.log('\n=== 0. The fork ===');
  line('rpc', RPC);
  line('slot', await conn.getSlot());
  line('owner', owner.publicKey.toBase58());
  line('delegate', delegate.publicKey.toBase58());
  line('venue vault', vault.publicKey.toBase58());

  console.log('\n=== 1. Real mainnet state cloned onto the fork ===');
  for (const [name, mint] of [
    ['USDC mint', USDC],
    ['NVDAx mint', NVDAX],
    ['Jupiter v6 (cloned)', new PublicKey(DEFAULT_MINTS.JUPITER_V6)],
  ] as const) {
    const info = await conn.getAccountInfo(mint);
    if (!info) throw new Error(`${name} (${mint.toBase58()}) is not present on the fork.`);
    line(name, `${mint.toBase58()} owner=${info.owner.toBase58()}${info.executable ? ' (executable)' : ''}`);
  }

  const scale = await readMintScale(NVDAX, conn);
  line('NVDAx decimals', scale.decimals);
  line('NVDAx multiplier', scale.multiplier);

  console.log('\n=== 2. Capped SPL approval (owner signs) ===');
  const appr = await approveDelegate(owner, delegate.publicKey, SPEND_USD * 5, conn);
  line('APPROVE SIGNATURE', appr.signature);
  line('APPROVE SLOT', appr.slot);
  const granted = await readDelegation(owner.publicKey, USDC, conn);
  line('on-chain delegate', granted.delegate);
  line('delegated cap', `${granted.remainingUsd} USDC`);
  if (granted.delegate !== delegate.publicKey.toBase58()) {
    throw new Error('The on-chain delegate is not the active delegate key.');
  }

  const before = {
    usdc: await getTokenBalance(owner.publicKey, USDC, conn),
    nvdax: await getTokenBalance(owner.publicKey, NVDAX, conn),
  };
  console.log('\n=== 3. Before ===');
  line('USDC', before.usdc.uiAmount);
  line('NVDAx', before.nvdax.uiAmount);
  line('NVDAx ATA', ataFor(owner.publicKey, NVDAX).toBase58());

  console.log(`\n=== 4. guardAndSpend: BUY $${SPEND_USD} NVDAx (delegate signs) ===`);
  const outcome = await guardAndSpend({
    walletId: 'prove-xstock-buy',
    ownerPubkey: owner.publicKey.toBase58(),
    symbol: 'NVDAx',
    usd: SPEND_USD,
    side: 'buy',
    skipRulesEngine: true,
  });

  if (!outcome.placed) {
    throw new Error(`Refused: ${outcome.reason} — ${outcome.detail}`);
  }

  line('BUY SIGNATURE', outcome.signature);
  line('BUY SLOT', outcome.slot);
  line('PRICE SOURCE', 'live Jupiter v6 quote API (off-chain HTTP; no program invoked)');
  line(
    'FILL PATH',
    outcome.venue === 'jupiter-route'
      ? 'jupiter-route — Jupiter v6 invoked on-chain, CPI into the AMM'
      : 'venue-vault — capped SPL delegate transfer, asset from the venue/maker account (NOT a Jupiter swap)',
  );
  line('filled', `${outcome.filledUnits} NVDAx`);
  line('fill price', `$${outcome.fillPrice.toFixed(2)}`);
  line('out units (raw)', outcome.outUnits.toString());

  const tx = await conn.getTransaction(outcome.signature, {
    commitment: 'confirmed',
    maxSupportedTransactionVersion: 0,
  });
  if (!tx) throw new Error('The buy signature is not in the fork ledger.');
  if (tx.meta?.err) throw new Error(`The buy failed on-chain: ${JSON.stringify(tx.meta.err)}`);

  /*
   * The claim under test is "a Jupiter swap happened", so check the ledger for it rather than
   * trusting the label. The program's own log lines are the evidence.
   */
  if (outcome.venue !== 'jupiter-route') {
    throw new Error(
      `Filled through '${outcome.venue}': a capped SPL delegate transfer with the asset delivered ` +
        'from the venue/maker account, priced off a Jupiter quote. That is PLAN.md §6.2 option A ' +
        'and a defensible design, but it is NOT a Jupiter swap — no on-chain route executed. ' +
        'Describe it accordingly, or clone the route accounts so a real route can run.',
    );
  }
  const logs = tx.meta?.logMessages ?? [];
  const invokedJupiter = logs.some((l) => l.includes(DEFAULT_MINTS.JUPITER_V6) && l.includes('invoke'));
  const routed = logs.some((l) => l.includes('Instruction: Route'));
  const ammSwapped = logs.some((l) => l.includes('Swap'));
  if (!invokedJupiter || !routed || !ammSwapped) {
    throw new Error(
      `The transaction does not show a Jupiter route (invoked=${invokedJupiter} routed=${routed} amm=${ammSwapped}).`,
    );
  }
  line('jupiter invoked', invokedJupiter);
  line('route + AMM swap', `${routed} / ${ammSwapped}`);
  console.log('\n=== 5. Confirmed in the ledger ===');
  line('slot', tx.slot);
  line('err', String(tx.meta?.err ?? null));
  line('fee (lamports)', tx.meta?.fee);

  const after = {
    usdc: await getTokenBalance(owner.publicKey, USDC, conn),
    nvdax: await getTokenBalance(owner.publicKey, NVDAX, conn),
  };
  const gained = after.nvdax.uiAmount - before.nvdax.uiAmount;
  const spent = before.usdc.uiAmount - after.usdc.uiAmount;

  console.log('\n=== 6. After ===');
  line('USDC', `${after.usdc.uiAmount} (-${spent.toFixed(6)})`);
  line('NVDAx', `${after.nvdax.uiAmount} (+${gained.toFixed(8)})`);
  line('delegated cap left', `${(await readDelegation(owner.publicKey, USDC, conn)).remainingUsd} USDC`);

  /*
   * The property the hardcoded-decimals version could not hold: what the executor says it
   * filled is what the wallet actually gained, multiplier and all.
   */
  const drift = Math.abs(outcome.filledUnits - gained);
  console.log('\n=== 7. Reported fill vs on-chain delta ===');
  line('reported filled', outcome.filledUnits);
  line('on-chain delta', gained);
  line('drift', drift);
  if (drift > 1e-9) {
    throw new Error(`Reported fill drifted from the on-chain balance change by ${drift}.`);
  }
  if (Math.abs(spent - SPEND_USD) > 1e-6) {
    throw new Error(`Spent ${spent} USDC, expected ${SPEND_USD}.`);
  }

  console.log('\nAll proofs held. Verify independently with:');
  console.log(`  solana confirm -v ${outcome.signature} --url ${RPC}`);
}

main().catch((err) => {
  console.error('\nPROOF FAILED:', err instanceof Error ? err.message : err);
  process.exit(1);
});
