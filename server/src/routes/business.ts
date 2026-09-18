/**
 * Business (PLAN.md 4.14): an operator's treasury, and the few things they may have it do.
 *
 *   GET  /business/treasury          the operator's treasury on this chain, read now — or null
 *   POST /business/treasury          create it { name }: a Privy wallet under the policy, registered as an owner
 *   POST /business/treasury/fund     test funds from the faucet, network fees included
 *   POST /business/treasury/grant    the treasury grants the bot { dailyCapUsd, days }
 *   POST /business/treasury/buy      the bot buys { symbol, usd } inside that grant
 *   POST /business/treasury/revoke   the treasury revokes the grant
 *   POST /business/treasury/prove    ask Privy to sign a transfer out, and show it refuse
 *
 * A person's routes, never an agent key's: each starts with `requireUser`, and acts only on the treasury that person
 * created, on this chain. Every answer that changed something carries the treasury read again and a sentence.
 */
import { Hono, type Context } from 'hono';
import { z } from 'zod';
import { getAddress, type Address } from 'viem';
import { requireUser } from '../auth/middleware.js';
import { currentWallet } from './wallet-context.js';
import {
  PrivyUnreadable,
  buyForTreasury,
  createTreasury,
  findTreasury,
  fundTreasury,
  grantBot,
  proveRefusal,
  revokeBot,
  treasuryView,
  type TreasuryAnswer,
  type TreasuryRow,
} from '../business/treasury.js';

export const businessRoutes = new Hono();

/** Privy not answering is an upstream failing, as a chain read is: a 502, in a sentence. */
async function answered(c: Context, run: () => Promise<TreasuryAnswer>) {
  try {
    const out = await run();
    return c.json(out.body, out.status);
  } catch (e) {
    if (e instanceof PrivyUnreadable) return c.json({ error: 'privy_unavailable', message: e.message }, 502);
    throw e;
  }
}

/** The signed-in operator's treasury here, or the answer that there is none. */
function withTreasury(c: Context, run: (t: TreasuryRow) => Promise<TreasuryAnswer>) {
  const { userId } = requireUser(c);
  return answered(c, async () => {
    const t = await findTreasury(userId);
    if (!t) return { status: 404, body: { error: 'no_treasury', message: 'This account has no treasury here yet.' } };
    return run(t);
  });
}

businessRoutes.get('/business/treasury', (c) => {
  const { userId } = requireUser(c);
  return answered(c, async () => {
    const t = await findTreasury(userId);
    return { status: 200, body: { treasury: t ? await treasuryView(t) : null } };
  });
});

const CreateInput = z.object({ name: z.string().trim().min(1).max(40) });

businessRoutes.post('/business/treasury', async (c) => {
  const { userId } = requireUser(c);
  const body = CreateInput.parse(await c.req.json());
  return answered(c, () => createTreasury(userId, body.name));
});

businessRoutes.post('/business/treasury/fund', (c) => withTreasury(c, fundTreasury));

const GrantInput = z.object({
  dailyCapUsd: z.number().min(1).max(10_000),
  days: z.number().int().min(1).max(30),
});

businessRoutes.post('/business/treasury/grant', (c) =>
  withTreasury(c, async (t) => {
    const body = GrantInput.parse(await c.req.json());
    return grantBot(t, body.dailyCapUsd, body.days);
  }),
);

const BuyInput = z.object({
  symbol: z.string().min(1).max(12),
  usd: z.number().positive().max(1_000),
});

businessRoutes.post('/business/treasury/buy', (c) =>
  withTreasury(c, async (t) => {
    const body = BuyInput.parse(await c.req.json());
    return buyForTreasury(t, body.symbol, body.usd);
  }),
);

businessRoutes.post('/business/treasury/revoke', (c) => withTreasury(c, revokeBot));

/** Where the refused transfer is addressed when the operator has no wallet of their own on file. */
const NOBODY: Address = '0x000000000000000000000000000000000000dEaD';

businessRoutes.post('/business/treasury/prove', (c) =>
  withTreasury(c, async (t) => {
    // To the operator's own wallet when there is one: the transfer an insider would ask for.
    const mine = await currentWallet(c);
    return proveRefusal(t, mine ? getAddress(mine.address) : NOBODY);
  }),
);
