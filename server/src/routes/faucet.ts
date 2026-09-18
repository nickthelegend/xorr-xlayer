/**
 * Money in (PLAN.md 4.4, 4.5): what the wallet holds, and the faucet.
 *
 *   GET  /wallet/funds  the wallet's USDC and ETH, read from the chain this executor settles on. The deposit screen polls
 *                       it every few seconds while it is open, so it is two reads with nothing priced: `/wallet/tokens`
 *                       prices every token and, on Base, asks 1inch's metered API — the wrong thing to ask twelve times a
 *                       minute to see whether a deposit has landed.
 *   GET  /faucet        what this deployment's faucet can send, read now, and whether this wallet may ask — and if not,
 *                       when it may.
 *   POST /faucet        send it (`evm/faucet.ts`): once per wallet per 24 hours, recorded — the claim and the trail entry
 *                       in one transaction — only once the receipt is in.
 *
 * A deployment with nothing to give says so in a sentence, `{ status: 'blocked', reason, detail }`, rather than offering a
 * button that fails.
 */
import { randomUUID } from 'node:crypto';
import { Hono } from 'hono';
import { formatEther, formatUnits, getAddress } from 'viem';
import { requireUser } from '../auth/middleware.js';
import { currentWallet, requireWallet, type WalletRow } from './wallet-context.js';
import { one, pool, tx } from '../db/index.js';
import { THIS_CHAIN } from '../db/chain-scope.js';
import { append } from '../audit/log.js';
import { publicClient } from '../evm/client.js';
import { ADDRESSES, CHAIN_KEY, explorerTx } from '../evm/chains.js';
import { ChainReadFailed, readChain } from '../http/chain-read.js';
import { log } from '../http/request-id.js';
import { humanFailure } from '../executor/failure.js';
import {
  FaucetSendFailed,
  oneSendAtATime,
  readFaucetOffer,
  refusedOutright,
  sendTestFunds,
  usdcOf,
  type EthTopUp,
  type FaucetOffer,
  type FaucetSent,
  type Offer,
} from '../evm/faucet.js';

import { isSolanaCluster, getClusterConfig } from '../solana/clusters.js';
import { readSolanaBalances } from '../solana/balances.js';

export const faucetRoutes = new Hono();

export type FaucetResponse = { status: 200 | 409 | 502; body: Record<string, unknown>; retryAfterSec?: number };

const blocked = (reason: string, detail: string, extra: Record<string, unknown> = {}): FaucetResponse => ({
  status: 409,
  body: { status: 'blocked', reason, detail, ...extra },
});

/**
 * Once a day per wallet, by this executor's clock.
 *
 * Not by the chain's: a fork's block time is whatever block it was pinned to and moves only when something is mined, so a
 * window counted in block time could stay shut for a week or reopen after a minute.
 */
export const CLAIM_WINDOW_MS = 24 * 60 * 60 * 1000;

const USDC_DECIMALS = 6;
const usdc = (raw: bigint) => Number(formatUnits(raw, USDC_DECIMALS));
const ether = (wei: bigint) => Number(formatEther(wei));
/** A moment in a sentence: to the minute, in UTC. The raw milliseconds travel beside it for the screen to localise. */
const when = (ms: number) => `${new Date(ms).toISOString().slice(0, 16).replace('T', ' ')} UTC`;
const ethAdded = (topUp: EthTopUp | null) => (topUp !== null && topUp.done ? topUp.addedWei : 0n);

/* ─────────────────────────────────────────────────────────────── the wallet's funds */

faucetRoutes.get('/wallet/funds', async (c) => {
  const w = await requireWallet(c);
  if (isSolanaCluster(process.env.XORR_CHAIN ?? '') || !w.address.startsWith('0x')) {
    const balances = await readSolanaBalances(w.address);
    const config = getClusterConfig();
    return c.json({
      owner: w.address,
      chain: config.key,
      usdc: { address: config.usdcMint, raw: balances.usdc.raw.toString(), amount: balances.usdc.amount },
      eth: { raw: balances.sol.lamports.toString(), amount: balances.sol.amount },
      sol: { raw: balances.sol.lamports.toString(), amount: balances.sol.amount },
      readAt: Date.now(),
    });
  }

  const owner = getAddress(w.address);
  // Both or neither: a balance that could not be read is a 502 naming it, never a zero beside one that could.
  const [usdcRaw, wei] = await readChain('your balances', () =>
    Promise.all([usdcOf(owner), publicClient.getBalance({ address: owner })]),
  );
  return c.json({
    owner,
    chain: CHAIN_KEY,
    usdc: { address: ADDRESSES.usdcBase, raw: usdcRaw.toString(), amount: usdc(usdcRaw) },
    eth: { raw: wei.toString(), amount: ether(wei) },
    readAt: Date.now(),
  });
});

/* ─────────────────────────────────────────────────────────────── what the faucet can send */

async function lastClaimAt(walletId: string): Promise<number | null> {
  const row = await one<{ claimed_at: Date }>(
    `SELECT claimed_at FROM faucet_claims WHERE wallet_id = $1 AND chain = ${THIS_CHAIN}
      ORDER BY claimed_at DESC LIMIT 1`,
    [walletId],
  );
  return row ? new Date(row.claimed_at).getTime() : null;
}

function offerView(offer: FaucetOffer) {
  if (!offer.available) {
    return {
      available: false,
      reason: offer.reason,
      detail: offer.detail,
      source: null,
      from: null,
      usdc: null,
      usdcRaw: null,
      ethFloor: null,
    };
  }
  return {
    available: true,
    reason: null,
    detail: offer.detail,
    source: offer.source,
    from: offer.from,
    usdc: usdc(offer.usdcRaw),
    usdcRaw: offer.usdcRaw.toString(),
    ethFloor: offer.ethFloorWei === null ? null : ether(offer.ethFloorWei),
  };
}

export async function faucetStatus(w: WalletRow | undefined, now = Date.now()): Promise<FaucetResponse> {
  const [offer, last] = await Promise.all([readFaucetOffer(), w ? lastClaimAt(w.id) : null]);
  const nextAt = last !== null && now - last < CLAIM_WINDOW_MS ? last + CLAIM_WINDOW_MS : null;
  return {
    status: 200,
    body: {
      chain: CHAIN_KEY,
      ...offerView(offer),
      windowHours: CLAIM_WINDOW_MS / 3_600_000,
      wallet: w
        ? { address: getAddress(w.address), lastClaimAt: last, nextAt, canAsk: offer.available && nextAt === null }
        : null,
    },
  };
}

faucetRoutes.get('/faucet', async (c) => {
  requireUser(c);
  const out = await faucetStatus(await currentWallet(c));
  return c.json(out.body, out.status);
});

/* ─────────────────────────────────────────────────────────────── sending */

/**
 * Hold this wallet's claim for the length of one send, across every executor sharing the database.
 *
 * The window check and the row that closes it are a whole transfer apart, so on their own two requests could both pass the
 * check and both be sent funds. The in-process queue (`oneSendAtATime`) closes that inside one executor; this closes it
 * between executors, which do overlap — a deploy starts the new one before the old one stops. A session advisory lock
 * keyed on the chain and the wallet: taken with `try`, so a second request is answered at once instead of holding a
 * connection while it waits, and released with its connection if the process dies mid-send.
 */
async function withClaimLock(walletId: string, fn: () => Promise<FaucetResponse>): Promise<FaucetResponse> {
  const key = `faucet:${CHAIN_KEY}:${walletId}`;
  const client = await pool.connect();
  let broken: Error | undefined;
  try {
    const { rows } = await client.query<{ locked: boolean }>('SELECT pg_try_advisory_lock(hashtext($1)) AS locked', [key]);
    if (!rows[0]?.locked) {
      return blocked('in_flight', 'Test funds for this wallet are already on their way. Look again in a moment.');
    }
    try {
      return await fn();
    } finally {
      // A connection that could not unlock is closed rather than pooled: closing it is what releases the lock.
      await client.query('SELECT pg_advisory_unlock(hashtext($1))', [key]).catch((e: unknown) => {
        broken = e instanceof Error ? e : new Error(String(e));
      });
    }
  } finally {
    client.release(broken);
  }
}

export async function claimFaucet(w: WalletRow, now: () => number = Date.now): Promise<FaucetResponse> {
  // Refused before the queue, the lock or a single read: on mainnet there is nothing to wait for.
  const outright = refusedOutright();
  if (outright) return blocked(outright.reason, outright.detail);

  return oneSendAtATime(() =>
    withClaimLock(w.id, async () => {
      const last = await lastClaimAt(w.id);
      if (last !== null && now() - last < CLAIM_WINDOW_MS) {
        const nextAt = last + CLAIM_WINDOW_MS;
        return {
          ...blocked(
            'claimed_recently',
            `This wallet was sent test funds at ${when(last)}. It can ask again at ${when(nextAt)}.`,
            { lastClaimAt: last, nextAt },
          ),
          retryAfterSec: Math.ceil((nextAt - now()) / 1000),
        };
      }

      const offer = await readFaucetOffer();
      if (!offer.available) return blocked(offer.reason, offer.detail);

      const to = getAddress(w.address);
      let sent: FaucetSent;
      try {
        const outcome = await sendTestFunds(offer, to);
        if (!outcome.sent) return blocked(outcome.reason, outcome.detail);
        sent = outcome;
      } catch (e) {
        // A read that failed before anything was sent is the chain not answering: a 502 in its own words.
        if (e instanceof ChainReadFailed) throw e;
        const raw = e instanceof Error ? e.message : String(e);
        log.warn(`[faucet] sending to ${to} failed: ${raw}`);
        return {
          status: 502,
          body: {
            status: 'failed',
            // Our own sentences stay as written; anything else is a node's error, put into words.
            error: e instanceof FaucetSendFailed ? raw : humanFailure(raw),
            ...(e instanceof FaucetSendFailed && e.txHash ? { txHash: e.txHash } : {}),
          },
        };
      }

      const claimedAt = now();
      const recorded = await record(w, offer, sent, claimedAt).then(
        () => true,
        (e: unknown) => {
          log.error(`[faucet] ${sent.txHash} reached ${to} and was not recorded: ${e instanceof Error ? e.message : String(e)}`);
          return false;
        },
      );
      return { status: 200, body: sentView(offer, sent, claimedAt, recorded) };
    }),
  );
}

faucetRoutes.post('/faucet', async (c) => {
  requireUser(c);
  const w = await currentWallet(c);
  if (!w) {
    return c.json({ status: 'blocked', reason: 'no_wallet', detail: 'No wallet is registered for this account yet.' }, 409);
  }
  const out = await claimFaucet(w);
  if (out.retryAfterSec !== undefined) c.header('retry-after', String(out.retryAfterSec));
  return c.json(out.body, out.status);
});

/** The claim row and the trail entry in one transaction: a send is recorded in both or in neither. */
async function record(w: WalletRow, offer: Offer, sent: FaucetSent, claimedAt: number): Promise<void> {
  const amount = usdc(sent.usdcRaw).toLocaleString('en-US', { maximumFractionDigits: USDC_DECIMALS });
  const detail =
    offer.source === 'fork-holder'
      ? `Moved from Aave’s USDC reserve (${sent.from}) on this fork of Base${ethClause(sent.eth)}. Fork funds exist only on this node.`
      : `From the faucet key (${sent.from}) on Base Sepolia. Testnet USDC has no value.`;
  await tx(async (client) => {
    await client.query(
      `INSERT INTO faucet_claims (id, wallet_id, address, paid_by, usdc_raw, usdc_tx, eth_added_wei, claimed_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        randomUUID(),
        w.id,
        sent.to,
        sent.from,
        sent.usdcRaw.toString(),
        sent.txHash,
        ethAdded(sent.eth).toString(),
        new Date(claimedAt),
      ],
    );
    await append(
      {
        walletId: w.id,
        agent: 'xorr',
        action: `Received ${amount} test USDC`,
        detail,
        kind: 'risk',
        signature: sent.txHash,
        payload: {
          source: offer.source,
          from: sent.from,
          to: sent.to,
          usdcRaw: sent.usdcRaw.toString(),
          block: sent.block.toString(),
          ethAddedWei: ethAdded(sent.eth).toString(),
          explorer: explorerTx(sent.txHash),
        },
      },
      client,
    );
  });
}

/** How the fork's ETH top-up went, as the end of a sentence. */
function ethClause(topUp: EthTopUp | null): string {
  if (topUp === null) return '';
  if (!topUp.done) return `; raising its ETH for gas failed (${topUp.failed})`;
  if (topUp.addedWei === 0n) return `; its ETH was already at least ${ether(topUp.floorWei)}, so it was left as it was`;
  return `, with its ETH raised from ${ether(topUp.beforeWei)} to ${ether(topUp.beforeWei + topUp.addedWei)} for gas`;
}

function ethView(topUp: EthTopUp | null) {
  if (topUp === null) return null;
  if (!topUp.done) return { floor: ether(topUp.floorWei), failed: topUp.failed };
  return {
    floor: ether(topUp.floorWei),
    before: ether(topUp.beforeWei),
    added: ether(topUp.addedWei),
    after: topUp.afterWei === null ? null : ether(topUp.afterWei),
  };
}

function sentView(offer: Offer, sent: FaucetSent, claimedAt: number, recorded: boolean) {
  return {
    status: 'sent',
    chain: CHAIN_KEY,
    source: offer.source,
    from: sent.from,
    to: sent.to,
    txHash: sent.txHash,
    block: sent.block.toString(),
    explorer: explorerTx(sent.txHash),
    usdc: {
      amount: usdc(sent.usdcRaw),
      raw: sent.usdcRaw.toString(),
      before: usdc(sent.usdcBefore),
      after: sent.usdcAfter === null ? null : usdc(sent.usdcAfter),
    },
    eth: ethView(sent.eth),
    claimedAt,
    nextAt: claimedAt + CLAIM_WINDOW_MS,
    recorded,
    ...(recorded
      ? {}
      : {
          detail:
            'The USDC arrived, but the record of it could not be written, so this wallet is not yet held to once a day. The transaction is the proof it was sent.',
        }),
  };
}
