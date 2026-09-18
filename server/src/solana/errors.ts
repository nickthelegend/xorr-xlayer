/**
 * Human-readable error translation for Solana and SPL Token errors (PLAN.md §8.3).
 *
 * Converts RPC, simulation, blockhash, and SPL custom program errors into
 * deterministic, actionable user-facing messages.
 */

export function humanFailure(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err ?? 'Unknown error');

  // SPL Token / Token-2022 delegation and allowance limits
  if (
    msg.includes('custom program error: 0x1') ||
    msg.includes('insufficient funds') ||
    msg.includes('insufficient balance') ||
    msg.includes('insufficient allowance') ||
    msg.includes('InsufficientDelegatedAmount') ||
    msg.includes('over-cap')
  ) {
    return 'The spending approval is too small or was withdrawn, so nothing could be pulled.';
  }

  // Invalid or unauthorized delegate
  if (
    msg.includes('custom program error: 0x6') ||
    msg.includes('InvalidDelegate') ||
    msg.includes('OwnerDoesNotMatch')
  ) {
    return 'That agent is not the one you gave permission to.';
  }

  // Revocation
  if (msg.includes('PolicyRevoked') || msg.includes('revoked')) {
    return 'Trading permission was revoked on-chain. Nothing was placed.';
  }

  // Unfunded account / prior credit
  if (
    msg.includes('Attempt to debit an account but found no record of a prior credit') ||
    msg.includes('account not found')
  ) {
    return 'The account has no balance on this chain.';
  }

  // Fee payer short on SOL
  if (
    msg.includes('insufficient lamports') ||
    msg.includes('insufficient funds for rent') ||
    msg.includes('account is not rent exempt')
  ) {
    return 'Not enough SOL to pay the transaction fee or rent exemption.';
  }

  // Blockhash / expiration
  if (msg.includes('blockhash not found') || msg.includes('BlockhashNotFound')) {
    return 'Transaction expired while waiting for network confirmation. Try again.';
  }

  // Signer mismatch
  if (
    msg.includes('unknown signer') ||
    msg.includes('signature verification failure') ||
    msg.includes('SignatureVerification')
  ) {
    return 'Signature verification failed.';
  }

  // Slippage
  if (msg.includes('SlippageToleranceExceeded') || msg.includes('slippage limit')) {
    return 'The price moved more than your slippage limit while this was in flight. Nothing was placed.';
  }

  // Token-2022 extensions: Pausable / Mint Paused
  if (
    msg.includes('MintPaused') ||
    msg.includes('AccountPaused') ||
    msg.includes('mint is paused') ||
    msg.includes('account is paused')
  ) {
    return 'This stock token is currently paused by the issuer.';
  }

  // Token-2022 extensions: Transfer Hook / Eligibility
  if (
    msg.includes('TransferHook') ||
    msg.includes('Transfer hook') ||
    msg.includes('eligibility') ||
    msg.includes('blocked by transfer hook')
  ) {
    return 'Transfer blocked by stock token eligibility or transfer hook rule.';
  }

  // Token-2022 extensions: Permanent Delegate / Unauthorized
  if (msg.includes('PermanentDelegate')) {
    return 'Action overridden or restricted by token permanent delegate.';
  }

  // Congestion
  if (msg.includes('Transaction simulation failed: Error processing instruction')) {
    return 'Network simulation failed. The trade could not be completed.';
  }

  return msg;
}
