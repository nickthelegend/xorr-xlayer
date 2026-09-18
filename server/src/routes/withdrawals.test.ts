/**
 * Withdrawals over HTTP (PLAN.md 4.9), with the book, the chain and the database stood in for.
 *
 * The book's own rules are `withdrawals/allowlist.test.ts`. What is pinned here is how the routes use it: the add route
 * never shortens the wait, a refused destination is written to the trail and stops `prepare-all` before the chain is
 * read, the transfer `prepare-all` builds decodes to exactly the chosen destination and the whole balance, and `record`
 * believes the receipt rather than the request — writing each outgoing transfer once, and as a risk when its
 * destination was not usable.
 */
import { Hono } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  decodeFunctionData,
  encodeAbiParameters,
  encodeEventTopics,
  erc20Abi,
  getAddress,
  isAddress,
  keccak256,
  toHex,
  zeroAddress,
  type Address,
  type Hex,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

const h = vi.hoisted(() => ({
  /** Whether the trail already carries the hash being recorded. */
  seen: false,
  /** X Layer mainnet's USDC and WETH. */
  USDC: '0xB6CEceAB302E2E4948951eE7843FC24E92933061',
  WETH: '0x5A77f1443D16ee5761d310e38b62f77f726bC71c',
  NATIVE: '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE',
  POOL: '0xA238Dd80C259a72e81d7e4664a9801593F98d1c5',
}));

vi.mock('../auth/privy.js', () => ({
  UnauthorizedError: class extends Error {
    readonly status = 401;
  },
  verifyToken: vi.fn(),
}));
vi.mock('./wallet-context.js', () => ({ currentWallet: vi.fn(), NoWalletError: class extends Error {} }));
vi.mock('../withdrawals/allowlist.js', () => ({
  COOLING_OFF_HOURS: 24,
  MAX_LABEL: 40,
  addAddress: vi.fn(),
  removeAddress: vi.fn(),
  listAddresses: vi.fn(),
  destinationStatus: vi.fn(),
  isValidAddress: (addr: string) => isAddress(addr.trim(), { strict: false }) || /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(addr.trim()),
  formatAddress: (addr: string) => (isAddress(addr.trim(), { strict: false }) ? getAddress(addr.trim()) : addr.trim()),
}));
vi.mock('../db/index.js', () => ({
  one: vi.fn(),
  query: vi.fn(),
  tx: async (fn: (client: unknown) => Promise<unknown>) =>
    fn({
      query: async (text: string) => {
        const hit = /FROM audit_log/.test(text) && h.seen;
        return { rows: hit ? [{ found: 1 }] : [], rowCount: hit ? 1 : 0 };
      },
    }),
}));
vi.mock('../audit/log.js', () => ({ append: vi.fn(async () => undefined) }));
vi.mock('../evm/client.js', () => ({ publicClient: { readContract: vi.fn(), getTransactionReceipt: vi.fn() } }));
vi.mock('../evm/chains.js', () => ({
  AAVE_V3_POOL: h.POOL,
  ADDRESSES: { usdc: h.USDC, weth: h.WETH, nativeToken: h.NATIVE },
  explorerTx: (hash: string) => `fork:${hash}`,
}));
vi.mock('../evm/delegation.js', () => ({ waitForTx: vi.fn() }));
vi.mock('../venues/tokens.js', () => ({
  canonicalSymbol: (raw: string) =>
    ({ USDC: 'USDC', WETH: 'WETH', OKB: 'OKB' } as Record<string, string>)[raw.trim().toUpperCase()] ?? raw.trim(),
}));
vi.mock('../portfolio/snapshots.js', () => ({ snapshotWallet: vi.fn(async () => true) }));
vi.mock('./market.js', () => ({
  functioningHere: vi.fn(async () => [
    { symbol: 'OKB', address: h.NATIVE, decimals: 18 },
    { symbol: 'WETH', address: h.WETH, decimals: 18 },
    { symbol: 'USDC', address: h.USDC, decimals: 6 },
  ]),
}));

const { currentWallet } = await import('./wallet-context.js');
const book = await import('../withdrawals/allowlist.js');
const { append } = await import('../audit/log.js');
const { publicClient } = await import('../evm/client.js');
const { waitForTx } = await import('../evm/delegation.js');
const { snapshotWallet } = await import('../portfolio/snapshots.js');
const { transfersIn, withdrawalRoutes } = await import('./withdrawals.js');
const { errorResponse } = await import('../http/errors.js');

const app = new Hono();
// Who is calling, as the auth middleware would have decided it.
app.use('*', async (c, next) => {
  if (c.req.header('x-test-caller') === 'user') c.set('user', { userId: 'did:privy:owner' } as never);
  await next();
});
app.onError(errorResponse);
app.route('/', withdrawalRoutes);

const account = (seed: string) => privateKeyToAccount(keccak256(toHex(seed))).address;
const OWNER = account('xorr/withdrawals/owner');
const DEST = account('xorr/withdrawals/cold-storage');
const STRANGER = account('xorr/withdrawals/stranger');
/** A stand-in for Aave's receipt token: only its burn and its payout are read, never its code. */
const A_USDC = getAddress('0x000000000000000000000000000000000000a05d');
const HASH = `0x${'ab'.repeat(32)}` as Hex;
const USABLE_AT = Date.UTC(2026, 8, 14, 9, 30);

const wallet = { id: 'wallet-1', address: OWNER, agents_stopped: false };
const ENTRY = { address: DEST, label: 'Cold storage', addedAt: USABLE_AT - 86_400_000, usableAt: USABLE_AT, usable: false };
const USABLE = { usable: true as const, address: DEST, label: 'Cold storage', usableAt: USABLE_AT };
const COOLING = {
  usable: false as const,
  reason: 'cooling_off' as const,
  detail: 'Cold storage is still cooling off.',
  address: DEST,
  label: 'Cold storage',
  usableAt: USABLE_AT,
};
const NOT_LISTED = { usable: false as const, reason: 'not_allowlisted' as const, detail: 'Not on your withdrawal allowlist.' };

async function call(path: string, body?: unknown): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await app.request(path, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { 'content-type': 'application/json', 'x-test-caller': 'user' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

const transferLog = (token: string, from: string, to: string, value: bigint) => ({
  address: token,
  topics: encodeEventTopics({ abi: erc20Abi, eventName: 'Transfer', args: { from: from as Address, to: to as Address } }),
  data: encodeAbiParameters([{ type: 'uint256' }], [value]),
});
const receipt = (over: Record<string, unknown>) => ({ from: OWNER, to: h.USDC, status: 'success', logs: [], ...over });

beforeEach(() => {
  vi.clearAllMocks();
  h.seen = false;
  vi.mocked(currentWallet).mockResolvedValue(wallet as never);
});

describe('the book', () => {
  it('asks for a wallet before anything else', async () => {
    vi.mocked(currentWallet).mockResolvedValue(undefined);
    expect(await call('/withdrawal-addresses')).toMatchObject({ status: 409, body: { status: 'blocked', reason: 'no_wallet' } });
    expect(book.listAddresses).not.toHaveBeenCalled();
  });

  it('lists with the cooling-off and the clock the flags were decided by', async () => {
    vi.mocked(book.listAddresses).mockResolvedValue({ serverTime: USABLE_AT - 3_600_000, addresses: [ENTRY] });
    const res = await call('/withdrawal-addresses');
    expect(res).toEqual({
      status: 200,
      body: { coolingOffHours: 24, serverTime: USABLE_AT - 3_600_000, addresses: [ENTRY] },
    });
    expect(book.listAddresses).toHaveBeenCalledWith('wallet-1');
  });

  it('adds with the full cooling-off: the route never passes a shorter one', async () => {
    vi.mocked(book.addAddress).mockResolvedValue({ status: 'added', entry: ENTRY });
    const res = await call('/withdrawal-addresses', { label: 'Cold storage', address: DEST });
    expect(res).toMatchObject({ status: 201, body: { status: 'added', coolingOffHours: 24, entry: ENTRY } });
    // Two arguments, so the book's own default — the 24 hours — is the wait.
    expect(vi.mocked(book.addAddress).mock.calls[0]).toEqual(['wallet-1', { label: 'Cold storage', address: DEST }]);
  });

  it('answers a refusal with the book’s own sentence, and a malformed body without asking it', async () => {
    vi.mocked(book.addAddress).mockResolvedValue({
      status: 'blocked',
      reason: 'already_listed',
      detail: 'Already there.',
      entry: ENTRY,
    });
    expect(await call('/withdrawal-addresses', { label: 'Again', address: DEST })).toMatchObject({
      status: 409,
      body: { status: 'blocked', reason: 'already_listed', detail: 'Already there.', entry: ENTRY },
    });
    expect(await call('/withdrawal-addresses', { label: 'Cold storage', address: 'cold storage' })).toMatchObject({
      status: 400,
      body: { error: 'invalid_request' },
    });
    expect(book.addAddress).toHaveBeenCalledTimes(1);
  });

  it('answers the zero address as a malformed body, not as a conflict with what the book holds', async () => {
    vi.mocked(book.addAddress).mockResolvedValue({
      status: 'blocked',
      reason: 'zero_address',
      detail: 'That is the zero address. Anything sent there is gone for good, so it cannot be a destination.',
    } as never);
    expect(await call('/withdrawal-addresses', { label: 'Burn', address: zeroAddress })).toMatchObject({
      status: 400,
      body: { status: 'blocked', reason: 'zero_address' },
    });
  });

  it('removes, and says when there was nothing to remove', async () => {
    vi.mocked(book.removeAddress).mockResolvedValueOnce({ status: 'removed', address: DEST, label: 'Cold storage' });
    expect(await call('/withdrawal-addresses/remove', { address: DEST })).toMatchObject({ status: 200, body: { status: 'removed' } });
    vi.mocked(book.removeAddress).mockResolvedValueOnce({ status: 'blocked', reason: 'not_listed', detail: 'Not there.' });
    expect(await call('/withdrawal-addresses/remove', { address: DEST })).toMatchObject({
      status: 404,
      body: { reason: 'not_listed' },
    });
  });
});

describe('the check before a signature', () => {
  it('says usable only when the book does', async () => {
    vi.mocked(book.destinationStatus).mockResolvedValue(USABLE);
    expect(await call('/withdrawal-addresses/check', { address: DEST })).toEqual({
      status: 200,
      body: { status: 'usable', address: DEST, label: 'Cold storage', usableAt: USABLE_AT },
    });
    expect(append).not.toHaveBeenCalled();
  });

  it('refuses an address still cooling off, says until when, and writes the refusal to the trail', async () => {
    vi.mocked(book.destinationStatus).mockResolvedValue(COOLING);
    expect(await call('/withdrawal-addresses/check', { address: DEST })).toMatchObject({
      status: 409,
      body: { status: 'blocked', reason: 'cooling_off', detail: COOLING.detail, usableAt: USABLE_AT, label: 'Cold storage' },
    });
    expect(append).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'block',
        action: 'Withdrawal refused',
        payload: expect.objectContaining({ reason: 'cooling_off', via: 'check', usableAt: USABLE_AT }),
      }),
    );
  });

  it('refuses an address that is not on the list', async () => {
    vi.mocked(book.destinationStatus).mockResolvedValue(NOT_LISTED);
    expect(await call('/withdrawal-addresses/check', { address: STRANGER })).toMatchObject({
      status: 409,
      body: { reason: 'not_allowlisted' },
    });
    expect(append).toHaveBeenCalledWith(expect.objectContaining({ kind: 'block' }));
  });
});

describe('preparing a withdrawal of everything', () => {
  it('refuses a destination that is not usable, and reads nothing from the chain', async () => {
    vi.mocked(book.destinationStatus).mockResolvedValue(COOLING);
    expect(await call('/withdrawals/prepare-all', { to: DEST, token: 'USDC' })).toMatchObject({
      status: 409,
      body: { reason: 'cooling_off', usableAt: USABLE_AT },
    });
    expect(publicClient.readContract).not.toHaveBeenCalled();
    expect(append).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'block', payload: expect.objectContaining({ via: 'prepare-all' }) }),
    );
  });

  it('moves the whole balance, to the unit, to exactly the destination', async () => {
    vi.mocked(book.destinationStatus).mockResolvedValue(USABLE);
    vi.mocked(publicClient.readContract).mockResolvedValue(1_234_567_891n as never);
    const res = await call('/withdrawals/prepare-all', { to: DEST.toLowerCase(), token: 'usdc' });

    expect(res.status).toBe(200);
    const body = res.body as { call: { to: string; data: Hex } };
    expect(body.call.to).toBe(getAddress(h.USDC));
    const decoded = decodeFunctionData({ abi: erc20Abi, data: body.call.data });
    expect(decoded.functionName).toBe('transfer');
    expect(decoded.args).toEqual([DEST, 1_234_567_891n]);
    expect(res.body).toMatchObject({
      status: 'prepared',
      amount: '1234.567891',
      amountRaw: '1234567891',
      token: { symbol: 'USDC', address: getAddress(h.USDC), decimals: 6 },
      destination: { address: DEST, label: 'Cold storage' },
    });
    expect(publicClient.readContract).toHaveBeenCalledWith(
      expect.objectContaining({ address: getAddress(h.USDC), functionName: 'balanceOf', args: [OWNER] }),
    );
  });

  it('refuses what it cannot or should not move', async () => {
    vi.mocked(book.destinationStatus).mockResolvedValue(USABLE);
    expect(await call('/withdrawals/prepare-all', { to: DEST, token: 'OKB' })).toMatchObject({
      status: 400,
      body: { reason: 'native_token' },
    });
    expect(await call('/withdrawals/prepare-all', { to: DEST, token: 'DOGE' })).toMatchObject({
      status: 400,
      body: { reason: 'unknown_token' },
    });
    expect(publicClient.readContract).not.toHaveBeenCalled();

    vi.mocked(publicClient.readContract).mockResolvedValue(0n as never);
    expect(await call('/withdrawals/prepare-all', { to: DEST, token: 'USDC' })).toMatchObject({
      status: 409,
      body: { reason: 'nothing_to_send' },
    });
  });

  it('answers a balance it could not read as a failed read, never as nothing to send', async () => {
    vi.mocked(book.destinationStatus).mockResolvedValue(USABLE);
    vi.mocked(publicClient.readContract).mockRejectedValue(new Error('socket hang up'));
    expect(await call('/withdrawals/prepare-all', { to: DEST, token: 'USDC' })).toMatchObject({
      status: 502,
      body: { error: 'chain_read_failed' },
    });
  });
});

describe('recording a withdrawal the owner signed', () => {
  it('records nothing for a hash the chain does not have', async () => {
    vi.mocked(waitForTx).mockResolvedValue(undefined);
    expect(await call('/withdrawals/record', { txHash: HASH })).toMatchObject({ status: 404, body: { status: 'unknown' } });
    expect(publicClient.getTransactionReceipt).not.toHaveBeenCalled();
    expect(append).not.toHaveBeenCalled();
  });

  it('refuses a transaction another wallet sent', async () => {
    vi.mocked(waitForTx).mockResolvedValue(true);
    vi.mocked(publicClient.getTransactionReceipt).mockResolvedValue(
      receipt({ from: STRANGER, logs: [transferLog(h.USDC, STRANGER, DEST, 1n)] }) as never,
    );
    expect(await call('/withdrawals/record', { txHash: HASH })).toMatchObject({
      status: 403,
      body: { reason: 'not_your_transaction' },
    });
    expect(append).not.toHaveBeenCalled();
  });

  it('writes a send to a usable address as the withdrawal it was — once, however often it is reported', async () => {
    vi.mocked(waitForTx).mockResolvedValue(true);
    vi.mocked(publicClient.getTransactionReceipt).mockResolvedValue(
      receipt({ logs: [transferLog(h.USDC, OWNER, DEST, 25_000_000n)] }) as never,
    );
    vi.mocked(book.destinationStatus).mockResolvedValue(USABLE);

    expect(await call('/withdrawals/record', { txHash: HASH })).toMatchObject({
      status: 200,
      body: {
        status: 'confirmed',
        duplicate: false,
        aave: null,
        transfers: [{ symbol: 'USDC', to: DEST, amount: '25', amountRaw: '25000000', usable: true, label: 'Cold storage' }],
      },
    });
    expect(append).toHaveBeenCalledTimes(1);
    expect(append).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'trade', action: 'Sent 25 USDC to Cold storage', signature: HASH }),
      expect.anything(),
    );
    expect(snapshotWallet).toHaveBeenCalledWith({ id: 'wallet-1', address: OWNER }, 'withdrawal');

    vi.mocked(append).mockClear();
    vi.mocked(snapshotWallet).mockClear();
    h.seen = true;
    expect((await call('/withdrawals/record', { txHash: HASH })).body).toMatchObject({ status: 'confirmed', duplicate: true });
    expect(append).not.toHaveBeenCalled();
    expect(snapshotWallet).not.toHaveBeenCalled();
  });

  it('writes a send to an address the allowlist does not clear as a risk', async () => {
    vi.mocked(waitForTx).mockResolvedValue(true);
    vi.mocked(publicClient.getTransactionReceipt).mockResolvedValue(
      receipt({ to: h.WETH, logs: [transferLog(h.WETH, OWNER, STRANGER, 10n ** 17n)] }) as never,
    );
    vi.mocked(book.destinationStatus).mockResolvedValue(NOT_LISTED);

    expect((await call('/withdrawals/record', { txHash: HASH })).body).toMatchObject({
      status: 'confirmed',
      transfers: [{ symbol: 'WETH', to: STRANGER, amount: '0.1', usable: false, label: null }],
    });
    expect(append).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'risk',
        action: 'Sent 0.1 WETH to an address your allowlist does not clear',
        detail: expect.stringContaining('is not on your allowlist'),
      }),
      expect.anything(),
    );
  });

  it('records a reverted transaction as moving nothing', async () => {
    vi.mocked(waitForTx).mockResolvedValue(false);
    vi.mocked(publicClient.getTransactionReceipt).mockResolvedValue(receipt({ status: 'reverted' }) as never);

    expect(await call('/withdrawals/record', { txHash: HASH })).toMatchObject({ status: 200, body: { status: 'reverted' } });
    expect(append).toHaveBeenCalledTimes(1);
    expect(append).toHaveBeenCalledWith(expect.objectContaining({ kind: 'risk', action: 'Withdrawal reverted' }), expect.anything());
    expect(book.destinationStatus).not.toHaveBeenCalled();
  });

  it('records the exit from Aave as yield, and the burn of the receipt token as nothing leaving', async () => {
    vi.mocked(waitForTx).mockResolvedValue(true);
    vi.mocked(publicClient.getTransactionReceipt).mockResolvedValue(
      receipt({
        to: h.POOL,
        logs: [transferLog(A_USDC, OWNER, zeroAddress, 100_500_000n), transferLog(h.USDC, A_USDC, OWNER, 100_500_000n)],
      }) as never,
    );

    expect((await call('/withdrawals/record', { txHash: HASH })).body).toMatchObject({
      status: 'confirmed',
      transfers: [],
      aave: { amount: '100.5', amountRaw: '100500000' },
    });
    expect(book.destinationStatus).not.toHaveBeenCalled();
    expect(append).toHaveBeenCalledTimes(1);
    expect(append).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'yield', action: 'Withdrew 100.5 USDC from Aave' }),
      expect.anything(),
    );
  });

  it('reads only ERC-20 transfers out of a receipt', () => {
    const ERC721 = [
      {
        type: 'event',
        name: 'Transfer',
        inputs: [
          { name: 'from', type: 'address', indexed: true },
          { name: 'to', type: 'address', indexed: true },
          { name: 'tokenId', type: 'uint256', indexed: true },
        ],
      },
    ] as const;
    const nft = {
      address: h.WETH,
      topics: encodeEventTopics({ abi: ERC721, eventName: 'Transfer', args: { from: OWNER, to: DEST, tokenId: 5n } }),
      data: '0x',
    };
    expect(transfersIn([nft, transferLog(h.USDC, OWNER, DEST, 7n)] as never)).toEqual([
      { token: getAddress(h.USDC), from: OWNER, to: DEST, value: 7n },
    ]);
  });
});
