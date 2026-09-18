/**
 * What a wallet failure actually means, in one sentence a person can act on.
 *
 * viem's errors are written for a developer at a terminal, and they were going straight to the
 * screen. Pulling the kill switch on a fork build put this under "Stop all agents":
 *
 *   Transaction creation failed.
 *   URL: https://base-mainnet.rpc.privy.systems/?privyAppId=cmtoq4h2o00nd0dg6r64i0od
 *   Request body: {"method":"eth_sendRawTransaction","params":["0x02f8…2000 hex characters…"]}
 *   Details: insufficient funds for gas * price + value: have 0 want 351872400000
 *   Version: viem@2.56.3
 *
 * Five lines, one of which says anything, and the other four publish the RPC endpoint, the Privy
 * app id and the entire signed transaction into the user interface. The reason is in there —
 * `Details:` — and everything around it is noise at best.
 *
 * So: keep the `Details:` line when viem gives one, map the handful of causes that have a better
 * sentence than viem's, and never render the request. Anything unrecognised keeps its first line,
 * which is short and at least true, rather than being replaced by a generic apology.
 */

/** viem prints `Details: <reason>` for the node's own message. That line is the useful one. */
function detailLine(message: string): string | undefined {
  const match = /^Details:\s*(.+)$/m.exec(message);
  return match?.[1]?.trim() || undefined;
}

export function humanWalletError(e: unknown): string {
  const raw = e instanceof Error ? e.message : String(e);
  const detail = detailLine(raw) ?? raw;

  // The user closed the sheet. Not a fault, and it must not read as one.
  if (/user rejected|denied transaction|request rejected/i.test(raw)) {
    return 'You cancelled the signature, so nothing changed.';
  }
  /*
   * The wallet has no ETH for the network fee on the chain the transaction goes to. On a fork build
   * that used to be real Base whatever the screen showed — Privy sent there — and "have 0" was the
   * truth about a chain the user was not looking at. A fork build now signs and the app sends to the
   * fork (`walletSignsOnly` in src/chain.ts), so this is the fork wallet's own balance, which the
   * faucet tops up.
   */
  if (/insufficient funds/i.test(raw)) {
    return 'Your wallet has no ETH to pay the network fee, so the transaction was not sent.';
  }
  if (/nonce too low|already known|replacement transaction underpriced/i.test(raw)) {
    return 'A transaction from this wallet is already in flight. Wait for it to settle, then try again.';
  }
  if (/timed out|timeout/i.test(raw)) {
    return 'The network did not answer in time. Nothing was sent.';
  }

  // Unrecognised: the first line only. Never the URL, the request body or the viem version.
  const firstLine = detail.split('\n')[0]!.trim();
  return firstLine.length > 200 ? `${firstLine.slice(0, 197)}…` : firstLine;
}
