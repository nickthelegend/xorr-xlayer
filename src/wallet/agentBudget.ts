/**
 * Each agent's own budget, held by the delegation contract (2026-09-25).
 *
 * The permission a person grants caps what the bot may spend in a day, in total. Inside it, every agent they hired or
 * made has a budget of its own on the contract: the agent's buys are charged to it, its sales are credited back, and a
 * trade past it reverts on chain whatever the executor asks. The OWNER sets it, with their own wallet — the bot key
 * cannot, because `setAgentBudget` sets the budget of whoever sends it.
 *
 * The key an agent's budget is filed under is `keccak256("xorr-agent:" + agent id)`: the executor derives it the same
 * way (`server/src/evm/agentKey.ts`), and the fixed vector in the test holds the two to one answer.
 */
import { encodeFunctionData, isAddressEqual, keccak256, parseEventLogs, parseUnits, toBytes, type Address, type Hex, type Log } from 'viem';

export const AGENT_BUDGET_ABI = [
  {
    type: 'function',
    name: 'setAgentBudget',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'agent', type: 'bytes32' },
      { name: 'budget', type: 'uint256' },
    ],
    outputs: [],
  },
  {
    type: 'function',
    name: 'agentBudget',
    stateMutability: 'view',
    inputs: [
      { name: 'owner', type: 'address' },
      { name: 'agent', type: 'bytes32' },
    ],
    outputs: [{ name: '', type: 'uint256' }],
  },
  {
    type: 'event',
    name: 'AgentBudgetSet',
    inputs: [
      { name: 'owner', type: 'address', indexed: true },
      { name: 'agent', type: 'bytes32', indexed: true },
      { name: 'budget', type: 'uint256', indexed: false },
    ],
  },
] as const;

/** The settlement token's decimals: a budget is counted in it, as the daily cap is. */
const USD_DECIMALS = 6;

/** The key the contract files `agentId`'s budget under. */
export function agentKey(agentId: string): Hex {
  return keccak256(toBytes(`xorr-agent:${agentId}`));
}

/** The largest budget the screen takes: a typo of three extra zeros should not be one tap from signing. */
export const MAX_AGENT_BUDGET_USD = 100_000;

/** Why `typed` is not a budget, or undefined when it is one. Zero is one: it stops the agent. */
export function budgetProblem(typed: string): string | undefined {
  const t = typed.trim();
  if (!/^\d+(\.\d{0,2})?$/.test(t)) return 'Enter an amount in dollars, like 50 or 12.50.';
  if (Number(t) > MAX_AGENT_BUDGET_USD) return `Keep it to $${MAX_AGENT_BUDGET_USD.toLocaleString('en-US')} or less.`;
  return undefined;
}

/** The call that sets `agent`'s budget to `usd` — sent by the owner, to the delegation contract. */
export function setAgentBudgetCall(agent: Hex, usd: string): Hex {
  return encodeFunctionData({
    abi: AGENT_BUDGET_ABI,
    functionName: 'setAgentBudget',
    // From the typed string, never through a float: "0.1" is exactly 100000 units.
    args: [agent, parseUnits(usd.trim(), USD_DECIMALS)],
  });
}

/** The reads this needs, from the chain the build settles on. */
export type BudgetReader = {
  readContract(args: {
    address: Address;
    abi: typeof AGENT_BUDGET_ABI;
    functionName: 'agentBudget';
    args: readonly [Address, Hex];
  }): Promise<bigint>;
};

/** What `owner` has left of `agent`'s budget, in dollars, as the contract holds it. */
export async function readAgentBudget(reader: BudgetReader, contract: Address, owner: Address, agent: Hex): Promise<number> {
  const raw = await reader.readContract({
    address: contract,
    abi: AGENT_BUDGET_ABI,
    functionName: 'agentBudget',
    args: [owner, agent],
  });
  return Number(raw) / 10 ** USD_DECIMALS;
}

/**
 * The budget a mined `setAgentBudget` set for `agent`, from the transaction's own log (2026-09-26) — or undefined when
 * the delegation logged none for this owner and agent.
 *
 * Read from the receipt rather than asked of the chain afterwards: a node a block behind the one that returned the
 * receipt still holds the old figure, and the card would have printed it as the one just set.
 */
export function budgetFromLogs(logs: readonly Log[], contract: Address, owner: Address, agent: Hex): number | undefined {
  const set = parseEventLogs({ abi: AGENT_BUDGET_ABI, eventName: 'AgentBudgetSet', logs: [...logs] }).filter(
    (l) =>
      isAddressEqual(l.address, contract) &&
      isAddressEqual(l.args.owner, owner) &&
      l.args.agent.toLowerCase() === agent.toLowerCase(),
  );
  const last = set.at(-1);
  return last ? Number(last.args.budget) / 10 ** USD_DECIMALS : undefined;
}
