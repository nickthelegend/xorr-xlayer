/**
 * `/verify` — the claims, re-checked while you watch.
 *
 * Deliberately public and deliberately read-only. A judge, a reviewer or a sceptical user should
 * not have to create an account to check whether the contract is real, and every probe behind this
 * is a read. Passing `?owner=0x…` adds the checks that need a specific wallet — the policy, the
 * venue allowlist, the cap and the audit chain — for any address, because all of those are public
 * on-chain facts about an address anyone can already look up on an explorer.
 *
 * There is nothing here that our own database could fake on its own. Each check names the call it
 * made so the reader can repeat it without this server.
 */
import { Hono } from 'hono';
import { isAddress, type Address } from 'viem';
import { runChecks } from '../verify/checks.js';

export const verifyRoutes = new Hono();

verifyRoutes.get('/verify', async (c) => {
  const raw = c.req.query('owner');
  /*
   * A malformed address is a 400, not a check failure.
   *
   * Letting it through would run every wallet probe against garbage and report a wall of red for
   * what is really a typo — the console would be blaming the product for the reader's mistake.
   */
  if (raw && !isAddress(raw)) {
    return c.json({ error: 'invalid_owner', message: `${raw} is not an address.` }, 400);
  }
  const report = await runChecks(raw as Address | undefined);
  // A failing claim is a 200 with a red row, not a 5xx. The report succeeded; the claim did not.
  return c.json(report);
});
