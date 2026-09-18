/**
 * The Privy control surface — what the wallet's own custodian will and will not do.
 *
 * Everything here is a read of Privy's API rather than a report of what we asked for. The point of
 * this project is that a claim you cannot check is not evidence, and a security control we merely
 * assert is the worst example of that.
 */
import { Hono } from 'hono';
import { encodeFunctionData, erc20Abi } from 'viem';
import { requireScope } from '../auth/middleware.js';
import { ADDRESSES } from '../evm/chains.js';
import { DELEGATION_ABI, DELEGATION_ADDRESS } from '../evm/delegation.js';
import { currentWallet } from './wallet-context.js';
import { markBroadcast } from '../http/request-id.js';
import {
  allowedDestinations,
  ensurePolicy,
  policyStatus,
  proveAuthorizationKey,
  rpcAsWallet,
  demoWalletId,
} from '../auth/privyPolicy.js';

export const privyRoutes = new Hono();

/** What Privy enforces on the signed-in user's wallet, read from Privy. */
privyRoutes.get('/privy/policy', async (c) => {
  // The same wallet every other route resolves; see `wallet-context`.
  const w = await currentWallet(c);
  if (!w) return c.json({ error: 'no_wallet' }, 400);
  const [status, policy] = await Promise.all([
    policyStatus(w.address),
    ensurePolicy().catch(() => undefined),
  ]);
  return c.json({
    ...status,
    /*
     * What the policy WOULD allow, next to what it currently does.
     *
     * A wallet that predates the policy cannot have one attached by us: Privy makes the wallet's
     * owner authorise that, and for a user's embedded wallet the owner is the user. Reporting only
     * `enforced: false` would read as "this feature does not work", when the truth is "this
     * control exists and belongs to you, not to us" — which is the more interesting fact.
     */
    policyId: status.policyId ?? policy?.id,
    policyName: status.policyName ?? policy?.name,
    wouldAllow: allowedDestinations(),
    ownedByQuorum: policy?.owner_id ?? null,
  });
});

/**
 * Prove it, live.
 *
 * Four requests, all made with every credential this server holds, each a zero-value call so
 * nothing is spent either way — what is tested is whether the request survives the policy:
 *  - `USDC.approve(delegation, 0)`, which the policy names and Privy must pass;
 *  - `USDC.transfer(stranger, 0)` — to a token the policy names, which is exactly the call a
 *    destination-only policy let through (PLAN.md 1.9) and Privy must now refuse;
 *  - `grant` naming a stranger as the delegate, which Privy must refuse;
 *  - a send to an address on no list, which Privy must refuse.
 *
 * Operator-only. It creates and drives the deployment's demo wallet through Privy's signing API; a
 * signed-in user had no business being able to spend the app's Privy request budget on it.
 */
privyRoutes.post('/privy/policy/prove', requireScope('admin'), async (c) => {
  /*
   * The rules under test are the ones this build means, not whatever Privy last stored.
   *
   * The demo wallet id is remembered, so nothing on this path used to bring the policy up to date
   * before probing it. The first proof after the calldata rules shipped tested the OLD rules —
   * `transfer` and a grant to a stranger both passed — and only the key check at the end patched
   * them in, so the same request a minute later came back proven.
   */
  await ensurePolicy();
  const walletId = await demoWalletId();
  if (!walletId) {
    return c.json({ error: 'no_demo_wallet', message: 'No policy-bound wallet on this deployment.' }, 400);
  }
  const caip2 = `eip155:${process.env.XORR_CHAIN === 'base-sepolia' ? 84532 : 8453}`;
  const chainId = process.env.XORR_CHAIN === 'base-sepolia' ? 84532 : 8453;

  const attempt = async (call: string, to: string, data?: `0x${string}`) => {
    // Marked before it is tried, outside the catch below: a probe the policy lets through is a real transaction.
    await markBroadcast();
    try {
      await rpcAsWallet(walletId, {
        method: 'eth_sendTransaction',
        caip2,
        params: { transaction: { to, value: '0x0', chain_id: chainId, ...(data ? { data } : {}) } },
      });
      return { call, to, blockedByPolicy: false, detail: 'accepted by the policy' };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      /*
       * Only a POLICY refusal counts as blocked.
       *
       * A call that gets past Privy and then fails — an unfunded wallet, a revert — is the policy
       * having ALLOWED it, the opposite result, and the two are easy to confuse because both arrive
       * as an error. Reading the reason is what makes this a test rather than a coin toss.
       */
      return { call, to, blockedByPolicy: /policy violation/i.test(msg), detail: msg.slice(0, 200) };
    }
  };

  const stranger = '0x000000000000000000000000000000000000dEaD';
  const [approve, transfer, grantToStranger, offList] = await Promise.all([
    attempt(
      'USDC.approve(delegation, 0)',
      ADDRESSES.usdcBase,
      encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [DELEGATION_ADDRESS, 0n] }),
    ),
    attempt(
      'USDC.transfer(stranger, 0)',
      ADDRESSES.usdcBase,
      encodeFunctionData({ abi: erc20Abi, functionName: 'transfer', args: [stranger, 0n] }),
    ),
    attempt(
      'grant(stranger, …)',
      DELEGATION_ADDRESS,
      encodeFunctionData({ abi: DELEGATION_ABI, functionName: 'grant', args: [stranger, 1n, 4_102_444_800n, []] }),
    ),
    attempt('send to an address on no list', stranger),
  ]);
  return c.json({
    walletId,
    allowed: [approve],
    refused: [transfer, grantToStranger, offList],
    // Every half has to behave: refusing everything would prove nothing either.
    proven:
      !approve.blockedByPolicy && transfer.blockedByPolicy && grantToStranger.blockedByPolicy && offList.blockedByPolicy,
    rules: allowedDestinations(),
    authorizationKey: await proveAuthorizationKey(),
  });
});
