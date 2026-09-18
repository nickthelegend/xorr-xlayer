/**
 * "Withdraw everything", wired to the executor and to the owner's own wallet (PLAN.md 4.9).
 *
 * The order, the checks on what gets signed and where it stops are `withdrawEverything.ts`. This holds
 * each step's state for the screen and hands the sequence the real calls: the executor's routes, and
 * the same `sendTransaction` the grant and a single send are signed with.
 */
import { useCallback, useState } from 'react';
import type { Address } from 'viem';
import { useAuth } from '@/auth/useAuth';
import { useGrantDelegation } from '@/auth/useGrantDelegation';
import { withdrawals } from '@/data/withdrawals';
import { useIntentKeys } from '@/data/useIntentKeys';
import { initialSteps, withdrawEverything, type Step } from './withdrawEverything';

export function useWithdrawEverything() {
  const { sendTransaction } = useGrantDelegation();
  // The address the wallet itself reports, which is what every call it signs has to pay back to.
  const { address } = useAuth();
  const [steps, setSteps] = useState<Step[]>(initialSteps);
  const [running, setRunning] = useState(false);
  /** Undefined until a run has ended; then whether all three steps finished. */
  const [finished, setFinished] = useState<boolean>();
  /*
   * One key per position sold. Each close went out with none, so a run stopped by a timeout and started again could sell
   * a position the first run had already sold. A close whose outcome is unknown now keeps its key, and the second run's
   * close of that position is answered with the first one's.
   */
  const keys = useIntentKeys();

  const run = useCallback(
    async (destination: { address: string; label: string }) => {
      if (!address) throw new Error('No wallet yet. Finish sign-in first.');
      setRunning(true);
      setFinished(undefined);
      setSteps(initialSteps());
      try {
        const out = await withdrawEverything(
          {
            owner: address as Address,
            destination,
            sellPreview: withdrawals.sellPreview,
            close: (symbol) =>
              keys.send(['withdraw-everything', 'close', symbol], (idempotencyKey) =>
                withdrawals.close(symbol, { idempotencyKey }),
              ),
            aavePosition: withdrawals.aavePosition,
            aaveWithdrawCall: withdrawals.aaveWithdrawCall,
            prepareAll: withdrawals.prepareAll,
            sign: sendTransaction,
            record: withdrawals.record,
          },
          setSteps,
        );
        setFinished(out.ok);
        return out;
      } finally {
        setRunning(false);
      }
    },
    [address, sendTransaction, keys],
  );

  return { steps, running, finished, run };
}
