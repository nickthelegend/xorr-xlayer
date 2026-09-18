/**
 * Limit orders over HTTP (PLAN.md 3.15), with the chain, the delegation and the database stood in for.
 *
 * The signing and hashing are real: orders are signed by a test key and verified by the venue module itself, so a
 * refusal of a bad signature here is the executor's own check, not a mock agreeing with the test. What the router and
 * the chain would answer — `hashOrder`, the clock, the nonce word, balances, the dry run — is supplied per case.
 *
 * Publishing is operator-only and refuses what no take here could fill. The list is this chain's, with what the chain
 * says about each order. A take refuses where nothing settles, without a permission, when the order is gone, when the
 * nonce is spent and when the owner is short — sending nothing — and otherwise fills through `spend()` and records the
 * fill where every fill is, recording nothing for a transaction that did not confirm.
 */
import { Hono } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ContractFunctionRevertedError, keccak256, toFunctionSelector, toHex, type Abi, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

const h = vi.hoisted(() => ({
  canSettle: true,
  statements: [] as { text: string; params: unknown[] }[],
  readContract: vi.fn(),
  getBlock: vi.fn(),
  multicall: vi.fn(),
  simulateContract: vi.fn(),
  ROUTER: '0x111111125421cA6dc452d289314280a0f8842A65',
  USDC: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
  WETH: '0x4200000000000000000000000000000000000006',
  CBBTC: '0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf',
  DELEGATION: '0xacf5cd5343b7b3ad78d8fae211af114ca4f17be2',
}));

vi.mock('../auth/privy.js', () => ({
  UnauthorizedError: class extends Error {
    readonly status = 401;
  },
  verifyToken: vi.fn(),
}));
vi.mock('./wallet-context.js', () => ({ currentWallet: vi.fn(), NoWalletError: class extends Error {} }));
vi.mock('../evm/client.js', () => ({
  publicClient: {
    readContract: h.readContract,
    getBlock: h.getBlock,
    multicall: h.multicall,
    simulateContract: h.simulateContract,
  },
  delegateAccount: { address: '0x316DA498a463abE2F9B2dd316F4005f4343b910f' },
}));
vi.mock('../evm/chains.js', () => ({
  ADDRESSES: { oneInchRouter: h.ROUTER, usdc: h.USDC, weth: h.WETH },
  CHAIN_KEY: 'xlayer-fork',
  chain: { id: 8453 },
  explorerTx: (hash: string) => `fork:${hash}`,
}));
vi.mock('../venues/oneinch.js', () => ({
  get CAN_SETTLE() {
    return h.canSettle;
  },
}));
vi.mock('../evm/delegation.js', async () => {
  const { parseUnits } = await import('viem');
  return {
    DELEGATION_ABI: [],
    DELEGATION_ADDRESS: h.DELEGATION,
    readPolicy: vi.fn(),
    spendAsDelegate: vi.fn(),
    waitForTx: vi.fn(),
    // The real conversion: the route checks the order's USDC survives it exactly.
    usdToUnits: (usd: number) => parseUnits(usd.toFixed(6), 6),
  };
});
vi.mock('../evm/gas.js', () => ({ gasStatus: vi.fn() }));
vi.mock('../db/index.js', () => {
  const client = {
    query: async (text: string, params: unknown[] = []) => {
      h.statements.push({ text, params });
      return { rows: [] };
    },
  };
  return { one: vi.fn(), query: vi.fn(), tx: async (fn: (c: typeof client) => Promise<unknown>) => fn(client) };
});
vi.mock('../audit/log.js', () => ({ append: vi.fn(async () => undefined) }));
vi.mock('../positions/index.js', () => ({ applyFill: vi.fn(async () => undefined) }));
vi.mock('../rules/engine.js', () => ({ evaluate: vi.fn(), recordSpend: vi.fn(async () => undefined) }));
vi.mock('../portfolio/snapshots.js', () => ({ snapshotWallet: vi.fn(async () => true) }));
vi.mock('../executor/fill-measure.js', () => ({ rawBalanceOf: vi.fn(), measuredDelta: vi.fn(), usdcRawOf: vi.fn() }));
vi.mock('../executor/failure.js', () => ({ humanFailure: (raw: string) => `In words: ${raw}` }));

const { one, query } = await import('../db/index.js');
const { append } = await import('../audit/log.js');
const { applyFill } = await import('../positions/index.js');
const { evaluate, recordSpend } = await import('../rules/engine.js');
const { snapshotWallet } = await import('../portfolio/snapshots.js');
const { readPolicy, spendAsDelegate, waitForTx } = await import('../evm/delegation.js');
const { gasStatus } = await import('../evm/gas.js');
const { measuredDelta, rawBalanceOf, usdcRawOf } = await import('../executor/fill-measure.js');
const { currentWallet } = await import('./wallet-context.js');
const lop = await import('../venues/limit-orders.js');
const { limitOrderRoutes } = await import('./limit-orders.js');
const { errorResponse } = await import('../http/errors.js');

const app = new Hono();
// Who is calling, as the auth middleware would have decided it.
app.use('*', async (c, next) => {
  const caller = c.req.header('x-test-caller');
  if (caller === 'operator') c.set('principal', { kind: 'operator', id: 'operator', name: 'operator', scopes: ['admin', 'read'] });
  if (caller === 'user') c.set('user', { userId: 'did:privy:owner' } as never);
  await next();
});
app.onError(errorResponse);
app.route('/', limitOrderRoutes);

const OWNER = '0x95A0b368588713011a15f4b1041423f31B08e615';
const wallet = { id: 'wallet-1', address: OWNER, agents_stopped: false };
const maker = privateKeyToAccount(keccak256(toHex('xorr/limit-orders/unit-test-maker')));
const stranger = privateKeyToAccount(keccak256(toHex('xorr/limit-orders/someone-else')));
const TRAITS = lop.buildMakerTraits({ expiration: 1_900_000_000n, nonce: 300n, noPartialFills: true });
const ORDER = {
  salt: 102030405060708090n,
  maker: maker.address,
  receiver: maker.address,
  makerAsset: h.WETH as Hex,
  takerAsset: h.USDC as Hex,
  makingAmount: 10n ** 16n,
  takingAmount: 25_000_000n,
  makerTraits: TRAITS,
};
/** The router's `hashOrder(ORDER)`, recorded on a Base fork — see `venues/limit-orders.test.ts`. */
const HASH = '0x345e8eb4fdb71825ade8a35717db833c344e0fa60ddf9b63b17454ae178354f9';
const SIGNATURE = await maker.signTypedData(lop.limitOrderTypedData(ORDER, 8453));

const bodyOf = (order: typeof ORDER, signature: string) => ({
  order: {
    ...order,
    salt: order.salt.toString(),
    makingAmount: order.makingAmount.toString(),
    takingAmount: order.takingAmount.toString(),
    makerTraits: order.makerTraits.toString(),
  },
  signature,
});
const publish = (payload: unknown, caller = 'operator') =>
  app.request('/limit-orders', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-test-caller': caller },
    body: JSON.stringify(payload),
  });
const list = () => app.request('/limit-orders', { headers: { 'x-test-caller': 'user' } });
const take = (hash = HASH, caller = 'user') =>
  app.request(`/limit-orders/${hash}/fill`, { method: 'POST', headers: { 'x-test-caller': caller } });

/** What the chain says about one order: its nonce word, and the maker's balance and allowance. */
const onChain = (word = 0n, balance = 10n ** 16n, allowance = 10n ** 16n) => [
  { status: 'success', result: word },
  { status: 'success', result: balance },
  { status: 'success', result: allowance },
];
const row = (over: Record<string, unknown> = {}) => ({
  order_hash: HASH,
  maker: maker.address,
  maker_asset: h.WETH,
  taker_asset: h.USDC,
  making_amount: '10000000000000000',
  taking_amount: '25000000',
  salt: '102030405060708090',
  maker_traits: TRAITS.toString(),
  signature: lop.compactSignatureHex(SIGNATURE),
  created_at: new Date('2026-09-13T00:00:00Z'),
  filled_at: null,
  fill_tx: null,
  taker_wallet_id: null,
  ...over,
});
const statement = (fragment: string) => h.statements.find((s) => s.text.includes(fragment));

beforeEach(() => {
  vi.clearAllMocks();
  h.canSettle = true;
  h.statements.length = 0;
  h.readContract.mockResolvedValue(HASH);
  h.getBlock.mockResolvedValue({ timestamp: 1_800_000_000n });
  h.multicall.mockResolvedValue(onChain());
  h.simulateContract.mockResolvedValue({ result: '0x' });
  vi.mocked(currentWallet).mockResolvedValue(wallet as never);
  vi.mocked(readPolicy).mockResolvedValue({
    delegate: '0x316DA498a463abE2F9B2dd316F4005f4343b910f',
    dailyCapUsd: 500,
    expiresAt: Date.now() + 86_400_000,
    revoked: false,
    remainingTodayUsd: 500,
    spentTodayUsd: 0,
  });
  vi.mocked(evaluate).mockResolvedValue({ allowed: true, spentTodayUsd: 0, remainingUsd: 475 });
  vi.mocked(gasStatus).mockResolvedValue({ eth: 1, enough: true, floor: 0.01, address: '0x316DA498a463abE2F9B2dd316F4005f4343b910f' });
  vi.mocked(usdcRawOf).mockResolvedValue(1_000_000_000n);
  vi.mocked(rawBalanceOf).mockResolvedValue(0n);
  vi.mocked(spendAsDelegate).mockResolvedValue('0xfill');
  vi.mocked(waitForTx).mockResolvedValue(true);
  vi.mocked(measuredDelta).mockResolvedValue(0.01);
});

describe('POST /limit-orders', () => {
  it('is operator-only, and reads nothing for anyone else', async () => {
    expect((await publish(bodyOf(ORDER, SIGNATURE), 'user')).status).toBe(403);
    expect((await publish(bodyOf(ORDER, SIGNATURE), 'nobody')).status).toBe(403);
    expect(h.readContract).not.toHaveBeenCalled();
    expect(one).not.toHaveBeenCalled();
  });

  it('stores a signed order once the router agrees on its hash and its nonce is unspent', async () => {
    vi.mocked(one).mockResolvedValueOnce({ order_hash: HASH });

    const res = await publish(bodyOf(ORDER, SIGNATURE));

    expect(res.status).toBe(201);
    expect(await res.json()).toMatchObject({ status: 'listed', hash: HASH, maker: maker.address, fillable: true });
    expect(h.readContract).toHaveBeenCalledWith(
      expect.objectContaining({ address: h.ROUTER, functionName: 'hashOrder', args: [lop.orderArg(ORDER)] }),
    );
    // Asked by nonce: the router shifts it to a slot itself.
    expect(h.multicall.mock.calls[0]![0].contracts[0]).toMatchObject({ functionName: 'bitInvalidatorForOrder', args: [maker.address, 300n] });
    const [sql, params] = vi.mocked(one).mock.calls[0]!;
    expect(sql).toMatch(/INSERT INTO limit_orders/);
    expect(params).toEqual([
      HASH,
      maker.address,
      h.WETH,
      h.USDC,
      '10000000000000000',
      '25000000',
      '102030405060708090',
      TRAITS.toString(),
      lop.compactSignatureHex(SIGNATURE),
    ]);
  });

  it('refuses a signature that does not recover the maker, before asking the chain anything', async () => {
    const forged = await stranger.signTypedData(lop.limitOrderTypedData(ORDER, 8453));
    const res = await publish(bodyOf(ORDER, forged));
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ reason: 'bad_signature' });
    expect(h.readContract).not.toHaveBeenCalled();
    expect(one).not.toHaveBeenCalled();
  });

  it('refuses an order the router hashes differently', async () => {
    h.readContract.mockResolvedValue(`0x${'ab'.repeat(32)}`);
    const res = await publish(bodyOf(ORDER, SIGNATURE));
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ reason: 'hash_mismatch' });
    expect(one).not.toHaveBeenCalled();
  });

  it("refuses an expired order and a spent nonce, by the chain's clock and the router's invalidator", async () => {
    h.getBlock.mockResolvedValue({ timestamp: 1_900_000_001n });
    expect(await (await publish(bodyOf(ORDER, SIGNATURE))).json()).toMatchObject({ status: 'blocked', reason: 'expired' });

    h.getBlock.mockResolvedValue({ timestamp: 1_800_000_000n });
    // Nonce 300 is bit 44 of slot 1.
    h.multicall.mockResolvedValue(onChain(1n << 44n));
    expect(await (await publish(bodyOf(ORDER, SIGNATURE))).json()).toMatchObject({ status: 'blocked', reason: 'invalidated' });
    expect(one).not.toHaveBeenCalled();
  });

  it('refuses what a take here could not fill, and another pair, and paying anyone but the maker', async () => {
    const partial = { ...ORDER, makerTraits: lop.buildMakerTraits({ expiration: 1_900_000_000n, nonce: 300n }) };
    expect(await (await publish(bodyOf(partial, SIGNATURE))).json()).toMatchObject({ reason: 'partial_fills' });
    const extension = { ...ORDER, makerTraits: TRAITS | lop.MAKER_TRAITS.HAS_EXTENSION };
    expect(await (await publish(bodyOf(extension, SIGNATURE))).json()).toMatchObject({ reason: 'unsupported_traits' });
    const cbbtc = { ...ORDER, makerAsset: h.CBBTC as Hex };
    expect(await (await publish(bodyOf(cbbtc, SIGNATURE))).json()).toMatchObject({ reason: 'unsupported_pair' });
    const elsewhere = { ...ORDER, receiver: OWNER as Hex };
    expect(await (await publish(bodyOf(elsewhere, SIGNATURE))).json()).toMatchObject({ reason: 'receiver_not_maker' });
    expect(h.readContract).not.toHaveBeenCalled();
  });

  it('answers a malformed order as a bad request', async () => {
    const res = await publish({ ...bodyOf(ORDER, SIGNATURE), signature: 'nope' });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: 'invalid_request' });
  });

  it('lists nothing where nothing settles', async () => {
    h.canSettle = false;
    const res = await publish(bodyOf(ORDER, SIGNATURE));
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ reason: 'not_settleable_here' });
    expect(h.readContract).not.toHaveBeenCalled();
  });

  it('takes a second publish of the same order calmly, and refuses one listed for another chain', async () => {
    vi.mocked(one).mockResolvedValueOnce(undefined).mockResolvedValueOnce({ here: true });
    const again = await publish(bodyOf(ORDER, SIGNATURE));
    expect(again.status).toBe(200);
    expect(await again.json()).toMatchObject({ status: 'listed', duplicate: true });

    vi.mocked(one).mockResolvedValueOnce(undefined).mockResolvedValueOnce({ here: false });
    expect(await (await publish(bodyOf(ORDER, SIGNATURE))).json()).toMatchObject({ reason: 'listed_elsewhere' });
  });
});

describe('GET /limit-orders', () => {
  it('where nothing settles, is empty and says why, without reading anything', async () => {
    h.canSettle = false;
    const res = await list();
    expect(res.status).toBe(200);
    const body = (await res.json()) as { detail: string };
    expect(body).toMatchObject({ settles: false, orders: [] });
    expect(body.detail).toMatch(/Nothing settles on base-fork/);
    expect(query).not.toHaveBeenCalled();
  });

  it("lists this chain's orders with price, size, maker, expiry, and what the chain says of each", async () => {
    const filled = row({
      order_hash: `0x${'cd'.repeat(32)}`,
      filled_at: new Date('2026-09-13T01:00:00Z'),
      fill_tx: '0xfill',
      taker_wallet_id: 'wallet-1',
    });
    vi.mocked(query).mockResolvedValue([row(), filled]);
    h.multicall.mockResolvedValue([...onChain(), ...onChain(1n << 44n)]);

    const res = await list();

    expect(res.status).toBe(200);
    expect(vi.mocked(query).mock.calls[0]![0]).toContain("chain = current_setting('xorr.chain_key')");
    const { settles, orders } = (await res.json()) as { settles: boolean; orders: Record<string, unknown>[] };
    expect(settles).toBe(true);
    expect(orders[0]).toMatchObject({
      hash: HASH,
      maker: maker.address,
      sells: 'WETH',
      pays: 'USDC',
      size: 0.01,
      cost: 25,
      price: 2500,
      nonce: '300',
      expiresAt: 1_900_000_000_000,
      status: 'open',
      fillable: true,
      takenByYou: false,
    });
    expect(orders[1]).toMatchObject({ status: 'filled', fillable: false, fillTx: '0xfill', takenByYou: true });
  });

  it('answers a chain that cannot be read with a 502, not an empty list', async () => {
    vi.mocked(query).mockResolvedValue([row()]);
    h.getBlock.mockRejectedValue(new Error('fetch failed'));
    const res = await list();
    expect(res.status).toBe(502);
    expect(await res.json()).toMatchObject({ error: 'chain_read_failed' });
  });
});

describe('POST /limit-orders/:hash/fill', () => {
  const nothingSent = () => {
    expect(h.simulateContract).not.toHaveBeenCalled();
    expect(spendAsDelegate).not.toHaveBeenCalled();
    expect(applyFill).not.toHaveBeenCalled();
  };

  it('where nothing settles, reads and sends nothing', async () => {
    h.canSettle = false;
    const res = await take();
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ reason: 'not_settleable_here' });
    expect(one).not.toHaveBeenCalled();
    nothingSent();
  });

  it('belongs to a signed-in person: an operator key cannot take for someone', async () => {
    expect((await take(HASH, 'operator')).status).toBe(403);
    nothingSent();
  });

  it('refuses without an active permission', async () => {
    vi.mocked(one).mockResolvedValue(row());
    vi.mocked(readPolicy).mockResolvedValue(null);
    const res = await take();
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ reason: 'delegation_inactive' });
    nothingSent();
  });

  it('says the order is gone when it is not listed on this chain, or was already taken', async () => {
    vi.mocked(one).mockResolvedValue(undefined);
    const gone = await take();
    expect(gone.status).toBe(404);
    expect(vi.mocked(one).mock.calls[0]![0]).toContain("chain = current_setting('xorr.chain_key')");

    vi.mocked(one).mockResolvedValue(row({ filled_at: new Date(), fill_tx: '0xearlier' }));
    expect(await (await take()).json()).toMatchObject({ reason: 'already_taken' });
    nothingSent();
  });

  it('refuses an order whose nonce is spent on chain', async () => {
    vi.mocked(one).mockResolvedValue(row());
    h.multicall.mockResolvedValue(onChain(1n << 44n));
    expect(await (await take()).json()).toMatchObject({ status: 'blocked', reason: 'invalidated' });
    nothingSent();
  });

  it('refuses when the owner holds less USDC than the order costs', async () => {
    vi.mocked(one).mockResolvedValue(row());
    vi.mocked(usdcRawOf).mockResolvedValue(24_999_999n);
    const res = await take();
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({
      reason: 'insufficient',
      detail: 'The order costs 25 USDC and you hold 24.999999.',
    });
    nothingSent();
  });

  it('says in words why the router would refuse, before signing anything', async () => {
    vi.mocked(one).mockResolvedValue(row());
    h.simulateContract.mockRejectedValue(
      new ContractFunctionRevertedError({
        abi: lop.LOP_ERRORS as unknown as Abi,
        data: toFunctionSelector('TransferFromMakerToTakerFailed()'),
        functionName: 'spend',
      }),
    );
    const res = await take();
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({
      reason: 'would_revert',
      detail: lop.LOP_REFUSALS.TransferFromMakerToTakerFailed,
    });
    expect(spendAsDelegate).not.toHaveBeenCalled();
  });

  it('takes the whole order through spend() and records the fill where every fill is', async () => {
    vi.mocked(one).mockResolvedValue(row());
    const fill = lop.buildLimitOrderFill({ order: ORDER, signature: SIGNATURE, owner: OWNER });

    const res = await take();

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      status: 'filled',
      hash: HASH,
      bought: 'WETH',
      received: 0.01,
      paid: 25,
      price: 2500,
      measured: true,
      venue: 'lop',
      txHash: '0xfill',
    });
    expect(h.simulateContract.mock.calls[0]![0]).toMatchObject({
      address: h.DELEGATION,
      functionName: 'spend',
      args: [OWNER, h.USDC, h.ROUTER, 25_000_000n, h.WETH, 10n ** 16n, fill.data],
    });
    expect(spendAsDelegate).toHaveBeenCalledWith({
      owner: OWNER,
      token: h.USDC,
      venue: h.ROUTER,
      usd: 25,
      data: fill.data,
      tokenOut: h.WETH,
      minOut: 10n ** 16n,
    });
    expect(statement('UPDATE limit_orders')!.params).toEqual([HASH, '0xfill', 'wallet-1']);
    expect(statement('INSERT INTO strategies')!.text).toMatch(/'limit', 'ended'/);
    const run = statement('INSERT INTO strategy_runs')!;
    expect(run.text).toMatch(/'filled', \$4, \$5, \$6, \$7, 'lop', 'buy', \$8, 'crypto'/);
    expect(run.params.slice(2)).toEqual([`limit:${HASH}`, 25, 0.01, 2500, '0xfill', 0.01]);
    expect(vi.mocked(applyFill).mock.calls[0]![1]).toEqual({
      walletId: 'wallet-1',
      symbol: 'WETH',
      units: 0.01,
      usd: 25,
      // Attributed to the order, not to whichever strategy happened to be running.
      attribution: { source: 'limit-order', id: null, label: 'Limit order' },
    });
    expect(vi.mocked(recordSpend).mock.calls[0]!.slice(0, 2)).toEqual(['wallet-1', 25]);
    expect(vi.mocked(append).mock.calls[0]![0]).toMatchObject({
      walletId: 'wallet-1',
      agent: 'You',
      action: 'Took a limit order: bought 0.01 WETH',
      kind: 'trade',
      signature: '0xfill',
      payload: { orderHash: HASH, maker: maker.address, venue: 'lop', measured: true, explorer: 'fork:0xfill' },
    });
    expect(snapshotWallet).toHaveBeenCalledWith({ id: 'wallet-1', address: OWNER }, 'fill');
  });

  it('records nothing for a fill that did not confirm', async () => {
    vi.mocked(one).mockResolvedValue(row());
    vi.mocked(waitForTx).mockResolvedValue(false);

    const res = await take();

    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({
      status: 'failed',
      error: 'In words: limit order fill 0xfill did not confirm',
      txHash: '0xfill',
    });
    expect(h.statements).toEqual([]);
    expect(applyFill).not.toHaveBeenCalled();
    expect(append).not.toHaveBeenCalled();
  });

  it('when the WETH that arrived cannot be read back, records the size the contract guaranteed, unmeasured', async () => {
    vi.mocked(one).mockResolvedValue(row());
    vi.mocked(measuredDelta).mockResolvedValue(undefined);

    const res = await take();

    expect(await res.json()).toMatchObject({ received: 0.01, measured: false });
    expect(statement('INSERT INTO strategy_runs')!.params[7]).toBeNull();
    expect(vi.mocked(append).mock.calls[0]![0].detail).toMatch(/^At least 0\.01 WETH/);
  });
});
