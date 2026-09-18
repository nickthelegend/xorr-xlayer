/**
 * On-chain proofs against a real Solana Mainnet Fork (PLAN.md §14).
 *
 * PROVES:
 * 1. Real on-chain signature and transaction confirmation on the fork.
 * 2. SPL cap rejection: transfer beyond delegatedAmount is rejected on-chain.
 * 3. Kill switch (revoke): on-chain revoke stops new orders while resting exits stay live.
 * 4. End-to-end xStocks trade: one real USDC -> NVDAx BUY and a SELL back.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { ChildProcess } from 'node:child_process';
import { Connection, Keypair, PublicKey, LAMPORTS_PER_SOL } from '@solana/web3.js';
import {
  getOrCreateAssociatedTokenAccount,
  mintTo,
  TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
} from '@solana/spl-token';
import {
  createConnection,
  waitForTx,
  DEFAULT_MINTS,
  delegateKeypair,
  payerKeypair,
  devOwnerKeypair,
  venueVaultKeypair,
  approveDelegate,
  revokeDelegate,
  spendAsDelegate,
  readDelegation,
  returnToOwner,
  usdToBaseUnits,
  baseUnitsToUsd,
  getTokenBalance,
  getSolBalance,
  ataFor,
} from './index.js';
import { guardAndSpend } from '../executor/place.js';
import { XSTOCKS } from '../venues/xstocks.js';
import { startValidator, stopValidator } from './fork-bootstrap.js';

/*
 * This run's own validator, on ports nobody else holds.
 *
 * The RPC used to default to 127.0.0.1:8899. Other checkouts on the same machine run this suite
 * too, and whichever validator held 8899 first was the one every run talked to: `startValidator`
 * saw it answering, reused it, and the proofs ran against another run's ledger — Proof 3 timed
 * out, Proof 4 read someone else's balances, and it "passed on re-run" once that validator exited.
 *
 * `FORK_RPC` has to be settled before the imports above load: `connection.ts` builds its singleton
 * from it at import, and `guardAndSpend` spends through that singleton. `vi.hoisted` runs first.
 * An explicitly set `FORK_RPC` still wins — CI or a developer pointing the suite at a fork on purpose.
 */
const FORK = await vi.hoisted(async () => {
  const { execSync } = await import('node:child_process');
  const { allocateValidatorPorts } = await import('./validator-ports.js');
  // These proofs drive a real solana-test-validator. Where that binary is absent (a dev box
  // without the Solana toolchain, the hermetic CI job), skip rather than fail the run.
  let hasValidator = false;
  try {
    execSync('solana-test-validator --version', { stdio: 'ignore' });
    hasValidator = true;
  } catch {
    // skipped below
  }
  const explicit = process.env.FORK_RPC;
  if (explicit || !hasValidator) {
    return { hasValidator, rpcUrl: explicit ?? '', ports: undefined, allocated: false };
  }
  const ports = await allocateValidatorPorts();
  const rpcUrl = `http://127.0.0.1:${ports.rpc}`;
  process.env.FORK_RPC = rpcUrl;
  return { hasValidator, rpcUrl, ports, allocated: true };
});
const FORK_RPC = FORK.rpcUrl;
const USDC_MINT = new PublicKey(DEFAULT_MINTS.USDC);
const NVDAX_MINT = new PublicKey(XSTOCKS.NVDAx!.address);

// The on-demand `solana-fork` CI job installs the toolchain so the suite executes there.
const d = FORK.hasValidator ? describe : describe.skip;

d('Solana Mainnet Fork On-Chain Proofs', () => {
  let conn: Connection;
  let validatorProcess: ChildProcess | null = null;
  // Fixtures and ledger per run, so two runs never share (or `--reset`) each other's ledger.
  let fixturesDir = '';

  const payer = payerKeypair();
  const delegate = delegateKeypair();
  const devOwner = devOwnerKeypair();
  const venueVault = venueVaultKeypair();

  beforeAll(async () => {
    // 1. Boot or connect to solana-test-validator
    fixturesDir = fs.mkdtempSync(path.join(os.tmpdir(), 'xorr-fork-chain-'));
    validatorProcess = await startValidator(fixturesDir, payer, {
      rpcUrl: FORK_RPC,
      ports: FORK.ports,
      ledgerDir: path.join(fixturesDir, 'ledger'),
      // Held from the moment of spawn: if this hook times out mid-boot, afterAll still stops it.
      onSpawn: (child) => {
        validatorProcess = child;
      },
    });
    conn = createConnection(FORK_RPC, 'confirmed');

    // 2. Fund SOL to test keypairs
    for (const kp of [payer, delegate, devOwner, venueVault]) {
      const airdropSig = await conn.requestAirdrop(kp.publicKey, 10 * LAMPORTS_PER_SOL);
      await conn.confirmTransaction(airdropSig, 'confirmed');
    }

    // 3. Fund devOwner with 25,000 USDC
    const devOwnerUsdcAta = await getOrCreateAssociatedTokenAccount(
      conn,
      payer,
      USDC_MINT,
      devOwner.publicKey,
      false,
      'confirmed',
      undefined,
      TOKEN_PROGRAM_ID,
    );
    await mintTo(
      conn,
      payer,
      USDC_MINT,
      devOwnerUsdcAta.address,
      payer,
      25_000_000000n,
      [],
      undefined,
      TOKEN_PROGRAM_ID,
    );

    // 4. Fund venue vault with 100,000 USDC and 1,000 NVDAx
    const vaultUsdcAta = await getOrCreateAssociatedTokenAccount(
      conn,
      payer,
      USDC_MINT,
      venueVault.publicKey,
      false,
      'confirmed',
      undefined,
      TOKEN_PROGRAM_ID,
    );
    await mintTo(
      conn,
      payer,
      USDC_MINT,
      vaultUsdcAta.address,
      payer,
      100_000_000000n,
      [],
      undefined,
      TOKEN_PROGRAM_ID,
    );

    const vaultNvdaxAta = await getOrCreateAssociatedTokenAccount(
      conn,
      payer,
      NVDAX_MINT,
      venueVault.publicKey,
      false,
      'confirmed',
      undefined,
      TOKEN_2022_PROGRAM_ID,
    );
    await mintTo(
      conn,
      payer,
      NVDAX_MINT,
      vaultNvdaxAta.address,
      payer,
      1_000_00000000n,
      [],
      undefined,
      TOKEN_2022_PROGRAM_ID,
    );

    // 5. Ensure devOwner has NVDAx ATA created
    await getOrCreateAssociatedTokenAccount(
      conn,
      payer,
      NVDAX_MINT,
      devOwner.publicKey,
      false,
      'confirmed',
      undefined,
      TOKEN_2022_PROGRAM_ID,
    );
  }, 60_000);

  // Runs whether the proofs passed, threw or timed out. Only ever stops the validator this run
  // spawned — one found already running at an explicit FORK_RPC is left alone.
  afterAll(async () => {
    try {
      if (validatorProcess) await stopValidator(validatorProcess);
    } finally {
      validatorProcess = null;
      if (fixturesDir) fs.rmSync(fixturesDir, { recursive: true, force: true });
      if (FORK.allocated) delete process.env.FORK_RPC;
    }
  }, 15_000);

  it('Proof 1: Real on-chain signature and confirmation on the fork', async () => {
    const testRecipient = Keypair.generate();
    const sig = await conn.requestAirdrop(testRecipient.publicKey, 1 * LAMPORTS_PER_SOL);
    const receipt = await waitForTx(sig, conn);

    expect(receipt.signature).toBe(sig);
    expect(receipt.signature.length).toBeGreaterThan(60); // base58 signature
    expect(receipt.slot).toBeGreaterThan(0);
    expect(receipt.err).toBeNull();

    const bal = await getSolBalance(testRecipient.publicKey, conn);
    expect(bal.sol).toBe(1);
  });

  it('Proof 2: SPL cap rejects an over-cap transfer on-chain', async () => {
    // Owner sets an on-chain SPL delegation cap of $100 (100 USDC)
    const approveCapUsd = 100;
    const approveUnits = usdToBaseUnits(approveCapUsd, 6);
    const approveRes = await approveDelegate(
      devOwner,
      delegate.publicKey,
      approveUnits,
      conn,
      payer,
    );

    expect(approveRes.signature).toBeTruthy();
    expect(approveRes.delegatedAmount).toBe(approveUnits);

    const state = await readDelegation(devOwner.publicKey, USDC_MINT, conn);
    expect(state.delegate).toBe(delegate.publicKey.toBase58());
    expect(state.delegatedAmount).toBe(approveUnits);
    expect(state.remainingUsd).toBe(100);

    const vaultUsdcAta = ataFor(venueVault.publicKey, USDC_MINT);

    // 1. Over-cap spend attempt: $150 (> $100 cap) MUST fail
    const overCapUnits = usdToBaseUnits(150, 6);
    await expect(
      spendAsDelegate({
        owner: devOwner.publicKey,
        destinationAta: vaultUsdcAta,
        amountUnits: overCapUnits,
        conn,
        feePayer: payer,
        delegate,
      }),
    ).rejects.toThrow(/InsufficientDelegatedAmount|custom program error: 0x1/);

    // 2. In-cap spend: $40 (< $100 cap) succeeds
    const inCapUnits = usdToBaseUnits(40, 6);
    const spendRes = await spendAsDelegate({
      owner: devOwner.publicKey,
      destinationAta: vaultUsdcAta,
      amountUnits: inCapUnits,
      conn,
      feePayer: payer,
      delegate,
    });

    expect(spendRes.signature).toBeTruthy();
    expect(spendRes.amount).toBe(inCapUnits);

    // Verify on-chain remaining delegated amount reduced to exactly $60
    const stateAfter = await readDelegation(devOwner.publicKey, USDC_MINT, conn);
    expect(stateAfter.delegatedAmount).toBe(usdToBaseUnits(60, 6));
    expect(stateAfter.remainingUsd).toBe(60);
  });

  it('Proof 3: Kill switch (revoke) stops new orders while resting exits stay live', async () => {
    // 1. Grant $500 permission
    await approveDelegate(devOwner, delegate.publicKey, 500, conn, payer);
    const beforeRevoke = await readDelegation(devOwner.publicKey, USDC_MINT, conn);
    expect(beforeRevoke.isRevoked).toBe(false);

    // 2. Kill switch triggered: revoke on-chain
    const revokeRes = await revokeDelegate(devOwner, conn, payer);
    expect(revokeRes.signature).toBeTruthy();

    const afterRevoke = await readDelegation(devOwner.publicKey, USDC_MINT, conn);
    expect(afterRevoke.isRevoked).toBe(true);
    expect(afterRevoke.delegate).toBeNull();
    expect(afterRevoke.delegatedAmount).toBe(0n);

    // 3. New BUY order is rejected by spend chokepoint
    const buyOutcome = await guardAndSpend({
      walletId: 'test-wallet',
      ownerPubkey: devOwner.publicKey.toBase58(),
      symbol: 'NVDAx',
      usd: 50,
      side: 'buy',
      skipRulesEngine: true,
    });

    expect(buyOutcome.placed).toBe(false);
    if (!buyOutcome.placed) {
      expect(buyOutcome.reason).toBe('delegation_revoked');
    }

    // 4. Resting exit / sell DOES stay live (reduces risk, returns funds to owner)
    // First ensure dev owner has some NVDAx to exit
    const devOwnerNvdaxAta = await getOrCreateAssociatedTokenAccount(
      conn,
      payer,
      NVDAX_MINT,
      devOwner.publicKey,
      false,
      'confirmed',
      undefined,
      TOKEN_2022_PROGRAM_ID,
    );
    await mintTo(
      conn,
      payer,
      NVDAX_MINT,
      devOwnerNvdaxAta.address,
      payer,
      1_00000000n, // 1 NVDAx
      [],
      undefined,
      TOKEN_2022_PROGRAM_ID,
    );

    const exitOutcome = await guardAndSpend({
      walletId: 'test-wallet',
      ownerPubkey: devOwner.publicKey.toBase58(),
      symbol: 'NVDAx',
      usd: 50,
      side: 'sell',
      skipRulesEngine: true,
    });

    expect(exitOutcome.placed).toBe(true);
    if (exitOutcome.placed) {
      expect(exitOutcome.side).toBe('sell');
      expect(exitOutcome.signature).toBeTruthy();
    }
  });

  it('Proof 4: Real USDC -> NVDAx BUY and SELL back on the fork', async () => {
    // Grant $1,000 delegation
    await approveDelegate(devOwner, delegate.publicKey, 1000, conn, payer);

    const usdcBefore = await getTokenBalance(devOwner.publicKey, USDC_MINT, conn);
    const nvdaxBefore = await getTokenBalance(devOwner.publicKey, NVDAX_MINT, conn);

    // 1. BUY: Buy $200 of NVDAx
    const buyUsd = 200;
    const buyOutcome = await guardAndSpend({
      walletId: 'test-wallet-4',
      ownerPubkey: devOwner.publicKey.toBase58(),
      symbol: 'NVDAx',
      usd: buyUsd,
      side: 'buy',
      skipRulesEngine: true,
    });

    expect(buyOutcome.placed).toBe(true);
    if (!buyOutcome.placed) return;

    expect(buyOutcome.symbol).toBe('NVDAx');
    expect(buyOutcome.side).toBe('buy');
    expect(buyOutcome.signature).toBeTruthy();
    expect(buyOutcome.filledUnits).toBeGreaterThan(0);
    expect(buyOutcome.fillPrice).toBeGreaterThan(0);

    // Check balances on-chain after BUY
    const usdcAfterBuy = await getTokenBalance(devOwner.publicKey, USDC_MINT, conn);
    const nvdaxAfterBuy = await getTokenBalance(devOwner.publicKey, NVDAX_MINT, conn);

    expect(usdcAfterBuy.amount).toBe(usdcBefore.amount - usdToBaseUnits(buyUsd, 6));
    expect(nvdaxAfterBuy.amount).toBeGreaterThan(nvdaxBefore.amount);

    console.log(`\n BUY PROOF SUCCESS:`);
    console.log(`  Spent:   ${buyUsd} USDC`);
    console.log(`  Bought:  ${buyOutcome.filledUnits.toFixed(6)} NVDAx @ $${buyOutcome.fillPrice.toFixed(2)}`);
    console.log(`  Tx Sig:  ${buyOutcome.signature}`);

    // 2. SELL back: Sell half back to USDC
    const sellUsd = 100;
    const sellOutcome = await guardAndSpend({
      walletId: 'test-wallet-4',
      ownerPubkey: devOwner.publicKey.toBase58(),
      symbol: 'NVDAx',
      usd: sellUsd,
      side: 'sell',
      skipRulesEngine: true,
    });

    expect(sellOutcome.placed).toBe(true);
    if (!sellOutcome.placed) return;

    expect(sellOutcome.side).toBe('sell');
    expect(sellOutcome.signature).toBeTruthy();

    // Check balances on-chain after SELL
    const usdcAfterSell = await getTokenBalance(devOwner.publicKey, USDC_MINT, conn);
    expect(usdcAfterSell.amount).toBeGreaterThan(usdcAfterBuy.amount);

    console.log(`\n SELL PROOF SUCCESS:`);
    console.log(`  Sold:    ${sellOutcome.filledUnits.toFixed(6)} NVDAx for ~$${sellOutcome.usd.toFixed(2)} USDC`);
    console.log(`  Tx Sig:  ${sellOutcome.signature}\n`);
  });
});
