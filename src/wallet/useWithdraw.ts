/**
 * Moving money OUT — signed by the user, never by us.
 *
 * The Send screen used to say withdrawals were not enabled because "the executor has no
 * transfer-out path". Half of that was a bug (it also claimed the executor held the key, which it
 * has never done since the Privy pivot) and half of it was the design working: an executor that
 * can move funds out is a custodian, and the whole product is an argument against being one.
 *
 * So the withdrawal is not a route to build — it is a transaction the OWNER signs with their own
 * embedded wallet, exactly like the grant. No delegation, no cap: this is the user's own money
 * leaving on their own signature, which is the one power the bot was never given.
 *
 * The allowlist and its cooling-off period are the gate, and since PLAN.md 4.9 both belong to the
 * executor. The transfer is built here, from the destination the person chose, and the executor is
 * asked immediately before a signature is requested whether that destination may receive anything
 * now — by its own clock, not this phone's, and not by the list a screen loaded a minute ago. A
 * destination that is not on the list, is still cooling off, or was removed from another device is
 * refused before anything is signed.
 */
import { useCallback, useState } from 'react';
import type { Address, Hex } from 'viem';
import { PublicKey } from '@solana/web3.js';
import { useGrantDelegation } from '@/auth/useGrantDelegation';
import { isSolana } from '@/chain';
import { isSolanaAddress, sameAddress, type AllowlistEntry } from './allowlist';
import { transferCall } from './transfer';
import { humanWalletError } from './walletError';
import { ApiError, errorText } from '@/data/apiError';
import { withdrawals } from '@/data/withdrawals';
import { getOrCreateSolanaKeypair, sendSolanaSplTransfer } from './solanaWallet';

export class NotAllowlisted extends Error {
  constructor(detail = 'That address is not on your allowlist.') {
    super(detail);
    this.name = 'NotAllowlisted';
  }
}

export class StillCoolingOff extends Error {
  constructor(
    detail = 'That address is still cooling off. It becomes usable once the period ends.',
    /** When the executor's clock lets it through, when the executor said. */
    readonly usableAt?: number,
  ) {
    super(detail);
    this.name = 'StillCoolingOff';
  }
}

export function useWithdraw() {
  const { sendTransaction } = useGrantDelegation();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [txHash, setTxHash] = useState<string>();

  /**
   * Send a token to an allowlisted destination (PLAN.md 3.11).
   *
   * @param token     The token as this chain lists it — its own address and decimals, from `/market/watchable`.
   * @param entry     The chosen destination. Must be on the list, and usable by the executor's clock.
   * @param allowlist The usable entries the screen offered.
   * @param amount    The amount as typed, in the token's own units.
   */
  const withdraw = useCallback(
    async (params: {
      token: { symbol: string; address: string; decimals: number };
      entry: AllowlistEntry | undefined;
      allowlist: AllowlistEntry[];
      amount: string;
    }) => {
      setBusy(true);
      setError(undefined);
      setTxHash(undefined);
      try {
        const { entry, allowlist, amount, token } = params;
        // Checked against the list itself, not against which card the screen had highlighted.
        if (!entry || !allowlist.some((a) => sameAddress(a.address, entry.address))) throw new NotAllowlisted();
        if (!(Number(amount) > 0)) throw new Error('Enter an amount above zero.');

        /*
         * The executor decides, now, with the signature still unrequested.
         *
         * `entry.usable` is what the executor said when the list was read, which may have been a
         * while ago on a screen left open. This is the answer at the moment it matters, and it is the
         * same check the executor applies to anything it prepares itself.
         */
        const verdict = await withdrawals.check(entry.address);
        if (verdict.status !== 'usable') {
          throw verdict.reason === 'cooling_off'
            ? new StillCoolingOff(verdict.detail, verdict.usableAt)
            : new NotAllowlisted(verdict.detail);
        }

        let hash: string;
        if (isSolanaAddress(entry.address) || isSolana) {
          const signer = await getOrCreateSolanaKeypair();
          const mint = new PublicKey(token.address);
          const destination = new PublicKey(entry.address);
          const rawAmount = BigInt(Math.round(Number(amount) * 10 ** token.decimals));
          hash = await sendSolanaSplTransfer({
            signer,
            mint,
            destination,
            amountRaw: rawAmount,
          });
        } else {
          // In the token's own decimals, from the typed string — never through a float.
          const call = transferCall(token, entry.address as Address, amount);
          hash = await sendTransaction(call.to, call.data);
        }

        setTxHash(hash);
        /*
         * Read back from the chain and written to the trail — what left, where to, and whether that
         * address was usable — with the portfolio snapshot after it (PLAN.md 2.10). Not awaited: the
         * executor waits for the transaction itself, and a record that fails is not the send failing.
         */
        void withdrawals.record(hash).catch(() => undefined);
        return hash;
      } catch (e) {
        /*
         * A refusal or an unreachable executor keeps the executor's sentence. Anything else is the
         * wallet's own failure, translated: `e.message` from viem is a multi-line dump with the useful
         * sentence buried in a `Details:` line — and on a cancelled signature it reads as an error
         * when nothing went wrong at all. `humanWalletError` is what the grant path already uses.
         */
        setError(e instanceof ApiError ? errorText(e) : humanWalletError(e));
        throw e;
      } finally {
        setBusy(false);
      }
    },
    [sendTransaction],
  );

  return { withdraw, busy, error, txHash };
}
