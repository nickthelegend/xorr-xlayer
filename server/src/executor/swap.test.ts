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
  // X Layer mainnet: Circle's USDC, wrapped OKB, OKX's wrapped BTC, WETH (held, not routed) and the NVDAx xStock.
  USDC: '0xB6CEceAB302E2E4948951eE7843FC24E92933061',
  WOKB: '0xe538905cf8410324e03A5A23C1c177a474D59b2b',
  XBTC: '0xb7C00000bcDEeF966b20B3D884B98E64d2b06b4f',
  WETH: '0x5A77f1443D16ee5761d310e38b62f77f726bC71c',
  NVDAX: '0xa8ddb5cd96b5222afe198316e9a57caa642850d5',
  DELEGATION: '0x6c5528Fd8E74a047A85bAb413856A9239E73540e',
  /** Uniswap v3 SwapRouter02 on X Layer. */
  ROUTER: '0x4f0C28f5926AFDA16bf2506D5D9e57Ea190f9bcA',
  /** OKX DEX's router and the approval contract it pulls through. */
  OKX_ROUTER: '0x7c5bee2a8091c3ef39072f64f18fac913060aeaf',
  OKX_SPENDER: '0x8b773D83bc66Be128c60e07E17C8901f7a64F000',
}));

vi.mock('../venues/tokens.js', () => {
  const TOKENS: Record<string, { address: string; decimals: number }> = {
    USDC: { address: h.USDC, decimals: 6 },
    WOKB: { address: h.WOKB, decimals: 18 },
    XBTC: { address: h.XBTC, decimals: 8 },
    WETH: { address: h.WETH, decimals: 18 },
    NVDAx: { address: h.NVDAX, decimals: 18 },
  };
  const canonical = new Map(Object.keys(TOKENS).map((k) => [k.toUpperCase(), k]));
  return {
    get CAN_SETTLE() {
      return h.canSettle;
    },
    SETTLEMENT_SYMBOL: 'USDC',
    TOKENS,
    canonicalSymbol: (s: string) => canonical.get(s.trim().toUpperCase()) ?? s.trim(),
  };
});
vi.mock('../venues/stocks.js', () => ({ isStock: (s: string) => s === 'NVDAx', equitiesFunctional: vi.fn(async () => false) }));
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
const ONE_WOKB = 1_000_000_000_000_000_000n;

/** Uniswap's route for WOKB → XBTC, held to 0.0039 XBTC. */
const INTO_XBTC = {
  payToken: { address: h.WOKB, decimals: 18 },
  swap: { to: h.ROUTER, data: '0x1111' },
  venue: 'uniswap-v3',
  floor: { tokenOut: h.XBTC, minOut: 390_000n },
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
  vi.mocked(priceOf).mockImplementation(async (s: string) => ({ WOKB: 2_500, XBTC: 100_000 })[s as 'WOKB']);
  vi.mocked(rawBalanceOf).mockImplementation(async (_owner, symbol) => (symbol === 'WOKB' ? ONE_WOKB : 0n));
  vi.mocked(chooseSettlement).mockResolvedValue(INTO_XBTC as never);
  vi.mocked(closeAsDelegate).mockResolvedValue('0xsig');
  vi.mocked(waitForTx).mockResolvedValue(true);
  vi.mocked(measuredDelta).mockResolvedValue(0.004);
  vi.mocked(usdcRawOf).mockResolvedValue(7n);
  vi.mocked(proceedsSince).mockResolvedValue(499.2);
});

describe('refused before anything is read', () => {
  it('where nothing settles, places nothing', async () => {
    h.canSettle = false;
    const r = await placeSwap(wallet, { from: 'USDC', to: 'WOKB', amount: '20' });
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
    const r = await placeSwap(wallet, { from: 'USDC', to: 'nvdax', amount: '20' });
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
    vi.mocked(one).mockResolvedValue({ venue: 'okx-dex' });

    const r = await placeSwap(wallet, { from: 'usdc', to: 'WOKB', amount: '20', slippagePct: 0.5 });

    expect(placeOrder).toHaveBeenCalledWith(wallet, 'WOKB', 20, 'Swap 20 USDC for WOKB', { slippagePct: 0.5 });
    expect(one).toHaveBeenCalledWith(expect.stringContaining('FROM strategy_runs'), ['run-1']);
    expect(r).toEqual({
      status: 200,
      body: { status: 'filled', from: 'USDC', to: 'WOKB', sold: 20, received: 0.008, usd: 20, venue: 'okx-dex', txHash: '0xabc' },
    });
    expect(closeAsDelegate).not.toHaveBeenCalled();
  });

  it('sends no tolerance when none was chosen, so the executor uses its own', async () => {
    vi.mocked(placeOrder).mockResolvedValue({
      placed: true,
      orderId: 'strategy-1',
      outcome: { status: 'filled', runId: 'run-1', signature: '0xabc', units: 0.008, price: 2_500 },
    });
    vi.mocked(one).mockResolvedValue({ venue: 'uniswap-v3' });

    await placeSwap(wallet, { from: 'USDC', to: 'WOKB', amount: '20' });
    expect(vi.mocked(placeOrder).mock.calls[0]![4]).toEqual({});
  });

  it('answers a refusal before the run with its reason, and a run the rules block the same way', async () => {
    const refusal = { status: 'blocked' as const, reason: 'no_delegation', detail: 'No active trading permission on-chain.' };
    vi.mocked(placeOrder).mockResolvedValueOnce({ placed: false, refusal });
    expect(await placeSwap(wallet, { from: 'USDC', to: 'WOKB', amount: '20' })).toEqual({ status: 409, body: refusal });

    const outcome = { status: 'blocked' as const, runId: 'run-2', reason: 'daily_cap', detail: 'The daily cap is spent.' };
    vi.mocked(placeOrder).mockResolvedValueOnce({ placed: true, orderId: 'strategy-2', outcome });
    expect(await placeSwap(wallet, { from: 'USDC', to: 'WOKB', amount: '20' })).toEqual({ status: 409, body: outcome });
  });
});

describe('paying anything else converts the holding through closePosition()', () => {
  it('sells exactly the units typed into the token asked for, measures what arrived, and records both sides', async () => {
    const r = await placeSwap(wallet, { from: 'WOKB', to: 'XBTC', amount: '0.2', slippagePct: 0.5 });

    expect(chooseSettlement).toHaveBeenCalledWith({
      intent: {
        inSymbol: 'WOKB',
        outSymbol: 'XBTC',
        amountIn: 0.2,
        amountInRaw: 200_000_000_000_000_000n,
        usd: 500,
        because: 'Swap placed by you.',
        slippagePct: 0.5,
      },
      owner: OWNER,
      isClose: true,
      delegationFrom: h.DELEGATION,
      // The same call and raw amount as the close below, so every venue is routed for exactly what it will pull.
      send: { via: 'closePosition', amount: 200_000_000_000_000_000n },
    });
    expect(closeAsDelegate).toHaveBeenCalledWith({
      owner: OWNER,
      token: h.WOKB,
      venue: h.ROUTER,
      amount: 200_000_000_000_000_000n,
      data: '0x1111',
      tokenOut: h.XBTC,
      minOut: 390_000n,
    });
    // XBTC read before the transaction, so the delta afterwards is the fill and nothing else.
    expect(measuredDelta).toHaveBeenCalledWith({ owner: OWNER, symbol: 'XBTC', before: 0n });
    expect(vi.mocked(applyFill).mock.calls.map((c) => c[1])).toEqual([
      // Both legs attributed to the swap, so neither lands in the book as nobody's.
      { walletId: 'wallet-1', symbol: 'WOKB', units: -0.2, usd: -400, attribution: SWAP },
      { walletId: 'wallet-1', symbol: 'XBTC', units: 0.004, usd: 400, attribution: SWAP },
    ]);
    expect(recordSale).toHaveBeenCalledWith(
      { client: true },
      {
        walletId: 'wallet-1',
        symbol: 'WOKB',
        label: 'Swapped 0.2 WOKB for 0.004 XBTC',
        units: 0.2,
        proceedsUsd: 400,
        quotedUsd: 500,
        signature: '0xsig',
        kind: 'swap',
        venue: 'uniswap-v3',
      },
    );
    expect(vi.mocked(append).mock.calls[0]![0]).toMatchObject({
      walletId: 'wallet-1',
      agent: 'You',
      action: 'Swapped 0.2 WOKB for 0.004 XBTC',
      kind: 'trade',
      signature: '0xsig',
      payload: { runId: 'run-9', venue: 'uniswap-v3', measured: true, explorer: 'fork:0xsig' },
    });
    expect(r).toEqual({
      status: 200,
      body: { status: 'filled', from: 'WOKB', to: 'XBTC', sold: 0.2, received: 0.004, usd: 400, venue: 'uniswap-v3', measured: true, txHash: '0xsig' },
    });
  });

  it('through OKX DEX, names its approval contract so the close is sent as closePositionVia', async () => {
    vi.mocked(chooseSettlement).mockResolvedValue({
      ...INTO_XBTC,
      swap: { to: h.OKX_ROUTER, data: '0x2222' },
      spender: h.OKX_SPENDER,
      venue: 'okx-dex',
    } as never);

    await placeSwap(wallet, { from: 'WOKB', to: 'XBTC', amount: '0.2' });

    expect(closeAsDelegate).toHaveBeenCalledWith(
      expect.objectContaining({ venue: h.OKX_ROUTER, spender: h.OKX_SPENDER, data: '0x2222' }),
    );
    // Uniswap's router pulls for itself: no spender, and the plain closePosition.
    vi.mocked(chooseSettlement).mockResolvedValue(INTO_XBTC as never);
    await placeSwap(wallet, { from: 'WOKB', to: 'XBTC', amount: '0.2' });
    expect(vi.mocked(closeAsDelegate).mock.calls[1]![0]).not.toHaveProperty('spender');
  });

  it('parses the typed decimal exactly — 0.1 WOKB is 10^17 wei, not the float of it', async () => {
    await placeSwap(wallet, { from: 'WOKB', to: 'XBTC', amount: '0.1' });
    expect(vi.mocked(closeAsDelegate).mock.calls[0]![0].amount).toBe(100_000_000_000_000_000n);
  });

  it('into USDC, measures the proceeds and records a close', async () => {
    vi.mocked(chooseSettlement).mockResolvedValue({
      ...INTO_XBTC,
      floor: { tokenOut: h.USDC, minOut: 495_000_000n },
    } as never);

    const r = await placeSwap(wallet, { from: 'WOKB', to: 'USDC', amount: '0.2' });

    expect(proceedsSince).toHaveBeenCalledWith(OWNER, 7n);
    expect(measuredDelta).not.toHaveBeenCalled();
    expect(vi.mocked(applyFill).mock.calls.map((c) => c[1])).toEqual([
      { walletId: 'wallet-1', symbol: 'WOKB', units: -0.2, usd: -499.2, attribution: SWAP },
    ]);
    expect(vi.mocked(recordSale).mock.calls[0]![1]).toMatchObject({ kind: 'close', proceedsUsd: 499.2, quotedUsd: 500 });
    expect(r.body).toMatchObject({ status: 'filled', to: 'USDC', received: 499.2, usd: 499.2 });
  });

  it('refuses without an active permission, and sends nothing', async () => {
    vi.mocked(readPolicy).mockResolvedValue({ revoked: true, expiresAt: Date.now() + 86_400_000 } as never);
    const r = await placeSwap(wallet, { from: 'WOKB', to: 'XBTC', amount: '0.2' });
    expect(r).toMatchObject({ status: 409, body: { reason: 'delegation_inactive' } });
    nothingSent();
  });

  it('refuses what is not held, and more than is held', async () => {
    vi.mocked(rawBalanceOf).mockResolvedValueOnce(0n);
    expect(await placeSwap(wallet, { from: 'WOKB', to: 'XBTC', amount: '0.2' })).toMatchObject({
      status: 409,
      body: { reason: 'not_held' },
    });

    vi.mocked(rawBalanceOf).mockResolvedValueOnce(100_000_000_000_000_000n);
    expect(await placeSwap(wallet, { from: 'WOKB', to: 'XBTC', amount: '0.2' })).toMatchObject({
      status: 409,
      body: { reason: 'insufficient', detail: 'You hold 0.1 WOKB, less than 0.2.' },
    });
    nothingSent();
  });

  it('says so when the balance cannot be read, and places nothing', async () => {
    vi.mocked(rawBalanceOf).mockResolvedValueOnce(undefined);
    expect(await placeSwap(wallet, { from: 'WOKB', to: 'XBTC', amount: '0.2' })).toMatchObject({
      status: 502,
      body: { status: 'failed' },
    });
    nothingSent();
  });

  it('refuses a holding it cannot price, and one worth less than the gas', async () => {
    // No price at all: the feed throws, and nothing is valued or placed.
    vi.mocked(priceOf).mockRejectedValueOnce(new Error('no price for WOKB'));
    expect(await placeSwap(wallet, { from: 'WOKB', to: 'XBTC', amount: '0.2' })).toMatchObject({ status: 503 });

    vi.mocked(priceOf).mockResolvedValueOnce(2);
    expect(await placeSwap(wallet, { from: 'WOKB', to: 'XBTC', amount: '0.2' })).toMatchObject({
      status: 409,
      body: { reason: 'dust' },
    });
    nothingSent();
  });

  it('records nothing for a swap that did not confirm', async () => {
    vi.mocked(waitForTx).mockResolvedValue(false);

    const r = await placeSwap(wallet, { from: 'WOKB', to: 'XBTC', amount: '0.2' });

    expect(r).toEqual({
      status: 502,
      body: { status: 'failed', from: 'WOKB', to: 'XBTC', error: 'In words: swap 0xsig did not confirm' },
    });
    expect(applyFill).not.toHaveBeenCalled();
    expect(recordSale).not.toHaveBeenCalled();
    expect(append).not.toHaveBeenCalled();
  });

  it('when what arrived cannot be read back, records the floor the contract enforced as the least it was', async () => {
    vi.mocked(measuredDelta).mockResolvedValue(undefined);

    const r = await placeSwap(wallet, { from: 'WOKB', to: 'XBTC', amount: '0.2' });

    expect(r.body).toMatchObject({ received: 0.0039, measured: false });
    expect(vi.mocked(recordSale).mock.calls[0]![1]).toMatchObject({ quotedUsd: null });
    expect(vi.mocked(append).mock.calls[0]![0].detail).toMatch(/^At least 0\.0039 XBTC/);
  });
});
