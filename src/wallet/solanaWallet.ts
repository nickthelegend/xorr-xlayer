/**
 * Solana embedded wallet management and transaction signing (PLAN.md §5, §8.1).
 *
 * Stores the user's Solana keypair securely via expo-secure-store with in-memory / local fallback.
 * Signs user-authorized transactions (such as SPL USDC withdrawals) and broadcasts them directly to
 * the Solana fork or cluster.
 */
import { Connection, Keypair, PublicKey, Transaction } from '@solana/web3.js';
import {
  createTransferInstruction,
  getAssociatedTokenAddressSync,
  createAssociatedTokenAccountInstruction,
} from '@solana/spl-token';
import bs58 from 'bs58';
import { Platform } from 'react-native';

const STORAGE_KEY = 'xorr_solana_user_secret';
let memoryKeypair: Keypair | undefined;

async function getStoredSecret(): Promise<string | null> {
  if (Platform.OS !== 'web' && typeof (globalThis as any).__DEV__ !== 'undefined') {
    try {
      const SecureStore = await import('expo-secure-store');
      return await SecureStore.getItemAsync(STORAGE_KEY);
    } catch {
      // Fall through to other storage
    }
  }
  if (typeof localStorage !== 'undefined') {
    return localStorage.getItem(STORAGE_KEY);
  }
  return null;
}

async function setStoredSecret(encoded: string): Promise<void> {
  if (Platform.OS !== 'web' && typeof (globalThis as any).__DEV__ !== 'undefined') {
    try {
      const SecureStore = await import('expo-secure-store');
      await SecureStore.setItemAsync(STORAGE_KEY, encoded);
      return;
    } catch {
      // Fall through to memory
    }
  }
  if (typeof localStorage !== 'undefined') {
    localStorage.setItem(STORAGE_KEY, encoded);
  }
}

/**
 * Parse a private key string (base58 encoded or JSON array) into a Solana Keypair.
 */
export function parseSolanaKeypair(raw: string): Keypair {
  const trimmed = raw.trim();
  if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
    const bytes = JSON.parse(trimmed) as number[];
    return Keypair.fromSecretKey(Uint8Array.from(bytes));
  }
  return Keypair.fromSecretKey(bs58.decode(trimmed));
}

/**
 * Get the active Solana RPC connection.
 */
export function getSolanaConnection(): Connection {
  const rpc =
    process.env.EXPO_PUBLIC_CHAIN_RPC ??
    process.env.SOLANA_RPC ??
    process.env.FORK_RPC ??
    'http://127.0.0.1:8899';
  return new Connection(rpc, 'confirmed');
}

/**
 * Get or initialize the user's Solana Keypair.
 * Generates and securely persists a new Keypair if none exists.
 */
export async function getOrCreateSolanaKeypair(): Promise<Keypair> {
  if (memoryKeypair) return memoryKeypair;

  const stored = await getStoredSecret().catch(() => null);
  if (stored) {
    try {
      memoryKeypair = parseSolanaKeypair(stored);
      return memoryKeypair;
    } catch {
      // Corrupt key, regenerate
    }
  }

  // Check if an explicit dev wallet key is passed via env
  const envKey = process.env.XORR_SOLANA_DEV_USER_KEY;
  if (envKey) {
    memoryKeypair = parseSolanaKeypair(envKey);
    return memoryKeypair;
  }

  const generated = Keypair.generate();
  const encoded = bs58.encode(generated.secretKey);
  await setStoredSecret(encoded).catch(() => undefined);

  memoryKeypair = generated;
  return memoryKeypair;
}

/**
 * Set the in-memory keypair (used by tests or custom signer injections).
 */
export function setMemoryKeypair(kp: Keypair | undefined): void {
  memoryKeypair = kp;
}

/**
 * Send a user-signed SPL token transfer to an allowlisted destination.
 */
export async function sendSolanaSplTransfer(params: {
  connection?: Connection;
  signer: Keypair;
  mint: PublicKey;
  destination: PublicKey;
  amountRaw: bigint;
}): Promise<string> {
  const connection = params.connection ?? getSolanaConnection();
  const { signer, mint, destination, amountRaw } = params;

  const sourceAta = getAssociatedTokenAddressSync(mint, signer.publicKey);
  const destAta = getAssociatedTokenAddressSync(mint, destination);

  const tx = new Transaction();

  // Check if recipient ATA exists; if not, create it
  const destAccountInfo = await connection.getAccountInfo(destAta);
  if (!destAccountInfo) {
    tx.add(
      createAssociatedTokenAccountInstruction(
        signer.publicKey,
        destAta,
        destination,
        mint,
      ),
    );
  }

  // Add SPL transfer instruction
  tx.add(createTransferInstruction(sourceAta, destAta, signer.publicKey, amountRaw));

  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash('confirmed');
  tx.recentBlockhash = blockhash;
  tx.feePayer = signer.publicKey;

  tx.sign(signer);

  const rawTx = tx.serialize();
  const signature = await connection.sendRawTransaction(rawTx, {
    skipPreflight: false,
    preflightCommitment: 'confirmed',
  });

  await connection.confirmTransaction(
    {
      signature,
      blockhash,
      lastValidBlockHeight,
    },
    'confirmed',
  );

  return signature;
}
