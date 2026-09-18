/**
 * A treasury's call reaches the chain the way the chain allows, and only as the call that was asked for (PLAN.md 4.14).
 *
 * Privy stands in for itself here with real signatures: each "answer" is a transaction signed by a real key, so the
 * checks that decide whether bytes may be sent run against genuine RLP and genuine ECDSA.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { encodeFunctionData, erc20Abi, type Hex } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';

const env = vi.hoisted(() => ({ chain: 'base-fork' as string }));
vi.mock('../evm/chains.js', () => ({
  get CHAIN_KEY() {
    return env.chain;
  },
  get chain() {
    return { id: env.chain === 'base-sepolia' ? 84532 : 8453 };
  },
}));
vi.mock('../auth/privyPolicy.js', () => ({ rpcAsWallet: vi.fn() }));
vi.mock('../evm/client.js', () => ({
  publicClient: {
    getTransactionCount: vi.fn(),
    estimateGas: vi.fn(),
    estimateFeesPerGas: vi.fn(),
    sendRawTransaction: vi.fn(),
  },
}));
vi.mock('../evm/delegation.js', () => ({ waitForTx: vi.fn() }));
vi.mock('../http/request-id.js', () => ({ markBroadcast: vi.fn() }));

const { rpcAsWallet } = await import('../auth/privyPolicy.js');
const { publicClient } = await import('../evm/client.js');
const { waitForTx } = await import('../evm/delegation.js');
const { transactAsTreasury, TreasuryRefused } = await import('./treasurySigner.js');

const treasury = privateKeyToAccount(generatePrivateKey());
const stranger = privateKeyToAccount(generatePrivateKey());
const DELEGATION = '0xc32dD8AeED3035D46C7c82A351fC5522c9D463f4';
const USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const approve = encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [DELEGATION, 1_000n] });
const call = { privyWalletId: 'wallet-1', from: treasury.address, to: USDC, data: approve } as const;
const HASH = `0x${'ab'.repeat(32)}` as Hex;

/** What Privy's signer would hand back: the transaction, signed by `by`. */
const signed = (by = treasury, over: { data?: Hex; nonce?: number; to?: `0x${string}` } = {}) =>
  by.signTransaction({
    to: over.to ?? USDC,
    data: over.data ?? approve,
    value: 0n,
    chainId: 8453,
    nonce: over.nonce ?? 7,
    gas: 75_000n,
    maxFeePerGas: 2n,
    maxPriorityFeePerGas: 1n,
    type: 'eip1559',
  });

beforeEach(() => {
  vi.clearAllMocks();
  env.chain = 'base-fork';
  vi.mocked(publicClient.getTransactionCount).mockResolvedValue(7);
  vi.mocked(publicClient.estimateGas).mockResolvedValue(60_000n);
  vi.mocked(publicClient.estimateFeesPerGas).mockResolvedValue({ maxFeePerGas: 2n, maxPriorityFeePerGas: 1n } as never);
  vi.mocked(publicClient.sendRawTransaction).mockResolvedValue(HASH);
  vi.mocked(waitForTx).mockResolvedValue(true);
});

describe('on a fork, Privy signs and the executor sends', () => {
  it("signs with the fork's own nonce, gas and fees, and sends the bytes once they are the call asked for", async () => {
    const raw = await signed();
    vi.mocked(rpcAsWallet).mockResolvedValue({ data: { signed_transaction: raw, encoding: 'rlp' } });

    await expect(transactAsTreasury(call)).resolves.toEqual({ hash: HASH, broadcastBy: 'executor' });

    expect(rpcAsWallet).toHaveBeenCalledWith('wallet-1', {
      method: 'eth_signTransaction',
      params: {
        transaction: {
          to: USDC,
          data: approve,
          value: '0x0',
          chain_id: 8453,
          nonce: 7,
          gas_limit: '0x124f8', // 60,000 and a quarter
          max_fee_per_gas: '0x2',
          max_priority_fee_per_gas: '0x1',
          type: 2,
        },
      },
    });
    expect(publicClient.sendRawTransaction).toHaveBeenCalledWith({ serializedTransaction: raw });
  });

  it('sends nothing Privy signed for other calldata', async () => {
    const other = encodeFunctionData({ abi: erc20Abi, functionName: 'transfer', args: [stranger.address, 1_000n] });
    vi.mocked(rpcAsWallet).mockResolvedValue({ data: { signed_transaction: await signed(treasury, { data: other }) } });

    await expect(transactAsTreasury(call)).rejects.toThrow(/signed a different transaction \(with other calldata\)/);
    expect(publicClient.sendRawTransaction).not.toHaveBeenCalled();
  });

  it('sends nothing signed by any key but the treasury', async () => {
    vi.mocked(rpcAsWallet).mockResolvedValue({ data: { signed_transaction: await signed(stranger) } });

    await expect(transactAsTreasury(call)).rejects.toThrow(/signed a different transaction \(by 0x/);
    expect(publicClient.sendRawTransaction).not.toHaveBeenCalled();
  });

  it('sends nothing for a nonce the fork did not give', async () => {
    vi.mocked(rpcAsWallet).mockResolvedValue({ data: { signed_transaction: await signed(treasury, { nonce: 3 }) } });

    await expect(transactAsTreasury(call)).rejects.toThrow(/with nonce 3/);
    expect(publicClient.sendRawTransaction).not.toHaveBeenCalled();
  });

  it('names a policy refusal as the policy refusing, not as a failure', async () => {
    vi.mocked(rpcAsWallet).mockRejectedValue(new Error('Privy POST /wallets/wallet-1/rpc → 400: RPC request denied due to policy violation'));

    await expect(transactAsTreasury(call)).rejects.toBeInstanceOf(TreasuryRefused);
  });

  it('reports a transaction that reverted as not taken', async () => {
    vi.mocked(rpcAsWallet).mockResolvedValue({ data: { signed_transaction: await signed() } });
    vi.mocked(waitForTx).mockResolvedValue(false);

    await expect(transactAsTreasury(call)).rejects.toThrow(/reverted/);
  });
});

describe('where Privy knows the chain, Privy sends', () => {
  it("asks for eth_sendTransaction on Base Sepolia and waits for Privy's transaction", async () => {
    env.chain = 'base-sepolia';
    vi.mocked(rpcAsWallet).mockResolvedValue({ method: 'eth_sendTransaction', data: { hash: HASH, caip2: 'eip155:84532' } });

    await expect(transactAsTreasury(call)).resolves.toEqual({ hash: HASH, broadcastBy: 'privy' });
    expect(rpcAsWallet).toHaveBeenCalledWith('wallet-1', {
      method: 'eth_sendTransaction',
      caip2: 'eip155:84532',
      params: { transaction: { to: USDC, data: approve, value: '0x0', chain_id: 84532 } },
    });
    expect(publicClient.sendRawTransaction).not.toHaveBeenCalled();
  });
});

describe('never where money is real', () => {
  it('refuses on Base before asking Privy for anything', async () => {
    env.chain = 'base';

    await expect(transactAsTreasury(call)).rejects.toThrow(/money is real/);
    expect(rpcAsWallet).not.toHaveBeenCalled();
  });
});
