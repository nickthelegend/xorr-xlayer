/**
 * xStocks are Token-2022 mints with the Scaled UI Amount extension: the displayed balance is
 * the raw balance times an issuer-controlled multiplier, and a split or a dividend moves the
 * multiplier rather than the raw balance.
 *
 * `getTokenBalance` used to divide by a hardcoded 8 decimals for every Token-2022 mint and
 * ignore the multiplier entirely, so a holder's reported position was wrong twice over: wrong
 * for any Token-2022 mint that is not 8 decimals, and wrong for every xStock the moment its
 * issuer declared a split.
 */
import { describe, expect, it, beforeEach } from 'vitest';
import { PublicKey, Connection } from '@solana/web3.js';
import {
  ExtensionType,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  MINT_SIZE,
  MintLayout,
  ScaledUiAmountConfigLayout,
  SCALED_UI_AMOUNT_CONFIG_SIZE,
  ACCOUNT_SIZE,
  AccountLayout,
  ACCOUNT_TYPE_SIZE,
  unpackMint,
} from '@solana/spl-token';
import { getTokenBalance, scaledUiMultiplier, ataFor, clearMintScaleCache } from './balances.js';

// NVDAx — a real xStock, and one of the Token-2022 mints `tokenProgramForMint` knows.
const NVDAX = 'Xsc9qvGR1efVDFGLrVsmkzv3qi45LTBjeUKSPmx9qEh';
const OWNER = '7v91N7iZEdMoQg6zJ5pA9oG3eF1n3hXyZ1W2v3u4t5s6';

/** A Token-2022 mint account carrying a Scaled UI Amount config. */
function encodeScaledMint(opts: {
  decimals: number;
  multiplier: number;
  newMultiplier?: number;
  effectiveTimestamp?: bigint;
}): Buffer {
  const base = Buffer.alloc(MINT_SIZE);
  MintLayout.encode(
    {
      mintAuthorityOption: 0,
      mintAuthority: PublicKey.default,
      supply: 1_000_000n,
      decimals: opts.decimals,
      isInitialized: true,
      freezeAuthorityOption: 0,
      freezeAuthority: PublicKey.default,
    },
    base,
  );

  /*
   * Token-2022 lays an extended mint out as: the base mint padded to ACCOUNT_SIZE, then one
   * account-type byte marking it a mint, then TLV entries of [type u16][len u16][data].
   * The padding is what keeps an extended mint from being mistaken for a token account.
   */
  const padded = Buffer.alloc(ACCOUNT_SIZE);
  base.copy(padded, 0);

  const accountType = Buffer.alloc(ACCOUNT_TYPE_SIZE);
  accountType.writeUInt8(1, 0); // AccountType::Mint

  const tlvHeader = Buffer.alloc(4);
  tlvHeader.writeUInt16LE(ExtensionType.ScaledUiAmountConfig, 0);
  tlvHeader.writeUInt16LE(SCALED_UI_AMOUNT_CONFIG_SIZE, 2);

  const ext = Buffer.alloc(SCALED_UI_AMOUNT_CONFIG_SIZE);
  ScaledUiAmountConfigLayout.encode(
    {
      authority: PublicKey.default,
      multiplier: opts.multiplier,
      newMultiplierEffectiveTimestamp: opts.effectiveTimestamp ?? 2n ** 62n,
      newMultiplier: opts.newMultiplier ?? opts.multiplier,
    },
    ext,
  );

  return Buffer.concat([padded, accountType, tlvHeader, ext]);
}

/** A Token-2022 token account holding `amount` raw units. */
function encodeTokenAccount(mint: PublicKey, owner: PublicKey, amount: bigint): Buffer {
  const buf = Buffer.alloc(ACCOUNT_SIZE);
  AccountLayout.encode(
    {
      mint,
      owner,
      amount,
      delegateOption: 0,
      delegate: PublicKey.default,
      delegatedAmount: 0n,
      state: 1,
      isNativeOption: 0,
      isNative: 0n,
      closeAuthorityOption: 0,
      closeAuthority: PublicKey.default,
    },
    buf,
  );
  return buf;
}

/**
 * A connection that answers for exactly two accounts: the mint and the owner's ATA.
 * No network, no validator — the arithmetic under test is all local.
 */
function connectionServing(mintData: Buffer, ataData: Buffer, ata: PublicKey): Connection {
  const conn = {
    getAccountInfo: async (pubkey: PublicKey) => {
      if (pubkey.equals(new PublicKey(NVDAX))) {
        return { data: mintData, owner: TOKEN_2022_PROGRAM_ID, lamports: 1, executable: false, rentEpoch: 0 };
      }
      if (pubkey.equals(ata)) {
        return { data: ataData, owner: TOKEN_2022_PROGRAM_ID, lamports: 1, executable: false, rentEpoch: 0 };
      }
      return null;
    },
  };
  return conn as unknown as Connection;
}

describe('scaled UI amount balances', () => {
  // Every case here reuses one mint address with different decimals and multipliers, so the
  // read-through memo has to be dropped between them.
  beforeEach(() => clearMintScaleCache());

  it('reports a 1.0-multiplier balance at face value', async () => {
    const mintPk = new PublicKey(NVDAX);
    const ownerPk = new PublicKey(OWNER);
    const ata = ataFor(ownerPk, mintPk, TOKEN_2022_PROGRAM_ID);

    // 3 whole tokens at 8 decimals.
    const conn = connectionServing(
      encodeScaledMint({ decimals: 8, multiplier: 1 }),
      encodeTokenAccount(mintPk, ownerPk, 300_000_000n),
      ata,
    );

    const bal = await getTokenBalance(ownerPk, mintPk, conn);
    expect(bal.decimals).toBe(8);
    expect(bal.amount).toBe(300_000_000n);
    expect(bal.uiAmount).toBeCloseTo(3, 10);
  });

  it('multiplies the balance by a non-1.0 multiplier', async () => {
    const mintPk = new PublicKey(NVDAX);
    const ownerPk = new PublicKey(OWNER);
    const ata = ataFor(ownerPk, mintPk, TOKEN_2022_PROGRAM_ID);

    // Same 3 raw tokens, but the issuer has declared a 4:1 split.
    const conn = connectionServing(
      encodeScaledMint({ decimals: 8, multiplier: 4 }),
      encodeTokenAccount(mintPk, ownerPk, 300_000_000n),
      ata,
    );

    const bal = await getTokenBalance(ownerPk, mintPk, conn);
    // The raw balance is untouched by a split — only the reported holding moves.
    expect(bal.amount).toBe(300_000_000n);
    expect(bal.uiAmount).toBeCloseTo(12, 10);
  });

  it('reads decimals from the mint rather than assuming 8 for Token-2022', async () => {
    const mintPk = new PublicKey(NVDAX);
    const ownerPk = new PublicKey(OWNER);
    const ata = ataFor(ownerPk, mintPk, TOKEN_2022_PROGRAM_ID);

    // A Token-2022 mint with 6 decimals, not 8. Assuming 8 under-reports by 100x.
    const conn = connectionServing(
      encodeScaledMint({ decimals: 6, multiplier: 1 }),
      encodeTokenAccount(mintPk, ownerPk, 5_000_000n),
      ata,
    );

    const bal = await getTokenBalance(ownerPk, mintPk, conn);
    expect(bal.decimals).toBe(6);
    expect(bal.uiAmount).toBeCloseTo(5, 10);
  });

  it('switches to the new multiplier once its effective timestamp has passed', async () => {
    const at = 1_800_000_000; // a fixed instant, so the test does not depend on the clock
    const mintPk = new PublicKey(NVDAX);

    const mintWithPending = (effective: bigint) =>
      unpackMint(
        mintPk,
        {
          data: encodeScaledMint({
            decimals: 8,
            multiplier: 1,
            newMultiplier: 10,
            effectiveTimestamp: effective,
          }),
          owner: TOKEN_2022_PROGRAM_ID,
          lamports: 1,
          executable: false,
          rentEpoch: 0,
        } as never,
        TOKEN_2022_PROGRAM_ID,
      );

    // Not yet in force: the current multiplier still applies.
    expect(scaledUiMultiplier(mintWithPending(BigInt(at + 1_000)), at)).toBe(1);
    // In force: the new multiplier applies.
    expect(scaledUiMultiplier(mintWithPending(BigInt(at - 1_000)), at)).toBe(10);
  });

  it('scales by 1 for a mint with no scaled-UI extension', async () => {
    // Plain SPL Token USDC: no extension, so raw / 10**decimals is the whole story.
    const usdc = new PublicKey('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v');
    const ownerPk = new PublicKey(OWNER);
    const ata = ataFor(ownerPk, usdc, TOKEN_PROGRAM_ID);

    const mintBuf = Buffer.alloc(MINT_SIZE);
    MintLayout.encode(
      {
        mintAuthorityOption: 0,
        mintAuthority: PublicKey.default,
        supply: 1_000_000n,
        decimals: 6,
        isInitialized: true,
        freezeAuthorityOption: 0,
        freezeAuthority: PublicKey.default,
      },
      mintBuf,
    );

    const conn = {
      getAccountInfo: async (pubkey: PublicKey) => {
        if (pubkey.equals(usdc)) {
          return { data: mintBuf, owner: TOKEN_PROGRAM_ID, lamports: 1, executable: false, rentEpoch: 0 };
        }
        if (pubkey.equals(ata)) {
          return {
            data: encodeTokenAccount(usdc, ownerPk, 25_000_000n),
            owner: TOKEN_PROGRAM_ID,
            lamports: 1,
            executable: false,
            rentEpoch: 0,
          };
        }
        return null;
      },
    } as unknown as Connection;

    const bal = await getTokenBalance(ownerPk, usdc, conn);
    expect(bal.decimals).toBe(6);
    expect(bal.uiAmount).toBeCloseTo(25, 10);
  });
});
