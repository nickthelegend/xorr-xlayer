/**
 * An agent's budget is the owner's to set, on chain; the executor only records what the chain says was set (2026-09-25).
 *
 * The database, the wallet and the receipt are stood in for; the log in the receipt is a real `AgentBudgetSet` event,
 * encoded as the contract emits it, so the route decodes it exactly as it would a mined one. A budget is recorded only
 * from that event — from the delegation contract, for this wallet, under this agent's key — and each refusal says which
 * of those it was not.
 */
import { Hono } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { encodeAbiParameters, encodeEventTopics, type Hex } from 'viem';
import { agentKey } from '../evm/agentKey.js';

const OWNER = '0x5c702B0E062850551E10F4827018e2670E9183d7';
const CONTRACT = '0x141e03dbf25265491eca6b33881e9774e7735ef5';
const TX = `0x${'ab'.repeat(32)}` as Hex;

vi.mock('../auth/privy.js', () => ({
  UnauthorizedError: class extends Error {
    readonly status = 401;
  },
  verifyToken: vi.fn(),
}));
vi.mock('../db/index.js', () => ({ one: vi.fn(), query: vi.fn(), tx: vi.fn(), pool: {} }));
vi.mock('../audit/log.js', () => ({ append: vi.fn(async () => undefined) }));
vi.mock('../evm/delegation.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../evm/delegation.js')>()),
  DELEGATION_ADDRESS: '0x141e03dbf25265491eca6b33881e9774e7735ef5',
  waitForReceipt: vi.fn(),
}));
vi.mock('../routes/wallet-context.js', () => ({
  currentWallet: vi.fn(),
  requireWallet: vi.fn(),
  NoWalletError: class extends Error {},
}));

const { one } = await import('../db/index.js');
const { append } = await import('../audit/log.js');
const { currentWallet } = await import('../routes/wallet-context.js');
const { DELEGATION_ABI, waitForReceipt } = await import('../evm/delegation.js');
const { agents } = await import('./routes.js');
const { errorResponse } = await import('../http/errors.js');

const app = new Hono();
app.onError(errorResponse);
app.route('/', agents);

const record = (agentId: string, txHash: string = TX) =>
  app.request(`/agents/${agentId}/budget`, {
    method: 'POST',
    body: JSON.stringify({ txHash }),
    headers: { 'content-type': 'application/json' },
  });

/** The log `setAgentBudget` leaves, as the contract emits it. */
function budgetLog(p: { owner?: Hex; agent?: Hex; budget: bigint; address?: string }) {
  return {
    address: p.address ?? CONTRACT,
    topics: encodeEventTopics({
      abi: DELEGATION_ABI,
      eventName: 'AgentBudgetSet',
      args: { owner: p.owner ?? OWNER, agent: p.agent ?? agentKey('agent-1') },
    }),
    data: encodeAbiParameters([{ type: 'uint256' }], [p.budget]),
    blockNumber: 1n,
    transactionHash: TX,
    logIndex: 0,
    blockHash: `0x${'00'.repeat(32)}`,
    transactionIndex: 0,
    removed: false,
  };
}

const receipt = (logs: unknown[], status: 'success' | 'reverted' = 'success') =>
  ({ status, logs, blockNumber: 1n, transactionHash: TX }) as never;

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(currentWallet).mockResolvedValue({ id: 'wallet-1', address: OWNER } as never);
  vi.mocked(one).mockImplementation(async (_text: string, params?: unknown[]) =>
    params?.[0] === 'agent-1' ? ({ id: 'agent-1', name: 'Momentum Scout' } as never) : (null as never),
  );
});

describe("recording an agent's budget", () => {
  it('records the figure the transaction set, under the agent that holds it, with the transaction beside it', async () => {
    vi.mocked(waitForReceipt).mockResolvedValue(receipt([budgetLog({ budget: 40_000_000n })]));

    const res = await record('agent-1');

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ budgetUsd: 40, onChainKey: agentKey('agent-1') });
    expect(append).toHaveBeenCalledWith(
      expect.objectContaining({
        walletId: 'wallet-1',
        agent: 'Momentum Scout',
        action: 'Budget set',
        detail: expect.stringContaining('$40.00'),
        signature: TX,
        payload: { agentKey: agentKey('agent-1'), budgetUsd: 40 },
      }),
    );
  });

  it("says a budget of zero stops the agent's buys", async () => {
    vi.mocked(waitForReceipt).mockResolvedValue(receipt([budgetLog({ budget: 0n })]));

    const res = await record('agent-1');

    expect(res.status).toBe(200);
    expect(vi.mocked(append).mock.calls[0]![0].detail).toContain('refuse any buy');
  });

  it("refuses another agent's budget, and records nothing", async () => {
    vi.mocked(waitForReceipt).mockResolvedValue(receipt([budgetLog({ agent: agentKey('agent-2'), budget: 1n })]));

    const res = await record('agent-1');

    expect(res.status).toBe(422);
    expect(((await res.json()) as { error: string }).error).toBe('not_a_budget');
    expect(append).not.toHaveBeenCalled();
  });

  it("refuses another wallet's budget", async () => {
    vi.mocked(waitForReceipt).mockResolvedValue(
      receipt([budgetLog({ owner: '0x000000000000000000000000000000000000dEaD', budget: 1n })]),
    );

    expect((await record('agent-1')).status).toBe(422);
    expect(append).not.toHaveBeenCalled();
  });

  it('refuses the same event from a contract that is not the delegation', async () => {
    vi.mocked(waitForReceipt).mockResolvedValue(
      receipt([budgetLog({ address: '0x00000000000000000000000000000000000000aa', budget: 1n })]),
    );

    expect((await record('agent-1')).status).toBe(422);
    expect(append).not.toHaveBeenCalled();
  });

  it('refuses a transaction that reverted, or that the chain has never seen', async () => {
    vi.mocked(waitForReceipt).mockResolvedValueOnce(receipt([budgetLog({ budget: 1n })], 'reverted'));
    const reverted = await record('agent-1');
    expect(reverted.status).toBe(422);
    expect(((await reverted.json()) as { error: string }).error).toBe('tx_reverted');

    vi.mocked(waitForReceipt).mockResolvedValueOnce(undefined);
    const missing = await record('agent-1');
    expect(missing.status).toBe(422);
    expect(((await missing.json()) as { error: string }).error).toBe('tx_not_found');
    expect(append).not.toHaveBeenCalled();
  });

  it('answers 404 for an agent this wallet does not have, before reading any receipt', async () => {
    const res = await record('agent-9');

    expect(res.status).toBe(404);
    expect(waitForReceipt).not.toHaveBeenCalled();
  });

  it('refuses anything that is not a transaction hash', async () => {
    expect((await record('agent-1', '0xabc')).status).toBe(400);
    expect(waitForReceipt).not.toHaveBeenCalled();
  });
});
