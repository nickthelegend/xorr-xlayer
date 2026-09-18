/**
 * viem clients and the executor's delegate key.
 *
 * The DELEGATE key lives here because the executor must sign a scheduled trade with nobody
 * present. Its blast radius is bounded by XorrDelegation: capped per day, venue-allowlisted,
 * time-boxed, and revocable by the user without our cooperation.
 *
 * The OWNER key never lives here — that is Privy's embedded wallet, on the user's side.
 */
import fs from 'node:fs';
import path from 'node:path';
import { createPublicClient, createWalletClient, http, type Hex } from 'viem';
import { privateKeyToAccount, generatePrivateKey } from 'viem/accounts';
import { chain, rpcUrl, CHAIN_KEY } from './chains.js';

const KEY_DIR = process.env.XORR_KEY_DIR ?? path.join(import.meta.dirname, '../../.keys');

/**
 * A generated key is a NEW IDENTITY, and on a real deployment that is silent breakage.
 *
 * `loadOrCreateKey` writes to a file inside the container. Containers are rebuilt on every
 * deploy, restart and crash-loop, so without `DELEGATE_PRIVATE_KEY` the executor mints a fresh
 * delegate each time it boots — and every grant already on chain names the PREVIOUS one.
 *
 * Nothing reports that. `policyOf` still returns an unrevoked policy, the safety screen still says
 * LIVE, `/health` is green, and the bot cannot place a single order: `spend` checks the caller
 * against the delegate the user granted, so every run reverts with `NotDelegate`. The user's money
 * is safe and their agents are dead, and the only visible difference is trades that never happen.
 *
 * It already happened here — a wallet held a live grant to `0xe992FE…` while the executor signed
 * as `0xC38f38f4…`, and both this file and `/verify` called that healthy.
 *
 * So a key is generated only where losing it costs nothing: a local node whose chain is discarded
 * with the container anyway. Anywhere else, refuse to start. A process that exits with the fix in
 * the message costs one deploy; one that boots with the wrong identity costs every trade until
 * someone works out why nothing is filling.
 */
const EPHEMERAL_KEY_OK = CHAIN_KEY === 'localnet' || CHAIN_KEY === 'base-fork';

function loadOrCreateKey(name: string): Hex {
  fs.mkdirSync(KEY_DIR, { recursive: true });
  const file = path.join(KEY_DIR, `${name}.key`);
  if (fs.existsSync(file)) return fs.readFileSync(file, 'utf8').trim() as Hex;
  if (!EPHEMERAL_KEY_OK) {
    throw new Error(
      `DELEGATE_PRIVATE_KEY is not set and XORR_CHAIN=${CHAIN_KEY} is a persistent chain. ` +
        'Generating one would give the executor a new identity that no existing grant names, ' +
        'so every trade would revert while the app still reported healthy. ' +
        'Set DELEGATE_PRIVATE_KEY to the key the current grants were signed for.',
    );
  }
  const key = generatePrivateKey();
  fs.writeFileSync(file, key, { mode: 0o600 });
  return key;
}

/**
 * The bot's signing key.
 *
 * In production this belongs in a KMS or an HSM — a file on a host is adequate for a local fork
 * and is NOT adequate beyond that. Recorded as an open item rather than glossed over.
 */
export const delegateAccount = privateKeyToAccount(
  (process.env.DELEGATE_PRIVATE_KEY as Hex) ?? loadOrCreateKey('delegate'),
);

/**
 * `cacheTime: 0`, because every read this client makes is a safety read.
 *
 * viem caches the latest block number for four seconds by default and resolves `readContract`
 * against it. So for up to four seconds after a user revokes, `readPolicy` still returned the
 * policy as LIVE — and the bot went on trading with it. A close placed inside that window
 * succeeded on a revoked permission, which is the kill switch failing at the only moment it
 * exists for.
 *
 * The README's claim is "revoke needs only the owner's signature: no server, no oracle, no
 * cooperation from the bot". A four-second window where the bot has not noticed is cooperation.
 *
 * The cost is one `eth_blockNumber` per read, against a policy read, a balance read and a gas
 * check that were each already a round trip. Nothing this executor reads is worth being stale:
 * not the policy, not the balances it sizes a trade from, not the gas it decides it can afford.
 */
export const publicClient = createPublicClient({ chain, transport: http(rpcUrl), cacheTime: 0 });

export const walletClient = createWalletClient({
  account: delegateAccount,
  chain,
  transport: http(rpcUrl),
});

export const KEY_DIRECTORY = KEY_DIR;
