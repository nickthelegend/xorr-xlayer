/**
 * The executor API — PLAN.md 12.1. Mirrors the client's repository interfaces one-to-one, so
 * swapping the app from fixtures to the server changes src/data/index.ts and nothing else.
 */
import { randomUUID } from 'node:crypto';
import { log } from '../http/request-id.js';
import { readChain } from '../http/chain-read.js';
import { screenPatience } from '../http/patience.js';
import { StillFetching } from '../http/deadline.js';
import { Hono, type Context } from 'hono';
import { z } from 'zod';
import { one, query, tx } from '../db/index.js';
import { append, exportTrail, list as listAudit, verify } from '../audit/log.js';
import { FILLS_SQL, fillsCsv, type FillRow } from '../audit/fills.js';
import { explainTrade } from '../bot/explain.js';
import { recordGrant, recordRevoke } from '../delegation/record.js';
import {
  ANCHOR_ADDRESS,
  agreement,
  anchorHistory,
  anchorOnDemand,
  anchoringConfigured,
} from '../audit/anchor.js';
import { evaluate, spentToday } from '../rules/engine.js';
import {
  runStrategy,
  CLOSE_ONLY_KINDS,
  EXECUTABLE_KINDS,
  SELF_SIZING_KINDS,
  type StrategyRow,
} from '../executor/run.js';
import { TOKENS as VENUE_TOKENS, canonicalSymbol } from '../venues/tokens.js';
import { nextRuns, type Cadence } from '../executor/schedule.js';
import { backingFor, backingSeries } from '../venues/proof-of-reserves.js';
import { backingDetail } from '../venues/backing-detail.js';
import { dividendYield } from '../venues/dividend-yield.js';
import { XSTOCKS, xStockKey } from '../venues/xstocks.js';
import { ADDRESSES, APPROVABLE_TOKENS, CHAIN_KEY, IS_MAINNET_STATE, OKX_DEX_APPROVE_SPENDER, SETTLEMENT_VENUES, explorerTx } from '../evm/chains.js';
import { allowanceView, chainAllowance, routerAllowance, routerSpender } from '../evm/allowances.js';
import { delegateAccount } from '../evm/client.js';
import { dripGasIfNeeded } from '../evm/gasDrip.js';
import {
  delegatePublicKey,
  readPolicy,
  readPolicyAndVenues,
  waitForTx,
  DELEGATION_ADDRESS,
} from '../evm/delegation.js';
import { requireUser } from '../auth/middleware.js';
import { bindWallet, findLinkedWallet } from '../auth/walletBinding.js';
import { freshWallets } from '../auth/privy.js';
import { currentWallet, requireWallet, walletsFor, type WalletRow } from './wallet-context.js';
import { erc20Abi, formatUnits, getAddress } from 'viem';
import type { Address, Hex } from 'viem';
import { priceOf } from '../market/prices.js';
import { COINGECKO_IDS } from '../market/ids.js';
import { totalValueUsd } from '../evm/balances.js';
import { TOKENS } from '../venues/tokens.js';
import { publicClient } from '../evm/client.js';
import { STOCKS, isStock, equitiesFunctional } from '../venues/stocks.js';
import { getPosition, listPositions, realisedPnl } from '../positions/index.js';
import { PUSH_KINDS } from '../notifications/push.js';
import { SNAPSHOT_EVERY_MS, historySince, listSnapshots, snapshotWallet, thinPoints } from '../portfolio/snapshots.js';

/**
 * Every wallet lookup is scoped to the AUTHENTICATED Privy user.
 *
 * The previous build read "the first wallet row", which was fine for one user on a laptop and
 * catastrophic for two: any caller could act on anyone's capital. Privy gives a verified user id
 * on every request and it is the key for everything below.
 */

export const routes = new Hono();

// `/health` moved to routes/ops.ts, where it checks the dependencies rather than only proving the
// process can still answer a request.

// ── Wallet ───────────────────────────────────────────────────────────────────

routes.get('/wallet', async (c) => {
  const w = await currentWallet(c);
  if (!w) return c.json(null);
  /*
   * `cluster` is where the wallet was CREATED. `chain` is where the executor is settling now.
   *
   * They are different facts and the screen was showing the first while meaning the second — so a
   * wallet created on Sepolia and now trading a Base fork reported "xlayer-testnet" underneath live
   * Base balances. The stored value is history and stays; the live one is what a user is asking
   * about when they look at this line.
   */
  return c.json({ ...w, chain: CHAIN_KEY });
});

/**
 * GET /wallets — every address on this account, the one in use first.
 *
 * A user having more than one is not hypothetical: web Privy lists any injected browser extension
 * alongside the embedded wallet, so an account that once connected through an extension has both on
 * file. Everything in this system is scoped by wallet — the policy, the balance, the strategies, the
 * trail — so the other address had a whole second set of all of it that nothing in the app could
 * reach, and no way to tell that was why the numbers looked wrong.
 *
 * `active` is computed from the SAME ordering `currentWallet` picks with, not recomputed here. A
 * list whose idea of the current wallet could disagree with the executor's would show a ticked row
 * while the money moved on a different address.
 *
 * Switching is `POST /wallet/connect`, which already exists and already asks Privy whether the
 * address really belongs to the caller. A second endpoint that set `active_at` directly would be a
 * second door into the same room, and the second door is the one nobody remembers to lock.
 */
routes.get('/wallets', async (c) => {
  const rows = await walletsFor(c);
  return c.json(
    rows.map((w, i) => ({
      id: w.id,
      address: w.address,
      /** `embedded` was made by Privy for this account; `connected` is a wallet the user brought. */
      kind: w.kind,
      /** Where the row was created. History, not where the executor settles now — see `GET /wallet`. */
      cluster: w.cluster,
      /** First in this order is the one every other route resolves to. */
      active: i === 0,
      lastActiveAt: w.active_at ? new Date(w.active_at).getTime() : undefined,
      createdAt: new Date(w.created_at).getTime(),
    })),
  );
});

/** Privy could not be asked which wallets this account has — which is not the same as it having none. */
function identityUnavailable(c: Context) {
  return c.json(
    {
      error: 'identity_unavailable',
      message: 'Could not confirm this wallet with Privy just now. Try again in a moment.',
    },
    503,
  );
}

/** The row exists under a different account. Reported, never resolved in the caller's favour. */
function ownedElsewhere(c: Context) {
  return c.json(
    {
      error: 'wallet_owned_by_another_account',
      message: 'This wallet is already registered to a different account.',
    },
    409,
  );
}

routes.post('/wallet/create', async (c) => {
  const user = requireUser(c);
  const existing = await currentWallet(c);
  if (existing) return c.json(existing);

  /*
   * Privy owns the embedded wallet, so the address comes from the verified identity and nowhere else.
   * This used to fall back to `body.address`, which let a request name any wallet at all and — through
   * the upsert below it — take the row from whoever held it. See `auth/walletBinding.ts`.
   */
  // The account record can be minutes old (see `verifyToken`), and a wallet Privy made seconds ago is
  // exactly what this route exists for — so ask again before saying there is none.
  let wallets = user.wallets;
  let embedded = wallets?.find((w) => w.embedded);
  if (!embedded) {
    wallets = await freshWallets(user.userId);
    embedded = wallets?.find((w) => w.embedded);
  }
  if (!wallets) return identityUnavailable(c);
  if (!embedded) {
    return c.json(
      {
        error: 'no_wallet',
        message: 'No embedded wallet on this Privy account yet. Create one in the app first.',
      },
      400,
    );
  }

  const bound = await bindWallet({
    id: randomUUID(),
    userId: user.userId,
    address: getAddress(embedded.address),
    kind: 'embedded',
    cluster: CHAIN_KEY,
  });
  if (bound.status !== 'bound') return ownedElsewhere(c);
  const row = bound.row;
  const address = row.address;
  if (!bound.inserted) return c.json(row);

  await append({
    walletId: row.id,
    agent: 'xorr',
    action: 'Wallet connected',
    detail: `Your keys, held by you. ${CHAIN_KEY}.`,
    kind: 'risk',
  });

  /*
   * A wallet that cannot pay gas cannot sign the permission, and the permission is the product.
   *
   * Privy creates the embedded wallet empty, so on the hosted deployment a first-time visitor
   * reached the delegate screen and the signature failed on `insufficient funds` — every screen
   * past that point unreachable. The drip refuses on mainnet and on a fork of it, refuses a wallet
   * that already holds anything, and refuses to spend the delegate below its own gas reserve.
   *
   * Awaited but never allowed to throw: the wallet exists and is usable either way, and someone
   * funding it themselves must not be blocked by a faucet that had nothing to give. The outcome is
   * written to the trail because a transfer out of the delegate's key is exactly the sort of thing
   * that should never happen unrecorded.
   */
  const drip = await dripGasIfNeeded(address as Address).catch((e) => ({
    sent: false as const,
    reason: e instanceof Error ? e.message : String(e),
  }));
  await append({
    walletId: row.id,
    agent: 'xorr',
    action: drip.sent ? `Sent ${drip.amountEth} test ETH for gas` : 'No gas sent',
    detail: drip.sent
      ? `${CHAIN_KEY} test ETH, so you can sign the permission. It has no value and buys nothing.`
      : `Not sent — ${drip.reason}.`,
    kind: 'risk',
    payload: drip.sent ? { hash: drip.hash } : { reason: drip.reason },
  }).catch(() => undefined);

  return c.json(row);
});

/**
 * The endpoint onboarding actually calls.
 *
 * `/wallet/create` exists and is the one that reads like the entry point, but screen 2 posts here —
 * Privy has already made the wallet, so the app is telling the executor about an address rather
 * than asking for one. That distinction cost the gas drip a whole deploy: it was added to
 * `/wallet/create`, which the app never calls, and a wallet signed in through the hosted build
 * still arrived with nothing to pay gas with.
 */
routes.post('/wallet/connect', async (c) => {
  const user = requireUser(c);
  const body = z.object({ address: z.string().regex(/^0x[a-fA-F0-9]{40}$/) }).parse(await c.req.json());

  /*
   * Only a wallet on the caller's own Privy account.
   *
   * This trusted `body.address` and upserted with `SET user_id = EXCLUDED.user_id`, so any signed-in
   * user could take any wallet row — and with it trade, close and flatten on that owner's permission.
   * Privy is the authority on which wallets an account has; a request body is not.
   */
  // Missing from the cached account record is not yet "not yours": a wallet linked a moment ago
  // postdates it, so ask Privy again before refusing.
  let wallets = user.wallets;
  let linked = wallets && findLinkedWallet(wallets, body.address);
  if (!linked) {
    wallets = await freshWallets(user.userId);
    linked = wallets && findLinkedWallet(wallets, body.address);
  }
  if (!wallets) return identityUnavailable(c);
  if (!linked) {
    return c.json(
      {
        error: 'wallet_not_linked',
        message: 'That address is not a wallet on your account, so it cannot be connected here.',
      },
      403,
    );
  }

  // `active_at` is the point of this call as much as the row is: the app is telling us which of this
  // user's addresses it is on, and that is what `currentWallet` orders by.
  const bound = await bindWallet({
    id: randomUUID(),
    userId: user.userId,
    address: getAddress(linked.address),
    kind: linked.embedded ? 'embedded' : 'connected',
    cluster: CHAIN_KEY,
  });
  if (bound.status !== 'bound') return ownedElsewhere(c);
  const row = bound.row;

  // Once, on first sight — decided by the insert itself, so two concurrent first connects cannot both
  // send gas.
  if (bound.inserted) {
    await append({
      walletId: row.id,
      agent: 'xorr',
      action: 'Wallet connected',
      detail: `Your keys, held by you. ${CHAIN_KEY}.`,
      kind: 'risk',
    }).catch(() => undefined);

    /*
     * A wallet that cannot pay gas cannot sign the permission, and the permission is the product.
     *
     * Privy creates the embedded wallet empty, so on the hosted deployment a first-time visitor
     * reached the delegate screen and the signature failed on `insufficient funds` — every screen
     * past that point unreachable. `dripGasIfNeeded` refuses on mainnet and on a fork of it,
     * refuses a wallet that already holds anything, and refuses to spend the delegate below its
     * own reserve.
     *
     * Never fatal: the wallet is created and usable either way, and someone funding it themselves
     * must not be blocked by a faucet that had nothing to give. Recorded in the trail because a
     * transfer out of the delegate's key should never happen unlogged.
     */
    const drip = await dripGasIfNeeded(row.address as Address).catch((e: unknown) => ({
      sent: false as const,
      reason: e instanceof Error ? e.message : String(e),
    }));
    await append({
      walletId: row.id,
      agent: 'xorr',
      action: drip.sent ? `Sent ${drip.amountEth} test ETH for gas` : 'No gas sent',
      detail: drip.sent
        ? `${CHAIN_KEY} test ETH, so you can sign the permission. It has no value and buys nothing.`
        : `Not sent — ${drip.reason}.`,
      kind: 'risk',
      payload: drip.sent ? { hash: drip.hash } : { reason: drip.reason },
    }).catch(() => undefined);
  }

  return c.json(row);
});

routes.get('/wallet/balance', async (c) => {
  const w = await currentWallet(c);
  if (!w) return c.json({ usd: 0 });

  /*
   * A failed read is an error, not a zero (PLAN.md 1.7).
   *
   * Both reads caught their own failures: a balance read that failed returned `total: 0` — "$0.00"
   * on the home screen of a funded wallet, logged and then served as fact — and a permission read
   * that failed became "no cap". `readChain` turns either into a 502, which the client shows as a
   * dash rather than a number.
   */
  /*
   * Bounded, because the app stops waiting at 45 seconds and this had no bound of its own (`http/patience.ts`).
   *
   * In the QA run against the hosted fork executor it gave no answer inside sixty. Each read now answers within a
   * screen's patience or says why it could not: a chain read as `chain_read_failed`, a price still on its way as
   * `warming`, and an Aave reserve that does not answer as nothing supplied, as when it fails.
   */
  const patience = screenPatience();
  const [policy, value] = await Promise.all([
    readChain('your permission', () => readPolicy(w.address as Address), patience.chainReadMs),
    // Read the chain. This used to be a hardcoded 0, so the home screen said "$0.00" while the
    // wallet held a real position.
    readChain(
      'your balance',
      () =>
        totalValueUsd(w.address as Address, { priceDeadlineMs: patience.priceMs, suppliedDeadlineMs: patience.aaveMs }),
      patience.chainReadMs,
    ),
  ]);
  // Balance is what the user holds; the policy tells us what the bot may touch of it.
  return c.json({
    usd: value.total,
    cashUsd: value.cash,
    /*
     * `raw` is dropped on the way out.
     *
     * It is a bigint, which JSON cannot serialise, and the client has no use for wei — it displays
     * units and dollars. It exists so the SERVER can close a whole position exactly.
     */
    holdings: value.holdings.map(({ symbol, units, usd }) => ({ symbol, units, usd })),
    /** USDC earning yield on Aave. Part of the total, but not spendable until withdrawn. */
    suppliedUsd: value.supplied,
    dailyCapUsd: policy?.dailyCapUsd ?? 0,
    remainingTodayUsd: policy?.remainingTodayUsd ?? 0,
  });
});

/**
 * What the wallet was worth over time (PLAN.md 2.10), from snapshots read on the chain — never a replay.
 *
 * `range` is 1D, 1W, 1M or ALL. Points come back oldest first, thinned so a long history stays small, with
 * every fill, close and withdrawal kept so an event is never sampled away. A wallet with no snapshots yet
 * answers an empty list, which is the truth about it.
 */
routes.get('/portfolio/history', async (c) => {
  const range = (c.req.query('range') ?? '1W').toUpperCase();
  const since = historySince(range);
  if (since === undefined) {
    return c.json({ error: 'invalid_range', message: 'range is one of 1D, 1W, 1M or ALL.' }, 400);
  }
  const w = await currentWallet(c);
  if (!w) return c.json({ range, chain: CHAIN_KEY, points: [] });
  return c.json({
    range,
    chain: CHAIN_KEY,
    everyMinutes: SNAPSHOT_EVERY_MS / 60_000,
    points: thinPoints(await listSnapshots(w.id, since)),
  });
});

/**
 * Take a snapshot now — after a withdrawal or a send the app made itself (PLAN.md 2.10).
 *
 * The executor sees its own fills and closes. A withdrawal the user signs never passes through it, so the
 * app says when one was sent. The value is still read from the chain — nothing in the request is taken as
 * a number — and given the transaction hash the request waits (bounded) for it to land first, so the
 * snapshot is of the wallet after it. At most one a minute per wallet.
 */
const lastRequestedSnapshot = new Map<string, number>();

routes.post('/portfolio/snapshot', async (c) => {
  const w = await requireWallet(c);
  const body = z
    .object({ txHash: z.string().regex(/^0x[0-9a-fA-F]{64}$/).optional() })
    .parse(await c.req.json().catch(() => ({})));
  const since = Date.now() - (lastRequestedSnapshot.get(w.id) ?? 0);
  if (since < 60_000) {
    const retryAfterSec = Math.ceil((60_000 - since) / 1000);
    c.header('retry-after', String(retryAfterSec));
    return c.json({ recorded: false, reason: 'rate_limited', retryAfterSec }, 429);
  }
  lastRequestedSnapshot.set(w.id, Date.now());
  if (body.txHash) await waitForTx(body.txHash as Hex).catch(() => undefined);
  return c.json({ recorded: await snapshotWallet(w, 'withdrawal') });
});

// ── Delegation ───────────────────────────────────────────────────────────────

routes.get('/delegation', async (c) => {
  const w = await currentWallet(c);
  if (!w) return c.json(null);
  // `null` is the chain saying there is no permission; a read that failed is a 502, not that. The
  // venues it allows come back in the same read (PLAN.md 2.5).
  const { policy, venues: allowed } = await readChain('your permission', () =>
    readPolicyAndVenues(w.address as Address),
  );
  if (!policy) return c.json(null);
  /*
   * What the user ACTUALLY allowed, asked of the contract.
   *
   * This was the list we would have asked them to sign, which is a different question and answers
   * it wrongly for anyone who granted before a venue was added — the safety screen would have
   * shown them a permission they never gave. The chain knows; ask it.
   */
  // An empty list here is "you allowed nothing" on the one screen that must be exactly true, so it
  // comes from the same all-or-nothing read as the policy: a failure is a 502, never an empty list.
  /*
   * Who the two parties actually are, in words.
   *
   * This screen's whole subject is "who may do what with your money", and it named both parties
   * with truncated hex. Two addresses that differ only in the middle look identical truncated,
   * which is the one place that matters. X Layer has no name service this build resolves,
   * so the screen shows the full addresses — which is what tells two of them apart.
   */
  const [ownerName, delegateName, recorded] = await Promise.all([
    // X Layer has no name service this build resolves (Basenames were Base's): the parties are named by address.
    Promise.resolve(null as string | null),
    Promise.resolve(null as string | null),
    /*
     * When the grant in force was made (PLAN.md 4.7) — the one fact about it the chain does not keep.
     *
     * `/delegation/record` takes it from the block that carried the `Granted` event. The row is found
     * by what the contract says now: this wallet, this chain, and the delegate and expiry `policyOf`
     * returned — so the record of an earlier grant, or of a grant on another chain, cannot lend this
     * one its start. No such row is no record, and the answer is null, not a length made up.
     */
    one<{ granted_at: Date }>(
      `SELECT granted_at FROM delegations
        WHERE wallet_id = $1 AND chain = current_setting('xorr.chain_key') AND granted_at IS NOT NULL
          AND lower(delegate_pubkey) = lower($2) AND expires_at = $3
        ORDER BY granted_at DESC LIMIT 1`,
      [w.id, policy.delegate, new Date(policy.expiresAt)],
    ),
  ]);
  return c.json({
    delegatePubkey: policy.delegate,
    delegateName,
    /*
     * Does this permission name the key we sign with?
     *
     * If it does not, the grant is inert: `spend` compares `msg.sender` to the delegate the user
     * signed for, so every run reverts and nothing else about the policy looks wrong. The client
     * cannot work this out on its own — it never sees the executor's key — so it is answered here
     * rather than left to a screen that would otherwise report LIVE for a bot that cannot trade.
     */
    delegateIsCurrent:
      policy.delegate.toLowerCase() === delegatePublicKey.toLowerCase(),
    ownerPubkey: w.address,
    ownerName,
    dailyCapUsd: policy.dailyCapUsd,
    expiresAt: policy.expiresAt,
    grantedAt: recorded ? recorded.granted_at.getTime() : null,
    venueAllowlist: allowed,
    withdrawalAllowlist: [],
    revoked: policy.revoked,
    onChainRemainingUsd: policy.remainingTodayUsd,
    spentTodayUsd: policy.spentTodayUsd,
  });
});

/**
 * The parameters the app needs to build the grant transaction.
 *
 * The USER signs the grant, with their own Privy wallet — the executor never holds the owner key
 * and so cannot grant itself permission. This route only says what to sign.
 */

/**
 * The tokens worth asking the user to approve — and no more.
 *
 * Approving every entry in the routing registry meant ELEVEN modals before the grant: the user
 * tapped Approve a dozen times to finish onboarding, and eight of those were Ondo equities that
 * have no code on Base Sepolia at all. An approval for a contract that does not exist is a
 * transaction that costs gas and grants nothing.
 *
 * So: the settlement token, plus every registry token that actually has code on the chain we
 * settle on. On Sepolia that is three signatures instead of eleven; on mainnet or a fork it is the
 * full set, which is correct there because those contracts are real and sellable.
 *
 * Checked with `eth_getCode` rather than assumed from a chain flag, because the whole point of the
 * two-environment split is that the answer differs and the chain is the one that knows.
 */
async function approvableTokens(): Promise<{ symbol: string; address: Address }[]> {
  /*
   * SETTLEMENT addresses, not quote addresses.
   *
   * `TOKENS` is the routing registry and it is always X Layer MAINNET — the pools are only ever asked
   * about mainnet, which is why `QUOTE_ADDRESSES` exists. Approving from it on the testnet would ask the
   * user to approve mainnet USDC, which has no code there. The user would then have granted a
   * permission that could never pull the token it spends.
   *
   * `ADDRESSES` follows `XORR_CHAIN`, so this is what the delegation will actually be asked to
   * move. The equities are added only where they function. `IS_MAINNET_STATE` is true on a
   * fork too, and `getCode` cannot tell a fork's equities from Base's: each carries one byte of
   * code, and on a fork every call to it fails `OpcodeNotFound`. So a fork build's grant asked for
   * eight approvals that could never execute, and stopped at the first (found proving PLAN.md 4.7).
   * The test is the one `/market/tradable` and `/verify` already use.
   */
  const equities = IS_MAINNET_STATE && (await equitiesFunctional());
  const settlement: [string, Address][] = [
    ...APPROVABLE_TOKENS.map((t) => [t.symbol, t.address] as [string, Address]),
    ...(equities ? Object.values(STOCKS).map((st) => [st.symbol, st.address] as [string, Address]) : []),
  ];
  const entries = settlement;
  const codes = await Promise.all(
    entries.map(([, address]) => publicClient.getCode({ address }).catch(() => undefined)),
  );
  return entries
    .filter((_, i) => (codes[i]?.length ?? 0) > 2)
    .map(([symbol, address]) => ({ symbol, address }));
}

/**
 * GET /approvals — what the delegation contract is currently allowed to pull, per token.
 *
 * The grant approves each tradable token for MAX_UINT256, which is what makes a fill possible
 * without a second signature per trade. It is also, on its own, an unlimited standing allowance
 * that nothing in the product ever showed and nothing could take back. Revoking the DELEGATION
 * stops the bot — `spend` checks the policy — but the ERC-20 approvals survive it, so a wallet
 * whose owner believed they had fully disengaged still had live allowances to a contract.
 *
 * Read from the token contracts rather than from our record of what we asked the user to sign:
 * an allowance the user set elsewhere, or revoked elsewhere, is the truth and our record is not.
 */
/**
 * Decimals for a settlement token.
 *
 * `TOKENS` is the routing registry and holds mainnet addresses, which is the wrong ADDRESS for a
 * Sepolia build — but decimals are a property of the asset rather than of the deployment, and USDC
 * is 6 everywhere it exists. Eighteen is the ERC-20 default and the right guess for anything not
 * listed, but a wrong guess here misplaces a decimal point on a permission screen, so an unknown
 * symbol is reported raw instead.
 */
function decimalsFor(symbol: string): number {
  return TOKENS[canonicalSymbol(symbol)]?.decimals ?? 18;
}

routes.get('/approvals', async (c) => {
  const w = await requireWallet(c);
  const owner = w.address as Address;
  const tokens = (await approvableTokens()).map((t) => ({ ...t, decimals: decimalsFor(t.symbol) }));
  /*
   * The delegation, which the app asks for, and each venue contract a fill approves for one trade and resets (PLAN.md
   * 3.12): Uniswap v3's router, and — where mainnet state is — OKX DEX's approval contract. The app never needs a
   * standing allowance to either, so one that exists came from somewhere else and is worth taking back. A read that
   * fails is `unread`, never shown as "None": that told a wallet it had approved nothing when nobody had been able to look.
   */
  const router = await routerSpender().catch(() => undefined);
  const venues: { name: string; address: Address }[] = [
    ...(router ? [{ name: 'Uniswap v3 router', address: router.address }] : []),
    ...(IS_MAINNET_STATE ? [{ name: 'OKX DEX approval contract', address: OKX_DEX_APPROVE_SPENDER as Address }] : []),
  ];
  const [toDelegation, toVenues] = await Promise.all([
    Promise.all(tokens.map((t) => chainAllowance(t.address, owner, DELEGATION_ADDRESS))),
    Promise.all(venues.map((v) => Promise.all(tokens.map((t) => routerAllowance(t.address, owner, 'chain', v.address))))),
  ]);
  const delegationTokens = tokens.map((t, i) => allowanceView(t, toDelegation[i]));
  return c.json({
    // The delegation's allowances, in the shape the Safety screen has always read.
    spender: DELEGATION_ADDRESS,
    tokens: delegationTokens,
    spenders: [
      { role: 'delegation', name: 'xorr delegation', address: DELEGATION_ADDRESS, source: 'chain', tokens: delegationTokens },
      ...(venues.length
        ? venues.map((v, vi) => ({
            role: 'router' as const,
            name: v.name,
            address: v.address,
            source: 'chain' as const,
            tokens: tokens.map((t, i) => allowanceView(t, toVenues[vi]?.[i])),
          }))
        : [{ role: 'router' as const, name: 'Swap router', address: null, source: null, tokens: null, unread: true }]),
    ],
  });
});

routes.get('/delegation/params', async (c) => {
  requireUser(c);
  return c.json({
    contract: DELEGATION_ADDRESS,
    delegate: delegatePublicKey,
    venues: SETTLEMENT_VENUES,
    token: ADDRESSES.usdc,
    /*
     * EVERY token the delegation may need to pull, not just the one it spends.
     *
     * The grant approved USDC alone, which is the buy side. `closePosition` pulls the asset being
     * SOLD, so with no WETH allowance the contract's `transferFrom` reverted with "pull failed" —
     * and that is every exit: take-profit, stop-loss, trailing, the panic flatten and the position
     * screen's own Close button. A wallet could be bought into and never sold out of, and the only
     * symptom was a generic "the transaction did not go through".
     *
     * Native ETH is excluded: it has no allowance to give, and the delegation trades the wrapped
     * form. The list follows the routing registry, so a token that becomes tradable becomes
     * approvable in the same change rather than two releases later.
     */
    tokens: await approvableTokens(),
    chain: CHAIN_KEY,
  });
});

/** Record a grant the user already signed, so the audit trail has it. */
/**
 * A 32-byte transaction hash, and nothing else.
 *
 * Both record routes took `z.string()`, so any text at all was accepted, written into the
 * append-only audit trail, and rendered there as a TRANSACTION with a block-explorer link. Passing
 * `"0xabc"` produced a permanent entry — "Trading permission granted · TRANSACTION 0xabc" — whose
 * link 404s for anyone who follows it. `waitForTx` swallows the failure for a malformed hash, so
 * nothing downstream noticed.
 *
 * The policy itself is still read from the chain and always was; this is about not writing an
 * unverifiable claim into a record that cannot be corrected afterwards.
 */
const TxHash = z
  .string()
  .regex(/^0x[0-9a-fA-F]{64}$/, 'must be a 32-byte transaction hash, 0x followed by 64 hex digits');

routes.post('/delegation/record', async (c) => {
  /*
   * The hash, and nothing the client says about it (PLAN.md 4.8).
   *
   * The app still sends `dailyCapUsd` and `expiresAt` beside the hash, and they are not read: they
   * are what the app ASKED the wallet to sign, and the record is of what was signed — the
   * transaction's own `Granted` event. The schema drops them rather than refusing them, so an app
   * that sends them keeps working.
   */
  const body = z.object({ txHash: TxHash }).parse(await c.req.json());
  const w = await requireWallet(c);
  // Every check before the record, and the record, are `recordGrant`'s — the same a business treasury's grant is held to.
  const out = await recordGrant(w, body.txHash as Hex);
  return c.json(out.body, out.status);
});

/** Record a revoke the user already signed. */
routes.post('/delegation/revoke', async (c) => {
  const body = z.object({ txHash: TxHash.optional() }).parse(await c.req.json().catch(() => ({})));
  const w = await requireWallet(c);
  const out = await recordRevoke(w, body.txHash as Hex | undefined);
  return c.json(out.body, out.status);
});

// ── Activity / audit ─────────────────────────────────────────────────────────

routes.get('/positions', async (c) => {
  const w = await currentWallet(c);
  if (!w) return c.json([]);
  return c.json(await listPositions(w));
});

/**
 * Whether an xStock is actually backed by the share it claims to represent.
 *
 * Backed's attestor publishes shares held against tokens in circulation; the ratio is the whole
 * badge. The answer is deliberately two-shaped — `verified` with a measured ratio, or `unverified`
 * with the reason — because the failure mode worth designing against is a tokenized-equity app
 * rendering a confident "1:1" it never actually read. Callers that want a number must handle not
 * getting one.
 *
 * 200 either way: "we could not reach the attestor" is an answer about the asset, not an error in
 * the request.
 */
/**
 * Whether a wallet may hold this xStock, asked before a buy is offered.
 *
 * xStocks are jurisdiction-restricted and Token-2022 gives the issuer several independent ways to
 * refuse a transfer. The screen needs this before it draws a buy button, because the alternative
 * is a user signing a transaction that fails on-chain for reasons nobody explained.
 *
 * `eligible: false` with `indeterminate: true` means a gate could not be read — which is NOT a
 * pass, and must not be drawn as one.
 */
/**
 * Everything a position can say about what backs it, for the backing drawer.
 *
 * Every field is a recorded value or `null`, and `null` means "we have no record of this" rather
 * than zero — the screen renders that difference in words. The attestation carries its own age
 * so the drawer can say how stale it is instead of implying it is current.
 */
/**
 * How an xStock's backing has moved, from attestations we have actually recorded.
 *
 * `observations` is on the wire deliberately: a chart drawn from two points and one drawn from two
 * hundred look similar and mean very different things, and the screen has to be able to say which
 * it is holding. Nothing is interpolated — gaps stay gaps, and a short series means we have not
 * been watching long, not that the token was unbacked before we started.
 */
/**
 * What an xStock has paid, derived from the multiplier it reinvests dividends through.
 *
 * `unmeasured` is a first-class answer with its own reason. A window we have not watched long
 * enough to measure is not a window in which the token paid nothing, and 0.00% would say it was.
 */
routes.get('/xstocks/:symbol/yield', async (c) => {
  const symbol = c.req.param('symbol');
  const stock = XSTOCKS[xStockKey(symbol) ?? symbol];
  if (!stock) {
    return c.json({ error: 'unknown_symbol', message: `${symbol} is not an xStock this executor knows.` }, 404);
  }
  const days = Number(c.req.query('days') ?? 365);
  return c.json(
    await dividendYield({
      symbol: stock.symbol,
      mint: stock.address,
      sinceDays: Number.isFinite(days) && days > 0 ? Math.min(days, 3650) : 365,
    }),
  );
});

routes.get('/xstocks/:symbol/reserves/history', async (c) => {
  const symbol = c.req.param('symbol');
  const stock = XSTOCKS[xStockKey(symbol) ?? symbol];
  if (!stock) {
    return c.json({ error: 'unknown_symbol', message: `${symbol} is not an xStock this executor knows.` }, 404);
  }
  return c.json(await backingSeries(stock.symbol));
});

routes.get('/xstocks/:symbol/backing/detail', async (c) => {
  const symbol = c.req.param('symbol');
  const detail = await backingDetail(symbol);
  if (!detail) {
    return c.json({ error: 'unknown_symbol', message: `${symbol} is not an xStock this executor knows.` }, 404);
  }
  return c.json(detail);
});

routes.get('/xstocks/:symbol/backing', async (c) => {
  const symbol = c.req.param('symbol');
  const status = await backingFor(symbol);
  if (status.status === 'unverified') {
    return c.json({ symbol, verified: false, reason: status.reason });
  }
  const b = status.backing;
  return c.json({
    symbol: b.symbol,
    verified: true,
    ratio: b.ratio,
    fullyBacked: b.ratio >= 1,
    sharesHeld: b.sharesHeld,
    circulatingSupply: b.circulatingSupply,
    custodians: b.custodians,
    asOf: b.asOf,
  });
});

/**
 * One position, or null.
 *
 * `null` rather than 404, and the distinction matters. A position the user closed, or a deep link
 * to one that no longer exists, is a legitimate STATE — the screen has a correct empty view for
 * it. Answering 404 made the browser log "Failed to load resource" for a screen that was behaving
 * perfectly, which trains everyone to ignore console errors. `/proposals/current` already answers
 * the same shape of question the same way.
 *
 * A 404 is still the right answer when the caller is wrong about something. Here they are not.
 */
/**
 * What has actually been made, as opposed to what the open book is worth today.
 *
 * Separate from `/positions` because a closed position is not a holding and must not appear in a
 * holdings list — but the profit taken on it is real money and has to live somewhere.
 */
/**
 * Disposals, as a spreadsheet an accountant can open.
 *
 * The audit trail is the compliance artifact for what the BOT did; this is the compliance artifact
 * for what the user OWES, and they are not the same document. Average cost, stated in the file
 * rather than assumed, because a jurisdiction that wants FIFO needs to know this is not it.
 *
 * A disposal with no recorded cost is included and flagged. Excluding it would produce a tidier
 * file that understates proceeds, which is the wrong direction to be wrong in on a tax report.
 */
routes.get('/pnl/disposals.csv', async (c) => {
  const w = await requireWallet(c);
  const rows = await query<{
    at: Date;
    symbol: string;
    units: string;
    proceeds_usd: string;
    cost_usd: string;
    realised_usd: string;
    basis_known: boolean;
  }>(
    `SELECT at, symbol, units, proceeds_usd, cost_usd, realised_usd, basis_known
       FROM disposals WHERE wallet_id = $1 ORDER BY at ASC`,
    [w.id],
  );

  const header = 'date,symbol,units,proceeds_usd,cost_basis_usd,gain_loss_usd,basis_method,basis_known';
  const body = rows.map((r) =>
    [
      new Date(r.at).toISOString(),
      r.symbol,
      r.units,
      r.proceeds_usd,
      r.cost_usd,
      r.realised_usd,
      'average_cost',
      r.basis_known ? 'yes' : 'no',
    ].join(','),
  );
  const total = rows.reduce((a, r) => a + Number(r.realised_usd), 0);
  // A total row, because the first thing anyone does with this file is add up the last column.
  body.push(`,,,,,${total.toFixed(2)},,`);

  return c.body([header, ...body].join('\n'), 200, {
    'content-type': 'text/csv; charset=utf-8',
    'content-disposition': 'attachment; filename="xorr-disposals.csv"',
  });
});

/**
 * Which interruptions this user wants, with every kind listed whether or not they have configured
 * it — a settings screen that only shows what has already happened is a settings screen you cannot
 * use until after the thing you wanted to turn off.
 */
routes.get('/notifications/prefs', async (c) => {
  const w = await requireWallet(c);
  const rows = await query<{ kind: string; enabled: boolean }>(
    `SELECT kind, enabled FROM notification_prefs WHERE wallet_id = $1`,
    [w.id],
  );
  const set = new Map(rows.map((r) => [r.kind, r.enabled]));
  return c.json(
    PUSH_KINDS.map((k) => ({ ...k, enabled: set.get(k.kind) ?? true })),
  );
});

routes.post('/notifications/prefs', async (c) => {
  const body = z
    .object({ kind: z.enum(PUSH_KINDS.map((k) => k.kind) as [string, ...string[]]), enabled: z.boolean() })
    .parse(await c.req.json());
  const w = await requireWallet(c);
  await query(
    `INSERT INTO notification_prefs (wallet_id, kind, enabled) VALUES ($1,$2,$3)
     ON CONFLICT (wallet_id, kind) DO UPDATE SET enabled = EXCLUDED.enabled`,
    [w.id, body.kind, body.enabled],
  );
  return c.json({ ok: true, kind: body.kind, enabled: body.enabled });
});

routes.get('/pnl/realised', async (c) => {
  const w = await requireWallet(c);
  return c.json(await realisedPnl(w.id));
});

/**
 * Every disposal, one row per sale.
 *
 * `/pnl/realised` aggregates by symbol, which is the right shape for "what have I made" and the
 * wrong one for "which sale was that". `/pnl/disposals.csv` has the rows but only as a file, so the
 * app could hand them to an accountant and never show them to the person who made them.
 *
 * `basis_known` is carried through per row rather than folded into the total. A sale whose cost was
 * never recorded understates the gain, and which sale it was is the thing an accountant asks first.
 */
routes.get('/disposals', async (c) => {
  const w = await requireWallet(c);
  const rows = await query<{
    id: string;
    symbol: string;
    at: Date;
    units: string;
    proceeds_usd: string;
    cost_usd: string;
    realised_usd: string;
    basis_known: boolean;
  }>(
    `SELECT id, symbol, at, units, proceeds_usd, cost_usd, realised_usd, basis_known
       FROM disposals WHERE wallet_id = $1 ORDER BY at DESC LIMIT 200`,
    [w.id],
  );
  return c.json(
    rows.map((r) => ({
      id: r.id,
      symbol: r.symbol,
      at: r.at.toISOString(),
      // NUMERIC arrives as a string because it is arbitrary precision; these are display
      // quantities of known small magnitude, so parsing them here is safe and honest.
      units: Number(r.units),
      proceeds: Number(r.proceeds_usd),
      cost: Number(r.cost_usd),
      realised: Number(r.realised_usd),
      basisKnown: r.basis_known,
    })),
  );
});

routes.get('/positions/:id', async (c) => {
  const w = await requireWallet(c);
  const position = await getPosition(w, c.req.param('id'));
  // An id that is not in this wallet's book is not found — see `getPosition`, which used to answer
  // it with the first position it had.
  if (!position) return c.json({ error: 'not_found', message: 'No position with that id in this wallet.' }, 404);
  return c.json(position);
});

routes.get('/activity', async (c) => {
  const w = await currentWallet(c);
  if (!w) return c.json([]);
  const rows = await listAudit(w.id);
  return c.json(
    rows.map((r) => ({
      id: String(r.seq),
      t: new Date(r.at).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' }),
      agent: r.agent,
      action: r.action,
      detail: r.detail,
      amount: r.amount,
      kind: r.kind,
      signature: r.signature ?? undefined,
      /*
       * Where to go and check it.
       *
       * "The history you check is not a history we hold" is the README's claim, and the app was
       * not giving anyone a way to check. `explorerTx` deliberately returns a `fork:` or `local:`
       * label rather than a URL on those networks — a link to a block explorer that has never
       * seen the transaction is worse than no link, because it looks like the transaction is not
       * real.
       */
      explorer: r.signature ? explorerTx(r.signature) : undefined,
    })),
  );
});

/**
 * Why the agent took the trade on this row.
 *
 * Keyed on the audit sequence, which is exactly the `id` the activity list already renders, so the
 * screen asks about the row the person tapped rather than about a signature it has to match up.
 * A sequence belonging to another wallet reads as missing — the counter is global, and
 * `/activity/8/explain` must not become a way to read somebody else's trade.
 */
routes.get('/activity/:seq/explain', async (c) => {
  const w = await requireWallet(c);
  const found = await explainTrade(w.id, c.req.param('seq'));
  if (!found) {
    return c.json({ error: 'not_found', message: 'No entry with that sequence in this wallet.' }, 404);
  }
  return c.json(found);
});

routes.get('/activity/export', async (c) => {
  const w = await requireWallet(c);
  const format = c.req.query('format') === 'json' ? 'json' : 'csv';
  const body = await exportTrail(w.id, format);
  return c.text(body, 200, {
    'content-type': format === 'json' ? 'application/json' : 'text/csv',
    'content-disposition': `attachment; filename="xorr-audit.${format}"`,
  });
});

/**
 * GET /activity/fills.csv — a receipt for every trade that actually settled.
 *
 * Narrower than `/activity/export` on purpose, and the narrowness is the feature. The audit trail
 * carries every row — the blocked runs, the ones with nothing to do, the strategies someone paused
 * — which is exactly right for a compliance artifact and wrong for "show me what I bought". This
 * answers the third question: what moved, when, at what price, and on which transaction.
 *
 * Only a run that reached `filled` AND carries a signature appears. A receipt for something that
 * did not happen is not a weaker receipt; it is a false one. `audit/fills.ts` holds the rule.
 */
routes.get('/activity/fills.csv', async (c) => {
  const w = await requireWallet(c);
  const rows = await query<FillRow>(FILLS_SQL, [w.id]);
  return c.body(fillsCsv(rows), 200, {
    'content-type': 'text/csv; charset=utf-8',
    'content-disposition': 'attachment; filename="xorr-fills.csv"',
  });
});

/**
 * The order this wallet's owner put their watchlist in.
 *
 * The LIST is the executor's — `/market/watchable` is what a strategy can follow here — so this is
 * a preference applied to it and never a copy of it. A symbol that stops being watchable keeps its
 * place in storage and returns to it if coverage comes back; the client's `markets/watchOrder.ts`
 * holds both halves of that rule and is tested on them.
 *
 * Scoped to the wallet like everything else here. An account with two addresses would otherwise
 * have one shared watchlist while every other screen showed two different sets of holdings.
 */
routes.get('/watchlist/order', async (c) => {
  const w = await requireWallet(c);
  const rows = await query<{ symbol: string }>(
    `SELECT symbol FROM watchlist_order WHERE wallet_id = $1 ORDER BY position ASC`,
    [w.id],
  );
  return c.json(rows.map((r) => r.symbol));
});

/**
 * Save it, whole.
 *
 * The entire order rather than a moved pair: a partial update would need the executor to hold its
 * own idea of what the list is, and the two would drift the moment the watchable set changed.
 * Written in one transaction — a delete followed by an insert that failed would leave someone with
 * no order at all, which is worse than the order being one move out of date.
 */
const WatchOrder = z.object({
  symbols: z.array(z.string().min(1).max(12)).max(200),
});

routes.put('/watchlist/order', async (c) => {
  const w = await requireWallet(c);
  const body = WatchOrder.parse(await c.req.json());

  /*
   * De-duplicated, keeping the first position of each.
   *
   * The primary key would reject the second copy anyway; doing it here means a client that sent a
   * duplicate gets its order saved rather than a 500 naming a constraint.
   */
  const seen = new Set<string>();
  const symbols = body.symbols.filter((s) => !seen.has(s) && seen.add(s) !== undefined);

  await tx(async (client) => {
    await client.query(`DELETE FROM watchlist_order WHERE wallet_id = $1`, [w.id]);
    for (const [position, symbol] of symbols.entries()) {
      await client.query(
        `INSERT INTO watchlist_order (wallet_id, symbol, position) VALUES ($1, $2, $3)`,
        [w.id, symbol, position],
      );
    }
  });

  return c.json({ symbols });
});

routes.get('/activity/verify', async (c) => {
  const w = await requireWallet(c);
  return c.json(await verify(w.id));
});

/**
 * What Base has been told about this wallet's trail, and whether we still agree with it.
 *
 * Read-only and cheap: two `eth_call`s and one indexed row. The screen behind it exists to let
 * someone check the strongest claim this product makes without taking our word for any part of it
 * — the contract address, the anchoring key and the block are all here, so the same read can be
 * repeated from anywhere.
 */
routes.get('/audit/anchor', async (c) => {
  const w = await requireWallet(c);
  const owner = w.address as Address;
  const [state, history] = await Promise.all([
    agreement(w.id, owner),
    anchorHistory(owner),
  ]);
  return c.json({
    configured: anchoringConfigured(),
    contract: ANCHOR_ADDRESS,
    anchoredBy: delegateAccount.address,
    chain: CHAIN_KEY,
    state: state.state,
    entryCount: state.entryCount,
    latest: state.state === 'none' ? null : state.anchor,
    history,
  });
});

/**
 * Anchor now, rather than waiting for the hourly sweep.
 *
 * Exists because "publish the current head" is exactly the thing a sceptic wants to do themselves:
 * make a trade, press this, and read the new commitment out of Base. It is bounded by the same
 * unchanged-head check the sweep uses, so pressing it twice costs one `eth_call` and no gas.
 */
routes.post('/audit/anchor', async (c) => {
  const w = await requireWallet(c);
  // At most once an hour per wallet when it would spend gas — see `audit/anchor-limit.ts`.
  const out = await anchorOnDemand(w.id, w.address as Address);
  if (!out.anchored && out.reason === 'not_configured') return c.json(out, 501);
  if (!out.anchored && out.reason === 'rate_limited') {
    c.header('retry-after', String(out.retryAfterSec));
    return c.json(out, 429);
  }
  return c.json(out);
});

// ── Limits ───────────────────────────────────────────────────────────────────

/**
 * The cap, read from the chain — like every other surface that reports it.
 *
 * This route asked Postgres: `SELECT daily_cap_usd ... FROM delegations`. Everything else in the
 * product asks the contract, and /verify publishes the claim in as many words — "The permission is
 * read from the chain, never from our database." This was the one place that was not true, and
 * `readPolicy`'s own docblock says why it matters: *never trust our own database for an enforcement
 * decision.*
 *
 * It showed. On the fork wallet, where the local row is stale, /limits rendered "Nothing —
 * permission is off · $0.00 cap · $480.00 spent" while /delegation and /safety, one tap away, both
 * read the chain and said Live with a $2,810 cap. Three screens, one wallet, two answers to the
 * question this whole product exists to answer — and the wrong one came from the database copy.
 *
 * Both numbers are still reported, because the footer on that screen promises exactly that: the cap
 * is enforced on the chain AND again by the executor, "and the stricter of the two is the one that
 * binds". So the chain gives the cap and the revocation, the executor's own tally gives what it
 * believes it has spent, and `remainingUsd` is the smaller of the two remainders — which is the
 * number that actually governs the next trade.
 */
routes.get('/limits', async (c) => {
  const w = await requireWallet(c);
  const policy = await readChain('your permission', () => readPolicy(w.address as Address));
  const ourSpend = await spentToday(w.id);

  /*
   * Never granted and revoked are different answers (PLAN.md 1.7).
   *
   * Both — and a read that failed — came back `revoked: true`, so a wallet that had simply not granted
   * anything yet was told its permission was "off", and an RPC timeout told a live wallet the same. A
   * failed read is now a 502, and `granted` says whether there is a permission at all.
   */
  if (!policy) {
    return c.json({
      dailyCapUsd: 0,
      spentTodayUsd: ourSpend,
      // No permission on the chain, so no tally of the chain's to set beside the executor's.
      chainSpentTodayUsd: null,
      executorSpentTodayUsd: ourSpend,
      remainingUsd: 0,
      revoked: false,
      granted: false,
    });
  }

  /*
   * Two tallies of today's spend, and the one reported is the stricter.
   *
   * The contract counts what `spend()` let through today; the executor counts the fills it recorded. They should agree,
   * and on a fork rebuilt under the book they did not: fills the database remembered were no longer on the chain, and the
   * Limits screen read "$908.05 spent" beside "$1,855.95 left" of a $2,810 cap — the chain's spend next to a remainder
   * taken from the executor's larger tally, three numbers that did not add up. `spentTodayUsd` is now the larger of the
   * two and `remainingUsd` is taken from that same figure, so the cap is always spent plus left. Both tallies travel
   * beside it, so a screen can say when they part.
   */
  const spent = Math.max(policy.spentTodayUsd, ourSpend);
  const tallies = { chainSpentTodayUsd: policy.spentTodayUsd, executorSpentTodayUsd: ourSpend };
  if (policy.revoked) {
    return c.json({
      dailyCapUsd: 0,
      spentTodayUsd: spent,
      ...tallies,
      remainingUsd: 0,
      revoked: true,
      granted: true,
      expiresAt: policy.expiresAt,
    });
  }

  return c.json({
    dailyCapUsd: policy.dailyCapUsd,
    spentTodayUsd: spent,
    ...tallies,
    // The chain's remainder is already 0 once the permission has expired; otherwise cap − spent is the bound that holds.
    remainingUsd: Math.max(0, Math.min(policy.remainingTodayUsd, policy.dailyCapUsd - spent)),
    revoked: false,
    granted: true,
    /*
     * The expiry, so a zero here can say WHY it is zero.
     *
     * An expired policy is not revoked, so this route answered `{dailyCapUsd: 1600, spentTodayUsd:
     * 0, remainingUsd: 0, revoked: false}` — a $1,600 limit with nothing spent and nothing left,
     * which is not a state the screen could explain because the number that explains it was not
     * sent. Observed on the hosted deployment against a grant that had lapsed thirteen hours
     * earlier, while `/safety` showed the same permission as Live.
     */
    expiresAt: policy.expiresAt,
  });
});

/**
 * Can this trade go through? Answered from the CHAIN, for the same reason `/limits` above is.
 *
 * The docblock twenty lines up describes this exact bug being fixed — and it was fixed on the GET
 * and missed here, on the POST. Which is the worse half: `/limits` only *reports* the cap, while
 * this route is the pre-trade authorisation check. It asked Postgres, and Postgres holds a CACHE
 * of the permission that is only as fresh as the last time a grant was recorded through us.
 *
 * Caught by granting a fresh permission in the browser and then asking this route about it: the
 * chain said live with $1,600 of headroom, `/limits` agreed, and this route answered
 * `{"allowed":false,"reason":"delegation_expired"}` — refusing every trade the user had just
 * signed for. A stale cache cannot be allowed to veto a live permission any more than it can be
 * allowed to authorise a revoked one.
 *
 * `evaluate` still applies the executor's own daily tally on top, because the footer on the limits
 * screen promises both are enforced and the stricter one binds.
 */
routes.post('/limits/check', async (c) => {
  const body = z.object({ usd: z.number() }).parse(await c.req.json());
  const w = await requireWallet(c);
  // Fails closed either way, but a timeout is not "no permission" and must not say it is.
  const policy = await readChain('your permission', () => readPolicy(w.address as Address));
  if (!policy) {
    return c.json({
      allowed: false,
      reason: 'no_delegation',
      detail: 'No active trading permission on-chain. Grant one before placing an order.',
    });
  }
  return c.json(
    await evaluate({
      walletId: w.id,
      usd: body.usd,
      dailyCapUsd: policy.dailyCapUsd,
      delegationExpiresAt: new Date(policy.expiresAt),
      delegationRevoked: policy.revoked,
      // The stop the user set on the executor (PLAN.md 2.14).
      killed: w.agents_stopped === true,
    }),
  );
});

// ── Prices ───────────────────────────────────────────────────────────────────

routes.get('/price/:symbol', async (c) => {
  /*
   * Not `.toUpperCase()`, and not `source: 'coingecko'` either.
   *
   * Uppercasing turned `NVDAc` into `NVDAC`, which is not a token anyone lists, so every equity
   * price answered "No price feed for NVDAC" for an asset on the app's own markets screen. And the
   * source was hardcoded: equities are priced from a live Uniswap v3 route on X Layer
   * (`venues/stocks.ts`), so naming CoinGecko was simply false for the symbols this route serves.
   */
  const symbol = canonicalSymbol(c.req.param('symbol'));
  /*
   * A symbol nothing prices is the caller's mistake, and a 404 says so.
   *
   * Every failure answered 502 — "No price feed for NOPE" included — and the app offers a retry on a 5xx, so it offered
   * to retry a request that can never work. The test is `priceOf`'s own: an equity is priced from its route, anything
   * else only through a feed id.
   */
  if (!isStock(symbol) && !COINGECKO_IDS[symbol]) {
    return c.json({ error: 'no_feed', detail: `No price feed for ${symbol}.` }, 404);
  }
  try {
    /*
     * Bounded to a screen's patience (`http/patience.ts`).
     *
     * With no deadline this waited as the scheduler waits, through every rung of CoinGecko's 429 ladder, and on a cold
     * cache the hosted Sepolia executor gave no answer inside sixty seconds (docs/TESTPLAN.md E149). Past the bound it
     * answers the last price within ten minutes, or `503 warming` with a retry-after while the fetch finishes for the
     * next caller.
     */
    const price = await priceOf(symbol, screenPatience().priceMs);
    return c.json({ symbol, price, source: isStock(symbol) ? 'uniswap-v3' : 'coingecko' });
  } catch (e) {
    // Late is not failed: the error handler answers it as `warming`, which the app and the endpoint QA wait out.
    if (e instanceof StillFetching) throw e;
    // A feed or a route that failed: worth asking again, which is what a 502 tells the app. The cause is for the log.
    log.warn(`[price] could not price ${symbol}: ${e instanceof Error ? e.message : String(e)}`);
    return c.json({ error: 'price_unavailable', detail: `${symbol} could not be priced just now.` }, 502);
  }
});
