import { describe, expect, it } from 'vitest';
import { decodeFunctionData } from 'viem';
import { AGENT_BUDGET_ABI, agentKey, budgetProblem, readAgentBudget, setAgentBudgetCall } from './agentBudget';

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
});
