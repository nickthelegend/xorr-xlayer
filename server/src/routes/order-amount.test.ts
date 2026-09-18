/**
 * The order route's bounds, and that the app's are the same ones.
 *
 * The app refuses a bad amount on the ticket so nobody spends a round trip on it (`src/markets/amount.ts`).
 * That is a courtesy, not a guard — the route has to hold whatever reaches it — and it is only a courtesy
 * worth having while the two agree. This imports both and puts the app's constants through the real route,
 * so a floor raised on one side and not the other fails here rather than on a user's ticket.
 */
import { Hono } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ORDER_MAX_USD as APP_MAX, ORDER_MIN_USD as APP_MIN, checkAmount } from '@/markets/amount';

vi.mock('../db/index.js', () => ({ one: vi.fn(), query: vi.fn() }));
vi.mock('../audit/log.js', () => ({ append: vi.fn(async () => undefined) }));
vi.mock('../auth/privy.js', () => ({
  UnauthorizedError: class extends Error {
    readonly status = 401;
  },
  verifyToken: vi.fn(),
}));
vi.mock('../executor/run.js', () => ({
  runStrategy: vi.fn(),
  CLOSE_ONLY_KINDS: new Set(['exit-rules']),
  EXECUTABLE_KINDS: new Set(['dca', 'momentum', 'exit-rules', 'rebalance', 'yield-rotation']),
  SELF_SIZING_KINDS: new Set(['exit-rules', 'rebalance']),
}));
vi.mock('../evm/delegation.js', () => ({ readPolicy: vi.fn() }));
vi.mock('../executor/order.js', () => ({ placeOrder: vi.fn() }));
vi.mock('../executor/swap.js', () => ({ placeSwap: vi.fn() }));
vi.mock('./wallet-context.js', () => ({
  currentWallet: vi.fn(),
  requireWallet: vi.fn(),
  NoWalletError: class extends Error {},
}));
vi.mock('../venues/stocks.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../venues/stocks.js')>()),
  equitiesFunctional: vi.fn(async () => true),
}));

const { query } = await import('../db/index.js');
const { requireWallet } = await import('./wallet-context.js');
const { placeOrder } = await import('../executor/order.js');
const { ORDER_MAX_USD, ORDER_MIN_USD, strategyRoutes } = await import('./strategies.js');
const { errorResponse } = await import('../http/errors.js');

const app = new Hono();
app.onError(errorResponse);
app.route('/', strategyRoutes);

const WALLET = { id: 'wallet-1', address: '0x95A0b368588713011a15f4b1041423f31B08e615' };

async function order(usd: unknown): Promise<number> {
  const res = await app.request('/orders', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ symbol: 'WETH', usd }),
  });
  return res.status;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(query).mockResolvedValue([]);
  vi.mocked(requireWallet).mockResolvedValue(WALLET as never);
  // Whatever gets past the schema reaches this, and a 200 is how the test knows it did.
  vi.mocked(placeOrder).mockResolvedValue({ placed: true, orderId: 'o-1', outcome: { status: 'filled' } } as never);
});

describe('the executor will not take an order it cannot settle', () => {
  it('refuses a fraction of a cent', async () => {
    // Not a smaller order: one that rounds to nothing at the venue after a real route and a real claim
    // against the period, and comes back `TF`.
    expect(await order(0.000001)).toBe(400);
    expect(await order(0.009)).toBe(400);
  });

  it('takes a cent', async () => {
    expect(await order(ORDER_MIN_USD)).toBe(200);
  });

  it('refuses above its ceiling and takes the ceiling itself', async () => {
    expect(await order(ORDER_MAX_USD + 1)).toBe(400);
    expect(await order(ORDER_MAX_USD)).toBe(200);
  });

  it('refuses zero and a negative amount', async () => {
    expect(await order(0)).toBe(400);
    expect(await order(-10)).toBe(400);
  });
});

describe('the app and the executor draw the same lines', () => {
  it('uses the same floor and ceiling', () => {
    expect(APP_MIN).toBe(ORDER_MIN_USD);
    expect(APP_MAX).toBe(ORDER_MAX_USD);
  });

  it('never refuses on the ticket something the route would have taken', async () => {
    // The direction that matters most: a client-side rule stricter than the server's is an order the
    // product could have placed and talked someone out of.
    for (const text of ['0.01', '1', '250', '12.34', String(ORDER_MAX_USD)]) {
      expect(checkAmount({ text }).state, text).toBe('ok');
      expect(await order(Number(text)), text).toBe(200);
    }
  });

  it('never lets through on the ticket something the route refuses', async () => {
    for (const text of ['0.001', String(ORDER_MAX_USD + 1)]) {
      expect(checkAmount({ text }).state, text).toBe('refused');
      expect(await order(Number(text)), text).toBe(400);
    }
  });
});
