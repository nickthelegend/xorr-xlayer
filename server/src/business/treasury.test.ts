/**
 * A business treasury does what its operator asks, through Privy and the chain, and nothing else (PLAN.md 4.14).
 *
 * Privy, the chain and the database are stood in for; the decisions are the treasury's own, and every call it asks Privy to
 * sign is read back by decoding its calldata. A treasury is filed apart from its operator's own wallets; it refuses where
 * money is real and where no key quorum owns the policy; it approves only what is missing before it grants this executor's
 * key, by the chain's clock; the grant and the revoke are recorded from their own transactions; and a transfer out is put
 * to Privy to SIGN, never to send, with only a policy refusal counted as proof.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { decodeFunctionData, erc20Abi, getAddress, maxUint256, parseUnits, type Abi, type Hex } from 'viem';

const h = vi.hoisted(() => ({
  chainKey: 'xlayer-fork',
  locked: true,
  statements: [] as { text: string; params: unknown[] }[],
  DELEGATION: '0xc32dD8AeED3035D46C7c82A351fC5522c9D463f4',
  DELEGATE: '0xC38f38f45463f77bD823FebE16b15714Eb98c8A5',
  USDC: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
  WETH: '0x4200000000000000000000000000000000000006',
  CBBTC: '0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf',
  ROUTER: '0x111111125421cA6dc452d289314280a0f8842A65',
}));

vi.mock('../db/index.js', () => {
  const client = {
    query: async (text: string, params: unknown[] = []) => {
      h.statements.push({ text, params });
      return { rows: text.includes('pg_try_advisory_lock') ? [{ locked: h.locked }] : [] };
    },
    release: () => undefined,
  };
  return {
    one: vi.fn(),
    query: vi.fn(),
    tx: async (fn: (c: typeof client) => Promise<unknown>) => fn(client),
    pool: { connect: async () => client },
  };
});
vi.mock('../db/chain-scope.js', () => ({ THIS_CHAIN: "current_setting('xorr.chain_key')" }));
vi.mock('../audit/log.js', () => ({ append: vi.fn(async () => undefined), list: vi.fn(async () => []) }));
vi.mock('../auth/privyPolicy.js', () => ({
  POLICY_NAME: 'xorr wallet policy (base-fork)',
  createPolicyWallet: vi.fn(),
  ensurePolicy: vi.fn(),
  getPolicy: vi.fn(),
  getPrivyWallet: vi.fn(),
  rpcAsWallet: vi.fn(),
}));
vi.mock('../delegation/record.js', () => ({ recordGrant: vi.fn(), recordRevoke: vi.fn() }));
vi.mock('../evm/allowances.js', () => ({ chainAllowance: vi.fn() }));
vi.mock('../evm/chains.js', () => ({
  get CHAIN_KEY() {
    return h.chainKey;
  },
  ADDRESSES: { usdc: h.USDC },
  APPROVABLE_TOKENS: [
    { symbol: 'USDC', address: h.USDC },
    { symbol: 'WETH', address: h.WETH },
    { symbol: 'CBBTC', address: h.CBBTC },
  ],
  SETTLEMENT_VENUES: [h.ROUTER],
  chain: { id: 8453 },
}));
vi.mock('../evm/client.js', () => ({
  publicClient: {
    getBalance: vi.fn(),
    getCode: vi.fn(),
    getBlock: vi.fn(),
    getBlockNumber: vi.fn(),
    getTransactionCount: vi.fn(),
    estimateFeesPerGas: vi.fn(),
    sendRawTransaction: vi.fn(),
  },
}));
vi.mock('../evm/delegation.js', async () => {
  const { parseUnits: units } = await import('viem');
  return {
    DELEGATION_ABI: [
      {
        type: 'function',
        name: 'grant',
        stateMutability: 'nonpayable',
        inputs: [
          { name: 'delegate', type: 'address' },
          { name: 'dailyCap', type: 'uint256' },
          { name: 'expiresAt', type: 'uint64' },
          { name: 'venues', type: 'address[]' },
        ],
        outputs: [],
      },
      { type: 'function', name: 'revoke', stateMutability: 'nonpayable', inputs: [], outputs: [] },
    ],
    DELEGATION_ADDRESS: h.DELEGATION,
    delegatePublicKey: h.DELEGATE,
    readPolicy: vi.fn(),
    waitForReceipt: vi.fn(),
    usdToUnits: (usd: number) => units(usd.toFixed(6), 6),
  };
});
vi.mock('../evm/faucet.js', () => ({ readFaucetOffer: vi.fn(), usdcOf: vi.fn() }));
vi.mock('../evm/gasDrip.js', () => ({ dripGasIfNeeded: vi.fn() }));
vi.mock('../executor/order.js', () => ({
  money: (usd: number) => `$${usd.toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 2 })}`,
  placeOrder: vi.fn(),
}));
vi.mock('../http/request-id.js', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock('../routes/faucet.js', () => ({ claimFaucet: vi.fn() }));
vi.mock('./treasurySigner.js', () => ({
  TreasuryRefused: class TreasuryRefused extends Error {},
  transactAsTreasury: vi.fn(),
}));

const { one } = await import('../db/index.js');
const { append } = await import('../audit/log.js');
const privy = await import('../auth/privyPolicy.js');
const { recordGrant, recordRevoke } = await import('../delegation/record.js');
const { chainAllowance } = await import('../evm/allowances.js');
const { publicClient } = await import('../evm/client.js');
const { DELEGATION_ABI, readPolicy, waitForReceipt } = await import('../evm/delegation.js');
const { readFaucetOffer, usdcOf } = await import('../evm/faucet.js');
const { placeOrder } = await import('../executor/order.js');
const { TreasuryRefused, transactAsTreasury } = await import('./treasurySigner.js');
const T = await import('./treasury.js');

const OPERATOR = 'did:privy:operator';
const OPERATOR_WALLET = getAddress('0x95a0b368588713011a15f4b1041423f31b08e615');
const TREASURY = getAddress('0x5aeda56215b167893e80b4fe645ba6d5bab767de');
const row = {
  id: 'treasury-1',
  operator_user_id: OPERATOR,
  wallet_id: 'wallet-t',
  privy_wallet_id: 'privy-w',
  name: 'Acme',
  created_at: new Date('2026-09-15T00:00:00Z'),
  address: TREASURY.toLowerCase(),
};
const hash = (n: number) => `0x${n.toString(16).padStart(64, '0')}` as Hex;
const CHAIN_NOW = 1_800_000_000n;
type Policy = NonNullable<Awaited<ReturnType<typeof readPolicy>>>;
const livePolicy = (over: Partial<Policy> = {}): Policy => ({
  delegate: getAddress(h.DELEGATE),
  dailyCapUsd: 50,
  expiresAt: Date.now() + 3_600_000,
  revoked: false,
  remainingTodayUsd: 45,
  spentTodayUsd: 5,
  ...over,
});

/** What the treasury asked Privy to sign, decoded: where each call went, which function, with what. */
const signedFor = () =>
  vi.mocked(transactAsTreasury).mock.calls.map(([call]) => {
    const decoded = decodeFunctionData({
      abi: (call.to === h.DELEGATION ? DELEGATION_ABI : erc20Abi) as Abi,
      data: call.data,
    });
    return { to: call.to, fn: decoded.functionName, args: decoded.args };
  });

beforeEach(() => {
  vi.clearAllMocks();
  h.chainKey = 'xlayer-fork';
  h.locked = true;
  h.statements.length = 0;
  vi.mocked(one).mockResolvedValue(row as never);
  vi.mocked(privy.getPrivyWallet).mockResolvedValue({
    id: 'privy-w',
    address: TREASURY.toLowerCase(),
    policy_ids: ['policy-1'],
    owner_id: 'quorum-1',
    additional_signers: [],
  });
  vi.mocked(privy.getPolicy).mockResolvedValue({
    id: 'policy-1',
    name: 'xorr wallet policy (base-fork)',
    chain_type: 'ethereum',
    rules: new Array(26).fill({}),
    owner_id: 'quorum-1',
  });
  vi.mocked(usdcOf).mockResolvedValue(1_000_000_000n);
  vi.mocked(publicClient.getBalance).mockResolvedValue(50_000_000_000_000_000n);
  vi.mocked(publicClient.getCode).mockResolvedValue('0x6080604052');
  vi.mocked(publicClient.getBlock).mockResolvedValue({ timestamp: CHAIN_NOW } as never);
  vi.mocked(publicClient.getTransactionCount).mockResolvedValue(3);
  vi.mocked(publicClient.estimateFeesPerGas).mockResolvedValue({ maxFeePerGas: 2n, maxPriorityFeePerGas: 1n } as never);
  vi.mocked(readPolicy).mockResolvedValue(null);
  vi.mocked(waitForReceipt).mockResolvedValue({ blockNumber: 100n, status: 'success' } as never);
  vi.mocked(publicClient.getBlockNumber).mockResolvedValue(100n);
  vi.mocked(readFaucetOffer).mockResolvedValue({ available: true } as never);
});

describe('creating a treasury', () => {
  beforeEach(() => {
    vi.mocked(privy.ensurePolicy).mockResolvedValue({ id: 'policy-1', owner_id: 'quorum-1' } as never);
    vi.mocked(privy.createPolicyWallet).mockResolvedValue({
      id: 'privy-w',
      address: TREASURY.toLowerCase(),
      policy_ids: ['policy-1'],
      owner_id: 'quorum-1',
      additional_signers: [],
    });
  });

  it("mints a Privy wallet under the quorum-owned policy, and files it apart from the operator's own wallets", async () => {
    vi.mocked(one).mockResolvedValueOnce(undefined).mockResolvedValueOnce(row as never);

    const out = await T.createTreasury(OPERATOR, 'Acme');

    expect(out.status, JSON.stringify(out.body)).toBe(200);
    const wallet = h.statements.find((s) => s.text.includes('INSERT INTO wallets'))!;
    expect(wallet.text).toContain("'treasury'");
    expect(wallet.params).toEqual([expect.any(String), `treasury:${OPERATOR}`, TREASURY, 'xlayer-fork']);
    const treasury = h.statements.find((s) => s.text.includes('INSERT INTO business_treasuries'))!;
    expect(treasury.params).toEqual([expect.any(String), OPERATOR, wallet.params[0], 'privy-w', 'Acme']);
    expect(append).toHaveBeenCalledWith(
      expect.objectContaining({ walletId: wallet.params[0], action: 'Treasury created', kind: 'risk' }),
      expect.anything(),
    );
    expect(out.body.treasury).toMatchObject({
      address: TREASURY,
      privy: { walletId: 'privy-w', ownerId: 'quorum-1', policyId: 'policy-1', policyOwnerId: 'quorum-1', rules: 26 },
    });
  });

  it('answers with the treasury that exists, and mints nothing', async () => {
    const out = await T.createTreasury(OPERATOR, 'Acme');

    expect(out.status).toBe(200);
    expect(out.body.note).toMatch(/already has a treasury/);
    expect(privy.createPolicyWallet).not.toHaveBeenCalled();
  });

  it('refuses a policy no key quorum owns, before any wallet exists', async () => {
    vi.mocked(one).mockResolvedValueOnce(undefined);
    vi.mocked(privy.ensurePolicy).mockResolvedValue({ id: 'policy-1', owner_id: null } as never);

    const out = await T.createTreasury(OPERATOR, 'Acme');

    expect(out).toMatchObject({ status: 409, body: { error: 'no_key_quorum' } });
    expect(privy.createPolicyWallet).not.toHaveBeenCalled();
    expect(h.statements.some((s) => s.text.includes('INSERT'))).toBe(false);
  });

  it('refuses where money is real, before Privy is asked anything', async () => {
    h.chainKey = 'xlayer';

    const out = await T.createTreasury(OPERATOR, 'Acme');

    expect(out).toMatchObject({ status: 409, body: { error: 'real_money' } });
    expect(privy.ensurePolicy).not.toHaveBeenCalled();
    expect(privy.createPolicyWallet).not.toHaveBeenCalled();
  });

  it('answers a second press at once while the first still holds the lock', async () => {
    h.locked = false;

    const out = await T.createTreasury(OPERATOR, 'Acme');

    expect(out).toMatchObject({ status: 409, body: { error: 'busy' } });
    expect(one).not.toHaveBeenCalled();
  });
});

/** The permission a $50-a-day, seven-day grant leaves, as the chain reads it back. */
const granted = livePolicy({ dailyCapUsd: 50, remainingTodayUsd: 50, spentTodayUsd: 0, expiresAt: Number(CHAIN_NOW + 7n * 86_400n) * 1000 });

describe('granting the bot', () => {
  beforeEach(() => {
    vi.mocked(readPolicy).mockResolvedValue(granted);
    vi.mocked(chainAllowance).mockImplementation(async (token) => (token === h.WETH ? maxUint256 : 0n));
    let n = 0;
    vi.mocked(transactAsTreasury).mockImplementation(async () => ({ hash: hash(++n), broadcastBy: 'executor' as const }));
    vi.mocked(recordGrant).mockResolvedValue({ status: 200, body: { ok: true } });
  });

  it("approves what is missing, then grants this executor's key until the chain's time plus the days, and records it", async () => {
    const out = await T.grantBot(row, 50, 7);

    expect(out.status, JSON.stringify(out.body)).toBe(200);
    const cap = parseUnits('50', 6);
    expect(signedFor()).toEqual([
      { to: h.USDC, fn: 'approve', args: [getAddress(h.DELEGATION), cap * 30n] },
      { to: h.CBBTC, fn: 'approve', args: [getAddress(h.DELEGATION), maxUint256] },
      { to: h.DELEGATION, fn: 'grant', args: [getAddress(h.DELEGATE), cap, CHAIN_NOW + 7n * 86_400n, [getAddress(h.ROUTER)]] },
    ]);
    for (const [call] of vi.mocked(transactAsTreasury).mock.calls) {
      expect(call).toMatchObject({ privyWalletId: 'privy-w', from: TREASURY });
    }
    expect(out.body.steps).toContainEqual({ call: 'approve WETH', tx: null, detail: 'already approved' });
    expect(recordGrant).toHaveBeenCalledWith({ id: 'wallet-t', address: TREASURY }, hash(3));
    expect(out.body.tx).toBe(hash(3));
  });

  it('approves no token that has no code on this chain', async () => {
    vi.mocked(publicClient.getCode).mockImplementation(async ({ address }) => (address === h.CBBTC ? undefined : '0x6080604052'));

    await T.grantBot(row, 50, 7);

    expect(signedFor().map((c) => c.to)).toEqual([h.USDC, h.DELEGATION]);
  });

  it('asks Privy for nothing while the treasury has no gas to send with', async () => {
    vi.mocked(publicClient.getBalance).mockResolvedValue(0n);

    const out = await T.grantBot(row, 50, 7);

    expect(out).toMatchObject({ status: 409, body: { error: 'needs_gas' } });
    expect(transactAsTreasury).not.toHaveBeenCalled();
  });

  it('says a policy refusal is the policy refusing, and records nothing', async () => {
    vi.mocked(transactAsTreasury).mockRejectedValue(new TreasuryRefused('RPC request denied due to policy violation'));

    const out = await T.grantBot(row, 50, 7);

    expect(out).toMatchObject({ status: 409, body: { error: 'refused_by_policy' } });
    expect(String(out.body.message)).toMatch(/policy violation/);
    expect(recordGrant).not.toHaveBeenCalled();
  });

  it('says so, with the hash, when a grant landed and could not be recorded', async () => {
    vi.mocked(recordGrant).mockResolvedValue({
      status: 400,
      body: { error: 'grant_superseded', message: 'That grant has since been replaced on-chain by another.' },
    });

    const out = await T.grantBot(row, 50, 7);

    expect(out).toMatchObject({ status: 502, body: { error: 'grant_not_recorded' } });
    expect(String(out.body.message)).toContain(hash(3));
  });

  it('records a grant only once the chain it reads has reached the block and shows the grant', async () => {
    // A node a block behind; then one at the block that does not show the grant yet; then the grant.
    vi.mocked(publicClient.getBlockNumber).mockResolvedValueOnce(99n);
    vi.mocked(readPolicy).mockResolvedValueOnce(null);

    const out = await T.grantBot(row, 50, 7);

    expect(out.status, JSON.stringify(out.body)).toBe(200);
    const recordedAt = vi.mocked(recordGrant).mock.invocationCallOrder[0]!;
    expect(vi.mocked(readPolicy).mock.invocationCallOrder.filter((order) => order < recordedAt)).toHaveLength(2);
    expect(vi.mocked(publicClient.getBlockNumber).mock.calls.length).toBeGreaterThanOrEqual(3);
  }, 10_000);
});

describe('trading and stopping', () => {
  it("buys through the one order path, as the treasury's own wallet", async () => {
    const walletRow = { id: 'wallet-t', address: TREASURY.toLowerCase(), kind: 'treasury', user_id: `treasury:${OPERATOR}` };
    vi.mocked(one).mockResolvedValueOnce(walletRow as never);
    vi.mocked(placeOrder).mockResolvedValue({
      placed: true,
      orderId: 'order-1',
      outcome: { status: 'filled', runId: 'run-1', signature: hash(9), units: 0.0021, price: 2400 },
    });

    const out = await T.buyForTreasury(row, 'WETH', 5);

    expect(out.status, JSON.stringify(out.body)).toBe(200);
    expect(placeOrder).toHaveBeenCalledWith(walletRow, 'WETH', 5, 'Treasury · $5 of WETH');
    expect(out.body).toMatchObject({ note: 'Bought 0.0021 WETH at $2,400.', tx: hash(9) });
  });

  it('passes a refusal on in its own words', async () => {
    vi.mocked(placeOrder).mockResolvedValue({
      placed: false,
      refusal: { status: 'blocked', reason: 'no_delegation', detail: 'No active trading permission on-chain.' },
    });

    const out = await T.buyForTreasury(row, 'WETH', 5);

    expect(out).toEqual({ status: 409, body: { error: 'no_delegation', message: 'No active trading permission on-chain.' } });
  });

  it('revokes as the treasury, and records the revoke from its own transaction', async () => {
    vi.mocked(readPolicy).mockResolvedValueOnce(livePolicy()).mockResolvedValue(livePolicy({ revoked: true }));
    vi.mocked(transactAsTreasury).mockResolvedValue({ hash: hash(4), broadcastBy: 'executor' });
    vi.mocked(recordRevoke).mockResolvedValue({ status: 200, body: { revoked: true } });

    const out = await T.revokeBot(row);

    expect(out.status, JSON.stringify(out.body)).toBe(200);
    expect(signedFor()).toMatchObject([{ to: h.DELEGATION, fn: 'revoke' }]);
    expect(recordRevoke).toHaveBeenCalledWith({ id: 'wallet-t', address: TREASURY }, hash(4));
  });

  it('records a revoke a lagging node still reads as live, once the node shows it stopped', async () => {
    vi.mocked(readPolicy)
      .mockResolvedValueOnce(livePolicy())
      .mockResolvedValueOnce(livePolicy())
      .mockResolvedValue(livePolicy({ revoked: true }));
    vi.mocked(transactAsTreasury).mockResolvedValue({ hash: hash(4), broadcastBy: 'privy' });
    vi.mocked(recordRevoke).mockResolvedValue({ status: 200, body: { revoked: true } });

    const out = await T.revokeBot(row);

    expect(out.status, JSON.stringify(out.body)).toBe(200);
    const recordedAt = vi.mocked(recordRevoke).mock.invocationCallOrder[0]!;
    expect(vi.mocked(readPolicy).mock.invocationCallOrder.filter((order) => order < recordedAt)).toHaveLength(3);
  }, 10_000);

  it('asks Privy for nothing when there is no live permission to stop', async () => {
    vi.mocked(readPolicy).mockResolvedValue(livePolicy({ revoked: true }));

    const out = await T.revokeBot(row);

    expect(out).toMatchObject({ status: 409, body: { error: 'nothing_to_stop' } });
    expect(transactAsTreasury).not.toHaveBeenCalled();
  });
});

describe('the refusal, seen', () => {
  it('asks Privy to sign — never to send — a transfer of everything the treasury holds, and records the refusal', async () => {
    vi.mocked(privy.rpcAsWallet).mockRejectedValue(
      new Error('Privy POST /wallets/privy-w/rpc → 400: RPC request denied due to policy violation'),
    );

    const out = await T.proveRefusal(row, OPERATOR_WALLET);

    expect(out.status, JSON.stringify(out.body)).toBe(200);
    expect(out.body).toMatchObject({ proven: true });
    const [walletId, request] = vi.mocked(privy.rpcAsWallet).mock.calls[0]! as [
      string,
      { method: string; params: { transaction: { to: string; data: Hex; chain_id: number; nonce: number } } },
    ];
    expect(walletId).toBe('privy-w');
    expect(request.method).toBe('eth_signTransaction');
    expect(request.params.transaction).toMatchObject({ to: h.USDC, chain_id: 8453, nonce: 3 });
    expect(decodeFunctionData({ abi: erc20Abi, data: request.params.transaction.data })).toEqual({
      functionName: 'transfer',
      args: [OPERATOR_WALLET, 1_000_000_000n],
    });
    expect(append).toHaveBeenCalledWith(
      expect.objectContaining({ walletId: 'wallet-t', action: 'Transfer out refused', kind: 'block' }),
    );
    expect(publicClient.sendRawTransaction).not.toHaveBeenCalled();
  });

  it('treats a signature as the failure it would be, and sends nothing', async () => {
    vi.mocked(privy.rpcAsWallet).mockResolvedValue({ data: { signed_transaction: '0x02f8', encoding: 'rlp' } });

    const out = await T.proveRefusal(row, OPERATOR_WALLET);

    expect(out).toMatchObject({ status: 500, body: { error: 'policy_signed_transfer', proven: false } });
    expect(publicClient.sendRawTransaction).not.toHaveBeenCalled();
    expect(append).not.toHaveBeenCalled();
  });

  it('does not count an unanswered request as a refusal', async () => {
    vi.mocked(privy.rpcAsWallet).mockRejectedValue(new Error('Privy POST /wallets/privy-w/rpc → 503: '));

    const out = await T.proveRefusal(row, OPERATOR_WALLET);

    expect(out).toMatchObject({ status: 502, body: { error: 'privy_undecided' } });
    expect(append).not.toHaveBeenCalled();
  });
});

describe('reading a treasury', () => {
  it('states the permission as the chain holds it', async () => {
    vi.mocked(readPolicy).mockResolvedValueOnce(livePolicy());
    expect((await T.treasuryView(row)).permission).toEqual({
      state: 'live',
      dailyCapUsd: 50,
      remainingUsd: 45,
      expiresAt: expect.any(Number),
    });
    vi.mocked(readPolicy).mockResolvedValueOnce(livePolicy({ revoked: true }));
    expect((await T.treasuryView(row)).permission.state).toBe('stopped');
    vi.mocked(readPolicy).mockResolvedValueOnce(livePolicy({ expiresAt: Date.now() - 1 }));
    expect((await T.treasuryView(row)).permission.state).toBe('expired');
    vi.mocked(readPolicy).mockResolvedValueOnce(null);
    expect((await T.treasuryView(row)).permission).toEqual({ state: 'none' });
  });

  it('names Privy not answering, rather than reporting no policy', async () => {
    vi.mocked(privy.getPrivyWallet).mockRejectedValue(new Error('Privy GET /wallets/privy-w → 503: '));

    await expect(T.treasuryView(row)).rejects.toBeInstanceOf(T.PrivyUnreadable);
  });
});
