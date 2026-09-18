/**
 * Granting the bot permission — signed by the USER, with their own Privy wallet. (web)
 *
 * This is the heart of the product's safety claim, so it matters who signs. The executor never
 * holds the owner key and therefore cannot grant itself permission: it can only tell the app what
 * to sign, and read the result back off the chain.
 *
 * The same applies to revoking. The kill switch is a transaction the user signs, which is why
 * "takes effect in under a second across every device" is true without any server being reachable.
 * It was not quite true until 2026-09-14: the stop asked the executor which contract to revoke
 * before it signed anything. Where a grant and a stop may go is now checked on the chain and
 * against the build's pinned contract (`src/wallet/delegationChain.ts`, FEATURES.md #1 and #24).
 *
 * How a signature reaches the chain — the wallet put on this build's network and asked where it is,
 * then either sending itself or, on a fork build, only signing while the app broadcasts to the fork —
 * is `src/wallet/userSigning.ts`, shared with the native hook (PLAN.md 4.1, 4.6).
 */
import { useCallback, useState } from 'react';
import { useWallets } from '@privy-io/react-auth';
import { pickEmbedded } from './embeddedWallet';
import { encodeFunctionData, parseUnits, type Address, type Hex } from 'viem';
import { api } from '@/data/api';
import { activeChain, pinnedDelegation, walletSignsOnly } from '@/chain';
import { humanWalletError } from '@/wallet/walletError';
import { SETTLEMENT_APPROVAL_DAYS, type GrantOptions } from '@/wallet/grantPlan';
import { chainAccess } from '@/wallet/chainAccess';
import { assertGrantDestination, confirmStopped, contractToStop } from '@/wallet/delegationChain';
import { estimateUserFee, sendAsUser, type UserSigner } from '@/wallet/userSigning';

const DELEGATION_ABI = [
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
  {
    type: 'function',
    name: 'approve',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'spender', type: 'address' },
      { name: 'amount', type: 'uint256' },
    ],
    outputs: [{ name: '', type: 'bool' }],
  },
] as const;

type DelegationParams = {
  contract: Address;
  delegate: Address;
  venues: Address[];
  /** The settlement token. Approved to the cap, because that IS what the bot may spend. */
  token: Address;
  /** Every token the delegation may need to pull, including the ones it only ever sells. */
  tokens?: { symbol: string; address: Address }[];
  chain: string;
};

const USDC_DECIMALS = 6;

/** An allowance, not a limit. The daily cap on-chain is the limit, and the user set it. */
const MAX_UINT256 = (1n << 256n) - 1n;

export function useGrantDelegation() {
  const { wallets } = useWallets();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  /*
   * The embedded wallet signs, or nothing does.
   *
   * `wallets[0]` was an injected extension on any browser that had one — verified on the hosted
   * build, where pressing this raised a browser wallet's own dialog for the USDC approval. A
   * permission signed by the wrong key grants nothing the executor can use.
   */
  const signer = useCallback(async (): Promise<UserSigner | undefined> => {
    const wallet = pickEmbedded(wallets);
    if (!wallet) return undefined;
    return {
      provider: await wallet.getEthereumProvider(),
      from: wallet.address as Address,
      chain: activeChain,
      chainAccess,
      signOnly: walletSignsOnly,
    };
  }, [wallets]);

  /** Why nothing can be signed on this session. */
  const noWallet = useCallback(
    () =>
      new Error(
        wallets?.length
          ? 'This needs your xorr wallet, not a browser extension. Sign out and back in to use it.'
          : 'No wallet yet. Finish sign-in first.',
      ),
    [wallets],
  );

  const send = useCallback(
    async (to: Address, data: Hex) => {
      const s = await signer();
      if (!s) throw noWallet();
      return sendAsUser(s, to, data);
    },
    [signer, noWallet],
  );

  /**
   * What sending `data` to `to` would cost in gas (PLAN.md 3.13), asked of the chain the transaction will run on.
   * Undefined when that cannot be said; never a zero.
   */
  const estimateFee = useCallback(
    async (to: Address, data: Hex): Promise<{ gas: bigint; gasPrice: bigint } | undefined> => {
      const s = await signer();
      return s ? estimateUserFee(s, to, data) : undefined;
    },
    [signer],
  );

  const grant = useCallback(
    async (dailyCapUsd: number, durationMs: number, options?: GrantOptions) => {
      setBusy(true);
      setError(undefined);
      try {
        const params = await api.get<DelegationParams>('/delegation/params');
        /*
         * Every approval below, and the grant, goes to an address the executor named. It has to be a contract on this
         * chain, and the one this build pinned — or a server that named another address would have had this wallet
         * approve its tokens there. Checked before the first prompt.
         */
        await assertGrantDestination(chainAccess, params.contract, pinnedDelegation);
        const cap = parseUnits(dailyCapUsd.toFixed(USDC_DECIMALS), USDC_DECIMALS);
        const expiresAt = BigInt(Math.floor((Date.now() + durationMs) / 1000));

        /*
         * Approve EVERY tradable token, not only the one the bot spends.
         *
         * The approvals let the delegation contract pull funds at the moment of a trade, and the
         * grant is what bounds how much and where — approving without granting gives the bot
         * nothing. This used to approve USDC alone, which authorised the buy side and nothing
         * else: `closePosition` pulls the asset being SOLD, so with no allowance on it every exit
         * reverted at `transferFrom`. A user could be bought into WETH and then find that
         * take-profit, stop-loss, the panic flatten and the Close button all silently failed.
         *
         * The order matters — approvals first, grant last — so a run that stops half way leaves a
         * wallet the bot cannot touch rather than one it can spend from but not exit.
         *
         * `max uint256` on the non-settlement tokens on purpose: the amount that will need
         * selling is whatever the bot bought, which is not knowable here, and an allowance is not
         * a spending limit — the daily cap on-chain is, and it is the one the user set. A smaller
         * number here would not cap anything, it would just make some future exit fail.
         */
        const settlement = params.token.toLowerCase();
        const approvable = params.tokens?.length
          ? params.tokens
          : [{ symbol: 'USDC', address: params.token }];
        /*
         * Only the approvals still missing, when the caller has worked that out (PLAN.md 4.7).
         *
         * A resume re-grants a permission whose allowances a revoke never touched; asking for every
         * one again was up to eleven wallet prompts to restore what was already there. Without
         * `options.approvals` every token is approved, as a first grant needs.
         */
        const wanted = options?.approvals?.map((a) => a.toLowerCase());
        for (const t of approvable) {
          if (wanted && !wanted.includes(t.address.toLowerCase())) continue;
          const amount =
            t.address.toLowerCase() === settlement ? cap * BigInt(SETTLEMENT_APPROVAL_DAYS) : MAX_UINT256;
          await send(
            t.address,
            encodeFunctionData({
              abi: DELEGATION_ABI,
              functionName: 'approve',
              args: [params.contract, amount],
            }),
          );
        }

        const txHash = await send(
          params.contract,
          encodeFunctionData({
            abi: DELEGATION_ABI,
            functionName: 'grant',
            args: [params.delegate, cap, expiresAt, params.venues],
          }),
        );

        // The server reads the grant from the transaction's own event before it records anything,
        // so a client claiming to have signed something is not enough.
        await api.post('/delegation/record', { txHash });
        return txHash;
      } catch (e) {
        // viem's message is a five-line dump with the RPC URL and the whole signed
        // transaction in it. See humanWalletError.
        const msg = humanWalletError(e);
        setError(msg);
        throw e;
      } finally {
        setBusy(false);
      }
    },
    [send],
  );

  const revoke = useCallback(async () => {
    setBusy(true);
    setError(undefined);
    try {
      const s = await signer();
      if (!s) throw noWallet();
      /*
       * Where the stop goes, decided on the chain.
       *
       * This asked the executor for the contract first, so with the executor down the kill switch could not be pressed
       * at all. Now the build's pinned contract is tried first and the executor is asked only if that holds no live
       * permission for this wallet; either way `policyOf` is read before anything is signed, so the stop goes where the
       * permission actually is and never to an address where it would land and do nothing.
       */
      let contract = pinnedDelegation ? await contractToStop(chainAccess, s.from, [pinnedDelegation]) : undefined;
      if (!contract) {
        const named = await api.get<DelegationParams>('/delegation/params').then(
          (p) => p.contract,
          () => undefined,
        );
        if (!named && !pinnedDelegation) {
          throw new Error('The server did not answer, and this app has no contract of its own to stop. Try again in a moment.');
        }
        contract = await contractToStop(chainAccess, s.from, [named]);
      }
      if (!contract) throw new Error('The chain shows no live permission for this wallet, so there is nothing to stop.');

      const txHash = await sendAsUser(
        s,
        contract,
        encodeFunctionData({ abi: DELEGATION_ABI, functionName: 'revoke', args: [] }),
      );
      await confirmStopped(chainAccess, contract, s.from, txHash);
      /*
       * Then the executor's record, if it answers. The chain already says revoked, and every trade is refused on that; a
       * server that is down must not turn a stop that happened into an error on the screen that asked for it.
       */
      await api.post('/delegation/revoke', { txHash }).catch(() => undefined);
      return txHash;
    } catch (e) {
      // viem's message is a five-line dump with the RPC URL and the whole signed
      // transaction in it. See humanWalletError.
      const msg = humanWalletError(e);
      setError(msg);
      throw e;
    } finally {
      setBusy(false);
    }
  }, [signer, noWallet]);

  /*
   * `send` is exported too.
   *
   * Grant and revoke are the two transactions this hook was built for, but they are not the only
   * ones the USER signs — withdrawing from Aave is theirs alone, by design, because the bot was
   * deliberately never given the aToken. Rather than a second hook duplicating the provider
   * plumbing (which differs between web and native, and is the only part that does), the caller
   * gets the primitive.
   */
  return { grant, revoke, sendTransaction: send, estimateFee, busy, error };
}
