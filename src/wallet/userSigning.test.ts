/**
 * How a person's transaction reaches the chain (PLAN.md 4.1, 4.6), with a wallet that signs for real — a local key
 * standing in for Privy's provider — so what the check refuses is a real signature over real bytes, not a string.
 */
import { describe, expect, it, vi } from 'vitest';
import { encodeFunctionData, erc20Abi, keccak256, parseTransaction, toHex, type Hex, type TransactionSerializable } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import {
  WrongChainError,
  estimateUserFee,
  sendAsUser,
  type ChainAccess,
  type UserSigner,
  type WalletProvider,
} from './userSigning';

const FORK = { id: 196, name: 'X Layer (local fork)' };
const USDC = '0xB6CEceAB302E2E4948951eE7843FC24E92933061';
const DELEGATION = '0xc32dd8aeed3035d46c7c82a351fc5522c9d463f4';
const DATA = encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [DELEGATION, 1_000_000n] });

type WalletOptions = {
  /** What `eth_chainId` answers; null for a wallet that will not say. */
  chainId?: number | string | null;
  switchFails?: boolean;
  /** Sign something other than what was asked. */
  tamper?: (tx: TransactionSerializable) => TransactionSerializable;
  /** Sign with another key than the wallet's own. */
  otherSigner?: boolean;
};

/** A wallet provider that really signs, as Privy's does, and can be told to misbehave. */
function wallet(opts: WalletOptions = {}) {
  const account = privateKeyToAccount(generatePrivateKey());
  const signer = opts.otherSigner ? privateKeyToAccount(generatePrivateKey()) : account;
  const calls: { method: string; params?: unknown[] }[] = [];
  const provider: WalletProvider = {
    async request({ method, params }) {
      calls.push({ method, params });
      switch (method) {
        case 'wallet_switchEthereumChain':
          if (opts.switchFails) throw new Error('Unrecognized chain');
          return null;
        case 'eth_chainId':
          if (opts.chainId === null) throw new Error('no answer');
          return opts.chainId ?? '0xc4';
        case 'eth_signTransaction': {
          const t = params![0] as Record<string, string | number>;
          const tx: TransactionSerializable = {
            type: 'eip1559',
            chainId: Number(t.chainId),
            to: t.to as Hex,
            data: t.data as Hex,
            value: BigInt(t.value as string),
            nonce: Number(BigInt(t.nonce as string)),
            gas: BigInt(t.gasLimit as string),
            maxFeePerGas: BigInt(t.maxFeePerGas as string),
            maxPriorityFeePerGas: BigInt(t.maxPriorityFeePerGas as string),
          };
          return signer.signTransaction(opts.tamper ? opts.tamper(tx) : tx);
        }
        case 'eth_estimateGas':
          return '0xc350';
        case 'eth_gasPrice':
          return '0x3b9aca00';
        case 'eth_sendTransaction':
          return `0x${'ab'.repeat(32)}`;
        default:
          throw new Error(`unexpected ${method}`);
      }
    },
  };
  return { address: account.address, provider, calls, methods: () => calls.map((c) => c.method) };
}

/** The fork, as the app reads it: a nonce, a gas estimate, fees, and a broadcast that keeps what it was given. */
function fork(over: Partial<Record<keyof ChainAccess, unknown>> = {}) {
  const sent: Hex[] = [];
  const access = {
    getTransactionCount: vi.fn(async () => 7),
    estimateGas: vi.fn(async () => 55_819n),
    estimateFeesPerGas: vi.fn(async () => ({ maxFeePerGas: 1_000_065_428n, maxPriorityFeePerGas: 1_000_000_000n })),
    getGasPrice: vi.fn(async () => 1_000_065_428n),
    sendRawTransaction: vi.fn(async ({ serializedTransaction }: { serializedTransaction: Hex }) => {
      sent.push(serializedTransaction);
      return keccak256(serializedTransaction);
    }),
    ...over,
  } as unknown as ChainAccess;
  return { access, sent };
}

const signerOf = (w: ReturnType<typeof wallet>, access: ChainAccess, signOnly: boolean): UserSigner => ({
  provider: w.provider,
  from: w.address,
  chain: FORK,
  chainAccess: access,
  signOnly,
});

describe('on a fork build the wallet only signs, and the app broadcasts to the fork', () => {
  it('signs exactly what the fork says — its nonce, the gas with headroom, its fees, its chain id', async () => {
    const w = wallet();
    const f = fork();
    const hash = await sendAsUser(signerOf(w, f.access, true), USDC, DATA);

    const asked = w.calls.find((c) => c.method === 'eth_signTransaction')!.params![0];
    expect(asked).toEqual({
      from: w.address,
      to: USDC,
      data: DATA,
      value: '0x0',
      chainId: 196,
      type: 2,
      nonce: '0x7',
      gasLimit: toHex((55_819n * 125n) / 100n),
      maxFeePerGas: toHex(1_000_065_428n),
      maxPriorityFeePerGas: toHex(1_000_000_000n),
    });
    expect(f.sent).toHaveLength(1);
    expect(hash).toBe(keccak256(f.sent[0]!));
  });

  it('never lets the wallet send or estimate: those go to Privy’s RPC, which is real X Layer', async () => {
    const w = wallet();
    await sendAsUser(signerOf(w, fork().access, true), USDC, DATA);
    expect(w.methods()).toEqual(['wallet_switchEthereumChain', 'eth_chainId', 'eth_signTransaction']);
  });

  const refusals: [string, WalletOptions][] = [
    ['another network', { tamper: (tx) => ({ ...tx, chainId: 1 }) }],
    ['another nonce', { tamper: (tx) => ({ ...tx, nonce: 8 }) }],
    ['another destination', { tamper: (tx) => ({ ...tx, to: DELEGATION }) }],
    ['other calldata', { tamper: (tx) => ({ ...tx, data: '0x' }) }],
    ['value attached', { tamper: (tx) => ({ ...tx, value: 1n }) }],
    ['another signer', { otherSigner: true }],
  ];
  it.each(refusals)('refuses a signature with %s, and broadcasts nothing', async (_what, opts) => {
    const w = wallet(opts);
    const f = fork();
    await expect(sendAsUser(signerOf(w, f.access, true), USDC, DATA)).rejects.toThrow(/signed a different transaction/);
    expect(f.sent).toHaveLength(0);
  });
});

/*
 * Seventeen signatures back to back, against an RPC whose `pending` count can lag the broadcast just made (2026-09-25):
 * the chain's count is a floor, and this session never reuses a nonce it has already broadcast for the wallet.
 */
describe('back-to-back signatures never reuse a nonce', () => {
  it('signs the next nonce even when the chain still reports the old count', async () => {
    const w = wallet();
    const f = fork();
    await sendAsUser(signerOf(w, f.access, true), USDC, DATA);
    await sendAsUser(signerOf(w, f.access, true), USDC, DATA);
    const nonces = f.sent.map((raw) => parseTransaction(raw).nonce);
    expect(nonces).toEqual([7, 8]);
  });

  it('follows the chain when it is ahead', async () => {
    const w = wallet();
    let count = 7;
    const f = fork({ getTransactionCount: vi.fn(async () => count) });
    await sendAsUser(signerOf(w, f.access, true), USDC, DATA);
    count = 12;
    await sendAsUser(signerOf(w, f.access, true), USDC, DATA);
    expect(f.sent.map((raw) => parseTransaction(raw).nonce)).toEqual([7, 12]);
  });

  it('keeps no memory of a signature that was never broadcast', async () => {
    const w = wallet();
    const refused = fork({
      sendRawTransaction: vi.fn(async () => {
        throw new Error('nonce too low');
      }),
    });
    await expect(sendAsUser(signerOf(w, refused.access, true), USDC, DATA)).rejects.toThrow(/nonce too low/);
    const f = fork();
    await sendAsUser(signerOf(w, f.access, true), USDC, DATA);
    expect(parseTransaction(f.sent[0]!).nonce).toBe(7);
  });
});

describe('on X Layer mainnet and testnet the wallet sends', () => {
  it('with a gas limit a quarter over the estimate', async () => {
    const w = wallet({ chainId: '0xc4' });
    const f = fork();
    await sendAsUser(signerOf(w, f.access, false), USDC, DATA);
    const sent = w.calls.find((c) => c.method === 'eth_sendTransaction')!.params![0];
    expect(sent).toEqual({ from: w.address, to: USDC, data: DATA, gas: toHex(62_500n) });
    expect(f.sent).toHaveLength(0);
  });

  it('without a limit, rather than an invented one, when the estimate fails', async () => {
    const w = wallet();
    const provider: WalletProvider = {
      request: (args) => (args.method === 'eth_estimateGas' ? Promise.reject(new Error('execution reverted')) : w.provider.request(args)),
    };
    await sendAsUser({ ...signerOf(w, fork().access, false), provider }, USDC, DATA);
    const sent = w.calls.find((c) => c.method === 'eth_sendTransaction')!.params![0];
    expect(sent).toEqual({ from: w.address, to: USDC, data: DATA });
  });
});

describe('the wallet is asked which network it is on before it signs (4.6)', () => {
  it('stops, with nothing signed, when the wallet stayed on another network', async () => {
    const w = wallet({ chainId: '0x7a0' });
    const f = fork();
    const sending = sendAsUser(signerOf(w, f.access, true), USDC, DATA);
    await expect(sending).rejects.toBeInstanceOf(WrongChainError);
    await expect(sendAsUser(signerOf(w, f.access, true), USDC, DATA)).rejects.toThrow(/network 1952 and did not switch/);
    expect(w.methods()).not.toContain('eth_signTransaction');
    expect(f.sent).toHaveLength(0);
  });

  it('stops when the wallet will not say', async () => {
    const w = wallet({ chainId: null });
    await expect(sendAsUser(signerOf(w, fork().access, true), USDC, DATA)).rejects.toThrow(/did not say which network/);
  });

  it('goes ahead when the switch errors but the wallet is already where it should be, and takes a numeric answer', async () => {
    await expect(sendAsUser(signerOf(wallet({ switchFails: true }), fork().access, true), USDC, DATA)).resolves.toMatch(/^0x/);
    await expect(sendAsUser(signerOf(wallet({ chainId: 196 }), fork().access, true), USDC, DATA)).resolves.toMatch(/^0x/);
  });
});

describe('the fee a person pays (3.13)', () => {
  it('is read from the fork when the wallet only signs', async () => {
    const w = wallet();
    expect(await estimateUserFee(signerOf(w, fork().access, true), USDC, DATA)).toEqual({ gas: 55_819n, gasPrice: 1_000_065_428n });
    expect(w.methods()).toEqual([]);
  });

  it('is asked of the wallet where the wallet sends', async () => {
    expect(await estimateUserFee(signerOf(wallet(), fork().access, false), USDC, DATA)).toEqual({ gas: 50_000n, gasPrice: 1_000_000_000n });
  });

  it('is undefined, never a zero, when it cannot be read', async () => {
    const f = fork({ estimateGas: vi.fn(async () => Promise.reject(new Error('node down'))) });
    expect(await estimateUserFee(signerOf(wallet(), f.access, true), USDC, DATA)).toBeUndefined();
  });
});
