/**
 * How a transaction the PERSON signs reaches the chain this build settles on (PLAN.md 4.1, 4.6).
 *
 * The grant, the approvals, revoking and withdrawing are signed by the user's own Privy wallet, never by the executor.
 * Privy's embedded wallet previews and broadcasts `eth_sendTransaction` through Privy's own RPC for a chain it knows,
 * and a fork of Base is chain 8453 — indistinguishable from real Base. On a fork build every one of those transactions
 * was simulated against real Base, where the wallet holds nothing, and refused with a balance nobody was looking at.
 *
 * `eth_signTransaction` only signs. So where Privy's chain is not this build's chain, the nonce, gas and fees are read
 * from the fork, the wallet signs exactly that, the signed bytes are checked against what was asked — network, nonce,
 * destination, calldata, value and signer — and the app broadcasts them to the fork itself. Proven against Privy's
 * wallet API on the Railway fork (`tools/prove-user-signing.ts`): Privy signed for chain 8453 without consulting real
 * Base, and the fork mined the transaction. On Base and Base Sepolia the wallet still sends: there Privy's RPC is the
 * chain.
 *
 * Either way the wallet is put on this build's chain first, and then ASKED which chain it is on (4.6). The switch used
 * to fail quietly, leaving a grant signed for another network, which the executor then never saw.
 */
import {
  isAddressEqual,
  parseTransaction,
  recoverTransactionAddress,
  toHex,
  type Address,
  type Chain,
  type Hex,
  type PublicClient,
  type TransactionSerialized,
} from 'viem';

/** The part of an EIP-1193 provider this needs. Both Privy SDKs' embedded-wallet providers have it. */
export type WalletProvider = {
  request(args: { method: string; params?: unknown[] }): Promise<unknown>;
};

/** Reads and broadcasts on the chain this build settles on — never through the wallet's own RPC. */
export type ChainAccess = Pick<
  PublicClient,
  'getTransactionCount' | 'estimateGas' | 'estimateFeesPerGas' | 'getGasPrice' | 'sendRawTransaction'
>;

export type UserSigner = {
  provider: WalletProvider;
  from: Address;
  chain: Pick<Chain, 'id' | 'name'>;
  chainAccess: ChainAccess;
  /** The wallet signs and this app broadcasts: where Privy's RPC for this chain id is not the chain this build reads. */
  signOnly: boolean;
};

export class WrongChainError extends Error {
  override name = 'WrongChainError';
}

/** `eth_chainId` answers in hex by the standard; some providers answer with a number. */
function chainIdOf(answer: unknown): number | undefined {
  if (typeof answer === 'number' && Number.isSafeInteger(answer)) return answer;
  if (typeof answer === 'string' && /^0x[0-9a-f]+$/i.test(answer)) return Number(BigInt(answer));
  return undefined;
}

/**
 * Put the wallet on this build's chain, then ask it where it is.
 *
 * The switch is allowed to fail — a wallet already on the chain may say so as an error — but the answer to
 * `eth_chainId` afterwards is not: a wallet on another network, or one that will not say, signs nothing.
 */
export async function ensureChain(provider: WalletProvider, chain: Pick<Chain, 'id' | 'name'>): Promise<void> {
  await provider
    .request({ method: 'wallet_switchEthereumChain', params: [{ chainId: toHex(chain.id) }] })
    .catch(() => undefined);
  const answered = await provider.request({ method: 'eth_chainId', params: [] }).then(chainIdOf, () => undefined);
  if (answered === chain.id) return;
  throw new WrongChainError(
    answered === undefined
      ? `Your wallet did not say which network it is on, so nothing was signed. This app settles on ${chain.name}.`
      : `Your wallet is on network ${answered} and did not switch to ${chain.name} (${chain.id}), so nothing was signed.`,
  );
}

/**
 * The signed bytes are the transaction that was asked for, signed by the wallet that was asked — or nothing is sent.
 *
 * The app broadcasts what the wallet returns, so this is the last point at which a wrong network, a stale nonce, another
 * destination or someone else's signature can be caught before it is on chain.
 */
export async function assertSignedAsAsked(
  raw: Hex,
  asked: { from: Address; to: Address; data: Hex; chainId: number; nonce: number },
): Promise<void> {
  const tx = parseTransaction(raw);
  const signer = await recoverTransactionAddress({ serializedTransaction: raw as TransactionSerialized });
  const problems = [
    tx.chainId !== asked.chainId ? `for network ${tx.chainId}` : null,
    tx.nonce !== asked.nonce ? `with nonce ${tx.nonce} instead of ${asked.nonce}` : null,
    !tx.to || !isAddressEqual(tx.to, asked.to) ? 'to another address' : null,
    (tx.data ?? '0x').toLowerCase() !== asked.data.toLowerCase() ? 'with other calldata' : null,
    (tx.value ?? 0n) !== 0n ? 'with value attached' : null,
    !isAddressEqual(signer, asked.from) ? `by ${signer}` : null,
  ].filter((p): p is string => p !== null);
  if (problems.length > 0) {
    throw new Error(`Your wallet signed a different transaction (${problems.join('; ')}), so it was not sent.`);
  }
}

/** A quarter over the estimate: it is made against this block and the transaction runs against a later one. */
const withHeadroom = (gas: bigint) => (gas * 125n) / 100n;

/** Send `data` to `to` as the user. Returns the transaction hash. */
export async function sendAsUser(signer: UserSigner, to: Address, data: Hex): Promise<Hex> {
  const { provider, from, chain, chainAccess } = signer;
  await ensureChain(provider, chain);

  if (!signer.signOnly) {
    /*
     * Estimate the gas ourselves, and say so in the request.
     *
     * Without a `gas` field the wallet supplies its own, and Privy's fell back to a plain transfer's 21,000 — below the
     * intrinsic cost of any contract call. Every user-signed write in the product is a contract call, so `grant`, the
     * ERC-20 approvals and a withdrawal all came back "intrinsic gas too low". When estimation itself fails the request
     * goes without a limit rather than with a made-up one: the wallet's guess is bad, and a number invented here would
     * be worse.
     */
    const gas = await provider
      .request({ method: 'eth_estimateGas', params: [{ from, to, data }] })
      .then((g) => toHex(withHeadroom(BigInt(g as string))))
      .catch(() => undefined);
    return (await provider.request({
      method: 'eth_sendTransaction',
      params: [{ from, to, data, ...(gas ? { gas } : {}) }],
    })) as Hex;
  }

  // Everything the signature commits to, read from the chain the transaction will actually run on.
  const [nonce, gas, fees] = await Promise.all([
    chainAccess.getTransactionCount({ address: from, blockTag: 'pending' }),
    chainAccess.estimateGas({ account: from, to, data }),
    chainAccess.estimateFeesPerGas(),
  ]);
  const raw = (await provider.request({
    method: 'eth_signTransaction',
    params: [
      {
        from,
        to,
        data,
        value: '0x0',
        chainId: chain.id,
        type: 2,
        nonce: toHex(nonce),
        gasLimit: toHex(withHeadroom(gas)),
        maxFeePerGas: toHex(fees.maxFeePerGas),
        maxPriorityFeePerGas: toHex(fees.maxPriorityFeePerGas),
      },
    ],
  })) as Hex;
  await assertSignedAsAsked(raw, { from, to, data, chainId: chain.id, nonce });
  return chainAccess.sendRawTransaction({ serializedTransaction: raw as TransactionSerialized });
}

/**
 * What sending `data` to `to` would cost in gas (PLAN.md 3.13): asked of the chain the transaction will run on.
 * Undefined when that cannot be said; never a zero.
 */
export async function estimateUserFee(
  signer: UserSigner,
  to: Address,
  data: Hex,
): Promise<{ gas: bigint; gasPrice: bigint } | undefined> {
  const { provider, from, chain, chainAccess } = signer;
  try {
    if (signer.signOnly) {
      const [gas, gasPrice] = await Promise.all([
        chainAccess.estimateGas({ account: from, to, data }),
        chainAccess.getGasPrice(),
      ]);
      return { gas, gasPrice };
    }
    await provider
      .request({ method: 'wallet_switchEthereumChain', params: [{ chainId: toHex(chain.id) }] })
      .catch(() => undefined);
    const [gas, gasPrice] = await Promise.all([
      provider.request({ method: 'eth_estimateGas', params: [{ from, to, data }] }),
      provider.request({ method: 'eth_gasPrice', params: [] }),
    ]);
    return { gas: BigInt(gas as string), gasPrice: BigInt(gasPrice as string) };
  } catch {
    return undefined;
  }
}
