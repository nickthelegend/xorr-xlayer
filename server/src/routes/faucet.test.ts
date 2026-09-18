/**
 * The faucet over HTTP (PLAN.md 4.4), with the chain, the fork node and the database stood in for.
 *
 * What a node and a database would answer — the client version, balances, receipts, the last claim, the lock — is supplied
 * per case; the decisions are the executor's own, and the receipts carry real ABI-encoded `Transfer` logs that the route
 * decodes itself. Mainnet refuses without reading anything. A fork refuses a node that is not anvil, sends from the
 * fork-only reserve by impersonation (dealing it more when it runs short), waits for the receipt and its Transfer, raises
 * the wallet's OKB by exactly what it lacks and never lowers it, and records the claim with its trail entry — and refuses
 * a second request inside a day with when it may ask again. X Layer testnet sends from the faucet key only when that key
 * holds USDC, capped, and otherwise says there is none. A balance read that fails is a 502, never a zero.
 */
import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { encodeAbiParameters, encodeEventTopics, erc20Abi, parseEther, parseUnits, toHex, type Address, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

const h = vi.hoisted(() => ({
  chainKey: 'xlayer-fork',
  locked: true,
  statements: [] as { text: string; params: unknown[] }[],
  walletClients: [] as { account: unknown }[],
  getBalance: vi.fn(),
  readContract: vi.fn(),
  getCode: vi.fn(),
  waitForTransactionReceipt: vi.fn(),
  estimateContractGas: vi.fn(),
  getGasPrice: vi.fn(),
  writeContract: vi.fn(),
  anvil: vi.fn(),
  dealErc20: vi.fn(),
  /** X Layer mainnet's USDC (Circle's native token), which a fork of it carries. */
  USDC: '0xB6CEceAB302E2E4948951eE7843FC24E92933061',
  /** Set from `FORK_USDC_RESERVE` once the module is loaded. */
  HOLDER: '' as string,
}));

vi.mock('../auth/privy.js', () => ({
  UnauthorizedError: class extends Error {
    readonly status = 401;
  },
  verifyToken: vi.fn(),
}));
vi.mock('./wallet-context.js', () => ({ currentWallet: vi.fn(), requireWallet: vi.fn(), NoWalletError: class extends Error {} }));
vi.mock('../evm/client.js', () => ({
  publicClient: {
    getBalance: h.getBalance,
    readContract: h.readContract,
    getCode: h.getCode,
    waitForTransactionReceipt: h.waitForTransactionReceipt,
    estimateContractGas: h.estimateContractGas,
    getGasPrice: h.getGasPrice,
  },
}));
vi.mock('../evm/chains.js', () => ({
  get CHAIN_KEY() {
    return h.chainKey;
  },
  get IS_MAINNET_STATE() {
    return h.chainKey === 'xlayer' || h.chainKey === 'xlayer-fork';
  },
  ADDRESSES: { usdc: h.USDC },
  chain: { id: 196 },
  rpcUrl: 'http://127.0.0.1:1',
  explorerTx: (hash: string) => `fork:${hash}`,
}));
vi.mock('../fork/anvil.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../fork/anvil.js')>()),
  anvil: h.anvil,
  dealErc20: h.dealErc20,
}));
vi.mock('viem', async (importOriginal) => ({
  ...(await importOriginal<typeof import('viem')>()),
  createWalletClient: vi.fn((opts: { account: unknown }) => {
    h.walletClients.push(opts);
    return { writeContract: h.writeContract };
  }),
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
vi.mock('../audit/log.js', () => ({ append: vi.fn(async () => undefined) }));

const { one } = await import('../db/index.js');
const { append } = await import('../audit/log.js');
const { currentWallet, requireWallet } = await import('./wallet-context.js');
const { faucetRoutes } = await import('./faucet.js');
const { errorResponse } = await import('../http/errors.js');
const { withRequestScope } = await import('../http/request-id.js');
const { FORK_USDC_RESERVE } = await import('../fork/anvil.js');
h.HOLDER = FORK_USDC_RESERVE;

const app = new Hono();
// Signed in, as the auth middleware would have decided it.
app.use('*', async (c, next) => {
  c.set('user', { userId: 'did:privy:owner' } as never);
  await next();
});
app.onError(errorResponse);
app.route('/', faucetRoutes);

const WALLET = '0x95A0b368588713011a15f4b1041423f31B08e615';
const OTHER = '0x00000000000000000000000000000000000a11ce';
const wallet = { id: 'wallet-1', address: WALLET };
/** A throwaway key — anvil's second well-known account, never funded anywhere real — as in `gasDrip.test.ts`. */
const FAUCET_KEY = '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d';
const FAUCET = privateKeyToAccount(FAUCET_KEY).address;
const TX = `0x${'ab'.repeat(32)}` as Hex;
const USDC_1000 = parseUnits('1000', 6);

const post = () => app.request('/faucet', { method: 'POST' });
const get = (path = '/faucet') => app.request(path);
const anvilMethods = () => h.anvil.mock.calls.map((call) => call[1] as string);
const claimInsert = () => h.statements.find((s) => s.text.includes('INSERT INTO faucet_claims'));

/** A receipt carrying a real ABI-encoded `Transfer` of USDC. */
function transferLog(from: string, to: string, value: bigint) {
  return {
    address: h.USDC,
    topics: encodeEventTopics({ abi: erc20Abi, eventName: 'Transfer', args: { from: from as Address, to: to as Address } }),
    data: encodeAbiParameters([{ type: 'uint256' }], [value]),
    blockNumber: 100n,
    blockHash: `0x${'cd'.repeat(32)}`,
    transactionHash: TX,
    transactionIndex: 0,
    logIndex: 0,
    removed: false,
  };
}
const receipt = (logs: unknown[], status = 'success') => ({ status, logs, transactionHash: TX, blockNumber: 100n });

/** Whatever was last sent arrives: the receipt's Transfer is from `from` to the transfer's own recipient and amount. */
function receiptsFrom(from: string) {
  h.waitForTransactionReceipt.mockImplementation(async () => {
    const [to, value] = (h.writeContract.mock.lastCall![0] as { args: [string, bigint] }).args;
    return receipt([transferLog(from, to, value)]);
  });
}

/** A fork node: anvil, USDC deployed, the holder funded, and these successive reads of the wallet's balances. */
function fork(opts: { node?: string; holderUsdc?: bigint; holderEth?: bigint; walletUsdc?: bigint[]; walletEth?: bigint[] } = {}) {
  h.chainKey = 'xlayer-fork';
  h.anvil.mockImplementation(async (_rpc: string, method: string) =>
    method === 'web3_clientVersion' ? (opts.node ?? 'anvil/v1.7.1') : null,
  );
  h.getCode.mockResolvedValue('0x6080604052');
  const usdcReads = opts.walletUsdc ?? [0n, USDC_1000];
  let usdcRead = 0;
  h.readContract.mockImplementation(async ({ args }: { args: [string] }) =>
    args[0] === h.HOLDER ? (opts.holderUsdc ?? parseUnits('24000000', 6)) : usdcReads[Math.min(usdcRead++, usdcReads.length - 1)],
  );
  const ethReads = opts.walletEth ?? [0n, parseEther('0.05')];
  let ethRead = 0;
  h.getBalance.mockImplementation(async ({ address }: { address: string }) =>
    address === h.HOLDER ? (opts.holderEth ?? 0n) : ethReads[Math.min(ethRead++, ethReads.length - 1)],
  );
  h.writeContract.mockResolvedValue(TX);
  receiptsFrom(h.HOLDER);
}

/** X Layer testnet, with a faucet key holding `usdc` and `okb`. */
function sepolia(usdc: bigint, eth = parseEther('0.018')) {
  h.chainKey = 'xlayer-testnet';
  process.env.FAUCET_PRIVATE_KEY = FAUCET_KEY;
  h.readContract.mockImplementation(async ({ args }: { args: [string] }) => (args[0] === FAUCET ? usdc : 0n));
  h.getBalance.mockResolvedValue(eth);
  h.estimateContractGas.mockResolvedValue(60_000n);
  h.getGasPrice.mockResolvedValue(1_000_000n);
  h.writeContract.mockResolvedValue(TX);
  receiptsFrom(FAUCET);
}

beforeEach(() => {
  vi.clearAllMocks();
  for (const fn of [h.getBalance, h.readContract, h.getCode, h.waitForTransactionReceipt, h.estimateContractGas, h.getGasPrice, h.writeContract, h.anvil, h.dealErc20]) {
    fn.mockReset();
  }
  vi.mocked(one).mockReset();
  vi.mocked(one).mockResolvedValue(undefined);
  h.chainKey = 'xlayer-fork';
  h.locked = true;
  h.statements.length = 0;
  h.walletClients.length = 0;
  vi.mocked(currentWallet).mockResolvedValue(wallet as never);
  vi.mocked(requireWallet).mockResolvedValue(wallet as never);
  delete process.env.FAUCET_PRIVATE_KEY;
});
afterEach(() => {
  vi.useRealTimers();
  delete process.env.FAUCET_PRIVATE_KEY;
});

describe('POST /faucet on a fork of X Layer', () => {
  it('moves 1,000 USDC from the fork-only reserve, waits for its Transfer, raises OKB by exactly the shortfall, and records it', async () => {
    fork({ walletUsdc: [0n, USDC_1000], walletEth: [parseEther('0.01'), parseEther('0.05')] });
    vi.setSystemTime(new Date('2026-09-13T12:00:00Z'));

    const res = await post();

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      status: 'sent',
      chain: 'xlayer-fork',
      source: 'fork-holder',
      from: h.HOLDER,
      to: WALLET,
      txHash: TX,
      usdc: { amount: 1000, raw: '1000000000', before: 0, after: 1000 },
      eth: { floor: 0.05, before: 0.01, added: 0.04, after: 0.05 },
      claimedAt: Date.parse('2026-09-13T12:00:00Z'),
      nextAt: Date.parse('2026-09-14T12:00:00Z'),
      recorded: true,
    });
    // Checked it is anvil, impersonated the holder, gave it gas by what it lacked, and stopped — then raised the wallet.
    expect(anvilMethods()).toEqual([
      'web3_clientVersion',
      'anvil_impersonateAccount',
      'anvil_addBalance',
      'anvil_stopImpersonatingAccount',
      'anvil_addBalance',
    ]);
    expect(h.anvil.mock.calls[1]![2]).toEqual([h.HOLDER]);
    expect(h.walletClients[0]).toMatchObject({ account: h.HOLDER });
    expect(h.writeContract).toHaveBeenCalledWith(
      expect.objectContaining({ address: h.USDC, functionName: 'transfer', args: [WALLET, USDC_1000] }),
    );
    // 0.01 held against a 0.05 floor: exactly 0.04 added. Added, never set.
    expect(h.anvil.mock.calls[4]![2]).toEqual([WALLET, toHex(parseEther('0.04'))]);
    expect(claimInsert()?.params).toEqual([
      expect.any(String),
      'wallet-1',
      WALLET,
      h.HOLDER,
      '1000000000',
      TX,
      parseEther('0.04').toString(),
      new Date('2026-09-13T12:00:00Z'),
    ]);
    expect(append).toHaveBeenCalledWith(
      expect.objectContaining({ walletId: 'wallet-1', action: 'Received 1,000 test USDC', kind: 'risk', signature: TX }),
      expect.anything(),
    );
    // The wallet's claim was held for the send and given back.
    const locks = h.statements.map((s) => s.text).filter((t) => t.includes('advisory'));
    expect(locks).toEqual([expect.stringContaining('pg_try_advisory_lock'), expect.stringContaining('pg_advisory_unlock')]);
  });

  it('never lowers a balance: a wallet already above the floor, and a holder with gas of its own, get no OKB', async () => {
    fork({ holderEth: parseEther('1'), walletEth: [parseEther('3'), parseEther('3')] });

    const body = (await (await post()).json()) as Record<string, unknown>;

    expect(body.eth).toEqual({ floor: 0.05, before: 3, added: 0, after: 3 });
    expect(anvilMethods()).not.toContain('anvil_addBalance');
    expect(anvilMethods()).not.toContain('anvil_setBalance');
    expect(claimInsert()?.params[6]).toBe('0');
  });

  it('refuses a second request inside a day with when it may ask again, reading nothing on chain; a day on, it sends', async () => {
    fork();
    vi.setSystemTime(new Date('2026-09-13T20:00:00Z'));
    vi.mocked(one).mockResolvedValue({ claimed_at: new Date('2026-09-13T12:00:00Z') });

    const res = await post();

    expect(res.status).toBe(409);
    expect(res.headers.get('retry-after')).toBe(String(16 * 3600));
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toMatchObject({
      status: 'blocked',
      reason: 'claimed_recently',
      lastClaimAt: Date.parse('2026-09-13T12:00:00Z'),
      nextAt: Date.parse('2026-09-14T12:00:00Z'),
    });
    expect(body.detail).toMatch(/can ask again at 2026-09-14 12:00 UTC/);
    expect(vi.mocked(one).mock.calls[0]![0]).toContain("chain = current_setting('xorr.chain_key')");
    expect(h.anvil).not.toHaveBeenCalled();
    expect(h.writeContract).not.toHaveBeenCalled();

    vi.setSystemTime(new Date('2026-09-14T12:00:00Z'));
    expect((await post()).status).toBe(200);
    expect(h.writeContract).toHaveBeenCalledTimes(1);
  });

  it('refuses a node that is not anvil, and impersonates nothing', async () => {
    fork({ node: 'Geth/v1.14.0-stable' });

    const res = await post();

    expect(res.status).toBe(409);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toMatchObject({ status: 'blocked', reason: 'not_anvil' });
    expect(body.detail).toContain('Geth/v1.14.0-stable');
    expect(anvilMethods()).toEqual(['web3_clientVersion']);
    expect(h.writeContract).not.toHaveBeenCalled();
    expect(append).not.toHaveBeenCalled();
  });

  it('deals the reserve more when it holds less than one request sends, then sends', async () => {
    fork({ holderUsdc: parseUnits('999', 6) });

    expect(await (await post()).json()).toMatchObject({ status: 'sent', usdc: { amount: 1000 } });
    expect(h.dealErc20).toHaveBeenCalledWith(
      expect.objectContaining({ token: h.USDC, holder: h.HOLDER, amount: parseUnits('10000000', 6) }),
    );
    expect(h.writeContract).toHaveBeenCalledTimes(1);
  });

  it('deals nothing to a reserve that holds enough', async () => {
    fork();
    expect((await post()).status).toBe(200);
    expect(h.dealErc20).not.toHaveBeenCalled();
  });

  it('records nothing for a transfer that reverted, names its hash, and still stops impersonating', async () => {
    fork();
    h.waitForTransactionReceipt.mockResolvedValue(receipt([], 'reverted'));

    const res = await post();

    expect(res.status).toBe(502);
    expect(await res.json()).toMatchObject({ status: 'failed', txHash: TX, error: expect.stringMatching(/reverted/) });
    expect(anvilMethods()).toContain('anvil_stopImpersonatingAccount');
    expect(claimInsert()).toBeUndefined();
    expect(append).not.toHaveBeenCalled();
  });

  it('records the transfer against the request’s Idempotency-Key before sending it, and sends nothing when that cannot be done', async () => {
    // A claim that answers 502 after its transfer is replayed to a retry, never sent twice (migration 025).
    fork();
    const order: string[] = [];
    h.writeContract.mockImplementation(async () => {
      order.push('send');
      return TX;
    });

    const recorded = await withRequestScope(async (scope) => {
      scope.beforeFirstBroadcast = async () => {
        order.push('recorded');
      };
      return post();
    });
    expect(recorded.status).toBe(200);
    expect(order).toEqual(['recorded', 'send']);

    const unrecorded = await withRequestScope(async (scope) => {
      scope.beforeFirstBroadcast = async () => {
        throw new Error('Connection terminated unexpectedly');
      };
      return post();
    });
    expect(unrecorded.status).toBe(502);
    expect(await unrecorded.json()).toMatchObject({ status: 'failed' });
    expect(order).toEqual(['recorded', 'send']);
    // However it ended, nothing on the node can sign as the reserve afterwards.
    expect(anvilMethods().filter((m) => m === 'anvil_stopImpersonatingAccount')).toHaveLength(2);
  });

  it('records nothing for a receipt whose Transfer went somewhere else', async () => {
    fork();
    h.waitForTransactionReceipt.mockResolvedValue(receipt([transferLog(h.HOLDER, OTHER, USDC_1000)]));

    const res = await post();

    expect(res.status).toBe(502);
    expect(await res.json()).toMatchObject({ status: 'failed', txHash: TX, error: expect.stringMatching(/without the USDC Transfer/) });
    expect(claimInsert()).toBeUndefined();
  });

  it('reports a failed OKB top-up beside the USDC that arrived, and still records the claim', async () => {
    fork();
    h.anvil.mockImplementation(async (_rpc: string, method: string, params: unknown[]) => {
      if (method === 'web3_clientVersion') return 'anvil/v1.7.1';
      if (method === 'anvil_addBalance' && params[0] === WALLET) throw new Error('anvil_addBalance: node went away');
      return null;
    });

    const body = await (await post()).json();

    expect(body).toMatchObject({ status: 'sent', eth: { floor: 0.05, failed: 'anvil_addBalance: node went away' }, recorded: true });
    expect(claimInsert()?.params[6]).toBe('0');
  });

  it('says the USDC arrived when the record of it could not be written', async () => {
    fork();
    vi.mocked(append).mockRejectedValueOnce(new Error('connection terminated'));

    const res = await post();

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ status: 'sent', txHash: TX, recorded: false, detail: expect.stringMatching(/arrived/) });
  });

  it('answers at once when this wallet is already being sent funds elsewhere, touching nothing', async () => {
    fork();
    h.locked = false;

    const res = await post();

    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ status: 'blocked', reason: 'in_flight' });
    expect(one).not.toHaveBeenCalled();
    expect(h.anvil).not.toHaveBeenCalled();
  });

  it('sends one at a time: a second wallet is impersonated for only after the first send has stopped', async () => {
    fork();
    vi.mocked(currentWallet)
      .mockResolvedValueOnce(wallet as never)
      .mockResolvedValueOnce({ id: 'wallet-2', address: OTHER } as never);

    const [first, second] = await Promise.all([post(), post()]);

    expect([first.status, second.status]).toEqual([200, 200]);
    expect(anvilMethods().filter((m) => /impersonat/i.test(m))).toEqual([
      'anvil_impersonateAccount',
      'anvil_stopImpersonatingAccount',
      'anvil_impersonateAccount',
      'anvil_stopImpersonatingAccount',
    ]);
  });

  it('answers a signed-in account with no wallet with a sentence', async () => {
    vi.mocked(currentWallet).mockResolvedValue(undefined);
    const res = await post();
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ status: 'blocked', reason: 'no_wallet' });
  });
});

describe('POST /faucet on X Layer testnet and mainnet', () => {
  it('sends nothing when the faucet key holds no USDC, and says there is none', async () => {
    sepolia(0n);

    const res = await post();

    expect(res.status).toBe(409);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toMatchObject({ status: 'blocked', reason: 'no_testnet_usdc' });
    expect(body.detail).toContain(FAUCET);
    expect(body.detail).toMatch(/holds no X Layer testnet USDC, so there is none to send/);
    expect(h.readContract).toHaveBeenCalledWith(expect.objectContaining({ functionName: 'balanceOf', args: [FAUCET] }));
    expect(h.writeContract).not.toHaveBeenCalled();
    expect(h.anvil).not.toHaveBeenCalled();
  });

  it('says so when the deployment has no faucet key, without reading the chain', async () => {
    h.chainKey = 'xlayer-testnet';
    expect(await (await post()).json()).toMatchObject({ status: 'blocked', reason: 'no_faucet_key' });
    expect(h.readContract).not.toHaveBeenCalled();
  });

  it('sends a real transfer from the faucet key, capped at ten USDC', async () => {
    sepolia(parseUnits('25', 6));

    const res = await post();

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      status: 'sent',
      source: 'faucet-key',
      from: FAUCET,
      usdc: { amount: 10, raw: '10000000' },
      eth: null,
    });
    expect((h.walletClients[0]!.account as { address: string }).address).toBe(FAUCET);
    expect(h.writeContract).toHaveBeenCalledWith(
      expect.objectContaining({ functionName: 'transfer', args: [WALLET, parseUnits('10', 6)] }),
    );
    expect(h.anvil).not.toHaveBeenCalled();
    expect(append).toHaveBeenCalledWith(expect.objectContaining({ action: 'Received 10 test USDC', signature: TX }), expect.anything());
  });

  it('sends what the key has when that is less than the cap', async () => {
    sepolia(parseUnits('4', 6));
    expect(await (await post()).json()).toMatchObject({ status: 'sent', usdc: { amount: 4, raw: '4000000' } });
  });

  it('sends nothing when the faucet key cannot pay for the transfer', async () => {
    sepolia(parseUnits('25', 6), 0n);
    expect(await (await post()).json()).toMatchObject({ status: 'blocked', reason: 'faucet_out_of_gas' });
    expect(h.writeContract).not.toHaveBeenCalled();
  });

  it('refuses on X Layer mainnet before reading the chain or the database', async () => {
    h.chainKey = 'xlayer';

    const res = await post();

    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ status: 'blocked', reason: 'real_money' });
    expect(one).not.toHaveBeenCalled();
    expect(h.readContract).not.toHaveBeenCalled();
    expect(h.statements).toEqual([]);
  });

  it('refuses on a chain whose money is real that is not X Layer, before reading the chain or the database', async () => {
    h.chainKey = 'arbitrum';

    const res = await post();

    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ status: 'blocked', reason: 'real_money' });
    expect(one).not.toHaveBeenCalled();
    expect(h.readContract).not.toHaveBeenCalled();
    expect(h.statements).toEqual([]);
  });
});

describe('GET /faucet', () => {
  it('on a fork, says what one request sends and when this wallet may ask again, and sends nothing', async () => {
    fork();
    vi.setSystemTime(new Date('2026-09-13T20:00:00Z'));
    vi.mocked(one).mockResolvedValue({ claimed_at: new Date('2026-09-13T12:00:00Z') });

    const res = await get();

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      chain: 'xlayer-fork',
      available: true,
      reason: null,
      detail: expect.stringMatching(/^1,000 USDC sent from a fork-only reserve on this fork of X Layer/),
      source: 'fork-holder',
      from: h.HOLDER,
      usdc: 1000,
      usdcRaw: '1000000000',
      ethFloor: 0.05,
      windowHours: 24,
      wallet: {
        address: WALLET,
        lastClaimAt: Date.parse('2026-09-13T12:00:00Z'),
        nextAt: Date.parse('2026-09-14T12:00:00Z'),
        canAsk: false,
      },
    });
    expect(anvilMethods()).toEqual(['web3_clientVersion']);
    expect(h.writeContract).not.toHaveBeenCalled();
  });

  it('on X Layer testnet with an empty faucet key, is unavailable and says why', async () => {
    sepolia(0n);
    expect(await (await get()).json()).toMatchObject({
      available: false,
      reason: 'no_testnet_usdc',
      usdc: null,
      wallet: { address: WALLET, nextAt: null, canAsk: false },
    });
  });

  it('on X Layer mainnet, reads nothing on chain', async () => {
    h.chainKey = 'xlayer';
    expect(await (await get()).json()).toMatchObject({ available: false, reason: 'real_money', wallet: { canAsk: false } });
    expect(h.readContract).not.toHaveBeenCalled();
    expect(h.anvil).not.toHaveBeenCalled();
  });

  it('on a chain whose money is real that is not X Layer, reads nothing on chain either', async () => {
    h.chainKey = 'arbitrum';
    expect(await (await get()).json()).toMatchObject({
      available: false,
      reason: 'real_money',
      detail: expect.stringContaining('settles on arbitrum, where USDC is real money'),
      wallet: { canAsk: false },
    });
    expect(h.readContract).not.toHaveBeenCalled();
    expect(h.anvil).not.toHaveBeenCalled();
  });
});

describe('GET /wallet/funds', () => {
  it("reads the wallet's USDC and OKB from the chain", async () => {
    h.readContract.mockResolvedValue(USDC_1000);
    h.getBalance.mockResolvedValue(parseEther('0.05'));

    const res = await get('/wallet/funds');

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      owner: WALLET,
      chain: 'xlayer-fork',
      usdc: { address: h.USDC, raw: '1000000000', amount: 1000 },
      eth: { raw: '50000000000000000', amount: 0.05 },
    });
    expect(h.readContract).toHaveBeenCalledWith(expect.objectContaining({ functionName: 'balanceOf', args: [WALLET] }));
  });

  it('answers a read that failed with a 502, never with a zero', async () => {
    h.readContract.mockRejectedValue(new Error('socket hang up'));
    h.getBalance.mockResolvedValue(parseEther('0.05'));

    const res = await get('/wallet/funds');

    expect(res.status).toBe(502);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toMatchObject({ error: 'chain_read_failed', message: 'Could not read your balances from the chain just now.' });
    expect(body).not.toHaveProperty('usdc');
    expect(body).not.toHaveProperty('eth');
  });
});
