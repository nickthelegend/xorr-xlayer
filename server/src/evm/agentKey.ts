/**
 * An agent's key in `XorrDelegation`'s budget ledger: `keccak256("xorr-agent:" + id)`, where `id` is the agent's own id
 * (`agents.id`). The app computes the same bytes to sign `setAgentBudget` (`src/agents/agentKey.ts`); the contract never
 * learns more than that the owner budgeted something under it.
 */
import { keccak256, toBytes, type Hex } from 'viem';

export function agentKey(agentId: string): Hex {
  return keccak256(toBytes(`xorr-agent:${agentId}`));
}
