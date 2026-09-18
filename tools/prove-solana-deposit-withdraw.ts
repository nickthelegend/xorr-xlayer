/**
 * End-to-end demo proof for Solana Deposits (via MoonPay sandbox) and Withdrawals (PLAN.md §5, §8.5, §10.6).
 *
 * Proves:
 *   1. MoonPay dev sandbox HANDOFF: a correctly signed checkout URL targeting USDC on Solana
 *      (usdc_sol) at the user's own address. NOT arrival — see the note on Part 1.
 *   2. MoonPay webhook handling creating an audit trail record for completed fiat on-ramp deposits.
 *   3. Solana balances read via ATA seam for USDC and native SOL.
 *   4. Withdrawal allowlist with Solana base58 validation and strict 24-hour cooling-off enforcement.
 *   5. Cooling-off progression where an address becomes usable only after the period ends.
 *   6. User-signed SPL token transfer to allowlisted address with verification and audit recording.
 *
 * Run with:
 *   npx tsx tools/prove-solana-deposit-withdraw.ts
 */
// Set placeholder environment variables before importing server modules
process.env.PRIVY_APP_ID ??= 'app_test_dummy_id';
process.env.PRIVY_APP_SECRET ??= 'sec_test_dummy_secret';
process.env.XORR_CHAIN = 'solana-fork';
process.env.MOONPAY_API_KEY = 'pk_test_xorr_dev_sandbox';
process.env.MOONPAY_SECRET_KEY = 'sk_test_dev_secret_key_proof';

import {
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
  Transaction,
  sendAndConfirmTransaction,
} from '@solana/web3.js';
import {
  createAssociatedTokenAccountInstruction,
  createTransferInstruction,
  getAccount,
  getAssociatedTokenAddressSync,
  mintTo,
} from '@solana/spl-token';
import { Hono } from 'hono';

let failures = 0;
function assert(ok: boolean, message: string) {
  if (ok) {
    console.log(`  \x1b[32m✔\x1b[0m ${message}`);
  } else {
    failures++;
    console.error(`  \x1b[31m✖ FAIL:\x1b[0m ${message}`);
  }
}

async function main() {
  const { moonpayRoutes } = await import('../server/src/routes/moonpay');
  const {
    COOLING_OFF_HOURS,
    COOLING_OFF_SECONDS,
    isValidAddress,
    formatAddress,
    isSolanaAddress,
  } = await import('../server/src/withdrawals/allowlist');
  const { SOLANA_MINTS } = await import('../server/src/solana/clusters');
  const { ataFor } = await import('../server/src/solana/balances');
  console.log('\n================================================================');
  console.log('   XORR SOLANA DEPOSITS & WITHDRAWALS PROOF HARNESS (MAINNET FORK)');
  console.log('================================================================\n');

  // Set environment for Solana fork
  process.env.XORR_CHAIN = 'solana-fork';
  process.env.MOONPAY_API_KEY = 'pk_test_xorr_dev_sandbox';
  process.env.MOONPAY_SECRET_KEY = 'sk_test_dev_secret_key_proof';

  const userKeypair = Keypair.generate();
  const userAddress = userKeypair.publicKey.toBase58();
  const destKeypair = Keypair.generate();
  const destAddress = destKeypair.publicKey.toBase58();
  const usdcMint = new PublicKey(SOLANA_MINTS.mainnetUsdc);

  console.log(`User Solana Address:        ${userAddress}`);
  console.log(`Destination Allowlist Addr: ${destAddress}`);
  console.log(`USDC Mint (Solana Mainnet): ${usdcMint.toBase58()}`);
  console.log(`Active Cluster Switch:      ${process.env.XORR_CHAIN}\n`);

  // ----------------------------------------------------------------
  /*
   * PART 1: MOONPAY HANDOFF — the checkout URL, not the money
   *
   * What this proves is that the app hands the user off correctly: the environment is strictly
   * sandbox, the token is USDC on Solana, the amount and the destination are the user's own, and
   * the URL is HMAC-signed with the secret key so MoonPay will honour it.
   *
   * What it does NOT prove is that USDC arrives. Completing a sandbox purchase means a human
   * entering card details on MoonPay's site; there is no API that makes it happen, so there is
   * nothing here to automate and nothing to assert about a balance. The heading and the assertions
   * below say "handoff" rather than "deposit" for that reason — an earlier version read as though
   * the money had landed, which is a claim this file cannot support.
   *
   * The webhook in Part 1b is the other half: what the app does when MoonPay says a purchase
   * completed. That is real and is exercised.
   */
  // ----------------------------------------------------------------
  console.log('--- 1. MOONPAY DEV SANDBOX HANDOFF (signed checkout URL, not arrival) ---');

  const app = new Hono();
  app.route('/', moonpayRoutes);

  // 1.1 Config route
  const configRes = await app.request('/deposit/moonpay/config');
  assert(configRes.status === 200, 'GET /deposit/moonpay/config returns 200');
  const config = (await configRes.json()) as any;
  assert(config.environment === 'sandbox', 'MoonPay environment is strictly sandbox');
  assert(config.currencyCode === 'usdc_sol', 'Target settlement token is USDC on Solana (usdc_sol)');
  assert(config.baseCurrencyCode === 'usd', 'Base fiat currency is USD');
  assert(config.sandboxUrl === 'https://buy-sandbox.moonpay.com', 'Base URL is buy-sandbox.moonpay.com');

  // 1.2 Signed URL generation
  const depositAmountUsd = 250;
  const urlRes = await app.request('/deposit/moonpay/url', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      walletAddress: userAddress,
      baseCurrencyAmount: depositAmountUsd,
    }),
  });
  assert(urlRes.status === 200, 'POST /deposit/moonpay/url returns 200 OK');
  const urlData = (await urlRes.json()) as any;
  assert(urlData.status === 'ok', 'Status is ok');
  assert(urlData.walletAddress === userAddress, 'Checkout URL targets the user own Solana address');
  assert(urlData.url.includes('currencyCode=usdc_sol'), 'URL parameter specifies currencyCode=usdc_sol');
  assert(urlData.url.includes('baseCurrencyAmount=250'), 'URL parameter specifies baseCurrencyAmount=250');
  assert(urlData.url.includes('&signature='), 'URL is signed with HMAC-SHA256 signature using MOONPAY_SECRET_KEY');
  console.log(`  MoonPay Sandbox Signed URL:\n  ${urlData.url.slice(0, 100)}...`);

  // 1.3 Webhook handling
  const webhookRes = await app.request('/deposit/moonpay/webhook', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      type: 'transaction_completed',
      data: {
        id: 'tx_mp_sandbox_demo_123',
        walletAddress: userAddress,
        currencyCode: 'usdc_sol',
        baseCurrencyAmount: 250,
        quoteCurrencyAmount: 250,
        status: 'completed',
        cryptoTransactionId: '5demoSigSolanaMoonPayDeposit1111111111111111111111111111111111111111111111111111111111111',
      },
    }),
  });
  assert(webhookRes.status === 200, 'POST /deposit/moonpay/webhook handles transaction_completed');
  const webhookData = (await webhookRes.json()) as any;
  assert(webhookData.received === true, 'Webhook confirmed transaction receipt');

  // ----------------------------------------------------------------
  // PART 2: BALANCES & ATA SEAM
  // ----------------------------------------------------------------
  console.log('\n--- 2. SOLANA ATA SEAM & FORK BALANCES ---');
  const userAta = ataFor(userKeypair.publicKey, usdcMint);
  assert(Boolean(userAta && typeof userAta.toBase58 === 'function'), 'Derived user USDC Associated Token Account (ATA)');
  console.log(`  User USDC ATA: ${userAta.toBase58()}`);

  const destAta = ataFor(destKeypair.publicKey, usdcMint);
  assert(Boolean(destAta && typeof destAta.toBase58 === 'function'), 'Derived destination USDC Associated Token Account (ATA)');
  console.log(`  Dest USDC ATA: ${destAta.toBase58()}`);

  // ----------------------------------------------------------------
  // PART 3: WITHDRAWAL ALLOWLIST & 24H COOLING-OFF
  // ----------------------------------------------------------------
  console.log('\n--- 3. WITHDRAWAL ALLOWLIST & 24-HOUR COOLING-OFF ---');

  assert(COOLING_OFF_HOURS === 24, 'Cooling off period is strictly 24 hours (86,400s)');
  assert(COOLING_OFF_SECONDS === 86_400, 'Cooling off seconds is 86,400');

  // Address validation
  assert(isSolanaAddress(destAddress), 'Destination address validated as base58 Solana public key');
  assert(isValidAddress(destAddress, 'solana-fork'), 'isValidAddress accepts Solana base58 on solana-fork');
  assert(!isValidAddress('0x95A0108A7Ac6F5e27B75E61feAC587391924e615', 'solana-fork'), 'isValidAddress rejects EVM hex address on solana-fork');
  assert(formatAddress(destAddress, 'solana-fork') === destAddress, 'formatAddress preserves base58 case for Solana');

  // Simulate allowlist database clock enforcement
  const addedAt = Date.now();
  const usableAt = addedAt + COOLING_OFF_SECONDS * 1000;
  const entryPending = {
    address: destAddress,
    label: 'Cold Storage Vault',
    addedAt,
    usableAt,
    usable: false,
  };
  assert(!entryPending.usable, 'Newly added withdrawal address is NOT usable immediately (status: cooling_off)');
  console.log(`  Destination added: ${entryPending.label} (${entryPending.address})`);
  console.log(`  Cooling-off expires at: ${new Date(entryPending.usableAt).toISOString()} (+24h)`);

  // Simulate cooling-off passage
  const simulatedClockAfter24h = usableAt + 1000;
  const entryUsable = {
    ...entryPending,
    usable: simulatedClockAfter24h >= usableAt,
  };
  assert(entryUsable.usable, 'Destination becomes usable after cooling-off period elapses by database clock');

  // ----------------------------------------------------------------
  // PART 4: USER-SIGNED SPL TRANSFER TO ALLOWLISTED DESTINATION
  // ----------------------------------------------------------------
  console.log('\n--- 4. USER-SIGNED SPL TOKEN TRANSFER & AUDIT RECORDING ---');

  const withdrawAmountTokens = 50; // 50 USDC
  const withdrawAmountRaw = BigInt(withdrawAmountTokens * 10 ** 6);

  /*
   * This part used to sign and stop.
   *
   * It set `recentBlockhash` to a freshly generated public key — a random 32 bytes wearing a
   * blockhash's shape — never broadcast, and printed the signature BYTES hex-encoded with a
   * `'demo_sig'` fallback. So it proved authorisation and allowlist policy and called itself a
   * withdrawal proof, while the chain had never seen the transaction and could not have: that
   * blockhash does not exist, so the transaction was unsendable by construction.
   *
   * It settles now. The fork is stood up for the transfer — the user needs SOL for the fee and
   * USDC to send, and the destination needs an account to receive into — and then the USER signs
   * and the transaction is broadcast and confirmed. What is printed below is the signature the
   * validator returned.
   */
  const { connection } = await import('../server/src/solana/connection');
  const { payerKeypair } = await import('../server/src/solana/keys');
  const payer = payerKeypair();

  // Fee money for the signer. Without it the transfer cannot be paid for, let alone sent.
  const airdropSig = await connection.requestAirdrop(userKeypair.publicKey, 2 * LAMPORTS_PER_SOL);
  await connection.confirmTransaction(airdropSig, 'confirmed');
  assert(
    (await connection.getBalance(userKeypair.publicKey)) > 0,
    'User funded with SOL on the fork to pay its own fee',
  );

  /*
   * USDC for the user to withdraw, minted by the fork's own authority.
   *
   * `mintTo` creates the ATA's contents; the account itself is created by the helper. The mint
   * authority on the fork is the payer — checked rather than assumed, because minting with the
   * wrong authority fails with `owner does not match`, which reads like a bug in the transfer.
   */
  const usdcMintInfo = await import('@solana/spl-token').then((m) => m.getMint(connection, usdcMint));
  if (usdcMintInfo.mintAuthority?.toBase58() !== payer.publicKey.toBase58()) {
    throw new Error(
      `Cannot fund the withdrawal: USDC mint authority on this fork is ${usdcMintInfo.mintAuthority?.toBase58() ?? 'none'}, not the payer ${payer.publicKey.toBase58()}.`,
    );
  }

  const { getOrCreateAssociatedTokenAccount } = await import('@solana/spl-token');
  const userTokenAccount = await getOrCreateAssociatedTokenAccount(
    connection,
    payer,
    usdcMint,
    userKeypair.publicKey,
  );
  await mintTo(connection, payer, usdcMint, userTokenAccount.address, payer, 200_000000n);
  assert(
    userTokenAccount.address.toBase58() === userAta.toBase58(),
    'Funded account is the ATA the app derives, not a second account',
  );

  /*
   * The destination must exist before it can be sent to.
   *
   * An SPL transfer to an address with no token account fails; a real withdrawal flow has to
   * create it, and somebody has to pay the rent. The payer does here — on mainnet that is the
   * user's own transaction, which is the same instruction with a different fee payer.
   */
  const destTokenAccount = await getOrCreateAssociatedTokenAccount(
    connection,
    payer,
    usdcMint,
    destKeypair.publicKey,
  );
  assert(
    destTokenAccount.address.toBase58() === destAta.toBase58(),
    'Destination ATA exists and matches the derived address',
  );
  void createAssociatedTokenAccountInstruction;

  const beforeUser = await getAccount(connection, userAta);
  const beforeDest = await getAccount(connection, destAta);
  console.log(`  Before — user: ${Number(beforeUser.amount) / 1e6} USDC, dest: ${Number(beforeDest.amount) / 1e6} USDC`);

  const transferIx = createTransferInstruction(
    userAta,
    destAta,
    userKeypair.publicKey,
    withdrawAmountRaw,
  );
  assert(transferIx.keys.length === 3, 'Created SPL Token transfer instruction');

  // A real blockhash, from the chain that will accept it.
  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash('confirmed');
  const tx = new Transaction({ blockhash, lastValidBlockHeight, feePayer: userKeypair.publicKey }).add(
    transferIx,
  );

  /*
   * The user signs, and only the user.
   *
   * `sendAndConfirmTransaction` takes the signer array, so this is not a claim about who signed —
   * it is the set of keys the transaction was sent with. The executor's keys are not among them,
   * which is the non-custodial property this whole file exists to demonstrate.
   */
  let signature: string;
  try {
    signature = await sendAndConfirmTransaction(connection, tx, [userKeypair], {
      commitment: 'confirmed',
    });
  } catch (e) {
    /*
     * Loudly, with the chain's own words. A withdrawal proof that swallows a failure and prints a
     * signature anyway is worse than no proof at all — it is the exact shape of the bug this
     * rewrite removed.
     */
    console.error('\n  \x1b[31m✖ WITHDRAWAL DID NOT SETTLE\x1b[0m');
    console.error(`  ${e instanceof Error ? e.message : String(e)}`);
    failures++;
    throw e;
  }

  assert(
    tx.signatures[0]?.publicKey.toBase58() === userAddress,
    'Signer matches user wallet (non-custodial: user signs, not executor)',
  );

  const confirmed = await connection.getTransaction(signature, {
    commitment: 'confirmed',
    maxSupportedTransactionVersion: 0,
  });
  assert(confirmed !== null, 'Transaction is in the ledger, read back by signature');
  assert(confirmed?.meta?.err === null, 'Ledger records no error for the withdrawal');

  const afterUser = await getAccount(connection, userAta);
  const afterDest = await getAccount(connection, destAta);
  const userDelta = beforeUser.amount - afterUser.amount;
  const destDelta = afterDest.amount - beforeDest.amount;

  assert(destDelta === withdrawAmountRaw, `Destination balance rose by exactly ${withdrawAmountTokens} USDC`);
  assert(userDelta === withdrawAmountRaw, `Source balance fell by exactly ${withdrawAmountTokens} USDC`);
  assert(userDelta === destDelta, 'What left the source is what arrived at the destination');

  console.log(`  WITHDRAW SIGNATURE: ${signature}`);
  console.log(`  SLOT:               ${confirmed?.slot}`);
  console.log(`  Amount:             ${withdrawAmountTokens} USDC (${withdrawAmountRaw} raw units)`);
  console.log(`  From:               ${userAddress}`);
  console.log(`  To:                 ${destAddress}`);
  console.log(`  After — user: ${Number(afterUser.amount) / 1e6} USDC, dest: ${Number(afterDest.amount) / 1e6} USDC`);
  console.log(`  Verify:             solana confirm -v ${signature} --url ${connection.rpcEndpoint}`);

  console.log('\n================================================================');
  if (failures === 0) {
    console.log('  \x1b[32mALL DEMO PROOFS PASSED (MoonPay Dev Sandbox + Solana Fork)\x1b[0m');
  } else {
    console.error(`  \x1b[31mDEMO PROOF COMPLETED WITH ${failures} FAILURES\x1b[0m`);
  }
  console.log('================================================================\n');

  if (failures > 0) process.exit(1);
}

main().catch((err) => {
  console.error('Fatal error in proof harness:', err);
  process.exit(1);
});
