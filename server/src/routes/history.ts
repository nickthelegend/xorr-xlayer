/**
 * GET /history — what settled on chain for this wallet (PLAN.md 3.14).
 *
 * Distinct from Activity, which is the executor's own trail of what it decided. This is what the chain recorded: the
 * delegation contract's `Spent` and `Closed` events for the caller's wallet, on the chain this executor serves — and on
 * Base mainnet, where 1inch indexes a wallet's life outside the app as well, 1inch's History API beside them.
 *
 * The chain is the authority, so the join runs one way. Where one of this wallet's runs recorded the event's
 * transaction, the run says what the executor meant by it — the strategy's kind and symbol, the venue it chose, the
 * side, the units and dollars it measured. An event with no run behind it is still history; a run with no event is not.
 *
 * The screen read The Graph from the client until this route, spends only, and the subgraph indexes the Sepolia
 * contract — so on the fork, where every fill is real, it said nothing had settled. Closes appeared nowhere.
 */
import { Hono } from 'hono';
import { formatUnits, type Address } from 'viem';
import { query } from '../db/index.js';
import { THIS_CHAIN } from '../db/chain-scope.js';
import { AAVE_V3_POOL, ADDRESSES, CHAIN_KEY, IS_MAINNET_STATE, explorerTx, ONEINCH_ROUTER } from '../evm/chains.js';
import { publicClient } from '../evm/client.js';
import { DELEGATION_ADDRESS } from '../evm/delegation.js';
import { getLogsPaged } from '../evm/logs.js';
import type { SettlementVenue } from '../executor/settle.js';
import { currentRequestId, log } from '../http/request-id.js';
import { bookAddress } from '../venues/aqua.js';
import { oneinchHistory, type OneInchHistoryEvent } from '../venues/history.js';
import { SETTLEMENT_SYMBOL, TOKENS } from '../venues/oneinch.js';
import { swapVmBookAddress } from '../venues/swapvm.js';
import { requireWallet } from './wallet-context.js';

export const historyRoutes = new Hono();

/**
 * `XorrDelegation`'s two settlement events, exactly as `contracts/src/XorrDelegation.sol` declares them.
 *
 * `DELEGATION_ABI` holds the contract's functions and errors and no events, so they are spelled out here. Owner,
 * delegate and venue are indexed, which is what lets the node filter on the owner. The order and the flags matter: a
 * wrong signature does not throw, it asks for a topic nothing emits and comes back as an empty history.
 */
export const SPENT_EVENT = {
  type: 'event',
  name: 'Spent',
  inputs: [
    { name: 'owner', type: 'address', indexed: true },
    { name: 'delegate', type: 'address', indexed: true },
    { name: 'venue', type: 'address', indexed: true },
    { name: 'token', type: 'address', indexed: false },
    { name: 'amount', type: 'uint256', indexed: false },
    { name: 'spentToday', type: 'uint256', indexed: false },
  ],
} as const;

export const CLOSED_EVENT = {
  type: 'event',
  name: 'Closed',
  inputs: [
    { name: 'owner', type: 'address', indexed: true },
    { name: 'delegate', type: 'address', indexed: true },
    { name: 'venue', type: 'address', indexed: true },
    { name: 'token', type: 'address', indexed: false },
    { name: 'amount', type: 'uint256', indexed: false },
  ],
} as const;

/**
 * How far back the history reads, in blocks: bounded, never from genesis.
 *
 * Mirrors `LOOKBACK_BLOCKS` in `venues/aqua.ts` — the same 9,000 by default, overridable the same way for a deployment
 * that can afford a longer read. Aqua picked its number to fit a provider's range cap, which `getLogsPaged` has since
 * made moot; this one is bounded by how long a screen should wait. The range is read in sequential windows of at most
 * 1,800 blocks, and one owner-filtered window measured about 0.28s against Base Sepolia's RPC: 9,000 blocks is five
 * windows per event, ten in all, three seconds or so. On Base's two-second blocks that is roughly the last five hours,
 * and the response names the window it read — so an empty list says "nothing in this window", never "nothing ever".
 */
const LOOKBACK_BLOCKS = BigInt(process.env.HISTORY_LOOKBACK_BLOCKS ?? 9_000);

/** Rows when the request does not say, and the most it may ask for — the same ceiling as `/runs`. */
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

/**
 * Block reads in flight at once. One at a time made fifty rows a fifteen-second wait at ~0.29s a read; all at once is a
 * burst a free RPC answers with 429s.
 */
const TIME_READS_AT_ONCE = 4;

export type HistoryToken = { symbol: string; decimals: number; address: string };

/** What the executor recorded for the transaction, from its own run. */
export type HistoryRun = {
  kind: string;
  venue: string | null;
  side: string | null;
  units: number | null;
  usd: number | null;
  symbol: string;
};

export type HistoryItem = {
  kind: 'spent' | 'closed' | '1inch';
  txHash: string;
  block: number;
  /** The block's time, or null when that block could not be read — the settlement is no less true for it. */
  at: string | null;
  /** The executor's name for a venue it settles on, otherwise the contract's address. */
  venue: string | null;
  token: HistoryToken | null;
  /** In the token's base units, exactly as the chain carries it. Null only for a 1inch event that moved no token. */
  amount: string | null;
  /** Dollars only where the amount IS dollars — see `dollarsOf`. */
  usd: number | null;
  run?: HistoryRun;
  /** What 1inch calls the event, and which way the token that stands for it moved. 1inch rows only. */
  oneinch?: { type: string; direction: 'in' | 'out' | null };
  explorer: string;
};

/** A row with its place in its block, so rows from two sources order the way the chain did. */
type Placed = { item: HistoryItem; txIndex: number; logIndex: number };

/**
 * The token at an address, from the registry — or null, and the amount stays raw.
 *
 * `TOKENS` is all-mainnet on purpose (it is what 1inch is asked about), and on Base Sepolia the settlement USDC is
 * Circle's other deployment, `ADDRESSES.usdc`. So this chain's own USDC is checked first: without it every Sepolia
 * spend would read as an unknown token.
 */
function tokenAt(address: string): HistoryToken | null {
  const a = address.toLowerCase();
  if (a === ADDRESSES.usdc.toLowerCase()) {
    return { symbol: SETTLEMENT_SYMBOL, decimals: TOKENS[SETTLEMENT_SYMBOL]!.decimals, address: ADDRESSES.usdc };
  }
  for (const [symbol, t] of Object.entries(TOKENS)) {
    if (t.address.toLowerCase() === a) return { symbol, decimals: t.decimals, address: t.address };
  }
  return null;
}

/**
 * Dollars, where the amount is the settlement token — the unit the daily cap already counts in.
 *
 * Null for anything else. The chain does not record what a sold asset was worth, and pricing it now would put today's
 * price on a past settlement; what the executor measured, where it has a run, is on `run.usd`.
 */
function dollarsOf(token: HistoryToken | null, amount: bigint): number | null {
  return token?.symbol === SETTLEMENT_SYMBOL ? Number(formatUnits(amount, token.decimals)) : null;
}

/**
 * The name `strategy_runs.venue` records for a contract a fill may go to (`SettlementVenue`), or the address itself for
 * one this chain does not settle on. Aave is named only where its pool exists.
 */
function venueName(address: string): string {
  const named: [string | undefined, SettlementVenue][] = [
    [ONEINCH_ROUTER, '1inch'],
    [IS_MAINNET_STATE ? AAVE_V3_POOL : undefined, 'aave'],
    [bookAddress(), 'aqua'],
    [swapVmBookAddress(), 'swapvm'],
  ];
  return named.find(([a]) => a?.toLowerCase() === address.toLowerCase())?.[1] ?? address;
}

/**
 * The provider's own words for a failed read, fit for a response body.
 *
 * viem's `shortMessage` and `details` rather than `message`, which runs to a dozen lines with the request body in them.
 * Any URL is cut: an RPC URL can carry the provider's API key, and this sentence goes to a screen.
 */
function reasonOf(e: unknown): string {
  const err = (e ?? {}) as { shortMessage?: unknown; details?: unknown };
  const head =
    typeof err.shortMessage === 'string'
      ? err.shortMessage
      : e instanceof Error
        ? (e.message.split('\n')[0] ?? '')
        : String(e);
  const details = typeof err.details === 'string' && !head.includes(err.details) ? ` ${err.details}` : '';
  return `${head}${details}`
    .replace(/\s*(?:for |at )?https?:\/\/\S+/gi, '')
    .trim()
    .slice(0, 300);
}

/** This owner's `Spent` and `Closed` events in the window, as rows. */
async function chainSettlements(owner: Address, fromBlock: bigint, toBlock: bigint): Promise<Placed[]> {
  // One event after the other, as the book scans do: these endpoints rate-limit as well as range-limit.
  const spent = await getLogsPaged({ address: DELEGATION_ADDRESS, event: SPENT_EVENT, args: { owner }, fromBlock, toBlock });
  const closed = await getLogsPaged({ address: DELEGATION_ADDRESS, event: CLOSED_EVENT, args: { owner }, fromBlock, toBlock });

  const logs = [
    ...spent.map((l) => ({ kind: 'spent' as const, venue: l.args.venue, token: l.args.token, amount: l.args.amount, l })),
    ...closed.map((l) => ({ kind: 'closed' as const, venue: l.args.venue, token: l.args.token, amount: l.args.amount, l })),
  ];
  const out: Placed[] = [];
  for (const { kind, venue, token, amount, l } of logs) {
    // Pending, or not decodable against the declared event: neither is a settlement.
    if (l.blockNumber === null || !l.transactionHash || !venue || !token || amount === undefined) continue;
    const ref = tokenAt(token);
    out.push({
      txIndex: l.transactionIndex ?? 0,
      logIndex: l.logIndex ?? 0,
      item: {
        kind,
        txHash: l.transactionHash,
        block: Number(l.blockNumber),
        at: null,
        venue: venueName(venue),
        token: ref,
        amount: amount.toString(),
        usd: dollarsOf(ref, amount),
        explorer: explorerTx(l.transactionHash),
      },
    });
  }
  return out;
}

/**
 * A 1inch event as a row. One token movement stands for it: what the wallet paid, preferring a token the registry knows,
 * else what it received — the same side a `Spent` or a `Closed` reports.
 */
function placeOneInch(e: OneInchHistoryEvent, owner: string): Placed {
  const d = e.details;
  const actions = d.tokenActions ?? [];
  const paid = actions.filter((a) => a.fromAddress.toLowerCase() === owner);
  const received = actions.filter((a) => a.toAddress.toLowerCase() === owner);
  const listed = (a: { address: string }) => tokenAt(a.address) !== null;
  const action = paid.find(listed) ?? paid[0] ?? received.find(listed) ?? received[0];
  const token = action ? tokenAt(action.address) : null;
  const amount = action && /^\d+$/.test(action.amount) ? action.amount : null;
  return {
    txIndex: d.orderInBlock,
    logIndex: e.eventOrderInTransaction,
    item: {
      kind: '1inch',
      txHash: d.txHash,
      block: d.blockNumber,
      at: new Date(d.blockTimeSec * 1000).toISOString(),
      venue: d.toAddress ? venueName(d.toAddress) : null,
      token,
      amount,
      usd: amount === null ? null : dollarsOf(token, BigInt(amount)),
      oneinch: { type: d.type, direction: action ? (paid.includes(action) ? 'out' : 'in') : null },
      explorer: explorerTx(d.txHash),
    },
  };
}

/**
 * Each distinct block's time, read once: a block holding three of this wallet's events costs one read, not three. Null
 * for a block whose read failed.
 */
async function blockTimes(blocks: readonly bigint[]): Promise<Map<bigint, string | null>> {
  const distinct = [...new Set(blocks)];
  const out = new Map<bigint, string | null>();
  for (let i = 0; i < distinct.length; i += TIME_READS_AT_ONCE) {
    await Promise.all(
      distinct.slice(i, i + TIME_READS_AT_ONCE).map(async (blockNumber) => {
        const block = await publicClient.getBlock({ blockNumber }).catch(() => undefined);
        out.set(blockNumber, block ? new Date(Number(block.timestamp) * 1000).toISOString() : null);
      }),
    );
  }
  return out;
}

/** GET /history?limit= — this wallet's settlements, newest first. */
historyRoutes.get('/history', async (c) => {
  const w = await requireWallet(c);
  const owner = w.address as Address;

  const asked = c.req.query('limit');
  const n = asked === undefined ? DEFAULT_LIMIT : Number(asked);
  if (!Number.isFinite(n)) {
    return c.json({ error: 'bad_limit', detail: `limit is a number of rows, at most ${MAX_LIMIT}.` }, 400);
  }
  const limit = Math.min(MAX_LIMIT, Math.max(1, Math.floor(n)));

  // Absent, not empty: with no contract configured there is nothing to read, and "nothing settled" would be a claim.
  if (/^0x0{40}$/i.test(DELEGATION_ADDRESS)) {
    return c.json(
      { error: 'not_configured', detail: 'This executor has no delegation contract configured, so there are no settlements to read.' },
      503,
    );
  }

  /*
   * 1inch is asked alongside the chain — another host, another lane — and settled into an answer either way, so its
   * failure can neither become an unhandled rejection nor take the chain's history down with it.
   */
  const fromOneInch =
    CHAIN_KEY === 'xlayer'
      ? oneinchHistory(owner, limit).then(
          (events) => ({ events, reason: null }),
          (e: unknown) => ({ events: [] as OneInchHistoryEvent[], reason: reasonOf(e) }),
        )
      : undefined;

  let head: bigint;
  let fromBlock: bigint;
  let placed: Placed[];
  try {
    head = await publicClient.getBlockNumber();
    fromBlock = head > LOOKBACK_BLOCKS ? head - LOOKBACK_BLOCKS : 0n;
    placed = await chainSettlements(owner, fromBlock, head);
  } catch (e) {
    // An unread log is not an empty history. The cause goes to the log in full; the screen gets the provider's words.
    const reason = reasonOf(e);
    log.warn(`[history] could not read the settlements of ${owner}: ${e instanceof Error ? e.message : String(e)}`);
    return c.json(
      {
        error: 'chain_read_failed',
        message: `Could not read this wallet's settlements from the chain just now: ${reason}`,
        reason,
        requestId: currentRequestId(),
      },
      502,
    );
  }

  const oneinch = fromOneInch ? await fromOneInch : undefined;
  const onChain = new Set(placed.map((p) => p.item.txHash.toLowerCase()));
  for (const e of oneinch?.events ?? []) {
    // A transaction that did not go through settled nothing. One the contract already reported is that report, joined
    // to its run; 1inch's copy would list it twice.
    if (e.details.status !== 'completed' || onChain.has(e.details.txHash.toLowerCase())) continue;
    placed.push(placeOneInch(e, owner.toLowerCase()));
  }

  // Newest first, in the order the chain put them: block, then transaction, then log.
  placed.sort((a, b) => b.item.block - a.item.block || b.txIndex - a.txIndex || b.logIndex - a.logIndex);
  const items = placed.slice(0, limit).map((p) => p.item);
  const settlements = items.filter((i) => i.kind !== '1inch');

  // The runs behind the listed transactions, from this wallet's own strategies on this chain.
  const hashes = [...new Set(settlements.map((i) => i.txHash.toLowerCase()))];
  const runs = new Map<string, HistoryRun>();
  if (hashes.length > 0) {
    const rows = await query<{
      signature: string;
      kind: string;
      symbol: string;
      venue: string | null;
      side: string | null;
      units: string | null;
      usd: string | null;
    }>(
      `SELECT lower(r.signature) AS signature, s.kind, s.symbol, r.venue, r.side, r.units, r.usd
         FROM strategy_runs r
         JOIN strategies s ON s.id = r.strategy_id
        WHERE s.wallet_id = $1 AND s.chain = ${THIS_CHAIN} AND r.chain = ${THIS_CHAIN}
          AND lower(r.signature) = ANY($2::text[])
        ORDER BY (r.status = 'filled') DESC, r.started_at DESC`,
      [w.id, hashes],
    );
    for (const r of rows) {
      if (runs.has(r.signature)) continue;
      runs.set(r.signature, {
        kind: r.kind,
        venue: r.venue,
        side: r.side,
        // NUMERIC arrives as a string; these are display quantities, and null stays null.
        units: r.units === null ? null : Number(r.units),
        usd: r.usd === null ? null : Number(r.usd),
        symbol: r.symbol,
      });
    }
  }

  // 1inch rows carry their own time; the chain's are read — with the window's first block, so the answer can say since when.
  const times = await blockTimes([...settlements.map((i) => BigInt(i.block)), fromBlock]);
  for (const i of settlements) {
    i.at = times.get(BigInt(i.block)) ?? null;
    const run = runs.get(i.txHash.toLowerCase());
    if (run) i.run = run;
  }

  return c.json({
    owner: w.address,
    chain: CHAIN_KEY,
    source: oneinch && oneinch.reason === null ? 'chain+1inch' : 'chain',
    window: { fromBlock: Number(fromBlock), toBlock: Number(head), since: times.get(fromBlock) ?? null },
    unavailable: oneinch?.reason ? { source: '1inch', reason: oneinch.reason } : null,
    items,
  });
});
