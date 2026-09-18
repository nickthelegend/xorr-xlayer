/**
 * Cross-chain quotes — PLAN.md 3.16. Read-only: nothing here builds, signs or submits an order.
 *
 * `GET /crosschain/destinations` is where a quote can go from Base, and which contract arrives on each chain.
 * `GET /crosschain/quote?to=<chainId>&token=USDC|WETH&amount=<decimal>` asks 1inch's Fusion+ quoter what would arrive,
 * for the signed-in wallet, and answers with the auction presets a person would choose between: how long each runs,
 * what arrives, and what 1inch estimates filling costs.
 *
 * Every quote says `submittable: false`, with the reason. Submitting a Fusion+ order locks real funds on mainnet, which
 * PLAN.md 3.16 keeps out on purpose, so no route here could — and the answer says so rather than leaving a client to
 * infer it from an endpoint that is not there.
 */
import { Hono } from 'hono';
import type { Address } from 'viem';
import { requireUser } from '../auth/middleware.js';
import { currentWallet } from './wallet-context.js';
import {
  CROSSCHAIN_TOKENS,
  DESTINATIONS,
  SOURCE,
  crosschainQuote,
  quoteFailure,
  readAsk,
} from '../venues/fusion-plus.js';

export const crosschainRoutes = new Hono();

/** The registry itself, so the screen draws its chain choices from the list the route accepts rather than a copy. */
crosschainRoutes.get('/crosschain/destinations', (c) => {
  requireUser(c);
  return c.json({ from: SOURCE, tokens: [...CROSSCHAIN_TOKENS], destinations: [...DESTINATIONS] });
});

crosschainRoutes.get('/crosschain/quote', async (c) => {
  requireUser(c);
  // A question that cannot be asked is refused before anything is read — the wallet, or 1inch's quota.
  const ask = readAsk({ to: c.req.query('to'), token: c.req.query('token'), amount: c.req.query('amount') });
  if ('error' in ask) return c.json(ask, 400);

  // The quoter prices for a wallet, and the wallet is the signed-in user's. 409, as `NoWalletError`: the request is
  // fine, and the account is what has to change first.
  const w = await currentWallet(c);
  if (!w) {
    return c.json({ error: 'no_wallet', detail: 'A quote is asked for your wallet, and this account has none yet.' }, 409);
  }

  try {
    return c.json(await crosschainQuote(ask, w.address as Address));
  } catch (e) {
    // 1inch refusing, or not answering, is a real answer: the screen says which, with the reason, and shows no numbers.
    return c.json(quoteFailure(e, ask), 502);
  }
});
