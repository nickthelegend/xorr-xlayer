/**
 * Domain types — PLAN.md 3.1. Derived from the real shape of ui/mobile-ui/data/markets.json
 * plus the entities the pivot adds (wallet, delegation, strategy).
 */

/** design.md §1: every instrument carries its own mark gradient stops. */
export type GradientStops = { c1: string; c2: string };

export type AssetClassId = 'crypto' | 'stocks' | 'commodities' | 'indices' | 'preipo';

export type Instrument = GradientStops & {
  sym: string;
  name: string;
  /** "Perp · 100x", "Spot · Perp", "Perp · ICE feed" — rendered after the name in a market row. */
  tag: string;
  /** Display price string as designed. Live prices replace this via MarketRepository. */
  px: string;
  /** Display change string, e.g. "+0.67%" / "−1.08%" (U+2212). */
  chg: string;
  up: boolean;
  classId: AssetClassId;
  /**
   * Whether a real feed backs this instrument. PLAN.md §1.3 item 8: "Every price on screen is
   * real, or labelled."
   *
   * An instrument with no feed carries NO price (`px` is a dash, `chg` is empty) rather than a prototype
   * number under a SIMULATED tag, and the UI labels it "No price feed". The value was `'simulated'`, a
   * name left over from those prototype numbers that no longer described anything; it now says what is
   * true (PLAN.md 3.18).
   */
  feed: 'live' | 'unavailable';
  /** On-chain mint/market id where one exists — used by the price service and the executor. */
  mint?: string;
};

export type AssetClass = {
  id: AssetClassId;
  label: string;
  /** The caption shown left of the count row on screen 24. */
  note: string;
  /** The "See all N …" footer link. */
  more: string;
  instruments: Instrument[];
};

/** [open, high, low, close] in price space. design.md §6: author OHLC, then project. */
export type Bar = readonly [number, number, number, number];

export type Timeframe = '15m' | '1H' | '4H' | '1D' | '1W';

export type Candles = {
  symbol: string;
  timeframe: Timeframe;
  bars: Bar[];
  /**
   * `warming` is not `unavailable`.
   *
   * The executor fetches history from a rate-limited upstream and answers 503 with a Retry-After
   * while it does. Collapsing that into "no chart for this market" tells a user their market has
   * no history when it will have some in seconds — the wrong answer, stated confidently.
   */
  feed: 'live' | 'unavailable' | 'warming';
};

export type Agent = GradientStops & {
  /** The row id once hired; the persona id before that. Use `personaId` to hire. */
  id: string;
  personaId?: string;
  name: string;
  role: string;
  /** The headline metric on the roster card: "61% win rate", "12.6% APY", "Always on". */
  metric: string;
  pnl30d: number;
  win: number;
  trades: number;
  /** Persisted server-side, so a reinstall does not forget who you hired. */
  hired?: boolean;
  tone?: 'dry' | 'sharp' | 'flat';
  riskLimits?: Record<string, unknown>;
  /** Made by this wallet's owner rather than one of the four (`POST /agents/custom`, 2026-09-16). */
  custom?: boolean;
  /** For a made agent: the persona id of the one of the four it follows. */
  style?: string;
};

export type ActivityKind = 'trade' | 'risk' | 'block' | 'yield';

export type ActivityEvent = {
  id: string;
  t: string;
  agent: string;
  action: string;
  detail: string;
  /** Signed display string, or '' when the event moved no money. */
  amount: string;
  kind: ActivityKind;
  /** On-chain signature when the event produced a transaction. */
  signature?: string;
  /**
   * A block-explorer URL, or a `fork:`/`local:` label when the chain has no explorer.
   *
   * The label is deliberate: linking a fork transaction to BaseScan would 404, which reads as the
   * transaction not being real rather than the network not being public.
   */
  explorer?: string;
};

export type Alert = {
  id: string;
  name: string;
  detail: string;
  default: boolean;
  /**
   * Watching, or already fired and waiting for the condition to clear.
   *
   * "On" cannot express this. An alert that has fired is still on, and telling the user it is
   * simply "on" hides the one fact they would want — that it already went off and will not go off
   * again until the price comes back. Optional because an older executor will not send it.
   */
  armed?: boolean;
  lastFiredAt?: string | null;
  fireCount?: number;
};

export type NewsItem = {
  id: string;
  tag: string;
  t: string;
  headline: string;
  /** `null` when no language model was available — the card shows the headline alone. */
  take: string | null;
  tagBg: string;
  tagFg: string;
};

export type Sleeve = {
  name: string;
  weight: number;
  note: string;
  color: string;
};

export type BacktestResult = {
  lookback: '30d' | '90d' | '6m' | '1y';
  ret: number;
  maxDd: number;
  sharpe: number;
  trades: number;
  /**
   * The equity series, downsampled for drawing. NUMBERS, not an SVG polyline — the chart
   * scales a series itself, and the real values let the screen label what the line is worth.
   */
  equity: number[];
  /**
   * Where the numbers came from, and what they are not.
   *
   * The executor sends these and calls them honesty fields — a backtest with no context is
   * a sales pitch. This type dropped them, so the screen showed a return with no provenance
   * and no disclaimer.
   */
  feed?: 'live';
  source?: string;
  disclaimer?: string;
};

export type Position = {
  id: string;
  symbol: string;
  side: 'long' | 'short';
  leverage: number;
  /** Average cost per unit, from real fills. */
  entry: number;
  mark: number;
  /** 0 for spot — a spot position cannot be liquidated, and the screen hides the row. */
  liquidation: number;
  notional: number;
  margin: number;
  unrealised: number;
  unrealisedPct: number;
  units: number;
  fundingPaid: number;
  feed: 'live' | 'unavailable';
  /** What the executor's ledger records. `units` is capped at what the wallet holds (PLAN.md 2.7). */
  ledgerUnits?: number;
  /** What the wallet holds on this chain; `null` where the token cannot be asked about here. */
  chainUnits?: number | null;
  /** `ledgerUnits − chainUnits`: positive when the ledger records more than the wallet holds. */
  driftUnits?: number | null;
};

export type Proposal = {
  id: string;
  agent: string;
  status: string;
  /** `null` when no language model was available. The numbers below stand on their own. */
  opening: string | null;
  action: string;
  notional: string;
  entry: string;
  stop: string;
  target: string;
  rationale: string;
  onApprove: string;
  onSkip: string;
  /** Unix ms. Screen 12's "expires 4:12" counts down to this — [G27]. */
  expiresAt: number;
};

/**
 * What deciding a proposal actually did — PLAN.md 1.3.
 *
 * Approving used to answer "Filled … Stop set at …" for a trade that never happened. The status is
 * now the executor's own account of what it did, and `filled` only ever arrives with the transaction
 * that filled it.
 */
export type ProposalDecision = {
  /** `approve`, `skip` and `expired` also answer a proposal that had already been decided that way. */
  status: 'filled' | 'blocked' | 'failed' | 'skip' | 'expired' | 'gone' | 'approve';
  message: string;
  /** With `filled`: the settling transaction. */
  signature?: string;
  orderId?: string;
  /** The `exit-rules` strategy holding the proposal's stop and target, when one was set. */
  exitStrategyId?: string | null;
  reason?: string;
};

// ── Pivot entities ────────────────────────────────────────────────────────────

export type Wallet = {
  address: string;
  /** 'embedded' = created by Privy at the email login, recovered by signing in again; 'connected' = user brought their own. */
  kind: 'embedded' | 'connected';
  /**
   * The chain this wallet was created on — history, and left alone.
   *
   * The union used to be `'devnet' | 'mainnet-beta'`, which are Solana clusters left over from
   * before the pivot. The server has been sending `base-sepolia` and `base-fork` into it ever
   * since, so the type was asserting something no value had ever satisfied.
   */
  cluster: string;
  /** Where the executor is settling RIGHT NOW. This is what a user means by "which network". */
  chain?: string;
};

/**
 * The delegation — PLAN.md §3.4. Trade-only, venue-allowlisted, capped, time-boxed, revocable.
 * These four fields ARE screen 4's four controls.
 */
export type Delegation = {
  /** The bot's trading authority pubkey. Never has withdraw rights. */
  delegatePubkey: string;
  ownerPubkey: string;
  /**
   * Basenames for the two parties, when they have one.
   *
   * Null for most addresses, and null is the honest answer rather than a reason to fall back to
   * something invented. Truncated hex is what these were before, and two addresses that differ
   * only in the middle look identical truncated — on the one screen where telling them apart is
   * the entire point.
   */
  ownerName?: string | null;
  delegateName?: string | null;
  /**
   * Is the granted delegate the key the executor actually signs with?
   *
   * A permission granted to a different key is unusable — `spend` checks the caller against the
   * address the user signed for — but it reads as perfectly healthy: not revoked, cap intact,
   * unexpired. The screen said LIVE while the bot could not place an order, which is the one
   * mistake this screen must never make.
   */
  delegateIsCurrent?: boolean;
  /** screen 4 "Daily Spend Cap", $200–$5,000 step $200. Enforced outside the client. */
  dailyCapUsd: number;
  /** What the permission has spent today, as `/delegation` reports it. Absent from an executor older than the field. */
  spentTodayUsd?: number;
  /** screen 4 "Run For" -> a real expiry, unix ms. */
  expiresAt: number;
  /**
   * When the grant in force was made, unix ms: the time of the block that carried its `Granted`
   * event, as `/delegation/record` read it (PLAN.md 4.7). Resume re-grants for as long as that grant
   * ran — `expiresAt` less this — because "Run For" itself is not kept on chain.
   *
   * Null when there is no record of that grant — one made before grants were recorded this way, or
   * never reported by the app — and absent from an executor older than the field. Neither is a
   * reason to invent a length.
   */
  grantedAt?: number | null;
  /** Programs/venues the authority may touch. */
  venueAllowlist: string[];
  /** Withdrawals may only go here, after a cooling-off period. */
  withdrawalAllowlist: string[];
  revoked: boolean;
  /** The signature that created it, so the grant is auditable. */
  signature?: string;
};

export type StrategyKind =
  | 'dca'
  | 'rebalance'
  | 'exit-rules'
  | 'yield-rotation'
  | 'grid'
  | 'momentum'
  | 'event-driven';

export type StrategyState = 'draft' | 'watch' | 'live' | 'paused' | 'ended';

export type Cadence = 'daily' | 'weekly' | 'biweekly' | 'monthly';

export type Strategy = {
  id: string;
  kind: StrategyKind;
  state: StrategyState;
  label: string;
  symbol: string;
  /** USD per run for DCA; target weights for rebalance; etc. */
  params: Record<string, unknown>;
  cadence?: Cadence;
  /** Unix ms of the next scheduled run. */
  nextRunAt?: number;
  /** Slice of the delegation's daily cap this strategy may consume. PLAN.md 9.2. */
  dailyAllocationUsd: number;
  createdAt: number;
  /** The agent that runs it, when one does (`POST /strategies` takes it; `GET /strategies` says it). */
  agentId?: string;
  /**
   * Which state a resume will put this back to. Present only while it is paused.
   *
   * A strategy paused out of `watch` resumes into `watch`; one paused out of `live` resumes live.
   * The two are different things to tap, and the list had no way to tell them apart.
   */
  pausedFrom?: string;
};

/** A 90x30 sparkline row on screen 5. G5 lifted these out of the prototype. */
export type WatchlistRow = {
  sym: string;
  px: string;
  chg: string;
  up: boolean;
  /** SVG polyline points in a 90x30 viewBox. design.md §6 "Sparkline". */
  spark: string;
};

export type WatchlistGroup = {
  label: string;
  tab: string;
  rows: WatchlistRow[];
};


/**
 * What Privy — the custodian of the key itself — will let this wallet do.
 *
 * The second lock, and a different KIND of lock from the delegation. `XorrDelegation` bounds the
 * bot and is enforced by a contract anyone can read. This bounds the wallet, and is enforced by
 * the party that holds the key, before a signature exists. Neither substitutes for the other, and
 * the safety screen shows both because "defence in depth" is a claim until you can see both
 * layers named.
 */
export type PrivyPolicyView = {
  /** Attached to THIS wallet, as opposed to merely existing. */
  enforced: boolean;
  policyId?: string;
  policyName?: string;
  walletId?: string;
  /** Destinations the attached policy names. Empty when nothing is attached. */
  allowed: { label: string; address: string }[];
  /** What the policy would allow, whether or not it is attached yet. */
  wouldAllow: { label: string; address: string }[];
  /** The key quorum that owns the policy — why we cannot widen it ourselves. */
  ownedByQuorum: string | null;
  ownerId: string | null;
};

/**
 * What Base has been told about this wallet's audit trail.
 *
 * `state` is the whole point and its three values are not degrees of one thing:
 *
 * - `match`    — the head on-chain is the head we hold; everything up to it is committed.
 * - `ahead`    — more rows have been written since the last anchor. The ordinary state between
 *                anchors, and a pass only because the server re-hashes the row AT the anchored
 *                length before saying it.
 * - `diverged` — the trail changed underneath a commitment Base already holds. The alarm.
 * - `none`     — nothing has been anchored for this wallet yet.
 */
export type AuditAnchor = {
  head: string;
  entryCount: number;
  /** Unix seconds, from the block. */
  at: number;
  blockNo: number;
};

export type AnchorReport = {
  configured: boolean;
  contract: string;
  /** The key that signed the anchors — the same address the app names as the bot's key. */
  anchoredBy: string;
  chain: string;
  state: 'match' | 'ahead' | 'diverged' | 'none';
  entryCount: number;
  latest: AuditAnchor | null;
  history: AuditAnchor[];
};

/**
 * What each settlement venue would give for the same trade.
 *
 * A refusal is an answer here, not an omission: "no maker book is deep enough at $2,500" is the
 * information, and a comparison that dropped the venues which could not serve would read as
 * "1inch is the only venue" — a different and false claim.
 */
export type VenueQuote =
  | {
      venue: 'aqua' | 'swapvm' | '1inch';
      served: true;
      outAmount: number;
      detail: string;
      /** What the transaction costs to send, and what is left after paying it. Never zero for
       *  "unknown" — a cost we could not measure is absent, not free. */
      gasUsd?: number;
      netUsd?: number;
    }
  | { venue: 'aqua' | 'swapvm' | '1inch'; served: false; reason: string };

export type RouteComparison = {
  inSymbol: string;
  outSymbol: string;
  amount: number;
  quotes: VenueQuote[];
  best?: 'aqua' | 'swapvm' | '1inch';
  /** The winner AFTER gas. Undefined unless every served venue could be costed. */
  bestNet?: 'aqua' | 'swapvm' | '1inch';
  /** Undefined when only one venue served — "better than nothing" is not a margin. */
  edgeBps?: number;
};
