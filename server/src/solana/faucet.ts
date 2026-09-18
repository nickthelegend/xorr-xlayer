/**
 * Faucet and test funding for Solana devnet, localnet, and fork (PLAN.md §8.1).
 *
 * Refuses immediately on mainnet-beta (where money is 'real').
 */
import { Connection, Keypair, PublicKey, LAMPORTS_PER_SOL } from '@solana/web3.js';
import {
  getOrCreateAssociatedTokenAccount,
  mintTo,
} from '@solana/spl-token';
import { connection as defaultConnection, waitForTx } from './connection.js';
import { DEFAULT_MINTS } from './clusters.js';
import { CURRENT_FACTS } from './money.js';
import { payerKeypair } from './keys.js';
import { tokenProgramForMint } from './balances.js';

export async function airdropSol(
  recipient: PublicKey | string,
  solAmount = 10,
  conn: Connection = defaultConnection,
): Promise<{ signature: string; slot: number }> {
  if (!CURRENT_FACTS.canDripSol) {
    throw new Error(`SOL airdrop refused: money is '${CURRENT_FACTS.money}' on this cluster.`);
  }

  const pk = typeof recipient === 'string' ? new PublicKey(recipient) : recipient;
  const lamports = BigInt(Math.floor(solAmount * LAMPORTS_PER_SOL));
  const sig = await conn.requestAirdrop(pk, Number(lamports));
  const { slot } = await waitForTx(sig, conn);
  return { signature: sig, slot };
}

export async function mintTokens(params: {
  recipient: PublicKey | string;
  mint: PublicKey | string;
  amountUnits: bigint;
  mintAuthority?: Keypair;
  conn?: Connection;
  feePayer?: Keypair;
}): Promise<{ signature: string; slot: number; ata: string }> {
  if (!CURRENT_FACTS.canMintTokens) {
    throw new Error(`Token minting refused: money is '${CURRENT_FACTS.money}' on this cluster.`);
  }

  const {
    recipient,
    mint,
    amountUnits,
    mintAuthority = payerKeypair(),
    conn = defaultConnection,
    feePayer = payerKeypair(),
  } = params;

  const recipientPk = typeof recipient === 'string' ? new PublicKey(recipient) : recipient;
  const mintPk = typeof mint === 'string' ? new PublicKey(mint) : mint;
  const prog = tokenProgramForMint(mintPk);

  const ata = await getOrCreateAssociatedTokenAccount(
    conn,
    feePayer,
    mintPk,
    recipientPk,
    false,
    'confirmed',
    undefined,
    prog,
  );

  const sig = await mintTo(
    conn,
    feePayer,
    mintPk,
    ata.address,
    mintAuthority,
    amountUnits,
    [],
    undefined,
    prog,
  );

  const { slot } = await waitForTx(sig, conn);
  return { signature: sig, slot, ata: ata.address.toBase58() };
}

/**
 * Convenience helper to fund a dev owner with standard demo balances:
 * 10 SOL, 25,000 USDC, 10 NVDAx.
 */
export async function fundDevOwner(params: {
  owner: PublicKey | string;
  usdcAmount?: number;
  nvdaxAmount?: number;
  solAmount?: number;
  conn?: Connection;
  mintAuthority?: Keypair;
}): Promise<{
  solSig?: string;
  usdcSig?: string;
  nvdaxSig?: string;
}> {
  const {
    owner,
    usdcAmount = 25_000,
    nvdaxAmount = 10,
    solAmount = 10,
    conn = defaultConnection,
    mintAuthority = payerKeypair(),
  } = params;

  const res: { solSig?: string; usdcSig?: string; nvdaxSig?: string } = {};

  if (solAmount > 0) {
    const { signature } = await airdropSol(owner, solAmount, conn);
    res.solSig = signature;
  }

  if (usdcAmount > 0) {
    const units = BigInt(Math.floor(usdcAmount * 1e6));
    const { signature } = await mintTokens({
      recipient: owner,
      mint: DEFAULT_MINTS.USDC,
      amountUnits: units,
      mintAuthority,
      conn,
    });
    res.usdcSig = signature;
  }

  if (nvdaxAmount > 0) {
    const nvdaxMint = 'Xsc9qvGR1efVDFGLrVsmkzv3qi45LTBjeUKSPmx9qEh';
    const units = BigInt(Math.floor(nvdaxAmount * 1e8));
    const { signature } = await mintTokens({
      recipient: owner,
      mint: nvdaxMint,
      amountUnits: units,
      mintAuthority,
      conn,
    });
    res.nvdaxSig = signature;
  }

  return res;
}
