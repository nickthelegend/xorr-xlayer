/**
 * Limit orders: published by makers, listed for owners, taken through the permission (PLAN.md 3.15).
 *
 *   POST /limit-orders             operator-only. A signed 1inch order is checked against the router — the signature
 *                                  recovers its maker, the hash is the router's own, it has not expired and its nonce
 *                                  is not spent — and stored.
 *   GET  /limit-orders             this chain's orders, each with its price, size, maker, expiry and whether the chain
 *                                  says it can still be taken.
 *   POST /limit-orders/:hash/fill  the signed-in owner takes the whole order: `XorrDelegation.spend()` pays its USDC
 *                                  and the router sends the maker's WETH to the owner.
 *
 * Nothing is posted to 1inch's public orderbook: that is a mainnet action. And where nothing settles the list is empty
 * and says why, rather than listing orders no fill could reach.
 *
 * A take is a buy like any other: the same permission, the same rule check, the same daily cap on chain, a dry run
 * before anything is signed, a receipt before anything is recorded, and the fill written where every fill is.
 */
import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { Hono } from 'hono';
import { z } from 'zod';
import { formatUnits, getAddress, isAddressEqual, type Address, type Hex } from 'viem';
import { requireScope, requireUser } from '../auth/middleware.js';
import { currentWallet, type WalletRow } from './wallet-context.js';
import { one, query, tx } from '../db/index.js';
import { THIS_CHAIN } from '../db/chain-scope.js';
import { append } from '../audit/log.js';
import { delegateAccount, publicClient } from '../evm/client.js';
import { ADDRESSES, CHAIN_KEY, chain, explorerTx } from '../evm/chains.js';
import {
  DELEGATION_ABI,
  DELEGATION_ADDRESS,
  readPolicy,
  spendAsDelegate,
  usdToUnits,
  waitForTx,
} from '../evm/delegation.js';
import { gasStatus } from '../evm/gas.js';
import { readChain } from '../http/chain-read.js';
import { CAN_SETTLE } from '../venues/oneinch.js';
import { applyFill } from '../positions/index.js';
import { evaluate, recordSpend } from '../rules/engine.js';
import { snapshotWallet } from '../portfolio/snapshots.js';
import { measuredDelta, rawBalanceOf, usdcRawOf } from '../executor/fill-measure.js';
import { humanFailure } from '../executor/failure.js';
import {
  LOP_ABI,
  LOP_ERRORS,
  LOP_REFUSALS,
  LOP_ROUTER,
  buildLimitOrderFill,
  compactSignatureHex,
  hashLimitOrder,
  judgeOrder,
  orderArg,
  readMakerTraits,
  readOrdersOnChain,
  recoverOrderSigner,
  revertName,
  type LimitOrder,
  type OrderStatus,
} from '../venues/limit-orders.js';

export const limitOrderRoutes = new Hono();

export type LimitOrderResponse = { status: number; body: Record<string, unknown> };

const blocked = (reason: string, detail: string, status = 409): LimitOrderResponse => ({
  status,
  body: { status: 'blocked', reason, detail },
});
const failed = (error: string, status = 502): LimitOrderResponse => ({ status, body: { status: 'failed', error } });

/**
 * The one pair listed. USDC is what `spend()` pulls and what the daily cap counts, so it is the only thing an owner can
 * pay with; WETH is what the fill is proven to deliver on the fork (`fork/prove-limit-order.ts`).
 */
const SELLS = { symbol: 'WETH', address: ADDRESSES.wethBase, decimals: 18 } as const;
const PAYS = { symbol: 'USDC', address: ADDRESSES.usdcBase, decimals: 6 } as const;

const nothingSettles = (what: string) =>
  `Nothing settles on ${CHAIN_KEY} — 1inch has no deployment here — so ${what}.`;

/** Enough digits to read, none that are noise. */
const shown = (n: number) => Number(n.toPrecision(6));
const dollars = (n: number) => `$${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/* ─────────────────────────────────────────────────────────────── publishing */

const UINT256 = z
  .string()
  .regex(/^(0x[0-9a-fA-F]{1,64}|[0-9]{1,78})$/, 'a uint256, as a decimal or 0x string')
  .transform((s) => BigInt(s))
  .refine((n) => n < 1n << 256n, 'a uint256');
const ADDRESS = z
  .string()
  .regex(/^0x[0-9a-fA-F]{40}$/, 'an address')
  .transform((a) => getAddress(a));

/** A signed order, as a maker publishes it. Every uint256 is a string: JSON has no integer that wide. */
export const PublishInput = z.object({
  order: z.object({
    salt: UINT256,
    maker: ADDRESS,
    receiver: ADDRESS,
    makerAsset: ADDRESS,
    takerAsset: ADDRESS,
    makingAmount: UINT256,
    takingAmount: UINT256,
    makerTraits: UINT256,
  }),
  signature: z.string().regex(/^0x([0-9a-fA-F]{128}|[0-9a-fA-F]{130})$/, 'a 64- or 65-byte signature, as hex'),
});

const LOW_80_BITS = (1n << 80n) - 1n;

export async function publishLimitOrder(input: z.infer<typeof PublishInput>): Promise<LimitOrderResponse> {
  if (!CAN_SETTLE) return blocked('not_settleable_here', nothingSettles('no limit order can be listed'));
  const order: LimitOrder = input.order;

  if (!isAddressEqual(order.makerAsset, SELLS.address) || !isAddressEqual(order.takerAsset, PAYS.address)) {
    return blocked(
      'unsupported_pair',
      'Only orders selling WETH for USDC are listed: USDC is what the permission spends, and WETH is what a take is proven to deliver.',
      400,
    );
  }
  // The listing, the proof and the trail all say the maker is paid, so that has to be what the order says.
  if (!isAddressEqual(order.receiver, order.maker)) {
    return blocked('receiver_not_maker', 'The order pays someone other than its maker, and only orders paying the maker are listed.', 400);
  }
  if (order.makingAmount === 0n || order.takingAmount === 0n) {
    return blocked('invalid_amount', 'Both sides of the order must be above zero.', 400);
  }

  const traits = readMakerTraits(order.makerTraits);
  /*
   * Whole orders only. A take is all or nothing — `spend()` pulls exactly the taking amount and holds the owner to the
   * whole making amount — so an order someone else could part-fill first would be listed at a size no take here can
   * fill. A whole order also spends a nonce bit, which is what the list reads to say whether it is still open.
   */
  if (!traits.noPartialFills) {
    return blocked('partial_fills', 'Only all-or-nothing orders are listed: a take through the permission is always the whole order.', 400);
  }
  if (traits.hasExtension || traits.preInteraction || traits.postInteraction || traits.usePermit2 || traits.needCheckEpochManager) {
    return blocked(
      'unsupported_traits',
      'The order needs an extension, an interaction, Permit2 or an epoch check, none of which a take here sends or reads.',
      400,
    );
  }
  // The taker is the delegation contract: an order only someone else may take cannot be taken here.
  if (traits.allowedSender !== 0n && traits.allowedSender !== (BigInt(DELEGATION_ADDRESS) & LOW_80_BITS)) {
    return blocked('private_order', 'The order may only be taken by someone else.', 400);
  }

  let signature: Hex;
  let signer: Address;
  try {
    signature = compactSignatureHex(input.signature as Hex);
    signer = await recoverOrderSigner(order, signature, chain.id);
  } catch (e) {
    return blocked('bad_signature', e instanceof Error ? e.message : String(e), 400);
  }
  if (!isAddressEqual(signer, order.maker)) {
    return blocked('bad_signature', 'The signature does not recover the order’s maker.', 400);
  }

  const hash = hashLimitOrder(order, chain.id);
  const routerHash = await readChain('the 1inch router’s hash of the order', () =>
    publicClient.readContract({ address: LOP_ROUTER, abi: LOP_ABI, functionName: 'hashOrder', args: [orderArg(order)] }),
  );
  if (routerHash.toLowerCase() !== hash.toLowerCase()) {
    return blocked('hash_mismatch', `The router hashes this order as ${routerHash}, not ${hash}, so nothing here could fill it.`);
  }

  const { now, states } = await readChain('the order', () => readOrdersOnChain([order]));
  const state = states[0]!;
  const judged = judgeOrder({ order, now, onChain: state });
  if (judged.status === 'invalidated' || judged.status === 'expired') return blocked(judged.status, judged.detail);
  if (state.invalidated === undefined) return failed('Whether the order is still open could not be read from the chain, so it was not listed.');

  const inserted = await one<{ order_hash: string }>(
    `INSERT INTO limit_orders
       (order_hash, maker, maker_asset, taker_asset, making_amount, taking_amount, salt, maker_traits, signature)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     ON CONFLICT (order_hash) DO NOTHING
     RETURNING order_hash`,
    [
      hash,
      order.maker,
      order.makerAsset,
      order.takerAsset,
      order.makingAmount.toString(),
      order.takingAmount.toString(),
      order.salt.toString(),
      order.makerTraits.toString(),
      signature,
    ],
  );
  if (!inserted) {
    // A fork shares Base's chain id, so the same signed order can be published against both.
    const existing = await one<{ here: boolean }>(
      `SELECT chain = ${THIS_CHAIN} AS here FROM limit_orders WHERE order_hash = $1`,
      [hash],
    );
    if (existing && !existing.here) return blocked('listed_elsewhere', 'This order is already listed for another chain.');
    return { status: 200, body: { status: 'listed', hash, duplicate: true } };
  }
  return {
    status: 201,
    body: { status: 'listed', hash, maker: order.maker, detail: judged.detail, fillable: judged.fillable },
  };
}

limitOrderRoutes.post('/limit-orders', requireScope('admin'), async (c) => {
  const input = PublishInput.parse(await c.req.json());
  const out = await publishLimitOrder(input);
  return c.json(out.body, out.status as 200 | 201 | 400 | 409 | 502);
});

/* ─────────────────────────────────────────────────────────────── listing */

type LimitOrderRow = {
  order_hash: string;
  maker: string;
  maker_asset: string;
  taker_asset: string;
  making_amount: string;
  taking_amount: string;
  salt: string;
  maker_traits: string;
  signature: string;
  created_at: Date;
  filled_at: Date | null;
  fill_tx: string | null;
  taker_wallet_id: string | null;
};

const COLUMNS = `order_hash, maker, maker_asset, taker_asset, making_amount::text, taking_amount::text, salt::text,
  maker_traits::text, signature, created_at, filled_at, fill_tx, taker_wallet_id`;

/** The signed struct, rebuilt from its row. The receiver is the maker: publishing refuses anything else. */
function orderOf(row: LimitOrderRow): LimitOrder {
  const maker = getAddress(row.maker);
  return {
    salt: BigInt(row.salt),
    maker,
    receiver: maker,
    makerAsset: getAddress(row.maker_asset),
    takerAsset: getAddress(row.taker_asset),
    makingAmount: BigInt(row.making_amount),
    takingAmount: BigInt(row.taking_amount),
    makerTraits: BigInt(row.maker_traits),
  };
}

export type ListedOrder = {
  hash: string;
  maker: string;
  sells: string;
  pays: string;
  /** Raw base units, exactly. */
  makingAmount: string;
  takingAmount: string;
  /** WETH the order sells, and USDC it costs, as numbers to show. */
  size: number;
  cost: number;
  /** USDC per WETH. */
  price: number;
  nonce: string;
  /** Milliseconds; null for an order that never expires. */
  expiresAt: number | null;
  createdAt: number;
  status: OrderStatus;
  /** Null when the chain could not be read. */
  fillable: boolean | null;
  detail: string;
  filledAt: number | null;
  fillTx: string | null;
  takenByYou: boolean;
};

function listed(row: LimitOrderRow, order: LimitOrder, judged: ReturnType<typeof judgeOrder>, walletId?: string): ListedOrder {
  const size = Number(formatUnits(order.makingAmount, SELLS.decimals));
  const cost = Number(formatUnits(order.takingAmount, PAYS.decimals));
  const { expiration, nonce } = readMakerTraits(order.makerTraits);
  return {
    hash: row.order_hash,
    maker: order.maker,
    sells: SELLS.symbol,
    pays: PAYS.symbol,
    makingAmount: order.makingAmount.toString(),
    takingAmount: order.takingAmount.toString(),
    size,
    cost,
    price: cost / size,
    nonce: nonce.toString(),
    expiresAt: expiration === 0n ? null : Number(expiration) * 1000,
    createdAt: new Date(row.created_at).getTime(),
    status: judged.status,
    fillable: judged.fillable,
    detail: judged.detail,
    filledAt: row.filled_at ? new Date(row.filled_at).getTime() : null,
    fillTx: row.fill_tx,
    takenByYou: walletId !== undefined && row.taker_wallet_id === walletId,
  };
}

export async function listLimitOrders(walletId: string | undefined): Promise<LimitOrderResponse> {
  if (!CAN_SETTLE) {
    return {
      status: 200,
      body: { settles: false, chain: CHAIN_KEY, detail: nothingSettles('there are no limit orders to take'), orders: [] },
    };
  }
  const rows = await query<LimitOrderRow>(
    `SELECT ${COLUMNS} FROM limit_orders WHERE chain = ${THIS_CHAIN} ORDER BY created_at DESC LIMIT 100`,
  );
  if (rows.length === 0) return { status: 200, body: { settles: true, chain: CHAIN_KEY, detail: null, orders: [] } };

  const orders = rows.map(orderOf);
  const { now, states } = await readChain('the limit orders', () => readOrdersOnChain(orders));
  return {
    status: 200,
    body: {
      settles: true,
      chain: CHAIN_KEY,
      detail: null,
      orders: rows.map((row, i) =>
        listed(row, orders[i]!, judgeOrder({ order: orders[i]!, now, onChain: states[i]!, filledAt: row.filled_at }), walletId),
      ),
    },
  };
}

limitOrderRoutes.get('/limit-orders', async (c) => {
  requireUser(c);
  const w = await currentWallet(c);
  const out = await listLimitOrders(w?.id);
  return c.json(out.body, out.status as 200);
});

/* ─────────────────────────────────────────────────────────────── taking */

/**
 * A limit order taken, recorded where every other fill is: an ended `limit` strategy and its filled run, at venue
 * `lop` on side `buy` — the shape `recordSale` gives a sale. The period key is the order hash, so the database refuses
 * to record one order as two fills.
 */
export async function recordLimitFill(
  client: PoolClient,
  fill: {
    walletId: string;
    orderHash: string;
    maker: string;
    label: string;
    /** WETH that arrived: measured, or the order's size when the balance could not be read back. */
    units: number;
    usd: number;
    /** What the order promised, beside a measured fill; null leaves the fill unmeasured. */
    quotedUnits: number | null;
    signature: string;
  },
): Promise<string> {
  const strategyId = randomUUID();
  await client.query(
    `INSERT INTO strategies (id, wallet_id, kind, state, label, symbol, params, daily_allocation_usd)
     VALUES ($1, $2, 'limit', 'ended', $3, $4, $5, 0)`,
    [strategyId, fill.walletId, fill.label, SELLS.symbol, JSON.stringify({ manual: true, orderHash: fill.orderHash, maker: fill.maker })],
  );
  const runId = randomUUID();
  await client.query(
    `INSERT INTO strategy_runs
       (id, strategy_id, period_key, status, usd, units, price, signature, venue, side, quoted_units, asset_class, finished_at)
     VALUES ($1, $2, $3, 'filled', $4, $5, $6, $7, 'lop', 'buy', $8, 'crypto', now())`,
    [
      runId,
      strategyId,
      `limit:${fill.orderHash}`,
      fill.usd,
      fill.units,
      fill.units > 0 ? fill.usd / fill.units : null,
      fill.signature,
      fill.quotedUnits,
    ],
  );
  return runId;
}

export async function takeLimitOrder(w: WalletRow, rawHash: string): Promise<LimitOrderResponse> {
  if (!CAN_SETTLE) return blocked('not_settleable_here', nothingSettles('no limit order can be taken'));
  if (!/^0x[0-9a-fA-F]{64}$/.test(rawHash)) return blocked('invalid_hash', 'That is not an order hash.', 400);
  const hash = rawHash.toLowerCase();

  const row = await one<LimitOrderRow>(
    `SELECT ${COLUMNS} FROM limit_orders WHERE order_hash = $1 AND chain = ${THIS_CHAIN}`,
    [hash],
  );
  if (!row) return blocked('not_found', 'No limit order with that hash is listed on this chain.', 404);
  if (row.filled_at) {
    return blocked('already_taken', `This order was already taken here${row.fill_tx ? `, in ${row.fill_tx}` : ''}.`);
  }
  const order = orderOf(row);
  if (hashLimitOrder(order, chain.id) !== hash) {
    return blocked('order_mismatch', 'The stored order no longer produces its own hash, so it was not taken.');
  }
  const owner = w.address as Address;

  const policy = await readChain('your permission', () => readPolicy(owner));
  if (!policy || policy.revoked || policy.expiresAt <= Date.now()) {
    return blocked(
      'delegation_inactive',
      'The trading permission is missing, revoked or expired, so no order can be taken on your behalf. Renew it, or trade yourself — your funds never left your wallet.',
    );
  }

  const usd = Number(formatUnits(order.takingAmount, PAYS.decimals));
  const verdict = await evaluate({
    walletId: w.id,
    usd,
    dailyCapUsd: policy.dailyCapUsd,
    delegationExpiresAt: new Date(policy.expiresAt),
    delegationRevoked: policy.revoked,
    killed: w.agents_stopped === true,
  });
  if (!verdict.allowed) return blocked(verdict.reason, verdict.detail);
  if (usd > policy.remainingTodayUsd + 0.000001) {
    return blocked(
      'onchain_daily_cap',
      `The contract allows ${dollars(policy.remainingTodayUsd)} more today, and this order costs ${dollars(usd)}.`,
    );
  }

  // The delegate pays the gas. Out of it, every take would fail inside the send and read as the order's fault.
  const gas = await gasStatus().catch(() => null);
  if (gas && !gas.enough) {
    return blocked(
      'agent_out_of_gas',
      `The executor's wallet is down to ${gas.eth.toFixed(4)} ETH and cannot pay for the transaction. Nothing was taken.`,
    );
  }

  const { now, states } = await readChain('the order', () => readOrdersOnChain([order]));
  const judged = judgeOrder({ order, now, onChain: states[0]! });
  if (judged.fillable === null) return failed(judged.detail);
  if (!judged.fillable) return blocked(judged.status, judged.detail);

  const held = await usdcRawOf(owner);
  if (held === undefined) return failed('Your USDC balance could not be read, so nothing was taken.');
  if (held < order.takingAmount) {
    return blocked(
      'insufficient',
      `The order costs ${formatUnits(order.takingAmount, PAYS.decimals)} USDC and you hold ${formatUnits(held, PAYS.decimals)}.`,
    );
  }
  /*
   * `spendAsDelegate` takes dollars and converts them to USDC's six decimals. The router takes exactly the taking amount
   * and the delegation approves exactly what it pulls, so the two must agree to the unit — true for any order below
   * billions of dollars, and checked rather than assumed.
   */
  if (usdToUnits(usd) !== order.takingAmount) {
    return blocked('unrepresentable', 'The order’s USDC amount does not survive conversion to dollars exactly, so it was not taken.');
  }

  const fill = buildLimitOrderFill({ order, signature: row.signature as Hex, owner });

  /*
   * Dry run, with the router's errors in the ABI.
   *
   * `spendAsDelegate` simulates too, but against the delegation's ABI alone, so a router refusal would come back as four
   * bytes. Asked here first, "the maker spent their WETH" and "the approval is short" arrive as sentences.
   */
  const refusal = await publicClient
    .simulateContract({
      account: delegateAccount,
      address: DELEGATION_ADDRESS,
      abi: [...DELEGATION_ABI, ...LOP_ERRORS],
      functionName: 'spend',
      args: [owner, fill.token, fill.venue, fill.amount, fill.tokenOut, fill.minOut, fill.data],
    })
    .then(
      () => undefined,
      (e: unknown) => e,
    );
  if (refusal !== undefined) {
    const name = revertName(refusal);
    const raw = refusal instanceof Error ? refusal.message : String(refusal);
    // A revert is an answer, and asking again gets the same one. Anything else is the node, and worth retrying.
    if (name === undefined && !/revert/i.test(raw)) return failed(humanFailure(raw));
    return blocked('would_revert', (name && LOP_REFUSALS[name]) ?? humanFailure(raw));
  }

  let signature: Hex | undefined;
  try {
    // Read before the transaction, so the delta afterwards is the fill and nothing else.
    const before = await rawBalanceOf(owner, SELLS.symbol);
    signature = await spendAsDelegate({
      owner,
      token: fill.token,
      venue: fill.venue,
      usd,
      data: fill.data,
      tokenOut: fill.tokenOut,
      minOut: fill.minOut,
    });
    // Nothing is recorded for a transaction that was broadcast and not mined — see `closeHolding`.
    const settled = await waitForTx(signature).catch(() => false);
    if (!settled) throw new Error(`limit order fill ${signature} did not confirm`);

    const measured = await measuredDelta({ owner, symbol: SELLS.symbol, before });
    const size = Number(formatUnits(order.makingAmount, SELLS.decimals));
    // When the balance could not be read back, what the contract guaranteed arrived: the least it can have been.
    const received = measured ?? size;
    const price = usd / received;
    const action = `Took a limit order: bought ${shown(received)} ${SELLS.symbol}`;
    const sent = signature;

    await tx(async (client) => {
      await client.query(
        `UPDATE limit_orders SET filled_at = now(), fill_tx = $2, taker_wallet_id = $3
          WHERE order_hash = $1 AND chain = ${THIS_CHAIN} AND filled_at IS NULL`,
        [hash, sent, w.id],
      );
      const runId = await recordLimitFill(client, {
        walletId: w.id,
        orderHash: hash,
        maker: order.maker,
        label: action,
        units: received,
        usd,
        quotedUnits: measured === undefined ? null : size,
        signature: sent,
      });
      await applyFill(client, {
        walletId: w.id,
        symbol: SELLS.symbol,
        units: received,
        usd,
        attribution: { source: 'limit-order', id: null, label: 'Limit order' },
      });
      // `spend()` counted it against the cap on chain; the executor's tally must agree.
      await recordSpend(w.id, usd, client);
      await append(
        {
          walletId: w.id,
          agent: 'You',
          action,
          detail: `${measured === undefined ? 'At least ' : ''}${shown(received)} ${SELLS.symbol} for ${shown(usd)} ${PAYS.symbol}, ${dollars(price)} a ${SELLS.symbol}, from maker ${order.maker}, through the 1inch Limit Order Protocol.`,
          kind: 'trade',
          signature: sent,
          payload: {
            runId,
            orderHash: hash,
            maker: order.maker,
            received,
            usd,
            price,
            venue: 'lop',
            measured: measured !== undefined,
            explorer: explorerTx(sent),
          },
        },
        client,
      );
    });
    void snapshotWallet({ id: w.id, address: owner }, 'fill').catch(() => undefined);

    return {
      status: 200,
      body: {
        status: 'filled',
        hash,
        bought: SELLS.symbol,
        received,
        paid: usd,
        price,
        measured: measured !== undefined,
        venue: 'lop',
        txHash: sent,
      },
    };
  } catch (e) {
    return {
      status: 502,
      body: {
        status: 'failed',
        error: humanFailure(e instanceof Error ? e.message : String(e)),
        ...(signature ? { txHash: signature } : {}),
      },
    };
  }
}

limitOrderRoutes.post('/limit-orders/:hash/fill', async (c) => {
  requireUser(c);
  const w = await currentWallet(c);
  if (!w) return c.json({ status: 'blocked', reason: 'no_wallet', detail: 'No wallet is registered for this account yet.' }, 409);
  const out = await takeLimitOrder(w, c.req.param('hash'));
  return c.json(out.body, out.status as 200 | 400 | 404 | 409 | 502);
});
