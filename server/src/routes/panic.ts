/**
 * Get me out.
 *
 * `revoke()` stops the bot. It does not sell anything — and those are different needs that a
 * frightened person at 3am will not distinguish. The safety screen offered only the first one, so
 * a user who wanted out had to revoke, then go and place every sell by hand, on a screen designed
 * for making one considered trade at a time.
 *
 * Two properties make this safe to hand someone:
 *
 *   - **It routes through `closePosition`, never `spend`.** The daily cap is a limit on putting
 *     capital AT risk. A cap that can block an exit is a cap that traps you, and a spending limit
 *     that silences a panic button is worse than no limit at all.
 *   - **It is per-asset and reports each one.** A flatten that sells three of four holdings and
 *     returns "ok" is a lie about the fourth. Every leg gets its own result, and one failure does
 *     not abandon the rest.
 *
 * It does NOT revoke. Selling and withdrawing permission are separate decisions, and doing the
 * second silently would leave a user unable to run anything afterwards without understanding why.
 */
import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { Hono } from 'hono';
import { log } from '../http/request-id.js';
import { readChain } from '../http/chain-read.js';
import { screenPatience } from '../http/patience.js';
import { z } from 'zod';
import { formatUnits, type Address } from 'viem';
import { requireUser } from '../auth/middleware.js';
import { currentWallet } from './wallet-context.js';
import { tx } from '../db/index.js';
import { append } from '../audit/log.js';
import { holdings } from '../evm/balances.js';
import { closeAsDelegate, readPolicy, waitForTx } from '../evm/delegation.js';
import { SLIPPAGE, TOKENS, canonicalSymbol } from '../venues/tokens.js';
import { buildSwap } from '../venues/uniswap.js';
import { DELEGATION_ADDRESS } from '../evm/delegation.js';
import { ADDRESSES, explorerTx } from '../evm/chains.js';
import { applyFill } from '../positions/index.js';
import { send } from '../notifications/push.js';
import { humanFailure } from '../executor/failure.js';
import { proceedsSince, usdcRawOf } from '../executor/fill-measure.js';
import { isStock } from '../venues/stocks.js';
import { snapshotWallet } from '../portfolio/snapshots.js';

export const panic = new Hono();

/** Below this a sale costs more in gas than it returns. Selling it anyway is a disservice. */
export const DUST_USD = 1;

type Leg = {
  symbol: string;
  units: number;
  usd: number;
  status: 'sold' | 'failed' | 'skipped';
  detail: string;
  signature?: string;
  explorer?: string;
};

/**
 * A sale someone asked for, recorded where every other fill is (PLAN.md 2.8).
 *
 * Closes and flattens wrote a position row and an audit entry but no `strategy_runs` row, so the
 * record `/runs`, fill quality and the venue counts read had none of the sales a person asked for.
 * One `close` strategy per sale — already ended, so nothing schedules it — and its filled run, in the
 * same transaction as the position change.
 */
export async function recordSale(
  client: PoolClient,
  sale: {
    walletId: string;
    symbol: string;
    label: string;
    units: number;
    proceedsUsd: number;
    /** The arrival value, when the proceeds were measured. Null leaves the sale unmeasured. */
    quotedUsd: number | null;
    signature: string;
    /** A sale into the settlement token is a `close`; one into any other token is a `swap` (PLAN.md 3.9). */
    kind?: 'close' | 'swap';
    /** Where it settled. A close goes through Uniswap v3 (`venues/uniswap.ts`); a swap names the venue its settlement chose. */
    venue?: string;
  },
): Promise<string> {
  const strategyId = randomUUID();
  await client.query(
    `INSERT INTO strategies (id, wallet_id, kind, state, label, symbol, params, daily_allocation_usd)
     VALUES ($1, $2, $3, 'ended', $4, $5, $6, 0)`,
    [strategyId, sale.walletId, sale.kind ?? 'close', sale.label, sale.symbol, JSON.stringify({ manual: true })],
  );
  const runId = randomUUID();
  await client.query(
    `INSERT INTO strategy_runs
       (id, strategy_id, period_key, status, usd, units, price, signature, venue, side, quoted_usd, asset_class, finished_at)
     VALUES ($1, $2, $3, 'filled', $4, $5, $6, $7, $8, 'sell', $9, $10, now())`,
    [
      runId,
      strategyId,
      `sale:${runId}`,
      sale.proceedsUsd,
      sale.units,
      sale.units > 0 ? sale.proceedsUsd / sale.units : null,
      sale.signature,
      sale.venue ?? 'uniswap-v3',
      sale.quotedUsd,
      isStock(sale.symbol) ? 'equity' : 'crypto',
    ],
  );
  return runId;
}

/** Proceeds as the trail says them: measured, or plainly labelled as the estimate they are. */
function proceedsLabel(usd: number, measured: boolean): string {
  const amount = `$${usd.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} USDC`;
  return measured ? amount : `about ${amount} (the balance could not be read back)`;
}

panic.get('/panic/preview', async (c) => {
  requireUser(c);
  // `currentWallet`, not another unordered `LIMIT 1`: selling down the wrong one of a user's
  // wallet rows is the worst outcome any of these copies could produce.
  const w = await currentWallet(c);
  if (!w) return c.json({ legs: [], totalUsd: 0 });
  /*
   * Bounded as `/wallet/balance` is (`http/patience.ts`), and a read that failed is a failure.
   *
   * This waited on every held token's price with the scheduler's patience and gave no answer inside sixty seconds in
   * the QA run against the hosted fork executor. And with no `readChain`, a balance read that threw reached the screen
   * as a 500 carrying viem's own message.
   */
  const patience = screenPatience();
  const held = await readChain(
    'your holdings',
    () => holdings(w.address as Address, { priceDeadlineMs: patience.priceMs }),
    patience.chainReadMs,
  );
  const legs = held.filter((h) => h.usd >= DUST_USD);
  return c.json({
    legs: legs.map((h) => ({ symbol: h.symbol, units: h.units, usd: h.usd })),
    totalUsd: legs.reduce((a, h) => a + h.usd, 0),
    // Named so the screen can say it out loud rather than implying it.
    dustBelowUsd: DUST_USD,
    /** Said out loud so the screen can, rather than surprising someone afterwards. */
    slippagePct: SLIPPAGE.panic,
    skipped: held.filter((h) => h.usd < DUST_USD).map((h) => h.symbol),
  });
});

panic.post('/panic/flatten', async (c) => {
  requireUser(c);
  // `currentWallet`, not another unordered `LIMIT 1`: selling down the wrong one of a user's
  // wallet rows is the worst outcome any of these copies could produce.
  const w = await currentWallet(c);
  if (!w) return c.json({ error: 'no_wallet' }, 400);
  const owner = w.address as Address;

  /*
   * A revoked or expired permission means the bot cannot sell for you.
   *
   * Saying that plainly beats attempting four transactions that all revert with the same opaque
   * error — and it points at the fix, which is to grant again before flattening.
   */
  const policy = await readPolicy(owner);
  if (!policy) {
    return c.json(
      { error: 'no_delegation', message: 'No trading permission on-chain, so nothing can be sold for you. Your funds are yours to move directly.' },
      400,
    );
  }
  if (policy.revoked || policy.expiresAt <= Date.now()) {
    return c.json(
      {
        error: 'delegation_inactive',
        message:
          'The trading permission is revoked or expired, so the bot cannot sell on your behalf. Renew it to use this, or move the funds yourself — they never left your wallet.',
      },
      400,
    );
  }

  const held = (await holdings(owner)).filter((h) => h.units > 0);
  const legs: Leg[] = [];

  for (const h of held) {
    if (h.usd < DUST_USD) {
      legs.push({
        symbol: h.symbol,
        units: h.units,
        usd: h.usd,
        status: 'skipped',
        detail: `Worth less than $${DUST_USD} — the gas would cost more than the sale returns.`,
      });
      continue;
    }
    const token = TOKENS[h.symbol];
    if (!token) {
      legs.push({
        symbol: h.symbol,
        units: h.units,
        usd: h.usd,
        status: 'failed',
        detail: 'No route registry entry for this token, so it cannot be sold here.',
      });
      continue;
    }

    try {
      const swap = await buildSwap({
        inSymbol: h.symbol,
        outSymbol: 'USDC',
        amount: h.units,
        // The router must be told the same number the delegation will approve it for.
        amountRaw: h.raw,
        from: DELEGATION_ADDRESS,
        receiver: owner,
        // A panic exit accepts more slippage than a scheduled buy, on purpose. See `SLIPPAGE`.
        slippagePct: SLIPPAGE.panic,
      });
      const usdcBefore = await usdcRawOf(owner);
      const signature = await closeAsDelegate({
        owner,
        token: token.address,
        venue: swap.to as Address,
        // The token's own units. The whole position, because a partial exit is not what was asked.
        // The chain's own number, not a float round-trip. See `Holding.raw`.
        amount: h.raw,
        data: swap.data,
        // The proceeds are the owner's cash, at no less than the router's own floor (PLAN.md 1.4).
        tokenOut: ADDRESSES.usdc,
        minOut: swap.minOut,
      });

    /*
     * Wait for the receipt before recording the sale.
     *
     * `closeAsDelegate` returns as soon as the transaction is broadcast. Both of these paths then
     * wrote the position row, the audit entry and a "Sold" line for the user — for a transaction
     * that had not been mined and, on a chain without automine, might still revert. The book would
     * then say a position was closed while the chain still held it, which is the one direction this
     * error must never go: a user told they are out of a trade they are still in.
     *
     * `runStrategy` already waits for exactly this reason. This path was written separately and
     * never got it.
     */
    const settled = await waitForTx(signature).catch(() => false);
    if (!settled) throw new Error(`close ${signature} did not confirm`);


      // What arrived, and exactly what left (PLAN.md 2.8).
      const proceeds = await proceedsSince(owner, usdcBefore);
      const soldUnits = Number(formatUnits(h.raw, token.decimals));
      const proceedsUsd = proceeds ?? h.usd;

      await tx(async (client) => {
        await applyFill(client, {
          walletId: w.id,
          symbol: h.symbol,
          units: -soldUnits,
          usd: -proceedsUsd,
          attribution: { source: 'flatten', id: null, label: 'Sell everything' },
        });
        const runId = await recordSale(client, {
          walletId: w.id,
          symbol: h.symbol,
          label: `Flatten: sold all ${h.symbol}`,
          units: soldUnits,
          proceedsUsd,
          quotedUsd: proceeds === undefined ? null : h.usd,
          signature,
        });
        await append(
          {
            walletId: w.id,
            agent: 'Drawdown Guard',
            action: `Sold all ${h.symbol}`,
            detail: `${soldUnits.toFixed(6)} ${h.symbol} for ${proceedsLabel(proceedsUsd, proceeds !== undefined)}. You asked to be flattened.`,
            kind: 'trade',
            signature,
            payload: {
              panic: true,
              runId,
              symbol: h.symbol,
              units: soldUnits,
              usd: proceedsUsd,
              quotedUsd: h.usd,
              measured: proceeds !== undefined,
              explorer: explorerTx(signature),
            },
          },
          client,
        );
      });

      legs.push({
        symbol: h.symbol,
        units: soldUnits,
        usd: proceedsUsd,
        status: 'sold',
        detail: `${soldUnits.toFixed(6)} ${h.symbol} sold for ${proceedsLabel(proceedsUsd, proceeds !== undefined)}.`,
        signature,
        explorer: explorerTx(signature),
      });
    } catch (e) {
      /*
       * One failure must not abandon the rest.
       *
       * A flatten that stops at the first illiquid token leaves the user holding everything after
       * it, having been told the operation ran.
       */
      const raw = e instanceof Error ? e.message : String(e);
      log.error(`[panic] ${h.symbol} failed:`, raw);
      legs.push({
        symbol: h.symbol,
        units: h.units,
        usd: h.usd,
        status: 'failed',
        detail: humanFailure(raw),
      });
    }
  }

  const sold = legs.filter((l) => l.status === 'sold');
  const failed = legs.filter((l) => l.status === 'failed');
  // The wallet's value after the sales (PLAN.md 2.10); not awaited.
  if (sold.length > 0) void snapshotWallet({ id: w.id, address: owner }, 'close').catch(() => undefined);

  if (legs.length === 0) {
    await tx(async (client) => {
      await append(
        {
          walletId: w.id,
          agent: 'Drawdown Guard',
          action: 'Nothing to sell',
          detail: 'You asked to be flattened and there were no positions to close.',
          kind: 'risk',
          payload: { panic: true },
        },
        client,
      );
    });
  }

  void send(w.id, {
    title: failed.length ? 'Flattened, with problems' : 'Everything sold to USDC',
    body: failed.length
      ? `${sold.length} sold, ${failed.length} could not be. Open the app to see which.`
      : `${sold.length} position${sold.length === 1 ? '' : 's'} closed. Your cash is in your own wallet.`,
    route: '/activity',
    kind: 'panic-flatten',
  }).catch(() => undefined);

  return c.json({
    legs,
    sold: sold.length,
    failed: failed.length,
    // The cap is untouched on purpose, and the response says so rather than leaving it implied.
    capUntouched: true,
  });
});

/**
 * The close itself, with the wallet already resolved.
 *
 * Split out because there are two legitimate callers that authenticate differently: the
 * signed-in user on `/positions/close`, and the deployed closing agent on
 * `/agent/positions/close`. Duplicating it would duplicate the exit path — the one path that
 * has to behave identically no matter who asked.
 *
 * It goes through `closeAsDelegate`, never `spend`, so the daily cap cannot silence it. A cap
 * is a limit on putting capital AT risk; a cap that can block an exit is a cap that traps you.
 *
 * A `fraction` rather than an amount, because that is what the screen asks — and because a
 * full close has to move the balance the CHAIN holds, not a float round-trip of it. `h.raw` is
 * the chain's own number and the fraction is applied to it in integer maths, so a 100% close is
 * exactly the balance and never eight wei over it.
 */
export async function closeHolding(params: {
  wallet: { id: string; address: string };
  symbol: string;
  fraction: number;
  /** Whose name goes in the audit row: the user pressed it, or an agent's rule fired. */
  actor: string;
}): Promise<{ status: number; body: Record<string, unknown> }> {
  const { wallet: w, fraction, actor } = params;
  const owner = w.address as Address;
  // `NVDAc` uppercased is not a token anyone can flatten.
  const symbol = canonicalSymbol(params.symbol);

  const policy = await readPolicy(owner);
  if (!policy || policy.revoked || policy.expiresAt <= Date.now()) {
    return {
      status: 409,
      body: {
        status: 'blocked',
        reason: 'delegation_inactive',
        detail:
          'The trading permission is revoked or expired, so the bot cannot sell on your behalf. Renew it, or move the funds yourself — they never left your wallet.',
      },
    };
  }

  const h = (await holdings(owner)).find((x) => x.symbol === symbol && x.units > 0);
  if (!h) {
    return {
      status: 409,
      body: { status: 'blocked', reason: 'not_held', detail: `No ${symbol} to sell.` },
    };
  }

  const token = TOKENS[symbol];
  if (!token) {
    return {
      status: 409,
      body: {
        status: 'blocked',
        reason: 'no_route',
        detail: `${symbol} cannot be sold on this chain.`,
      },
    };
  }

  // Integer maths on the chain's own number. A full close is EXACTLY the balance.
  const full = fraction >= 0.999999;
  const raw = full ? h.raw : (h.raw * BigInt(Math.round(fraction * 1e6))) / 1_000_000n;
  if (raw <= 0n) {
    return {
      status: 409,
      body: { status: 'blocked', reason: 'dust', detail: 'That is too small to sell.' },
    };
  }
  const units = full ? h.units : h.units * fraction;
  const usd = full ? h.usd : h.usd * fraction;
  if (usd < DUST_USD) {
    return {
      status: 409,
      body: {
        status: 'blocked',
        reason: 'dust',
        detail: `Worth less than $${DUST_USD} — the gas would cost more than the sale returns.`,
      },
    };
  }

  try {
    const swap = await buildSwap({
      inSymbol: symbol,
      outSymbol: 'USDC',
      amount: units,
      amountRaw: raw,
      from: DELEGATION_ADDRESS,
      receiver: owner,
      // A deliberate exit is not a panic, and it is not a scheduled buy either: somebody is
      // watching and wants it done. `stop` is the middle tier for exactly that — an exit that
      // must not fail because the market moved while it was being signed.
      slippagePct: SLIPPAGE.stop,
    });
    const usdcBefore = await usdcRawOf(owner);
    const signature = await closeAsDelegate({
      owner,
      token: token.address,
      venue: swap.to as Address,
      amount: raw,
      data: swap.data,
      tokenOut: ADDRESSES.usdc,
      minOut: swap.minOut,
    });

    /*
     * Wait for the receipt before recording the sale.
     *
     * `closeAsDelegate` returns as soon as the transaction is broadcast. Both of these paths then
     * wrote the position row, the audit entry and a "Sold" line for the user — for a transaction
     * that had not been mined and, on a chain without automine, might still revert. The book would
     * then say a position was closed while the chain still held it, which is the one direction this
     * error must never go: a user told they are out of a trade they are still in.
     *
     * `runStrategy` already waits for exactly this reason. This path was written separately and
     * never got it.
     */
    const settled = await waitForTx(signature).catch(() => false);
    if (!settled) throw new Error(`close ${signature} did not confirm`);


    // What arrived, and exactly what the delegation pulled — not the float the fraction was taken of.
    const proceeds = await proceedsSince(owner, usdcBefore);
    const soldUnits = Number(formatUnits(raw, token.decimals));
    const proceedsUsd = proceeds ?? usd;
    const action = full ? `Sold all ${symbol}` : `Sold ${Math.round(fraction * 100)}% of ${symbol}`;

    await tx(async (client) => {
      await applyFill(client, {
        walletId: w.id,
        symbol,
        units: -soldUnits,
        usd: -proceedsUsd,
        /*
         * A close of ONE position, which is not a flatten.
         *
         * `/panic/flatten` sells everything and is attributed as such; this is a person closing a
         * single holding they chose. Sharing a label between the two would put "Sell everything"
         * against a sale that sold one thing.
         */
        attribution: { source: 'manual', id: null, label: 'Close' },
      });
      const runId = await recordSale(client, {
        walletId: w.id,
        symbol,
        label: action,
        units: soldUnits,
        proceedsUsd,
        quotedUsd: proceeds === undefined ? null : usd,
        signature,
      });
      await append(
        {
          walletId: w.id,
          agent: actor,
          action,
          detail: `${soldUnits.toFixed(6)} ${symbol} for ${proceedsLabel(proceedsUsd, proceeds !== undefined)}.`,
          kind: 'trade',
          signature,
          payload: {
            runId,
            symbol,
            units: soldUnits,
            usd: proceedsUsd,
            quotedUsd: usd,
            measured: proceeds !== undefined,
            fraction,
            explorer: explorerTx(signature),
          },
        },
        client,
      );
    });

    // The wallet's value with this sale in it (PLAN.md 2.10); not awaited.
    void snapshotWallet({ id: w.id, address: owner }, 'close').catch(() => undefined);

    return {
      status: 200,
      body: { status: 'closed', symbol, units: soldUnits, usd: proceedsUsd, measured: proceeds !== undefined, txHash: signature },
    };
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e);
    return { status: 502, body: { status: 'failed', symbol, error: humanFailure(error) } };
  }
}

/**
 * Sell part or all of ONE holding — screen 22's "Close {n}%", and the sell side of the order
 * ticket.
 */
export const CloseInput = z.object({
  symbol: z.string().min(1).max(12),
  /** 0 < fraction <= 1. Screen 22's pills send 0.25 / 0.5 / 0.75 / 1. */
  fraction: z.number().gt(0).max(1).default(1),
});

panic.post('/positions/close', async (c) => {
  requireUser(c);
  /*
   * `user_id`, which is the column that exists.
   *
   * This asked for `privy_user_id` — a column no migration has ever created — so every call to
   * the route the position screen's "Close" button makes died in Postgres, for every user, on
   * every asset. It was never caught because nothing exercised the route against a real
   * database with a real session: the coverage test only asks whether a path 404s.
   */
  // `currentWallet`, not another unordered `LIMIT 1`: selling down the wrong one of a user's
  // wallet rows is the worst outcome any of these copies could produce.
  const w = await currentWallet(c);
  if (!w) return c.json({ status: 'blocked', reason: 'no_wallet' }, 409);

  const body = CloseInput.parse(await c.req.json());
  const out = await closeHolding({ wallet: w, symbol: body.symbol, fraction: body.fraction, actor: 'You' });
  return c.json(out.body, out.status as 200 | 409 | 502);
});
