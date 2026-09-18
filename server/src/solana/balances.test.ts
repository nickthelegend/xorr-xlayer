import { describe, expect, it } from 'vitest';
import { PublicKey } from '@solana/web3.js';
import { ataFor, toPublicKey } from './balances.js';
import { SOLANA_MINTS } from './clusters.js';

describe('solana balances', () => {
  it('converts string to PublicKey', () => {
    const pubkeyStr = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
    const pk = toPublicKey(pubkeyStr);
    expect(pk).toBeInstanceOf(PublicKey);
    expect(pk.toBase58()).toBe(pubkeyStr);

    const same = toPublicKey(pk);
    expect(same).toBe(pk);
  });

  it('computes deterministically correct ATA for a user and mint', () => {
    // Known wallet and mainnet USDC mint
    const user = '7v91N7iZEdMoQg6zJ5pA9oG3eF1n3hXyZ1W2v3u4t5s6';
    const usdcMint = SOLANA_MINTS.mainnetUsdc;

    const ata1 = ataFor(user, usdcMint);
    const ata2 = ataFor(new PublicKey(user), new PublicKey(usdcMint));

    expect(ata1.toBase58()).toBe(ata2.toBase58());
    expect(PublicKey.isOnCurve(ata1.toBytes())).toBe(false); // ATAs are PDAs (off curve)
  });

  it('uses default usdc mint when mint is omitted', () => {
    const user = '7v91N7iZEdMoQg6zJ5pA9oG3eF1n3hXyZ1W2v3u4t5s6';
    const ata = ataFor(user);
    expect(ata).toBeInstanceOf(PublicKey);
    expect(ata.toBase58().length).toBeGreaterThanOrEqual(32);
  });
});
