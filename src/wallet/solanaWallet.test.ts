import { describe, expect, it, beforeEach } from 'vitest';
import { Keypair, PublicKey } from '@solana/web3.js';
import bs58 from 'bs58';
import {
  parseSolanaKeypair,
  getOrCreateSolanaKeypair,
  setMemoryKeypair,
} from './solanaWallet';

describe('Solana embedded wallet helper', () => {
  beforeEach(() => {
    setMemoryKeypair(undefined);
  });

  it('parses base58 and JSON array encoded keypairs', () => {
    const generated = Keypair.generate();
    const b58 = bs58.encode(generated.secretKey);
    const json = JSON.stringify(Array.from(generated.secretKey));

    const fromB58 = parseSolanaKeypair(b58);
    const fromJson = parseSolanaKeypair(json);

    expect(fromB58.publicKey.toBase58()).toBe(generated.publicKey.toBase58());
    expect(fromJson.publicKey.toBase58()).toBe(generated.publicKey.toBase58());
  });

  it('getOrCreateSolanaKeypair returns a valid Keypair and caches it', async () => {
    const kp1 = await getOrCreateSolanaKeypair();
    expect(kp1).toBeInstanceOf(Keypair);
    expect(kp1.publicKey.toBase58().length).toBeGreaterThanOrEqual(32);

    const kp2 = await getOrCreateSolanaKeypair();
    expect(kp2.publicKey.toBase58()).toBe(kp1.publicKey.toBase58());
  });
});
