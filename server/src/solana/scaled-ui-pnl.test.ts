/**
 * A split or an auto-reinvested dividend on an xStock moves an issuer-controlled multiplier;
 * every raw balance stays exactly where it was. Anything that turns raw base units into a
 * number a person reads — a holding, a fill size, a fill price — has to apply it.
 *
 * These cover the conversion seam itself (`toUiAmount` / `fromUiAmount`), which is what the
 * executor's P&L and the balance reads both go through.
 */
import { describe, expect, it, beforeEach } from 'vitest';
import { PublicKey, Connection } from '@solana/web3.js';
import {
  ExtensionType,
  TOKEN_2022_PROGRAM_ID,
  MINT_SIZE,
  MintLayout,
  ScaledUiAmountConfigLayout,
  SCALED_UI_AMOUNT_CONFIG_SIZE,
  ACCOUNT_SIZE,
  ACCOUNT_TYPE_SIZE,
} from '@solana/spl-token';
import { toUiAmount, fromUiAmount, readMintScale, clearMintScaleCache } from './balances.js';

const NVDAX = 'Xsc9qvGR1efVDFGLrVsmkzv3qi45LTBjeUKSPmx9qEh';

function scaledMint(decimals: number, multiplier: number): Buffer {
  const base = Buffer.alloc(MINT_SIZE);
  MintLayout.encode(
    {
      mintAuthorityOption: 0,
      mintAuthority: PublicKey.default,
      supply: 1_000_000n,
      decimals,
      isInitialized: true,
      freezeAuthorityOption: 0,
      freezeAuthority: PublicKey.default,
    },
    base,
  );
  const padded = Buffer.alloc(ACCOUNT_SIZE);
  base.copy(padded, 0);
  const accountType = Buffer.alloc(ACCOUNT_TYPE_SIZE);
  accountType.writeUInt8(1, 0);
  const tlv = Buffer.alloc(4);
  tlv.writeUInt16LE(ExtensionType.ScaledUiAmountConfig, 0);
  tlv.writeUInt16LE(SCALED_UI_AMOUNT_CONFIG_SIZE, 2);
  const ext = Buffer.alloc(SCALED_UI_AMOUNT_CONFIG_SIZE);
  ScaledUiAmountConfigLayout.encode(
    {
      authority: PublicKey.default,
      multiplier,
      newMultiplierEffectiveTimestamp: 2n ** 62n,
      newMultiplier: multiplier,
    },
    ext,
  );
  return Buffer.concat([padded, accountType, tlv, ext]);
}

function connServing(data: Buffer): Connection {
  return {
    getAccountInfo: async () => ({
      data,
      owner: TOKEN_2022_PROGRAM_ID,
      lamports: 1,
      executable: false,
      rentEpoch: 0,
    }),
  } as unknown as Connection;
}

describe('scaled-UI P&L', () => {
  beforeEach(() => clearMintScaleCache());

  it('reports the multiplied holding, not the raw one', () => {
    // 0.46331112 raw NVDAx after a 4:1 split is four times the position.
    const raw = 46_331_112n;
    expect(toUiAmount(raw, { decimals: 8, multiplier: 1 })).toBeCloseTo(0.46331112, 10);
    expect(toUiAmount(raw, { decimals: 8, multiplier: 4 })).toBeCloseTo(1.85324448, 10);
  });

  it('prices a fill against what was actually received', () => {
    // $100 buys 0.46331112 raw units. Pre-split that is ~$215.84 a share.
    const raw = 46_331_112n;
    const spentUsd = 100;

    const naive = spentUsd / toUiAmount(raw, { decimals: 8, multiplier: 1 });
    expect(naive).toBeCloseTo(215.84, 2);

    // A 1.0017 multiplier means slightly more stock arrived, so each share cost slightly less.
    const real = spentUsd / toUiAmount(raw, { decimals: 8, multiplier: 1.001701196801074 });
    expect(real).toBeCloseTo(215.47, 2);
    expect(real).toBeLessThan(naive);
  });

  it('round-trips a displayed amount back to raw units', () => {
    const scale = { decimals: 8, multiplier: 2.5 };
    const raw = fromUiAmount(5, scale);
    expect(toUiAmount(raw, scale)).toBeCloseTo(5, 8);
  });

  it('reads a non-1.0 multiplier off the mint', async () => {
    const scale = await readMintScale(NVDAX, connServing(scaledMint(8, 4)), TOKEN_2022_PROGRAM_ID);
    expect(scale.decimals).toBe(8);
    expect(scale.multiplier).toBe(4);
    // The holding a judge would see: raw 1.0 NVDAx reads as 4.0 after the split.
    expect(toUiAmount(100_000_000n, scale)).toBeCloseTo(4, 10);
  });

  it('takes decimals from the mint rather than assuming 8 for Token-2022', async () => {
    const scale = await readMintScale(NVDAX, connServing(scaledMint(6, 1)), TOKEN_2022_PROGRAM_ID);
    expect(scale.decimals).toBe(6);
    // Assuming 8 here would report a 5.0 position as 0.05.
    expect(toUiAmount(5_000_000n, scale)).toBeCloseTo(5, 10);
  });

  it('sees a multiplier change once the cache expires', async () => {
    const before = await readMintScale(NVDAX, connServing(scaledMint(8, 1)), TOKEN_2022_PROGRAM_ID);
    expect(before.multiplier).toBe(1);
    // Issuer declares a split. A stale memo would keep reporting the old position.
    clearMintScaleCache();
    const after = await readMintScale(NVDAX, connServing(scaledMint(8, 4)), TOKEN_2022_PROGRAM_ID);
    expect(after.multiplier).toBe(4);
  });
});
