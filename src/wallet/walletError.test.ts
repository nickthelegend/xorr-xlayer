/**
 * viem's error text was going straight onto the screen.
 *
 * Pulling the kill switch on a fork build put this under "Stop all agents", off the bottom of a
 * scroll area: five lines, one of which says anything, and the other four publishing the RPC
 * endpoint, the Privy app id and the whole signed transaction into the user interface.
 */
import { describe, expect, it } from 'vitest';
import { humanWalletError } from './walletError';

/** Verbatim from the simulator, shortened only in the hex blob. */
const VIEM_DUMP = `Transaction creation failed.

URL: https://base-mainnet.rpc.privy.systems/?privyAppId=cmtoq4h2o00nd0dg6r64i0od
Request body: {"method":"eth_sendRawTransaction","params":["0x02f8b28221058083df424083c96a8083682194abe6f2bbe7471c4976128f0dc13a7f83499e9a23"]}

Details: insufficient funds for gas * price + value: have 0 want 351872400000
Version: viem@2.56.3`;

describe('a wallet failure reads as a sentence, not a request log', () => {
  it('says what went wrong and nothing about the transport', () => {
    const message = humanWalletError(new Error(VIEM_DUMP));
    expect(message).toBe(
      'Your wallet has no ETH to pay the network fee, so the transaction was not sent.',
    );
  });

  it('never leaks the endpoint, the app id or the signed transaction', () => {
    const message = humanWalletError(new Error(VIEM_DUMP));
    expect(message).not.toContain('rpc.privy.systems');
    expect(message).not.toContain('privyAppId');
    expect(message).not.toContain('eth_sendRawTransaction');
    expect(message).not.toContain('0x02f8');
    expect(message).not.toContain('viem@');
  });

  it('a cancelled signature is not a fault', () => {
    expect(humanWalletError(new Error('User rejected the request.'))).toBe(
      'You cancelled the signature, so nothing changed.',
    );
  });

  it('keeps the node’s own reason when there is no better sentence', () => {
    const message = humanWalletError(
      new Error('Something failed.\n\nDetails: execution reverted: NotDelegate\nVersion: viem@2.56.3'),
    );
    expect(message).toBe('execution reverted: NotDelegate');
  });

  it('does not replace an unrecognised message with a generic apology', () => {
    expect(humanWalletError(new Error('Chain 8453 is not configured.'))).toBe(
      'Chain 8453 is not configured.',
    );
  });

  it('caps a runaway single line rather than filling the screen', () => {
    expect(humanWalletError(new Error('x'.repeat(500))).length).toBeLessThanOrEqual(200);
  });
});
