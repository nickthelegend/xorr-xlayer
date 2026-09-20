/**
 * An order the wallet cannot pay for is refused here, in a sentence — not at the contract, in ERC20's.
 *
 * `spend()` pulls USDC from the owner, so an order for more than the owner holds can never settle. Without this guard
 * the attempt reached the delegation and came back as "The contract function \"spend\" reverted with the following
 * reason: ERC20: transfer amount exceeds balance", contract address and calldata attached — and that string is what
 * the run detail screen shows a person, verbatim and on purpose. Seen on 2026-09-20, when an agent traded a wallet
 * whose permission was live before its USDC had arrived.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.hoisted(() => {
  process.env.XORR_CHAIN = 'xlayer-fork';
  process.env.PRIVY_APP_ID = 'test';
  process.env.PRIVY_APP_SECRET = 'test';
});

const usdcRawOf = vi.fn(async (_owner: string): Promise<bigint | undefined> => 1_000_000_000n);
const runStrategy = vi.fn(async () => ({ status: 'filled' as const, runId: 'r1', signature: '0xabc', units: 1, usd: 50 }));
const one = vi.fn(async (sql: string) => (/INSERT INTO strategies/.test(sql) ? { id: 's1', wallet_id: 'w1' } : null));

vi.mock('./fill-measure.js', () => ({ usdcRawOf: (o: string) => usdcRawOf(o) }));
vi.mock('./run.js', () => ({ runStrategy: () => runStrategy() }));
vi.mock('../db/index.js', () => ({ one: (sql: string) => one(sql), query: async () => [] }));
vi.mock('../db/chain-scope.js', () => ({ THIS_CHAIN: `'xlayer-fork'` }));
vi.mock('../evm/delegation.js', () => ({
  readPolicy: async () => ({ dailyCapUsd: 100, expiresAt: Date.now() + 86_400_000, revoked: false }),
}));

const { placeOrder } = await import('./order.js');

const WALLET = { id: 'w1', address: '0x95A0b368588713011a15f4b1041423f31B08e615' } as never;

beforeEach(() => {
  usdcRawOf.mockClear();
  runStrategy.mockClear();
});

describe('an order bigger than the wallet', () => {
  it('is refused before anything is signed, naming both figures', async () => {
    usdcRawOf.mockResolvedValueOnce(12_340_000n); // $12.34
    const res = await placeOrder(WALLET, 'TSLAx', 50, 'test');
    expect(res.placed).toBe(false);
    expect(res.placed === false && res.refusal).toEqual({
      status: 'blocked',
      reason: 'insufficient_funds',
      detail: 'This wallet holds $12.34 of USDC, and the order needs $50.00. Add funds, or place a smaller order.',
    });
    expect(runStrategy).not.toHaveBeenCalled();
  });

  it('lets an order the wallet can cover through', async () => {
    usdcRawOf.mockResolvedValueOnce(50_000_000n); // exactly $50
    const res = await placeOrder(WALLET, 'TSLAx', 50, 'test');
    expect(res.placed).toBe(true);
    expect(runStrategy).toHaveBeenCalled();
  });

  it('does not refuse on an unreadable balance — that is an outage, and the contract still decides', async () => {
    usdcRawOf.mockResolvedValueOnce(undefined);
    const res = await placeOrder(WALLET, 'TSLAx', 50, 'test');
    expect(res.placed).toBe(true);
  });
});
