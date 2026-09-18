/**
 * Test funds for a wallet that has none (PLAN.md 4.4).
 *
 * USDC is the only thing the executor settles in, and a wallet Privy has just made holds none. A first-time visitor could
 * sign in, grant a permission and never see a fill, with no way inside the app to get the one token all of it runs on:
 * Circle's testnet faucet is behind a captcha (PLAN.md 8.8), and a fork has no faucet at all.
 *
 * So the executor sends a fixed amount of the settlement token, and what sending means depends on the chain:
 *
 *   - **A fork of Base** (`base-fork`, `localnet`). Real Base USDC moved from a real holder, Aave's aUSDC reserve, by
 *     impersonating it — the way `fork-bootstrap.ts` and `fork/makers.ts` fund a rebuilt fork. A real `transfer`, a real
 *     `Transfer` event and a receipt; nothing minted, no storage written. The wallet's fork ETH is then raised to a floor
 *     so it can pay for what it signs itself. Only on a node that says it is anvil: impersonation is a cheat a local node
 *     honours, and an executor pointed at a real node by mistake has to learn that from a refusal, not from trying.
 *   - **Base Sepolia.** Circle's USDC from the faucet key, capped, when that key holds any — read live on every request.
 *     When it holds none, nothing is sent and the refusal says so.
 *   - **Base mainnet.** Refused before anything is read. It is real money.
 *
 * Whether a wallet may ask again is the route's question (`routes/faucet.ts`), answered from the database; this module
 * only knows what the chain can give and how to give it.
 */
import {
  createWalletClient,
  erc20Abi,
  formatEther,
  formatUnits,
  http,
  isAddressEqual,
  parseEther,
  parseEventLogs,
  parseUnits,
  toHex,
  type Address,
  type Hex,
  type TransactionReceipt,
} from 'viem';
import { publicClient } from './client.js';
import { ADDRESSES, CHAIN_KEY, chain, rpcUrl } from './chains.js';
import { moneyOn, networkName } from './money.js';
import { faucetAccount } from './gasDrip.js';
import { readChain } from '../http/chain-read.js';
import { markBroadcast } from '../http/request-id.js';
import { WHALE as USDC_HOLDER, anvil } from '../fork/makers.js';

const USDC = ADDRESSES.usdcBase;
const USDC_DECIMALS = 6;

/**
 * USDC one request sends on a fork: 1,000.
 *
 * Five times the smallest daily cap the permission screen offers ($200), so a new wallet can grant a real cap and watch
 * days of fills spend against it, with a swap and a limit order besides; a fifth of the largest ($5,000), so it stays a
 * trial balance rather than the 25,000 `fork-bootstrap.ts` gives the operator's own wallet. The reserve it comes from
 * holds tens of millions, so a claim a day per wallet never runs it down.
 */
export const FORK_USDC = 1_000;

/**
 * The ETH a fork wallet is raised to: 0.05.
 *
 * What a wallet spends signing for itself — the approvals, the grant, a withdrawal — is a fraction of a cent each at
 * Base's gas prices, and 0.05 covers thousands of them: twenty-five times the testnet drip (`gasDrip.ts`), which was
 * sized for exactly those signatures. A floor, not a grant: a wallet already above it is left alone, and one below is
 * raised by the shortfall, never set to a figure.
 */
export const FORK_ETH_FLOOR = '0.05';

/**
 * The most USDC one request sends on Base Sepolia: 10.
 *
 * Testnet USDC comes only from Circle's captcha-gated faucet, so whatever the faucet key holds was put there by hand and is
 * shared by every new wallet on the deployment. Ten covers a grant, a swap and a withdrawal at testnet sizes, so a small
 * balance serves many wallets. A key holding less sends what it has.
 */
export const SEPOLIA_USDC_CAP = 10;

/** Gas for the holder's own transfer: many times what one ERC-20 transfer costs on Base, and only ever topped up to. */
const HOLDER_GAS = parseEther('0.01');

/** A fork mines at once and a testnet in seconds. Past this nothing is recorded, and the hash is reported. */
const RECEIPT_TIMEOUT_MS = 60_000;

const CIRCLE =
  'Testnet USDC comes from Circle’s faucet at faucet.circle.com, which is behind a captcha this app cannot solve for you — ask there for your address.';

export type FaucetRefusal =
  | 'real_money'
  | 'not_anvil'
  | 'no_usdc_contract'
  | 'holder_short'
  | 'no_faucet_key'
  | 'no_testnet_usdc'
  | 'faucet_out_of_gas';

export type Refused = { available: false; reason: FaucetRefusal; detail: string };

/** What one request would send, read now. */
export type Offer = { available: true; from: Address; usdcRaw: bigint; detail: string } & (
  | { source: 'fork-holder'; ethFloorWei: bigint }
  // No ETH on a testnet: the drip at sign-up (`gasDrip.ts`) is what pays for a new wallet's first signatures there.
  | { source: 'faucet-key'; ethFloorWei: null }
);

export type FaucetOffer = Offer | Refused;

/** What raising a fork wallet's ETH did. It happens after the USDC has arrived, so a failure is reported, not thrown. */
export type EthTopUp =
  | { done: true; floorWei: bigint; beforeWei: bigint; addedWei: bigint; afterWei: bigint | null }
  | { done: false; floorWei: bigint; failed: string };

export type FaucetSent = {
  sent: true;
  txHash: Hex;
  block: bigint;
  from: Address;
  to: Address;
  usdcRaw: bigint;
  usdcBefore: bigint;
  /** Null when it could not be read back. The receipt's `Transfer` is what proves the arrival, not this. */
  usdcAfter: bigint | null;
  /** Null on a testnet. */
  eth: EthTopUp | null;
};

/** Refused at the moment of sending, with nothing sent. */
export type NotSent = { sent: false; reason: FaucetRefusal; detail: string };

/** A send that went wrong after it was attempted. `txHash` is set once there is a transaction to point at. */
export class FaucetSendFailed extends Error {
  constructor(
    message: string,
    readonly txHash?: Hex,
  ) {
    super(message);
    this.name = 'FaucetSendFailed';
  }
}

const usdcShown = (raw: bigint) =>
  Number(formatUnits(raw, USDC_DECIMALS)).toLocaleString('en-US', { maximumFractionDigits: USDC_DECIMALS });

export function usdcOf(owner: Address): Promise<bigint> {
  return publicClient.readContract({ address: USDC, abi: erc20Abi, functionName: 'balanceOf', args: [owner] });
}

/**
 * The chain the faucet refuses without reading anything: any whose money is real (`evm/money.ts`).
 *
 * It named `base`, so a mainnet under any other key went on down the fork's path and was stopped only because its node
 * does not answer as anvil.
 */
export function refusedOutright(): Refused | undefined {
  if (moneyOn(CHAIN_KEY) !== 'real') return undefined;
  return {
    available: false,
    reason: 'real_money',
    detail: `This executor settles on ${networkName(CHAIN_KEY)}, where USDC is real money, so there is no faucet. Fund the wallet by sending USDC to its address.`,
  };
}

/** What this deployment can send right now, or why it can send nothing. A read that fails throws `ChainReadFailed`. */
export async function readFaucetOffer(): Promise<FaucetOffer> {
  const outright = refusedOutright();
  if (outright) return outright;
  return CHAIN_KEY === 'base-sepolia' ? sepoliaOffer() : forkOffer();
}

async function forkOffer(): Promise<FaucetOffer> {
  const node = String(await readChain('which node this is', () => anvil(rpcUrl, 'web3_clientVersion', [])));
  if (!/^anvil\//i.test(node)) {
    return {
      available: false,
      reason: 'not_anvil',
      detail: `This executor is set up for ${CHAIN_KEY}, but its node answers as "${node}", not anvil — so there is no fork to move USDC on, and nothing was tried.`,
    };
  }
  const code = await readChain('the USDC contract', () => publicClient.getCode({ address: USDC }));
  if (!code || code === '0x') {
    return {
      available: false,
      reason: 'no_usdc_contract',
      detail: `There is no USDC contract at ${USDC} on this node, so there is no USDC to move.`,
    };
  }
  const usdcRaw = parseUnits(String(FORK_USDC), USDC_DECIMALS);
  const held = await readChain('the holder’s USDC', () => usdcOf(USDC_HOLDER));
  if (held < usdcRaw) {
    return {
      available: false,
      reason: 'holder_short',
      detail: `Aave’s USDC reserve holds ${usdcShown(held)} USDC on this fork, less than the ${usdcShown(usdcRaw)} one request sends.`,
    };
  }
  return {
    available: true,
    source: 'fork-holder',
    from: USDC_HOLDER,
    usdcRaw,
    ethFloorWei: parseEther(FORK_ETH_FLOOR),
    detail: `${usdcShown(usdcRaw)} USDC moved from Aave’s USDC reserve on this fork of Base, with the wallet’s ETH raised to ${FORK_ETH_FLOOR} for gas. Fork funds exist only on this node.`,
  };
}

const noFaucetKey = (): Refused => ({
  available: false,
  reason: 'no_faucet_key',
  detail: `This deployment has no faucet key, so it has no Base Sepolia USDC to send. ${CIRCLE}`,
});

async function sepoliaOffer(): Promise<FaucetOffer> {
  const faucet = faucetAccount();
  if (!faucet) return noFaucetKey();
  const held = await readChain('the faucet’s USDC', () => usdcOf(faucet.address));
  if (held === 0n) {
    return {
      available: false,
      reason: 'no_testnet_usdc',
      detail: `The faucet key (${faucet.address}) holds no Base Sepolia USDC, so there is none to send. ${CIRCLE}`,
    };
  }
  const cap = parseUnits(String(SEPOLIA_USDC_CAP), USDC_DECIMALS);
  const usdcRaw = held < cap ? held : cap;
  return {
    available: true,
    source: 'faucet-key',
    from: faucet.address,
    usdcRaw,
    ethFloorWei: null,
    detail: `${usdcShown(usdcRaw)} USDC from the faucet key (${faucet.address}), which holds ${usdcShown(held)}. Testnet USDC has no value.`,
  };
}

let queue: Promise<unknown> = Promise.resolve();

/**
 * Run `send` once every send queued before it in this process has finished, however it finished.
 *
 * Impersonation is node-wide: two sends overlapping on a fork would have the first to finish stop the holder's
 * impersonation under the second. On a testnet the faucet key would sign two transfers against the same nonce. Queued
 * rather than refused, so two wallets asking at once both get their answer.
 */
export function oneSendAtATime<T>(send: () => Promise<T>): Promise<T> {
  const run = queue.then(send);
  queue = run.catch(() => undefined);
  return run;
}

/** Send what `offer` describes to `to`, and return once the receipt proves it arrived. */
export function sendTestFunds(offer: Offer, to: Address): Promise<FaucetSent | NotSent> {
  return offer.source === 'fork-holder' ? sendFromHolder(offer, to) : sendFromFaucetKey(offer, to);
}

async function sendFromHolder(offer: Offer & { source: 'fork-holder' }, to: Address): Promise<FaucetSent> {
  const usdcBefore = await readChain('your USDC', () => usdcOf(to));
  const holderEth = await readChain('the holder’s ETH', () => publicClient.getBalance({ address: USDC_HOLDER }));

  await anvil(rpcUrl, 'anvil_impersonateAccount', [USDC_HOLDER]);
  let receipt: TransactionReceipt;
  try {
    // The holder pays for its own transfer, topped up by what it lacks rather than set: the reserve's own ETH stays.
    if (holderEth < HOLDER_GAS) {
      await anvil(rpcUrl, 'anvil_addBalance', [USDC_HOLDER, toHex(HOLDER_GAS - holderEth)]);
    }
    // No retries: a transfer sent twice is two transfers, and a node that did not answer may have taken the first.
    const holder = createWalletClient({ account: USDC_HOLDER, chain, transport: http(rpcUrl, { retryCount: 0 }) });
    // Recorded before it is sent, so a claim that answers 502 after this is replayed to a retry, never sent twice.
    await markBroadcast();
    const hash = await holder.writeContract({
      address: USDC,
      abi: erc20Abi,
      functionName: 'transfer',
      args: [to, offer.usdcRaw],
    });
    receipt = await confirmed(hash, USDC_HOLDER, to, offer.usdcRaw);
  } finally {
    // However the send ended, so nothing else on the node can sign as the reserve afterwards.
    await anvil(rpcUrl, 'anvil_stopImpersonatingAccount', [USDC_HOLDER]).catch(() => undefined);
  }

  const eth = await topUpEth(to, offer.ethFloorWei);
  return {
    sent: true,
    txHash: receipt.transactionHash,
    block: receipt.blockNumber,
    from: USDC_HOLDER,
    to,
    usdcRaw: offer.usdcRaw,
    usdcBefore,
    usdcAfter: await usdcOf(to).catch(() => null),
    eth,
  };
}

async function sendFromFaucetKey(offer: Offer & { source: 'faucet-key' }, to: Address): Promise<FaucetSent | NotSent> {
  const faucet = faucetAccount();
  // The offer was read moments ago in this same request; a key that is gone or different now is no faucet key.
  if (!faucet || !isAddressEqual(faucet.address, offer.from)) return { ...noFaucetKey(), sent: false };

  const args = [to, offer.usdcRaw] as const;
  const [usdcBefore, gas, gasPrice, faucetEth] = await Promise.all([
    readChain('your USDC', () => usdcOf(to)),
    readChain('what the transfer costs', () =>
      publicClient.estimateContractGas({ account: faucet, address: USDC, abi: erc20Abi, functionName: 'transfer', args }),
    ),
    readChain('the gas price', () => publicClient.getGasPrice()),
    readChain('the faucet’s ETH', () => publicClient.getBalance({ address: faucet.address })),
  ]);
  const cost = gas * gasPrice;
  if (faucetEth < cost) {
    return {
      sent: false,
      reason: 'faucet_out_of_gas',
      detail: `The faucet key holds ${formatEther(faucetEth)} ETH and the transfer costs about ${formatEther(cost)}, so nothing was sent.`,
    };
  }

  const wallet = createWalletClient({ account: faucet, chain, transport: http(rpcUrl, { retryCount: 0 }) });
  // Recorded before it is sent, as the fork's transfer is.
  await markBroadcast();
  const hash = await wallet.writeContract({ address: USDC, abi: erc20Abi, functionName: 'transfer', args });
  const receipt = await confirmed(hash, faucet.address, to, offer.usdcRaw);
  return {
    sent: true,
    txHash: hash,
    block: receipt.blockNumber,
    from: faucet.address,
    to,
    usdcRaw: offer.usdcRaw,
    usdcBefore,
    usdcAfter: await usdcOf(to).catch(() => null),
    eth: null,
  };
}

/** The receipt, once it proves the USDC moved: mined, successful, and carrying the `Transfer` it should. */
async function confirmed(hash: Hex, from: Address, to: Address, value: bigint): Promise<TransactionReceipt> {
  const receipt = await publicClient
    .waitForTransactionReceipt({ hash, timeout: RECEIPT_TIMEOUT_MS })
    .catch(() => undefined);
  if (!receipt) {
    throw new FaucetSendFailed(
      `The transfer was sent and did not confirm within ${RECEIPT_TIMEOUT_MS / 1000}s, so it was not recorded. It may still arrive: check the wallet before asking again.`,
      hash,
    );
  }
  if (receipt.status !== 'success') throw new FaucetSendFailed('The transfer reverted, so no USDC moved.', hash);
  const moved = parseEventLogs({ abi: erc20Abi, eventName: 'Transfer', logs: receipt.logs }).some(
    (log) =>
      isAddressEqual(log.address, USDC) &&
      isAddressEqual(log.args.from, from) &&
      isAddressEqual(log.args.to, to) &&
      log.args.value === value,
  );
  if (!moved) {
    throw new FaucetSendFailed('The transaction mined without the USDC Transfer it should have emitted, so it was not recorded.', hash);
  }
  return receipt;
}

/**
 * Raise a fork wallet's ETH to `floorWei` by what it lacks.
 *
 * `anvil_addBalance` adds rather than sets, so a balance is never lowered — not even one that grew between the read and
 * the write. Runs after the USDC has arrived, so it never throws: a top-up that failed is reported beside the transfer
 * that worked, not instead of it.
 */
async function topUpEth(to: Address, floorWei: bigint): Promise<EthTopUp> {
  try {
    const beforeWei = await publicClient.getBalance({ address: to });
    const addedWei = beforeWei < floorWei ? floorWei - beforeWei : 0n;
    if (addedWei > 0n) await anvil(rpcUrl, 'anvil_addBalance', [to, toHex(addedWei)]);
    const afterWei = await publicClient.getBalance({ address: to }).catch(() => null);
    return { done: true, floorWei, beforeWei, addedWei, afterWei };
  } catch (e) {
    return { done: false, floorWei, failed: e instanceof Error ? e.message : String(e) };
  }
}
