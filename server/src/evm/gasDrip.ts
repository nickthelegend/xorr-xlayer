/**
 * A new wallet cannot sign the thing this product is about.
 *
 * The whole flow turns on one action: the user signs an on-chain permission from their own embedded
 * wallet. Privy creates that wallet empty, and an empty wallet cannot pay gas — so on the hosted
 * deployment anyone could sign in, reach the delegate screen, press the button and watch it fail on
 * `insufficient funds`. Every screen behind that point was unreachable for a first-time visitor.
 *
 * So the executor drips a little testnet gas to a wallet it has just seen created. Not a feature —
 * a testnet affordance, and it is fenced accordingly:
 *
 *   - **Testnet only.** `IS_BASE_MAINNET_STATE` covers Base and any fork of it, and this refuses on
 *     both. Sending real ETH to an address because someone signed up is not a thing this should be
 *     able to do by accident.
 *   - **Once per wallet, and only a verified one.** The guarantee is `inserted` from `bindWallet`
 *     (`auth/walletBinding.ts`): the insert itself reports whether it created the row, so two
 *     concurrent first connects cannot both be first, and only an address Privy confirms is the
 *     caller's reaches it. The empty-wallet check below is a secondary net — measured against the
 *     public Sepolia RPC, a balance read straight after a receipt still returned zero, so
 *     read-after-write on a public node is not a lock.
 *   - **From its own key, never the delegate's** (PLAN.md 1.8). It paid from the delegate — the key
 *     every scheduled trade signs with — so each sign-up spent the bot's own gas, and enough of them
 *     would have stalled every strategy on the deployment. A dedicated `FAUCET_PRIVATE_KEY` pays now,
 *     with its own floor. Without one, nothing is sent and the reason says so.
 *   - **Never blocking, and never fatal.** A failed drip is logged and swallowed: the wallet is
 *     already created and usable, and a user who funds it themselves must not be held up by this.
 *
 * The amount is small on purpose. It covers the three signatures the grant costs on an L2 with room
 * to spare, and nothing beyond that — this is not a funding rail, and /fund is still where money
 * comes from.
 */
import { createWalletClient, formatEther, http, parseEther, type Address, type Hex } from 'viem';
import { privateKeyToAccount, type PrivateKeyAccount } from 'viem/accounts';
import { publicClient } from './client.js';
import { IS_BASE_MAINNET_STATE, CHAIN_KEY, chain, rpcUrl } from './chains.js';
import { moneyOn } from './money.js';
import { markBroadcast } from '../http/request-id.js';

/** Enough for the approvals and the grant on an L2, and not a penny of use beyond that. */
const DRIP_ETH = '0.002';
/** What the faucet keeps back, so a nearly empty one refuses cleanly instead of failing mid-send. */
const FAUCET_FLOOR_ETH = '0.0005';

export type DripResult =
  | { sent: true; amountEth: string; hash: string; from: string }
  | { sent: false; reason: string };

/** The faucet's account, when this deployment has one. Read per call, so a test — or a restart — sees the current key. */
export function faucetAccount(): PrivateKeyAccount | undefined {
  const key = process.env.FAUCET_PRIVATE_KEY;
  return key && /^0x[0-9a-fA-F]{64}$/.test(key) ? privateKeyToAccount(key as Hex) : undefined;
}

export async function dripGasIfNeeded(to: Address): Promise<DripResult> {
  /*
   * Never on Base's own state, and never on a chain whose money is real (`evm/money.ts`). Only the first was here, so a
   * mainnet under any other key, with a faucet key set, would have been sent real ETH from that key.
   */
  if (IS_BASE_MAINNET_STATE || moneyOn(CHAIN_KEY) === 'real') {
    return { sent: false, reason: `refusing to send real ETH on ${CHAIN_KEY}` };
  }

  const faucet = faucetAccount();
  if (!faucet) {
    return { sent: false, reason: 'this deployment has no faucet key, so no test ETH was sent' };
  }

  const [balance, faucetBalance] = await Promise.all([
    publicClient.getBalance({ address: to }),
    publicClient.getBalance({ address: faucet.address }),
  ]);

  if (balance > 0n) return { sent: false, reason: 'wallet already has gas' };

  const drip = parseEther(DRIP_ETH);
  if (faucetBalance < parseEther(FAUCET_FLOOR_ETH) + drip) {
    return {
      sent: false,
      reason: `the faucet holds ${formatEther(faucetBalance)} ETH, too little to send ${DRIP_ETH}`,
    };
  }

  const wallet = createWalletClient({ account: faucet, chain, transport: http(rpcUrl) });
  // Recorded before it is sent (`markBroadcast`): a retried connect must not become a second drip.
  await markBroadcast();
  const hash = await wallet.sendTransaction({ to, value: drip });
  return { sent: true, amountEth: DRIP_ETH, hash, from: faucet.address };
}
