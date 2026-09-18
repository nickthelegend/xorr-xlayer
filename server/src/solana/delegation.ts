/**
 * SPL Token delegation (approve, revoke, spend, return, read) on Solana (PLAN.md §6, §8.1).
 *
 * Non-custody invariant: user USDC sits in the user's own token account (ATA).
 * The user approves the bot's delegate key up to a capped `delegated_amount`.
 * The SPL Token program itself is the authoritative on-chain guard.
 *
 * Kill switch = on-chain SPL revoke instruction signed by the user.
 */
import {
  Connection,
  Keypair,
  PublicKey,
  Transaction,
  sendAndConfirmTransaction,
} from '@solana/web3.js';
import {
  createApproveInstruction,
  createRevokeInstruction,
  createTransferCheckedInstruction,
  createAssociatedTokenAccountIdempotentInstruction,
  getAccount,
  TokenAccountNotFoundError,
  TokenInvalidAccountOwnerError,
} from '@solana/spl-token';
import { connection as defaultConnection, waitForTx } from './connection.js';
import { DEFAULT_MINTS } from './clusters.js';
import { delegateKeypair, payerKeypair } from './keys.js';
import { ataFor, tokenProgramForMint, readMintScale, toUiAmount } from './balances.js';

export type DelegationState = {
  owner: string;
  ownerAta: string;
  delegate: string | null;
  delegatedAmount: bigint;
  balanceAmount: bigint;
  remainingUsd: number;
  isRevoked: boolean;
  hasActiveDelegation: boolean;
  /** Aliases the wallet routes read: the same facts in the shape they already expect. */
  hasDelegate: boolean;
  delegatedUsd: number;
  balanceUsd: number;
};

export function usdToBaseUnits(usd: number, decimals = 6): bigint {
  if (usd < 0) throw new Error(`Negative USD amount not allowed: ${usd}`);
  return BigInt(Math.floor(usd * 10 ** decimals));
}

export function baseUnitsToUsd(units: bigint, decimals = 6): number {
  return Number(units) / 10 ** decimals;
}

/**
 * Read delegation state from owner's USDC token account.
 */
export async function readDelegation(
  owner: PublicKey | string,
  mint: PublicKey | string = DEFAULT_MINTS.USDC,
  conn: Connection = defaultConnection,
): Promise<DelegationState> {
  const ownerPk = typeof owner === 'string' ? new PublicKey(owner) : owner;
  const mintPk = typeof mint === 'string' ? new PublicKey(mint) : mint;
  const prog = tokenProgramForMint(mintPk);
  const ownerAta = ataFor(ownerPk, mintPk, prog);

  try {
    const acc = await getAccount(conn, ownerAta, 'confirmed', prog);
    const delegate = acc.delegate ? acc.delegate.toBase58() : null;
    const delegatedAmount = acc.delegatedAmount;
    const isRevoked = !delegate || delegatedAmount === 0n;
    const hasActiveDelegation = Boolean(delegate && delegatedAmount > 0n);

    // Read the mint rather than assume it: the cap and the balance are both money.
    const scale = await readMintScale(mintPk, conn, prog);
    const delegatedUsd = toUiAmount(delegatedAmount, scale);
    return {
      owner: ownerPk.toBase58(),
      ownerAta: ownerAta.toBase58(),
      delegate,
      delegatedAmount,
      balanceAmount: acc.amount,
      remainingUsd: delegatedUsd,
      isRevoked,
      hasActiveDelegation,
      hasDelegate: hasActiveDelegation,
      delegatedUsd,
      balanceUsd: toUiAmount(acc.amount, scale),
    };
  } catch (e) {
    if (e instanceof TokenAccountNotFoundError || e instanceof TokenInvalidAccountOwnerError) {
      return {
        owner: ownerPk.toBase58(),
        ownerAta: ownerAta.toBase58(),
        delegate: null,
        delegatedAmount: 0n,
        balanceAmount: 0n,
        remainingUsd: 0,
        isRevoked: true,
        hasActiveDelegation: false,
        hasDelegate: false,
        delegatedUsd: 0,
        balanceUsd: 0,
      };
    }
    throw e;
  }
}

/**
 * Grant or update SPL delegation from user to delegate keypair.
 * Signed by ownerKeypair.
 */
export async function approveDelegate(
  ownerKeypair: Keypair,
  delegatePubkey: PublicKey | string = delegateKeypair().publicKey,
  maxUsdOrUnits: number | bigint,
  conn: Connection = defaultConnection,
  feePayer: Keypair = payerKeypair(),
  mint: PublicKey | string = DEFAULT_MINTS.USDC,
): Promise<{ signature: string; slot: number; delegatedAmount: bigint }> {
  const delegatePk = typeof delegatePubkey === 'string' ? new PublicKey(delegatePubkey) : delegatePubkey;
  const mintPk = typeof mint === 'string' ? new PublicKey(mint) : mint;
  const prog = tokenProgramForMint(mintPk);
  const ownerAta = ataFor(ownerKeypair.publicKey, mintPk, prog);

  const amountUnits = typeof maxUsdOrUnits === 'bigint' ? maxUsdOrUnits : usdToBaseUnits(maxUsdOrUnits, 6);

  const tx = new Transaction();
  // Ensure owner ATA exists
  tx.add(
    createAssociatedTokenAccountIdempotentInstruction(
      feePayer.publicKey,
      ownerAta,
      ownerKeypair.publicKey,
      mintPk,
      prog,
    ),
  );
  // Add approve instruction
  tx.add(
    createApproveInstruction(
      ownerAta,
      delegatePk,
      ownerKeypair.publicKey,
      amountUnits,
      [],
      prog,
    ),
  );

  const signers = feePayer.publicKey.equals(ownerKeypair.publicKey)
    ? [ownerKeypair]
    : [feePayer, ownerKeypair];

  const signature = await sendAndConfirmTransaction(conn, tx, signers, {
    commitment: 'confirmed',
  });

  const { slot } = await waitForTx(signature, conn);
  return { signature, slot, delegatedAmount: amountUnits };
}

/**
 * On-chain kill switch: Revoke SPL delegation immediately.
 * Signed by ownerKeypair.
 */
export async function revokeDelegate(
  ownerKeypair: Keypair,
  conn: Connection = defaultConnection,
  feePayer: Keypair = payerKeypair(),
  mint: PublicKey | string = DEFAULT_MINTS.USDC,
): Promise<{ signature: string; slot: number }> {
  const mintPk = typeof mint === 'string' ? new PublicKey(mint) : mint;
  const prog = tokenProgramForMint(mintPk);
  const ownerAta = ataFor(ownerKeypair.publicKey, mintPk, prog);

  const tx = new Transaction();
  tx.add(
    createRevokeInstruction(
      ownerAta,
      ownerKeypair.publicKey,
      [],
      prog,
    ),
  );

  const signers = feePayer.publicKey.equals(ownerKeypair.publicKey)
    ? [ownerKeypair]
    : [feePayer, ownerKeypair];

  const signature = await sendAndConfirmTransaction(conn, tx, signers, {
    commitment: 'confirmed',
  });

  const { slot } = await waitForTx(signature, conn);
  return { signature, slot };
}

/**
 * Spend from owner ATA as delegate (Plan §6.3, Option A).
 * Signed by delegateKeypair.
 */
export async function spendAsDelegate(params: {
  owner: PublicKey | string;
  destinationAta: PublicKey | string;
  amountUnits: bigint;
  mint?: PublicKey | string;
  conn?: Connection;
  feePayer?: Keypair;
  delegate?: Keypair;
}): Promise<{ signature: string; slot: number; amount: bigint }> {
  const {
    owner,
    destinationAta,
    amountUnits,
    mint = DEFAULT_MINTS.USDC,
    conn = defaultConnection,
    feePayer = payerKeypair(),
    delegate = delegateKeypair(),
  } = params;

  const ownerPk = typeof owner === 'string' ? new PublicKey(owner) : owner;
  const destPk = typeof destinationAta === 'string' ? new PublicKey(destinationAta) : destinationAta;
  const mintPk = typeof mint === 'string' ? new PublicKey(mint) : mint;
  const prog = tokenProgramForMint(mintPk);
  const ownerAta = ataFor(ownerPk, mintPk, prog);

  // Read current on-chain delegation state
  const state = await readDelegation(ownerPk, mintPk, conn);
  if (state.isRevoked) {
    throw new Error('PolicyRevoked: Trading permission revoked on-chain');
  }
  if (!state.delegate || state.delegate !== delegate.publicKey.toBase58()) {
    throw new Error(
      `InvalidDelegate: Delegate on account (${state.delegate ?? 'none'}) does not match active delegate (${delegate.publicKey.toBase58()})`,
    );
  }
  if (amountUnits > state.delegatedAmount) {
    throw new Error(
      `custom program error: 0x1 (InsufficientDelegatedAmount: requested ${amountUnits} units exceeds delegated cap of ${state.delegatedAmount})`,
    );
  }

  /*
   * `transferChecked` re-derives decimals from the mint and rejects the instruction if the
   * number handed to it disagrees. A guessed value is a failed transfer, not a rounding error.
   */
  const { decimals } = await readMintScale(mintPk, conn, prog);

  const tx = new Transaction();
  tx.add(
    createTransferCheckedInstruction(
      ownerAta,
      mintPk,
      destPk,
      delegate.publicKey,
      amountUnits,
      decimals,
      [],
      prog,
    ),
  );

  const signers = feePayer.publicKey.equals(delegate.publicKey)
    ? [delegate]
    : [feePayer, delegate];

  const signature = await sendAndConfirmTransaction(conn, tx, signers, {
    commitment: 'confirmed',
  });

  const { slot } = await waitForTx(signature, conn);
  return { signature, slot, amount: amountUnits };
}

/**
 * Return funds / proceeds from venue vault back to user's ATA.
 * Signed by fromKeypair (e.g. venue vault or payer).
 */
export async function returnToOwner(params: {
  owner: PublicKey | string;
  mint: PublicKey | string;
  amountUnits: bigint;
  fromKeypair: Keypair;
  conn?: Connection;
  feePayer?: Keypair;
}): Promise<{ signature: string; slot: number; amount: bigint }> {
  const {
    owner,
    mint,
    amountUnits,
    fromKeypair,
    conn = defaultConnection,
    feePayer = payerKeypair(),
  } = params;

  const ownerPk = typeof owner === 'string' ? new PublicKey(owner) : owner;
  const mintPk = typeof mint === 'string' ? new PublicKey(mint) : mint;
  const prog = tokenProgramForMint(mintPk);
  const ownerAta = ataFor(ownerPk, mintPk, prog);
  const sourceAta = ataFor(fromKeypair.publicKey, mintPk, prog);

  const tx = new Transaction();
  // Ensure recipient ATA exists
  tx.add(
    createAssociatedTokenAccountIdempotentInstruction(
      feePayer.publicKey,
      ownerAta,
      ownerPk,
      mintPk,
      prog,
    ),
  );
  tx.add(
    createTransferCheckedInstruction(
      sourceAta,
      mintPk,
      ownerAta,
      fromKeypair.publicKey,
      amountUnits,
      (await readMintScale(mintPk, conn, prog)).decimals,
      [],
      prog,
    ),
  );

  const signers = feePayer.publicKey.equals(fromKeypair.publicKey)
    ? [fromKeypair]
    : [feePayer, fromKeypair];

  const signature = await sendAndConfirmTransaction(conn, tx, signers, {
    commitment: 'confirmed',
  });

  const { slot } = await waitForTx(signature, conn);
  return { signature, slot, amount: amountUnits };
}
