/**
 * Withdrawals: the allowlist the executor holds, the check made before a signature, and what a signed withdrawal did
 * (PLAN.md 4.9).
 *
 *   GET  /withdrawal-addresses          this wallet's destinations on this chain, each with when it becomes usable, and
 *                                       the database's clock those were decided by.
 *   POST /withdrawal-addresses          add one, usable COOLING_OFF_HOURS later by that clock.
 *   POST /withdrawal-addresses/remove   take one off, at once. Adding it back starts a new cooling-off.
 *   POST /withdrawal-addresses/check    may anything be sent to this address now? The app asks immediately before it
 *                                       requests a signature.
 *   POST /withdrawals/prepare-all       the transfer of one token's whole balance to a usable destination, built only
 *                                       after the same check — the last step of "withdraw everything".
 *   POST /withdrawals/record            a transaction the owner signed, read back from the chain: what left the wallet,
 *                                       where it went and whether that destination was usable, written to the trail.
 *
 * Nothing here signs or sends. The executor has never had a transfer-out path and still has none: every withdrawal is
 * a transaction the owner signs with their own wallet, and what `prepare-all` returns is calldata the app checks before
 * it asks for that signature. What moved to the server is the decision about WHEN an address may receive anything.
 *
 * Addresses travel in request bodies, never in paths. Every path goes into the access log, and a list of where someone
 * keeps their savings does not belong there.
 */
import { Hono, type Context } from 'hono';
import { z } from 'zod';
import {
  decodeEventLog,
  encodeFunctionData,
  erc20Abi,
  formatUnits,
  getAddress,
  isAddressEqual,
  zeroAddress,
  type Address,
  type Hex,
  type Log,
} from 'viem';
import { requireUser } from '../auth/middleware.js';
import { currentWallet, type WalletRow } from './wallet-context.js';
import { tx } from '../db/index.js';
import { append, type AuditEntry } from '../audit/log.js';
import { publicClient } from '../evm/client.js';
import { AAVE_V3_POOL, ADDRESSES, explorerTx } from '../evm/chains.js';
import { waitForTx } from '../evm/delegation.js';
import { readChain } from '../http/chain-read.js';
import { canonicalSymbol } from '../venues/oneinch.js';
import { snapshotWallet } from '../portfolio/snapshots.js';
import { functioningHere } from './market.js';
import { isSolanaCluster, getClusterConfig } from '../solana/clusters.js';
import { getConnection, explorerTx as solanaExplorerTx } from '../solana/connection.js';
import { readTokenBalance, readSolBalance, ataFor } from '../solana/balances.js';
import {
  COOLING_OFF_HOURS,
  MAX_LABEL,
  addAddress,
  destinationStatus,
  listAddresses,
  removeAddress,
  isValidAddress,
  formatAddress,
  type DestinationVerdict,
} from '../withdrawals/allowlist.js';

export const withdrawalRoutes = new Hono();

export type WithdrawalResponse = { status: number; body: Record<string, unknown> };

const blocked = (reason: string, detail: string, status = 409, extra: Record<string, unknown> = {}): WithdrawalResponse => ({
  status,
  body: { status: 'blocked', reason, detail, ...extra },
});

const NO_WALLET = blocked('no_wallet', 'No wallet is registered for this account yet.');

const ADDRESS = z.string().trim().refine(isValidAddress, {
  message: 'an address: 0x hex address or Solana base58 address',
});
export const AddInput = z.object({ label: z.string().trim().min(1).max(MAX_LABEL), address: ADDRESS });
export const AddressInput = z.object({ address: ADDRESS });
export const PrepareAllInput = z.object({ to: ADDRESS, token: z.string().trim().min(1).max(12) });
export const RecordInput = z.object({
  txHash: z.string().trim().refine((val) => {
    if (/^0x[0-9a-fA-F]{64}$/.test(val)) return true;
    return /^[1-9A-HJ-NP-Za-km-z]{64,90}$/.test(val);
  }, { message: 'a 32-byte transaction hash (0x hex) or a Solana transaction signature (base58)' }),
});

/** The signed-in user's wallet. `undefined` is an account that has not registered one yet. */
async function walletOf(c: Context): Promise<WalletRow | undefined> {
  requireUser(c);
  return currentWallet(c);
}

function reply(c: Context, out: WithdrawalResponse) {
  return c.json(out.body, out.status as 200 | 201 | 400 | 403 | 404 | 409 | 502);
}

/* ─────────────────────────────────────────────────────────────── the book */

withdrawalRoutes.get('/withdrawal-addresses', async (c) => {
  const w = await walletOf(c);
  if (!w) return reply(c, NO_WALLET);
  return c.json({ coolingOffHours: COOLING_OFF_HOURS, ...(await listAddresses(w.id)) });
});

withdrawalRoutes.post('/withdrawal-addresses', async (c) => {
  const w = await walletOf(c);
  if (!w) return reply(c, NO_WALLET);
  const input = AddInput.parse(await c.req.json());
  const out = await addAddress(w.id, input);
  if (out.status === 'added') return c.json({ status: 'added', coolingOffHours: COOLING_OFF_HOURS, entry: out.entry }, 201);
  /*
   * Malformed is the body's fault whatever the book holds, so 400. The zero address was answered 409 — a conflict with
   * state — for an address nothing may ever be sent to, which no change of state can make a valid destination.
   */
  const malformed = out.reason === 'invalid_address' || out.reason === 'invalid_label' || out.reason === 'zero_address';
  return reply(c, blocked(out.reason, out.detail, malformed ? 400 : 409, out.entry ? { entry: out.entry } : {}));
});

withdrawalRoutes.post('/withdrawal-addresses/remove', async (c) => {
  const w = await walletOf(c);
  if (!w) return reply(c, NO_WALLET);
  const { address } = AddressInput.parse(await c.req.json());
  const out = await removeAddress(w.id, address);
  if (out.status === 'removed') return c.json(out);
  return reply(c, blocked(out.reason, out.detail, 404));
});

/* ─────────────────────────────────────────────────────────────── the check */

type Refusal = Extract<DestinationVerdict, { usable: false }>;

/**
 * A refused destination is a row in the trail, like everything else the safety layer stopped.
 *
 * The app never offers an address it lists as pending, so a refusal here is a list that changed under a screen — an
 * address removed from another device — or a build that does not ask before it signs. Either is worth finding later.
 */
async function refused(w: WalletRow, address: string, v: Refusal, via: 'check' | 'prepare-all'): Promise<WithdrawalResponse> {
  const extra = v.reason === 'cooling_off' ? { label: v.label, usableAt: v.usableAt } : {};
  await append({
    walletId: w.id,
    agent: 'xorr',
    action: 'Withdrawal refused',
    detail: v.detail,
    kind: 'block',
    payload: { address, reason: v.reason, via, ...extra },
  });
  return blocked(v.reason, v.detail, 409, extra);
}

/** May anything be sent to `address` now — asked by the app with the signature it is about to request still unasked. */
export async function checkDestination(w: WalletRow, address: string): Promise<WithdrawalResponse> {
  const verdict = await destinationStatus(w.id, address);
  if (!verdict.usable) return refused(w, address, verdict, 'check');
  return {
    status: 200,
    body: { status: 'usable', address: verdict.address, label: verdict.label, usableAt: verdict.usableAt },
  };
}

withdrawalRoutes.post('/withdrawal-addresses/check', async (c) => {
  const w = await walletOf(c);
  if (!w) return reply(c, NO_WALLET);
  const { address } = AddressInput.parse(await c.req.json());
  return reply(c, await checkDestination(w, address));
});

/* ─────────────────────────────────────────────────────────────── preparing */

/**
 * The transfer of one token's whole balance to a usable destination — the last step of "withdraw everything".
 *
 * The executor builds it because only something reading the chain knows that balance to the unit: a float in the app
 * would either leave dust behind or ask for more than exists and revert. The destination check comes first, and when
 * it refuses nothing else is read. The app decodes what comes back and will not ask for a signature unless it moves
 * exactly this amount of this token to the address the person chose, so this cannot redirect a withdrawal by writing
 * different calldata.
 */
export async function prepareWithdrawAll(w: WalletRow, input: { to: string; token: string }): Promise<WithdrawalResponse> {
  const verdict = await destinationStatus(w.id, input.to);
  if (!verdict.usable) return refused(w, input.to, verdict, 'prepare-all');

  const symbol = canonicalSymbol(input.token);
  const isSolana = isSolanaCluster(process.env.XORR_CHAIN ?? '') || !w.address.startsWith('0x') || !input.to.startsWith('0x');

  if (isSolana) {
    if (symbol === 'SOL') {
      const sol = await readSolBalance(w.address);
      if (sol.lamports === 0n) return blocked('nothing_to_send', 'This wallet holds no SOL, so there is nothing to send.');
      return {
        status: 200,
        body: {
          status: 'prepared',
          solana: true,
          token: { symbol: 'SOL', mint: 'So11111111111111111111111111111111111111112', decimals: 9 },
          amount: sol.amount.toString(),
          amountRaw: sol.lamports.toString(),
          destination: { address: verdict.address, label: verdict.label },
        },
      };
    }

    const config = getClusterConfig();
    const tokenBal = await readTokenBalance(w.address, config.usdcMint);
    if (tokenBal.raw === 0n) return blocked('nothing_to_send', 'This wallet holds no USDC, so there is nothing to send.');

    return {
      status: 200,
      body: {
        status: 'prepared',
        solana: true,
        token: { symbol: 'USDC', mint: config.usdcMint, decimals: config.decimals.usdc },
        amount: tokenBal.amount.toString(),
        amountRaw: tokenBal.raw.toString(),
        destination: { address: verdict.address, label: verdict.label },
        sourceAta: ataFor(w.address, config.usdcMint).toBase58(),
        destinationAta: ataFor(verdict.address, config.usdcMint).toBase58(),
      },
    };
  }

  // The tokens Send offers: `/market/watchable`, at this chain's own addresses and decimals.
  const token = (await functioningHere()).find((t) => t.symbol === symbol);
  if (!token) {
    return blocked('unknown_token', `${input.token} is not a token this chain lists, so no transfer of it was prepared.`, 400);
  }
  if (token.symbol === 'ETH') {
    return blocked('native_token', 'Native ETH pays the network fee for the transfer itself, so it is not withdrawn this way.', 400);
  }

  const owner = getAddress(w.address);
  const address = getAddress(token.address);
  const raw = await readChain(`your ${token.symbol} balance`, () =>
    publicClient.readContract({ address, abi: erc20Abi, functionName: 'balanceOf', args: [owner] }),
  );
  if (raw === 0n) return blocked('nothing_to_send', `This wallet holds no ${token.symbol}, so there is nothing to send.`);

  return {
    status: 200,
    body: {
      status: 'prepared',
      call: {
        to: address,
        data: encodeFunctionData({ abi: erc20Abi, functionName: 'transfer', args: [getAddress(verdict.address), raw] }),
      },
      token: { symbol: token.symbol, address, decimals: token.decimals },
      amount: formatUnits(raw, token.decimals),
      amountRaw: raw.toString(),
      destination: { address: verdict.address, label: verdict.label },
    },
  };
}

withdrawalRoutes.post('/withdrawals/prepare-all', async (c) => {
  const w = await walletOf(c);
  if (!w) return reply(c, NO_WALLET);
  const input = PrepareAllInput.parse(await c.req.json());
  return reply(c, await prepareWithdrawAll(w, input));
});

/* ─────────────────────────────────────────────────────────────── recording */

export type Transfer = { token: Address; from: Address; to: Address; value: bigint };

/** Every ERC-20 `Transfer` a receipt carries. Anything else — an NFT's four-topic Transfer included — is skipped. */
export function transfersIn(logs: readonly Log[]): Transfer[] {
  const out: Transfer[] = [];
  for (const log of logs) {
    try {
      const event = decodeEventLog({ abi: erc20Abi, eventName: 'Transfer', data: log.data, topics: log.topics });
      out.push({
        token: getAddress(log.address),
        from: getAddress(event.args.from),
        to: getAddress(event.args.to),
        value: event.args.value,
      });
    } catch {
      // Not an ERC-20 transfer.
    }
  }
  return out;
}

/**
 * Writes `entries` unless this wallet's trail already carries `hash`. True when it did, and nothing was written.
 *
 * The app may report one transaction twice — a retry, a second screen — and the trail cannot take a row back.
 */
async function appendOnce(walletId: string, hash: string, entries: AuditEntry[]): Promise<boolean> {
  return tx(async (client) => {
    // The lock `append` takes for this wallet, taken first, so two reports of one hash cannot both find it absent.
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [walletId]);
    const seen = await client.query(`SELECT 1 FROM audit_log WHERE wallet_id = $1 AND signature = $2 LIMIT 1`, [
      walletId,
      hash,
    ]);
    if ((seen.rowCount ?? 0) > 0) return true;
    for (const entry of entries) await append(entry, client);
    return false;
  });
}

export async function recordSolanaWithdrawal(w: WalletRow, signature: string): Promise<WithdrawalResponse> {
  const conn = getConnection();
  let txData = null;
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      txData = await conn.getTransaction(signature, { maxSupportedTransactionVersion: 0 });
      if (txData) break;
    } catch {
      // transient RPC error
    }
    await new Promise((r) => setTimeout(r, 800));
  }

  if (!txData) {
    return {
      status: 404,
      body: {
        status: 'unknown',
        detail:
          'That transaction is not on this chain, or has not landed yet. Nothing was recorded — the trail only carries hashes that can be looked up.',
      },
    };
  }

  const explorer = solanaExplorerTx(signature);

  if (txData.meta?.err) {
    const detail = 'The transaction was confirmed and reverted, so nothing left the wallet. Its network fee was still paid.';
    const duplicate = await appendOnce(w.id, signature, [
      {
        walletId: w.id,
        agent: 'You',
        action: 'Withdrawal reverted',
        detail,
        kind: 'risk',
        signature,
        payload: { withdrawal: true, reverted: true, explorer },
      },
    ]);
    return { status: 200, body: { status: 'reverted', txHash: signature, detail, duplicate } };
  }

  const ownerAddress = w.address;
  const usdcMint = getClusterConfig().usdcMint;

  let transferredAmount = 0;
  let transferredUnits = 0n;
  let destination = '';
  let tokenSymbol = 'USDC';

  const preToken = txData.meta?.preTokenBalances?.find((b) => b.owner === ownerAddress && b.mint === usdcMint);
  const postToken = txData.meta?.postTokenBalances?.find((b) => b.owner === ownerAddress && b.mint === usdcMint);

  if (preToken && postToken) {
    const preUnits = BigInt(preToken.uiTokenAmount.amount);
    const postUnits = BigInt(postToken.uiTokenAmount.amount);
    if (preUnits > postUnits) {
      transferredUnits = preUnits - postUnits;
      transferredAmount = Number(transferredUnits) / 1e6;

      const destToken = txData.meta?.postTokenBalances?.find(
        (b) => b.mint === usdcMint && b.owner && b.owner !== ownerAddress,
      );
      if (destToken?.owner) {
        destination = destToken.owner;
      }
    }
  }

  if (transferredUnits === 0n && txData.meta?.preBalances && txData.meta?.postBalances) {
    const message = txData.transaction.message;
    const keys = 'getAccountKeys' in message && typeof message.getAccountKeys === 'function'
      ? message.getAccountKeys().staticAccountKeys
      : (message as unknown as { accountKeys: any[] }).accountKeys;
    const ownerIndex = keys.findIndex((k: any) => (typeof k === 'string' ? k : k.toBase58()) === ownerAddress);
    if (ownerIndex !== -1) {
      const preLamports = BigInt(txData.meta.preBalances[ownerIndex] ?? 0);
      const postLamports = BigInt(txData.meta.postBalances[ownerIndex] ?? 0);
      const fee = BigInt(txData.meta.fee);
      if (preLamports > postLamports + fee) {
        transferredUnits = preLamports - postLamports - fee;
        transferredAmount = Number(transferredUnits) / 1e9;
        tokenSymbol = 'SOL';
        const preBals = txData.meta.preBalances;
        const destIndex = txData.meta.postBalances.findIndex(
          (bal, idx) => idx !== ownerIndex && bal > (preBals[idx] ?? 0),
        );
        if (destIndex !== -1) {
          const destKey = keys[destIndex];
          destination = typeof destKey === 'string' ? destKey : destKey.toBase58();
        }
      }
    }
  }

  if (!destination) {
    const { addresses } = await listAddresses(w.id);
    destination = addresses.length > 0 && addresses[0] ? addresses[0].address : 'recipient';
  }

  const verdict = await destinationStatus(w.id, destination);
  const what = `${transferredAmount.toFixed(transferredAmount < 0.01 ? 6 : 2)} ${tokenSymbol}`;
  const label = verdict.usable || verdict.reason === 'cooling_off' ? verdict.label : destination;

  const entry: AuditEntry = verdict.usable
    ? {
        walletId: w.id,
        agent: 'You',
        action: `Sent ${what} to ${label}`,
        detail: `${what} left this wallet for ${destination}, usable on your allowlist as ${label}. You signed it; the executor recorded it.`,
        kind: 'trade',
        signature,
        payload: {
          withdrawal: true,
          token: tokenSymbol,
          amount: transferredAmount.toString(),
          amountRaw: transferredUnits.toString(),
          to: destination,
          label,
          usable: true,
          explorer,
        },
      }
    : {
        walletId: w.id,
        agent: 'You',
        action: `Sent ${what} to an address your allowlist does not clear`,
        detail: `${what} left this wallet for ${destination}, which ${label ? `is on your allowlist as ${label} but was still cooling off` : 'is not on your allowlist'} when this was recorded. This app will not ask for that signature, so the transaction was signed somewhere else.`,
        kind: 'risk',
        signature,
        payload: {
          withdrawal: true,
          token: tokenSymbol,
          amount: transferredAmount.toString(),
          amountRaw: transferredUnits.toString(),
          to: destination,
          label,
          usable: false,
          explorer,
        },
      };

  const duplicate = await appendOnce(w.id, signature, [entry]);
  if (!duplicate) {
    void snapshotWallet({ id: w.id, address: ownerAddress }, 'withdrawal').catch(() => undefined);
  }

  const transfers = [
    {
      token: tokenSymbol === 'USDC' ? usdcMint : 'So11111111111111111111111111111111111111112',
      symbol: tokenSymbol,
      to: destination,
      amount: transferredAmount.toString(),
      amountRaw: transferredUnits.toString(),
      label: verdict.usable || verdict.reason === 'cooling_off' ? verdict.label : null,
      usable: verdict.usable,
    },
  ];

  return { status: 200, body: { status: 'confirmed', txHash: signature, transfers, aave: null, duplicate } };
}

/**
 * What a transaction the owner signed moved, read back from the chain and written to the trail.
 *
 * Supports both EVM transactions and Solana transactions.
 */
export async function recordWithdrawal(w: WalletRow, hash: string): Promise<WithdrawalResponse> {
  const isSolana = !hash.startsWith('0x') || isSolanaCluster(process.env.XORR_CHAIN ?? '') || !w.address.startsWith('0x');
  if (isSolana && !hash.startsWith('0x')) {
    return recordSolanaWithdrawal(w, hash);
  }

  const hexHash = hash as Hex;
  const mined = await waitForTx(hexHash).catch(() => undefined);
  if (mined === undefined) {
    return {
      status: 404,
      body: {
        status: 'unknown',
        detail:
          'That transaction is not on this chain, or has not landed yet. Nothing was recorded — the trail only carries hashes that can be looked up.',
      },
    };
  }

  const receipt = await readChain('the transaction', () => publicClient.getTransactionReceipt({ hash: hexHash }));
  const owner = getAddress(w.address);
  if (!isAddressEqual(receipt.from, owner)) {
    return blocked('not_your_transaction', 'That transaction was not sent by this wallet, so it is not one of your withdrawals.', 403);
  }
  const explorer = explorerTx(hexHash);

  if (receipt.status !== 'success') {
    const detail = 'The transaction was mined and reverted, so nothing left the wallet. Its network fee was still paid.';
    const duplicate = await appendOnce(w.id, hexHash, [
      {
        walletId: w.id,
        agent: 'You',
        action: 'Withdrawal reverted',
        detail,
        kind: 'risk',
        signature: hexHash,
        payload: { withdrawal: true, reverted: true, explorer },
      },
    ]);
    return { status: 200, body: { status: 'reverted', txHash: hexHash, detail, duplicate } };
  }

  const listed = new Map((await functioningHere()).map((t) => [t.address.toLowerCase(), t]));
  const moved = transfersIn(receipt.logs);

  const transfers = await Promise.all(
    moved
      .filter((t) => isAddressEqual(t.from, owner) && t.to !== zeroAddress && !isAddressEqual(t.to, owner))
      .map(async (t) => {
        const token = listed.get(t.token.toLowerCase());
        const verdict = await destinationStatus(w.id, t.to);
        return {
          token: t.token,
          symbol: token?.symbol ?? null,
          to: t.to,
          amount: token ? formatUnits(t.value, token.decimals) : null,
          amountRaw: t.value.toString(),
          label: verdict.usable || verdict.reason === 'cooling_off' ? verdict.label : null,
          usable: verdict.usable,
        };
      }),
  );

  const repaid =
    receipt.to && isAddressEqual(receipt.to, AAVE_V3_POOL)
      ? moved
          .filter((t) => isAddressEqual(t.to, owner) && isAddressEqual(t.token, ADDRESSES.usdcBase))
          .reduce((sum, t) => sum + t.value, 0n)
      : 0n;
  const aave = repaid > 0n ? { amount: formatUnits(repaid, 6), amountRaw: repaid.toString() } : null;

  const entries: AuditEntry[] = transfers.map((s) => {
    const what = `${s.amount ?? `${s.amountRaw} base units`} ${s.symbol ?? `of ${s.token}`}`;
    const payload = { withdrawal: true, ...s, explorer };
    return s.usable
      ? {
          walletId: w.id,
          agent: 'You',
          action: `Sent ${what} to ${s.label}`,
          detail: `${what} left this wallet for ${s.to}, usable on your allowlist as ${s.label}. You signed it; the executor recorded it.`,
          kind: 'trade',
          signature: hexHash,
          payload,
        }
      : {
          walletId: w.id,
          agent: 'You',
          action: `Sent ${what} to an address your allowlist does not clear`,
          detail: `${what} left this wallet for ${s.to}, which ${s.label ? `is on your allowlist as ${s.label} but was still cooling off` : 'is not on your allowlist'} when this was recorded. This app will not ask for that signature, so the transaction was signed somewhere else.`,
          kind: 'risk',
          signature: hexHash,
          payload,
        };
  });
  if (aave) {
    entries.push({
      walletId: w.id,
      agent: 'You',
      action: `Withdrew ${aave.amount} USDC from Aave`,
      detail: `Aave paid ${aave.amount} USDC back into this wallet. You signed the withdrawal; the bot never held the receipt token.`,
      kind: 'yield',
      signature: hexHash,
      payload: { withdrawal: true, aave: true, amountRaw: aave.amountRaw, explorer },
    });
  }

  const duplicate = entries.length > 0 ? await appendOnce(w.id, hexHash, entries) : false;
  if (entries.length > 0 && !duplicate) {
    void snapshotWallet({ id: w.id, address: owner }, 'withdrawal').catch(() => undefined);
  }

  return { status: 200, body: { status: 'confirmed', txHash: hexHash, transfers, aave, duplicate } };
}

withdrawalRoutes.post('/withdrawals/record', async (c) => {
  const w = await walletOf(c);
  if (!w) return reply(c, NO_WALLET);
  const { txHash } = RecordInput.parse(await c.req.json());
  return reply(c, await recordWithdrawal(w, txHash));
});
