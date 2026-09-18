/**
 * Setup and seed helper for Solana clusters (PLAN.md §8.1).
 */
import { Keypair } from '@solana/web3.js';
import { connection } from './connection.js';
import { airdropSol, fundDevOwner } from './faucet.js';
import { delegateKeypair, payerKeypair, devOwnerKeypair, venueVaultKeypair } from './keys.js';
import { CLUSTER_KEY } from './clusters.js';

export async function setupClusterAccounts(): Promise<{
  payer: string;
  delegate: string;
  devOwner: string;
  venueVault: string;
}> {
  console.log(`Setting up accounts on cluster: ${CLUSTER_KEY}...`);

  const payer = payerKeypair();
  const delegate = delegateKeypair();
  const devOwner = devOwnerKeypair();
  const venueVault = venueVaultKeypair();

  if (CLUSTER_KEY !== 'solana-mainnet') {
    // Fund fee payer and delegate with SOL
    console.log(`Funding payer ${payer.publicKey.toBase58()} with SOL...`);
    await airdropSol(payer.publicKey, 10, connection).catch((e) => console.log(`Airdrop payer notice: ${e.message}`));

    console.log(`Funding delegate ${delegate.publicKey.toBase58()} with SOL...`);
    await airdropSol(delegate.publicKey, 10, connection).catch((e) => console.log(`Airdrop delegate notice: ${e.message}`));

    console.log(`Funding venue vault ${venueVault.publicKey.toBase58()} with SOL...`);
    await airdropSol(venueVault.publicKey, 10, connection).catch((e) => console.log(`Airdrop vault notice: ${e.message}`));

    // Fund dev owner
    console.log(`Funding dev owner ${devOwner.publicKey.toBase58()} with SOL and tokens...`);
    await fundDevOwner({
      owner: devOwner.publicKey,
      usdcAmount: 25_000,
      nvdaxAmount: 10,
      solAmount: 10,
      conn: connection,
      mintAuthority: payer,
    }).catch((e) => console.log(`Fund dev owner notice: ${e.message}`));
  }

  return {
    payer: payer.publicKey.toBase58(),
    delegate: delegate.publicKey.toBase58(),
    devOwner: devOwner.publicKey.toBase58(),
    venueVault: venueVault.publicKey.toBase58(),
  };
}

if (process.argv[1]?.endsWith('setup.ts')) {
  setupClusterAccounts()
    .then((res) => {
      console.log('Setup completed:', res);
      process.exit(0);
    })
    .catch((err) => {
      console.error('Setup failed:', err);
      process.exit(1);
    });
}
