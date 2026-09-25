import { describe, expect, it } from 'vitest';
import { decodeFunctionData, encodeAbiParameters, encodeEventTopics, type Address, type Hex, type Log } from 'viem';
import { AGENT_BUDGET_ABI, agentKey, budgetFromLogs, budgetProblem, readAgentBudget, setAgentBudgetCall } from './agentBudget';

describe("an agent's budget", () => {
  /*
   * The executor charges a trade to the key IT derives, and the owner sets the budget under the key THIS derives. Two
   * derivations that drifted apart would give every agent a budget the executor never reads. The same fixed vector is
   * asserted on the server (`server/src/evm/agentKey.test.ts`).
   */
  it('is filed under the key the executor charges', () => {
    expect(agentKey('agent-1')).toBe('0xede9c75aa8bf4bbd6440741b4e38c9ddcde39984e5cc1080e0502a87eca6cf0a');
  });

  it('is set from the typed dollars exactly, with no float in between', () => {
    const data = setAgentBudgetCall(agentKey('agent-1'), '0.1');
    const { functionName, args } = decodeFunctionData({ abi: AGENT_BUDGET_ABI, data });
    expect(functionName).toBe('setAgentBudget');
    expect(args).toEqual([agentKey('agent-1'), 100_000n]);
    expect(decodeFunctionData({ abi: AGENT_BUDGET_ABI, data: setAgentBudgetCall(agentKey('a'), '12.34') }).args[1]).toBe(
      12_340_000n,
    );
  });

  it('takes zero, which stops the agent, and refuses what is not an amount', () => {
    expect(budgetProblem('0')).toBeUndefined();
    expect(budgetProblem('50')).toBeUndefined();
    expect(budgetProblem('12.50')).toBeUndefined();
    expect(budgetProblem('')).toMatch(/Enter an amount/);
    expect(budgetProblem('-5')).toMatch(/Enter an amount/);
    expect(budgetProblem('1.234')).toMatch(/Enter an amount/);
    expect(budgetProblem('abc')).toMatch(/Enter an amount/);
    expect(budgetProblem('1000000')).toMatch(/or less/);
  });

  it('is read back in dollars from the contract', async () => {
    const asked: unknown[] = [];
    const reader = {
      readContract: async (args: unknown) => {
        asked.push(args);
        return 25_500_000n;
      },
    };
    const owner = '0x5c702B0E062850551E10F4827018e2670E9183d7';
    const contract = '0x141e03dbf25265491eca6b33881e9774e7735ef5';
    expect(await readAgentBudget(reader, contract, owner, agentKey('agent-1'))).toBe(25.5);
    expect(asked[0]).toMatchObject({ address: contract, functionName: 'agentBudget', args: [owner, agentKey('agent-1')] });
  });

  /*
   * The card shows what the transaction set, read from its own log: asked of the chain just after, a node a block behind
   * answers with the budget from before it (2026-09-26).
   */
  it('is read from the log the transaction left, for this owner and agent only', () => {
    const owner = '0x5c702B0E062850551E10F4827018e2670E9183d7' as Address;
    const contract = '0x156DCE9E9d523775AB51f882616A431EdBfBcA22' as Address;
    const log = (agent: Hex, budget: bigint, address: Address = contract, who: Address = owner) =>
      ({
        address,
        topics: encodeEventTopics({ abi: AGENT_BUDGET_ABI, eventName: 'AgentBudgetSet', args: { owner: who, agent } }),
        data: encodeAbiParameters([{ type: 'uint256' }], [budget]),
        blockNumber: 1n,
        blockHash: `0x${'00'.repeat(32)}`,
        logIndex: 0,
        transactionHash: `0x${'ab'.repeat(32)}`,
        transactionIndex: 0,
        removed: false,
      }) as unknown as Log;

    expect(budgetFromLogs([log(agentKey('agent-1'), 50_000_000n)], contract, owner, agentKey('agent-1'))).toBe(50);
    expect(budgetFromLogs([log(agentKey('agent-2'), 50_000_000n)], contract, owner, agentKey('agent-1'))).toBeUndefined();
    const elsewhere = '0x00000000000000000000000000000000000000aa' as Address;
    expect(budgetFromLogs([log(agentKey('agent-1'), 1n, elsewhere)], contract, owner, agentKey('agent-1'))).toBeUndefined();
    expect(budgetFromLogs([], contract, owner, agentKey('agent-1'))).toBeUndefined();
  });
});
