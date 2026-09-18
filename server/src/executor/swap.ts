/**
 * A swap, placed now (PLAN.md 3.9).
 *
 * The Swap screen quoted a real route and then handed the user to a sell ticket: "Review swap" became
 * `POST /positions/close` at the stop tolerance, whatever pair and slippage the screen had shown. This is the
 * swap itself — under the same permission and the same settlement rules as everything else — in the two
 * shapes the delegation contract allows:
 *
 * - **Paying the settlement token** (USDC for anything) is a buy. It is placed as a one-shot order, so it
 *   passes every gate a run passes — the rules, the daily cap, best execution across venues, measurement —
 *   and `spend()` counts it against the cap.
 * - **Paying anything else** converts a holding. `closePosition()` sells exactly the units asked for into the
 *   token asked for. The contract charges that to no cap — it spends nothing the owner was not already holding
 *   in that token — and it refuses to sell the settlement token that way.
 *
 * The amount arrives as the decimal the person typed and is parsed into the token's own base units, never
 * through a float: the float of "0.1" is 100000000000000006 wei, and the delegation pulls exactly what it is told.
 */
import { formatUnits, parseUnits, type Address } from 'viem';
import { one, tx } from '../db/index.js';
import { append } from '../audit/log.js';
import { closeAsDelegate, readPolicy, waitForTx, DELEGATION_ADDRESS } from '../evm/delegation.js';
import { CHAIN_KEY, explorerTx } from '../evm/chains.js';
import { CAN_SETTLE, SETTLEMENT_SYMBOL, TOKENS, canonicalSymbol } from '../venues/tokens.js';
import { equitiesFunctional, isStock } from '../venues/stocks.js';
import { priceOf } from '../market/prices.js';
import { applyFill } from '../positions/index.js';
import { snapshotWallet } from '../portfolio/snapshots.js';
import { DUST_USD, recordSale } from '../routes/panic.js';
import type { WalletRow } from '../routes/wallet-context.js';
import { chooseSettlement } from './settle.js';
import { measuredDelta, proceedsSince, rawBalanceOf, usdcRawOf } from './fill-measure.js';
import { humanFailure, httpStatusFor } from './failure.js';
import { placeOrder } from './order.js';

export type SwapRequest = { from: string; to: string; amount: string; slippagePct?: number };
export type SwapResponse = { status: number; body: Record<string, unknown> };

const blocked = (reason: string, detail: string, status = 409): SwapResponse => ({
  status,
  body: { status: 'blocked', reason, detail },
});

/** The registry's name, with native ETH taken as WETH — the token the delegation can move, as a buy already does. */
function symbolOf(raw: string): string {
  const s = canonicalSymbol(raw);
  return s === 'ETH' ? 'WETH' : s;
}

/** Enough digits to read, none that are noise. */
const shown = (n: number) => Number(n.toPrecision(6));

export async function placeSwap(w: WalletRow, req: SwapRequest): Promise<SwapResponse> {
  const from = symbolOf(req.from);
  const to = symbolOf(req.to);
  if (!CAN_SETTLE) {
    return blocked(
      'not_settleable_here',
      `Nothing settles on ${CHAIN_KEY} — 1inch has no deployment here — so there is no swap to place.`,
    );
  }
  if (!TOKENS[from] || !TOKENS[to]) {
    return blocked('not_tradable', `${TOKENS[from] ? to : from} is not a token this executor trades.`);
  }
  if (from === to) return blocked('same_token', `Paying ${from} to receive ${from} is not a swap.`);
  if ((isStock(from) || isStock(to)) && !(await equitiesFunctional())) {
    return blocked('not_settleable_here', `Tokenized equities do not function on ${CHAIN_KEY}, so they cannot be swapped here.`);
  }
  return from === SETTLEMENT_SYMBOL ? buyWith(w, to, req) : convert(w, from, to, req);
}

/** USDC for anything: a one-shot order, with every gate a run has. */
async function buyWith(w: WalletRow, to: string, req: SwapRequest): Promise<SwapResponse> {
  const usd = Number(req.amount);
  const order = await placeOrder(
    w,
    to,
    usd,
    `Swap ${shown(usd)} USDC for ${to}`,
    req.slippagePct === undefined ? {} : { slippagePct: req.slippagePct },
  );
  if (!order.placed) return { status: 409, body: order.refusal };
  const outcome = order.outcome;
  if (outcome.status !== 'filled') return { status: httpStatusFor(outcome), body: outcome };
  // Where it settled is recorded with the fill; the screen names it.
  const run = await one<{ venue: string | null }>(`SELECT venue FROM strategy_runs WHERE id = $1`, [outcome.runId]);
  return {
    status: 200,
    body: {
      status: 'filled',
      from: SETTLEMENT_SYMBOL,
      to,
      sold: usd,
      received: outcome.units,
      usd,
      venue: run?.venue ?? null,
      txHash: outcome.signature,
    },
  };
}

/** Anything else: exactly the units asked for, sold into the token asked for, through `closePosition()`. */
async function convert(w: WalletRow, from: string, to: string, req: SwapRequest): Promise<SwapResponse> {
  const owner = w.address as Address;
  const pay = TOKENS[from]!;
  const receive = TOKENS[to]!;

  const policy = await readPolicy(owner);
  if (!policy || policy.revoked || policy.expiresAt <= Date.now()) {
    return blocked(
      'delegation_inactive',
      'The trading permission is revoked or expired, so nothing can be swapped on your behalf. Renew it, or move the funds yourself — they never left your wallet.',
    );
  }

  let raw: bigint;
  try {
    raw = parseUnits(req.amount, pay.decimals);
  } catch {
    return blocked('invalid_amount', `${req.amount} is not an amount of ${from}.`, 400);
  }
  if (raw <= 0n) return blocked('invalid_amount', 'The amount must be above zero.', 400);

  const held = await rawBalanceOf(owner, from);
  if (held === undefined) {
    return { status: 502, body: { status: 'failed', from, to, error: `Your ${from} balance could not be read, so nothing was placed.` } };
  }
  if (held === 0n) return blocked('not_held', `You hold no ${from}.`);
  if (raw > held) return blocked('insufficient', `You hold ${formatUnits(held, pay.decimals)} ${from}, less than ${req.amount}.`);

  const units = Number(formatUnits(raw, pay.decimals));
  const payPrice = await priceOf(from).catch(() => undefined);
  if (payPrice === undefined) {
    return {
      status: 503,
      body: { status: 'failed', from, to, error: `${from} has no price right now, so the swap cannot be valued or checked. Nothing was placed.` },
    };
  }
  const usd = units * payPrice;
  if (usd < DUST_USD) return blocked('dust', `Worth less than $${DUST_USD} — the gas would cost more than the swap returns.`);

  try {
    const settlement = await chooseSettlement({
      intent: {
        inSymbol: from,
        outSymbol: to,
        amountIn: units,
        amountInRaw: raw,
        usd,
        because: 'Swap placed by you.',
        slippagePct: req.slippagePct,
      },
      owner,
      // `closePosition()` sells what the owner holds: no book is asked, as on any exit.
      isClose: true,
      delegationFrom: DELEGATION_ADDRESS,
      // The `closePosition()` below, with the same raw amount, so a fork measures the route it will run (PLAN.md X77).
      send: { via: 'closePosition', amount: raw },
    });
    const intoSettlement = to === SETTLEMENT_SYMBOL;
    const before = intoSettlement ? await usdcRawOf(owner) : await rawBalanceOf(owner, to);
    const signature = await closeAsDelegate({
      owner,
      token: pay.address,
      venue: settlement.swap.to,
      amount: raw,
      data: settlement.swap.data,
      ...settlement.floor,
    });
    // Nothing is recorded for a transaction that was broadcast and not mined — see `closeHolding`.
    const settled = await waitForTx(signature).catch(() => false);
    if (!settled) throw new Error(`swap ${signature} did not confirm`);

    const measured = intoSettlement
      ? await proceedsSince(owner, before)
      : await measuredDelta({ owner, symbol: to, before });
    // When the balance could not be read back, what the contract guaranteed arrived — the least it can have been.
    const received = measured ?? Number(formatUnits(settlement.floor.minOut, receive.decimals));
    const receivePrice = intoSettlement ? 1 : await priceOf(to).catch(() => undefined);
    const receivedUsd = receivePrice === undefined ? usd : received * receivePrice;
    const action = `Swapped ${shown(units)} ${from} for ${shown(received)} ${to}`;

    await tx(async (client) => {
      const swapped = { source: 'manual' as const, id: null, label: 'Swap' };
      await applyFill(client, { walletId: w.id, symbol: from, units: -units, usd: -receivedUsd, attribution: swapped });
      if (!intoSettlement) {
        await applyFill(client, { walletId: w.id, symbol: to, units: received, usd: receivedUsd, attribution: swapped });
      }
      const runId = await recordSale(client, {
        walletId: w.id,
        symbol: from,
        label: action,
        units,
        proceedsUsd: receivedUsd,
        quotedUsd: measured === undefined ? null : usd,
        signature,
        kind: intoSettlement ? 'close' : 'swap',
        venue: settlement.venue,
      });
      await append(
        {
          walletId: w.id,
          agent: 'You',
          action,
          detail: `${measured === undefined ? 'At least ' : ''}${shown(received)} ${to} for ${shown(units)} ${from}, through ${settlement.venue}.`,
          kind: 'trade',
          signature,
          payload: {
            runId,
            from,
            to,
            sold: units,
            received,
            usd: receivedUsd,
            venue: settlement.venue,
            measured: measured !== undefined,
            explorer: explorerTx(signature),
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
        from,
        to,
        sold: units,
        received,
        usd: receivedUsd,
        venue: settlement.venue,
        measured: measured !== undefined,
        txHash: signature,
      },
    };
  } catch (e) {
    return { status: 502, body: { status: 'failed', from, to, error: humanFailure(e instanceof Error ? e.message : String(e)) } };
  }
}
