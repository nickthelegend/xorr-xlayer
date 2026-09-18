/**
 * A swap, placed now (PLAN.md 3.9) — with the chain, the venues and the database stood in for.
 *
 * `placeSwap` refuses what can never settle before it reads anything; places a USDC swap as a one-shot order with the
 * tolerance the person chose; and converts any other holding through `closePosition()` — exactly the units typed, into
 * the token asked for, measured, recorded on both sides and written to the trail — recording nothing for a
 * transaction that did not confirm.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { WalletRow } from '../routes/wallet-context.js';

const h = vi.hoisted(() => ({
  canSettle: true,
  USDC: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
  WETH: '0x4200000000000000000000000000000000000006',
  CBBTC: '0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf',
  NVDAC: '0x0000000000000000000000000000000000000da1',
  DELEGATION: '0x6c5528Fd8E74a047A85bAb413856A9239E73540e',
  ROUTER: '0x111111125421cA6dc452d289314280a0f8842A65',
}));

vi.mock('../venues/oneinch.js', () => ({
  get CAN_SETTLE() {
    return h.canSettle;
  },
  SETTLEMENT_SYMBOL: 'USDC',
  TOKENS: {
    ETH: { address: '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE', decimals: 18 },
    USDC: { address: h.USDC, decimals: 6 },
    WETH: { address: h.WETH, decimals: 18 },
    CBBTC: { address: h.CBBTC, decimals: 8 },
    NVDAc: { address: h.NVDAC, decimals: 18 },
  },
  canonicalSymbol: (s: string) => (s.toLowerCase() === 'nvdac' ? 'NVDAc' : s.toUpperCase()),
}));
vi.mock('../venues/stocks.js', () => ({ isStock: (s: string) => s === 'NVDAc', equitiesFunctional: vi.fn(async () => false) }));
vi.mock('../evm/chains.js', () => ({ CHAIN_KEY: 'xlayer-fork', explorerTx: (hash: string) => `fork:${hash}` }));
vi.mock('../evm/delegation.js', () => ({
  readPolicy: vi.fn(),
  closeAsDelegate: vi.fn(),
  waitForTx: vi.fn(),
  DELEGATION_ADDRESS: h.DELEGATION,
}));
vi.mock('../market/prices.js', () => ({ priceOf: vi.fn() }));
vi.mock('../positions/index.js', () => ({ applyFill: vi.fn(async () => undefined) }));
vi.mock('../portfolio/snapshots.js', () => ({ snapshotWallet: vi.fn(async () => true) }));
vi.mock('../routes/panic.js', () => ({ DUST_USD: 1, recordSale: vi.fn(async () => 'run-9') }));
vi.mock('../audit/log.js', () => ({ append: vi.fn(async () => undefined) }));
vi.mock('../db/index.js', () => ({ tx: async (fn: (c: unknown) => Promise<unknown>) => fn({ client: true }), one: vi.fn() }));
vi.mock('./settle.js', () => ({ chooseSettlement: vi.fn() }));
vi.mock('./fill-measure.js', () => ({ rawBalanceOf: vi.fn(), measuredDelta: vi.fn(), usdcRawOf: vi.fn(), proceedsSince: vi.fn() }));
vi.mock('./failure.js', () => ({
  humanFailure: (raw: string) => `In words: ${raw}`,
  httpStatusFor: (o: { status: string }) => (o.status === 'blocked' ? 409 : 502),
}));
vi.mock('./order.js', () => ({ placeOrder: vi.fn() }));

const { one } = await import('../db/index.js');
const { append } = await import('../audit/log.js');
const { readPolicy, closeAsDelegate, waitForTx } = await import('../evm/delegation.js');
const { priceOf } = await import('../market/prices.js');
const { applyFill } = await import('../positions/index.js');

/** A swap a person asked for, as `swap.ts` attributes it. */
const SWAP = { source: 'manual', id: null, label: 'Swap' } as const;
const { recordSale } = await import('../routes/panic.js');
const { equitiesFunctional } = await import('../venues/stocks.js');
const { chooseSettlement } = await import('./settle.js');
const { rawBalanceOf, measuredDelta, usdcRawOf, proceedsSince } = await import('./fill-measure.js');
const { placeOrder } = await import('./order.js');
const { placeSwap } = await import('./swap.js');

const OWNER = '0x95A0b368588713011a15f4b1041423f31B08e615';
const wallet = { id: 'wallet-1', address: OWNER } as unknown as WalletRow;
const ONE_WETH = 1_000_000_000_000_000_000n;

/** The aggregator's route for WETH → cbBTC, held to 0.0039 cbBTC. */
const INTO_CBBTC = {
  payToken: { address: h.WETH, decimals: 18 },
  swap: { to: h.ROUTER, data: '0x1111' },
  venue: '1inch',
  floor: { tokenOut: h.CBBTC, minOut: 390_000n },
};

const nothingSent = () => {
  expect(placeOrder).not.toHaveBeenCalled();
  expect(chooseSettlement).not.toHaveBeenCalled();
  expect(closeAsDelegate).not.toHaveBeenCalled();
  expect(applyFill).not.toHaveBeenCalled();
};

beforeEach(() => {
  h.canSettle = true;
  vi.clearAllMocks();
  vi.mocked(readPolicy).mockResolvedValue({ revoked: false, expiresAt: Date.now() + 86_400_000 } as never);
  vi.mocked(priceOf).mockImplementation(async (s: string) => ({ WETH: 2_500, CBBTC: 100_000 })[s as 'WETH']);
  vi.mocked(rawBalanceOf).mockImplementation(async (_owner, symbol) => (symbol === 'WETH' ? ONE_WETH : 0n));
  vi.mocked(chooseSettlement).mockResolvedValue(INTO_CBBTC as never);
  vi.mocked(closeAsDelegate).mockResolvedValue('0xsig');
  vi.mocked(waitForTx).mockResolvedValue(true);
  vi.mocked(measuredDelta).mockResolvedValue(0.004);
  vi.mocked(usdcRawOf).mockResolvedValue(7n);
  vi.mocked(proceedsSince).mockResolvedValue(499.2);
});

describe('refused before anything is read', () => {
  it('where nothing settles, places nothing', async () => {
    h.canSettle = false;
    const r = await placeSwap(wallet, { from: 'USDC', to: 'WETH', amount: '20' });
    expect(r).toMatchObject({ status: 409, body: { status: 'blocked', reason: 'not_settleable_here' } });
    expect(readPolicy).not.toHaveBeenCalled();
    nothingSent();
  });

  it('a token this executor does not trade', async () => {
    const r = await placeSwap(wallet, { from: 'USDC', to: 'DOGE', amount: '20' });
    expect(r).toMatchObject({ status: 409, body: { reason: 'not_tradable', detail: 'DOGE is not a token this executor trades.' } });
    nothingSent();
  });

  it('the same token on both sides — native ETH being WETH, as a buy already takes it', async () => {
    const r = await placeSwap(wallet, { from: 'ETH', to: 'weth', amount: '1' });
    expect(r).toMatchObject({ status: 409, body: { reason: 'same_token' } });
    nothingSent();
  });

  it('an equity where equities do not function', async () => {
    const r = await placeSwap(wallet, { from: 'USDC', to: 'nvdac', amount: '20' });
    expect(r).toMatchObject({ status: 409, body: { reason: 'not_settleable_here' } });
    expect(equitiesFunctional).toHaveBeenCalled();
    nothingSent();
  });
});

describe('paying USDC is a one-shot buy', () => {
  it('places the order with the tolerance chosen, and reports where it settled', async () => {
    vi.mocked(placeOrder).mockResolvedValue({
      placed: true,
      orderId: 'strategy-1',
      outcome: { status: 'filled', runId: 'run-1', signature: '0xabc', units: 0.008, price: 2_500 },
    });
    vi.mocked(one).mockResolvedValue({ venue: 'swapvm' });

    const r = await placeSwap(wallet, { from: 'usdc', to: 'WETH', amount: '20', slippagePct: 0.5 });

    expect(placeOrder).toHaveBeenCalledWith(wallet, 'WETH', 20, 'Swap 20 USDC for WETH', { slippagePct: 0.5 });
    expect(one).toHaveBeenCalledWith(expect.stringContaining('FROM strategy_runs'), ['run-1']);
    expect(r).toEqual({
      status: 200,
      body: { status: 'filled', from: 'USDC', to: 'WETH', sold: 20, received: 0.008, usd: 20, venue: 'swapvm', txHash: '0xabc' },
    });
    expect(closeAsDelegate).not.toHaveBeenCalled();
  });

  it('sends no tolerance when none was chosen, so the executor uses its own', async () => {
    vi.mocked(placeOrder).mockResolvedValue({
      placed: true,
      orderId: 'strategy-1',
      outcome: { status: 'filled', runId: 'run-1', signature: '0xabc', units: 0.008, price: 2_500 },
    });
    vi.mocked(one).mockResolvedValue({ venue: '1inch' });

    await placeSwap(wallet, { from: 'USDC', to: 'WETH', amount: '20' });
    expect(vi.mocked(placeOrder).mock.calls[0]![4]).toEqual({});
  });

  it('answers a refusal before the run with its reason, and a run the rules block the same way', async () => {
    const refusal = { status: 'blocked' as const, reason: 'no_delegation', detail: 'No active trading permission on-chain.' };
    vi.mocked(placeOrder).mockResolvedValueOnce({ placed: false, refusal });
    expect(await placeSwap(wallet, { from: 'USDC', to: 'WETH', amount: '20' })).toEqual({ status: 409, body: refusal });

    const outcome = { status: 'blocked' as const, runId: 'run-2', reason: 'daily_cap', detail: 'The daily cap is spent.' };
    vi.mocked(placeOrder).mockResolvedValueOnce({ placed: true, orderId: 'strategy-2', outcome });
    expect(await placeSwap(wallet, { from: 'USDC', to: 'WETH', amount: '20' })).toEqual({ status: 409, body: outcome });
  });
});

describe('paying anything else converts the holding through closePosition()', () => {
  it('sells exactly the units typed into the token asked for, measures what arrived, and records both sides', async () => {
    const r = await placeSwap(wallet, { from: 'WETH', to: 'CBBTC', amount: '0.2', slippagePct: 0.5 });

    expect(chooseSettlement).toHaveBeenCalledWith({
      intent: {
        inSymbol: 'WETH',
        outSymbol: 'CBBTC',
        amountIn: 0.2,
        amountInRaw: 200_000_000_000_000_000n,
        usd: 500,
        because: 'Swap placed by you.',
        slippagePct: 0.5,
      },
      owner: OWNER,
      preferred: undefined,
      isClose: true,
      delegationFrom: h.DELEGATION,
      // The same call and raw amount as the close below, so a fork measures the route it will run (PLAN.md X77).
      send: { via: 'closePosition', amount: 200_000_000_000_000_000n },
    });
    expect(closeAsDelegate).toHaveBeenCalledWith({
      owner: OWNER,
      token: h.WETH,
      venue: h.ROUTER,
      amount: 200_000_000_000_000_000n,
      data: '0x1111',
      tokenOut: h.CBBTC,
      minOut: 390_000n,
    });
    // cbBTC read before the transaction, so the delta afterwards is the fill and nothing else.
    expect(measuredDelta).toHaveBeenCalledWith({ owner: OWNER, symbol: 'CBBTC', before: 0n });
    expect(vi.mocked(applyFill).mock.calls.map((c) => c[1])).toEqual([
      // Both legs attributed to the swap, so neither lands in the book as nobody's.
      { walletId: 'wallet-1', symbol: 'WETH', units: -0.2, usd: -400, attribution: SWAP },
      { walletId: 'wallet-1', symbol: 'CBBTC', units: 0.004, usd: 400, attribution: SWAP },
    ]);
    expect(recordSale).toHaveBeenCalledWith(
      { client: true },
      {
        walletId: 'wallet-1',
        symbol: 'WETH',
        label: 'Swapped 0.2 WETH for 0.004 CBBTC',
        units: 0.2,
        proceedsUsd: 400,
        quotedUsd: 500,
        signature: '0xsig',
        kind: 'swap',
        venue: '1inch',
      },
    );
    expect(vi.mocked(append).mock.calls[0]![0]).toMatchObject({
      walletId: 'wallet-1',
      agent: 'You',
      action: 'Swapped 0.2 WETH for 0.004 CBBTC',
      kind: 'trade',
      signature: '0xsig',
      payload: { runId: 'run-9', venue: '1inch', measured: true, explorer: 'fork:0xsig' },
    });
    expect(r).toEqual({
      status: 200,
      body: { status: 'filled', from: 'WETH', to: 'CBBTC', sold: 0.2, received: 0.004, usd: 400, venue: '1inch', measured: true, txHash: '0xsig' },
    });
  });

  it('parses the typed decimal exactly — 0.1 WETH is 10^17 wei, not the float of it', async () => {
    await placeSwap(wallet, { from: 'WETH', to: 'CBBTC', amount: '0.1' });
    expect(vi.mocked(closeAsDelegate).mock.calls[0]![0].amount).toBe(100_000_000_000_000_000n);
  });

  it('into USDC, measures the proceeds and records a close', async () => {
    vi.mocked(chooseSettlement).mockResolvedValue({
      ...INTO_CBBTC,
      floor: { tokenOut: h.USDC, minOut: 495_000_000n },
    } as never);

    const r = await placeSwap(wallet, { from: 'WETH', to: 'USDC', amount: '0.2' });

    expect(proceedsSince).toHaveBeenCalledWith(OWNER, 7n);
    expect(measuredDelta).not.toHaveBeenCalled();
    expect(vi.mocked(applyFill).mock.calls.map((c) => c[1])).toEqual([
      { walletId: 'wallet-1', symbol: 'WETH', units: -0.2, usd: -499.2, attribution: SWAP },
    ]);
    expect(vi.mocked(recordSale).mock.calls[0]![1]).toMatchObject({ kind: 'close', proceedsUsd: 499.2, quotedUsd: 500 });
    expect(r.body).toMatchObject({ status: 'filled', to: 'USDC', received: 499.2, usd: 499.2 });
  });

  it('refuses without an active permission, and sends nothing', async () => {
    vi.mocked(readPolicy).mockResolvedValue({ revoked: true, expiresAt: Date.now() + 86_400_000 } as never);
    const r = await placeSwap(wallet, { from: 'WETH', to: 'CBBTC', amount: '0.2' });
    expect(r).toMatchObject({ status: 409, body: { reason: 'delegation_inactive' } });
    nothingSent();
  });

  it('refuses what is not held, and more than is held', async () => {
    vi.mocked(rawBalanceOf).mockResolvedValueOnce(0n);
    expect(await placeSwap(wallet, { from: 'WETH', to: 'CBBTC', amount: '0.2' })).toMatchObject({
      status: 409,
      body: { reason: 'not_held' },
    });

    vi.mocked(rawBalanceOf).mockResolvedValueOnce(100_000_000_000_000_000n);
    expect(await placeSwap(wallet, { from: 'WETH', to: 'CBBTC', amount: '0.2' })).toMatchObject({
      status: 409,
      body: { reason: 'insufficient', detail: 'You hold 0.1 WETH, less than 0.2.' },
    });
    nothingSent();
  });

  it('says so when the balance cannot be read, and places nothing', async () => {
    vi.mocked(rawBalanceOf).mockResolvedValueOnce(undefined);
    expect(await placeSwap(wallet, { from: 'WETH', to: 'CBBTC', amount: '0.2' })).toMatchObject({
      status: 502,
      body: { status: 'failed' },
    });
    nothingSent();
  });

  it('refuses a holding it cannot price, and one worth less than the gas', async () => {
    // No price at all: the feed throws, and nothing is valued or placed.
    vi.mocked(priceOf).mockRejectedValueOnce(new Error('no price for WETH'));
    expect(await placeSwap(wallet, { from: 'WETH', to: 'CBBTC', amount: '0.2' })).toMatchObject({ status: 503 });

    vi.mocked(priceOf).mockResolvedValueOnce(2);
    expect(await placeSwap(wallet, { from: 'WETH', to: 'CBBTC', amount: '0.2' })).toMatchObject({
      status: 409,
      body: { reason: 'dust' },
    });
    nothingSent();
  });

  it('records nothing for a swap that did not confirm', async () => {
    vi.mocked(waitForTx).mockResolvedValue(false);

    const r = await placeSwap(wallet, { from: 'WETH', to: 'CBBTC', amount: '0.2' });

    expect(r).toEqual({
      status: 502,
      body: { status: 'failed', from: 'WETH', to: 'CBBTC', error: 'In words: swap 0xsig did not confirm' },
    });
    expect(applyFill).not.toHaveBeenCalled();
    expect(recordSale).not.toHaveBeenCalled();
    expect(append).not.toHaveBeenCalled();
  });

  it('when what arrived cannot be read back, records the floor the contract enforced as the least it was', async () => {
    vi.mocked(measuredDelta).mockResolvedValue(undefined);

    const r = await placeSwap(wallet, { from: 'WETH', to: 'CBBTC', amount: '0.2' });

    expect(r.body).toMatchObject({ received: 0.0039, measured: false });
    expect(vi.mocked(recordSale).mock.calls[0]![1]).toMatchObject({ quotedUsd: null });
    expect(vi.mocked(append).mock.calls[0]![0].detail).toMatch(/^At least 0\.0039 CBBTC/);
  });
});
