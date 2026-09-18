/**
 * A business treasury's transactions, signed by Privy under the deployment's policy (PLAN.md 4.14).
 *
 * The treasury is a Privy wallet the key quorum owns, with the deployment's policy attached. The executor asks it to
 * sign; Privy decides, against the rules and before any signature exists, whether it may. There are two roads to a chain:
 *
 *   - where Privy knows the chain (Base Sepolia), `eth_sendTransaction`: Privy signs and broadcasts;
 *   - on a fork of Base, which Privy would take for Base itself, `eth_signTransaction` with the fork's own nonce, gas
 *     and fees, and the executor sends the bytes to the fork once they are shown to be the transaction it asked for,
 *     signed by the treasury. The app does the same for an embedded wallet on a fork build (`src/wallet/userSigning.ts`).
 *
 * Never where money is real. A treasury is a test-network wallet in this product, and nothing here should be able to
 * move real funds because a business was set up.
 */
import {
  isAddressEqual,
  parseTransaction,
  recoverTransactionAddress,
  toHex,
  type Address,
  type Hex,
  type TransactionSerialized,
} from 'viem';
import { rpcAsWallet } from '../auth/privyPolicy.js';
import { publicClient } from '../evm/client.js';
import { CHAIN_KEY, chain } from '../evm/chains.js';
import { moneyOn } from '../evm/money.js';
import { waitForTx } from '../evm/delegation.js';
import { markBroadcast } from '../http/request-id.js';

/** Privy refused the call under the policy: the second lock doing its job, not a failure to report as one. */
export class TreasuryRefused extends Error {
  constructor(detail: string) {
    super(detail);
    this.name = 'TreasuryRefused';
  }
}

export type TreasuryCall = { privyWalletId: string; from: Address; to: Address; data: Hex };

/** A quarter over the estimate: it is made against this block and the transaction runs against a later one. */
const withHeadroom = (gas: bigint) => (gas * 125n) / 100n;

/** Whether Privy puts the transaction on the chain itself. A fork, local or hosted, is not a chain Privy can reach. */
export function privyBroadcasts(): boolean {
  return moneyOn(CHAIN_KEY) === 'test';
}

/** Send one call as the treasury and wait for it to land. Returns the transaction hash and who broadcast it. */
export async function transactAsTreasury(call: TreasuryCall): Promise<{ hash: Hex; broadcastBy: 'privy' | 'executor' }> {
  if (moneyOn(CHAIN_KEY) === 'real') {
    throw new Error(`A business treasury does not transact on ${CHAIN_KEY}, where the money is real.`);
  }
  try {
    if (privyBroadcasts()) {
      await markBroadcast();
      const res = (await rpcAsWallet(call.privyWalletId, {
        method: 'eth_sendTransaction',
        caip2: `eip155:${chain.id}`,
        params: { transaction: { to: call.to, data: call.data, value: '0x0', chain_id: chain.id } },
      })) as { data?: { hash?: string } };
      const hash = res.data?.hash;
      if (!hash) throw new Error('Privy answered without a transaction hash.');
      return { hash: await confirmed(hash as Hex), broadcastBy: 'privy' };
    }

    // Everything the signature commits to, read from the chain the transaction will actually run on.
    const [nonce, gas, fees] = await Promise.all([
      publicClient.getTransactionCount({ address: call.from, blockTag: 'pending' }),
      publicClient.estimateGas({ account: call.from, to: call.to, data: call.data }),
      publicClient.estimateFeesPerGas(),
    ]);
    const res = (await rpcAsWallet(call.privyWalletId, {
      method: 'eth_signTransaction',
      params: {
        transaction: {
          to: call.to,
          data: call.data,
          value: '0x0',
          chain_id: chain.id,
          nonce,
          gas_limit: toHex(withHeadroom(gas)),
          max_fee_per_gas: toHex(fees.maxFeePerGas),
          max_priority_fee_per_gas: toHex(fees.maxPriorityFeePerGas),
          type: 2,
        },
      },
    })) as { data?: { signed_transaction?: string } };
    const raw = res.data?.signed_transaction;
    if (!raw) throw new Error('Privy answered without a signed transaction.');
    await assertSignedAsAsked(raw as TransactionSerialized, { ...call, chainId: chain.id, nonce });
    await markBroadcast();
    const hash = await publicClient.sendRawTransaction({ serializedTransaction: raw as TransactionSerialized });
    return { hash: await confirmed(hash), broadcastBy: 'executor' };
  } catch (e) {
    const detail = e instanceof Error ? e.message : String(e);
    if (e instanceof TreasuryRefused) throw e;
    if (/policy violation/i.test(detail)) throw new TreasuryRefused(detail);
    throw e;
  }
}

/** A transaction that did not land is not a step taken. */
async function confirmed(hash: Hex): Promise<Hex> {
  const ok = await waitForTx(hash, 60_000);
  if (ok === false) throw new Error(`${hash} reverted.`);
  if (ok === undefined) throw new Error(`${hash} did not confirm in time.`);
  return hash;
}

/**
 * Bytes are sent only when they are the call that was asked for, signed by the treasury.
 *
 * Privy is trusted to sign; it is not trusted to have signed the right thing. A different destination, calldata, value,
 * chain or nonce — or a signature by any other key — is refused here, before anything reaches the chain.
 */
async function assertSignedAsAsked(
  raw: TransactionSerialized,
  asked: TreasuryCall & { chainId: number; nonce: number },
): Promise<void> {
  const tx = parseTransaction(raw);
  const signer = await recoverTransactionAddress({ serializedTransaction: raw as never });
  const problems = [
    tx.chainId !== asked.chainId ? `for chain ${tx.chainId}` : null,
    tx.nonce !== asked.nonce ? `with nonce ${tx.nonce}` : null,
    !tx.to || !isAddressEqual(tx.to, asked.to) ? 'to another address' : null,
    (tx.data ?? '0x').toLowerCase() !== asked.data.toLowerCase() ? 'with other calldata' : null,
    (tx.value ?? 0n) !== 0n ? 'with value attached' : null,
    !isAddressEqual(signer, asked.from) ? `by ${signer}` : null,
  ].filter((p): p is string => p !== null);
  if (problems.length > 0) {
    throw new Error(`Privy signed a different transaction (${problems.join('; ')}), so it was not sent.`);
  }
}
