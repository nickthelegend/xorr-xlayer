/**
 * Setting an agent's budget — signed by the owner, read back from the chain (2026-09-25).
 *
 * The same shape as a withdrawal (`useWithdraw.ts`): the transaction is built here, signed by the person's own wallet
 * through the grant hook's `sendTransaction`, and goes only to the delegation contract this build pins. Then the chain
 * is asked what the budget now is — the screen shows the contract's figure, never the one that was typed — and the
 * executor is told the hash, so the trail carries it. A server that does not answer does not undo a budget that landed.
 */
import { useCallback, useState } from 'react';
import type { Address, Hex } from 'viem';
import { useGrantDelegation } from '@/auth/useGrantDelegation';
import { api } from '@/data/api';
import { ApiError, errorText } from '@/data/apiError';
import { pinnedDelegation } from '@/chain';
import { chainAccess } from './chainAccess';
import { assertGrantDestination } from './delegationChain';
import { humanWalletError } from './walletError';
import { agentKey, budgetFromLogs, budgetProblem, readAgentBudget, setAgentBudgetCall } from './agentBudget';
import { receiptOf } from './receipt';

/** How long to wait for the budget to land. The fork mines at once; X Layer in a few seconds. */
const RECEIPT_TIMEOUT_MS = 60_000;

export function useAgentBudget() {
  const { sendTransaction } = useGrantDelegation();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  /**
   * Set `agentId`'s budget to `typed` dollars. Resolves with what the contract now holds for it.
   */
  const setBudget = useCallback(
    async (agentId: string, typed: string): Promise<{ txHash: Hex; budgetUsd: number }> => {
      setBusy(true);
      setError(undefined);
      try {
        const problem = budgetProblem(typed);
        if (problem) throw new Error(problem);

        // Where it goes: the contract the executor trades through, and only if it is the one this build trusts.
        const { contract } = await api.get<{ contract: Address }>('/delegation/params');
        await assertGrantDestination(chainAccess, contract, pinnedDelegation);

        const key = agentKey(agentId);
        const txHash = await sendTransaction(contract, setAgentBudgetCall(key, typed));
        const receipt = await receiptOf(chainAccess, txHash, { timeoutMs: RECEIPT_TIMEOUT_MS });
        if (receipt.status !== 'success') throw new Error('The chain refused that budget, so nothing changed.');

        // What the transaction itself set, from its log; the contract is asked only if it logged nothing for this agent.
        const budgetUsd =
          budgetFromLogs(receipt.logs, contract, receipt.from, key) ??
          (await readAgentBudget(chainAccess, contract, receipt.from, key));
        await api.post(`/agents/${agentId}/budget`, { txHash }).catch(() => undefined);
        return { txHash, budgetUsd };
      } catch (e) {
        setError(e instanceof ApiError ? errorText(e) : humanWalletError(e));
        throw e;
      } finally {
        setBusy(false);
      }
    },
    [sendTransaction],
  );

  return { setBudget, busy, error };
}
