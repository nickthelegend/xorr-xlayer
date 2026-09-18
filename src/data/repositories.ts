/**
 * Repository interfaces — PLAN.md 3.2 / §3.8.
 *
 * "The whole client builds against typed repository interfaces with a fixture implementation.
 * Phase 12 swaps implementations, not screens. Any screen calling `fetch` directly is a bug."
 *
 * Enforced by src/data/repositories.test.ts, which greps the screen layer for `fetch(`.
 */
import type {
  ActivityEvent,
  Agent,
  Alert,
  AssetClass,
  BacktestResult,
  Candles,
  Delegation,
  Instrument,
  NewsItem,
  Position,
  PrivyPolicyView,
  Proposal,
  ProposalDecision,
  Sleeve,
  Strategy,
  Timeframe,
  Wallet,
} from './types';
import type { Keyed } from './intentKey';

export interface MarketRepository {
  listClasses(): Promise<AssetClass[]>;
  getInstrument(symbol: string): Promise<Instrument | null>;
  /**
   * Spot price per symbol.
   *
   * This carried a second line above it reading "Falls back to the fixture price with
   * feed:'simulated'", which stopped being true when that fallback was deliberately removed: it
   * put BTC on screen at the handoff's $66,560 while the real price was $79,880, correctly tagged
   * SIMULATED and twenty percent wrong. A symbol that HAS a feed and did not answer now shows a
   * dash. Only instruments with no feed at all keep an indicative price, and those say so.
   * `change24h` is optional on purpose: the tokenized equities are priced
   * from a single swap quote, which has no 24h window behind it. Reporting 0 there would read as a
   * measured "unchanged today".
   */
  quotes(
    symbols: string[],
  ): Promise<
    Record<string, { price: number; change24h?: number; warming?: boolean } | undefined>
  >;
  candles(symbol: string, timeframe: Timeframe): Promise<Candles>;
  /** A day of closes per symbol, for the row glyphs. Symbols without history are omitted. */
  sparklines(symbols: string[]): Promise<Record<string, number[]>>;
}

export interface BotRepository {
  /** Hire a persona. Idempotent — hiring twice is the same agent. */
  hire(personaId: string): Promise<Agent>;
  /** Make an agent of one's own: a name, what it does, and the one of the four it follows. */
  createAgent(input: {
    name: string;
    role: string;
    /** The persona id of the one of the four it works like. */
    style: string;
    tone?: 'dry' | 'sharp' | 'flat';
    riskLimits?: { maxUsdPerDay?: number; maxUsdPerTrade?: number };
  }): Promise<Agent>;
  /** Fire one. Its strategies are paused, never deleted. */
  fire(agentId: string): Promise<{ pausedStrategies: number }>;
  /** Tone and per-agent limits. */
  updateAgent(agentId: string, patch: { tone?: string; riskLimits?: Record<string, unknown> }): Promise<Agent>;
  listAgents(): Promise<Agent[]>;
  currentProposal(): Promise<Proposal | null>;
  /**
   * Ask the agent to consider a trade — PLAN.md 12.18.
   * Returns null when it declined, WITH the reason, because "what it chose not to do" is the
   * product. The thread renders that decline rather than sitting empty.
   */
  generateProposal(): Promise<{ proposal: Proposal | null; declined?: string }>;
  /** Approve places the order for real; the answer says what happened. See `ProposalDecision`. */
  decideProposal(id: string, decision: 'approve' | 'skip'): Promise<ProposalDecision>;
  /** `symbol` is what the replay buys, where the agent trades more than one; the executor defaults to WETH. */
  backtest(agentId: string, lookback: BacktestResult['lookback'], symbol?: string): Promise<BacktestResult>;
  leaderboard(): Promise<Agent[]>;
  /**
   * Ask the bot something — PLAN.md 11.7. Returns prose only: every figure on screen is rendered
   * by the client from its own records, so the model cannot put a number in front of the user.
   */
  ask(params: {
    agentId: string;
    question: string;
    tone: 'dry' | 'sharp' | 'flat';
    /** An agent someone made answers in `agentId`'s voice under its own name and mandate. */
    as?: { name: string; role: string };
    /** `text` is `null` when no model answered — the caller must say so, never invent one. */
  }): Promise<{
    text: string | null;
    source: 'model' | 'none';
    /**
     * Why no model answered, when none did: `no_key` (this build has none), `rejected` or `error` (one was asked and
     * nothing usable came back), `unreachable` (the request never arrived).
     */
    reason?: string;
  }>;
}

export interface StrategyRepository {
  /** Pause or resume. A paused strategy stops running and frees its share of the daily cap. */
  setState(id: string, state: 'live' | 'paused' | 'ended'): Promise<Strategy>;
  /** Run one now, through the same period claim the scheduler uses. */
  /** `reason` is an identifier; `detail`, when the executor sends one, is the sentence for a person. */
  runNow(id: string): Promise<{ status: string; reason?: string; detail?: string; units?: number; price?: number }>;
  list(): Promise<Strategy[]>;
  create(s: Omit<Strategy, 'id' | 'createdAt'>): Promise<Strategy>;
  pause(id: string): Promise<Strategy>;
  resume(id: string): Promise<Strategy>;
  end(id: string): Promise<Strategy>;
}

export interface OrderRepository {
  /**
   * Place a market order. Screen 14's CTA.
   *
   * The executor picks the route and the price and enforces every limit — it runs the same
   * `runStrategy` path the scheduler runs. A `blocked` outcome carries the policy engine's
   * own reason, which is the sentence the user should read.
   *
   * `write` is the order's `Idempotency-Key`, and there is no placing one without it: a buy tapped again after a timeout
   * must reach the executor as the same buy (FEATURES.md #29, `intentKey.ts`).
   */
  place(input: { symbol: string; usd: number }, write: Keyed): Promise<OrderOutcome>;
}

export type OrderOutcome = {
  status: 'filled' | 'watch' | 'blocked' | 'failed' | 'skipped';
  orderId?: string;
  txHash?: string;
  units?: number;
  price?: number;
  reason?: string;
  detail?: string;
  error?: string;
};

export interface PortfolioRepository {
  positions(): Promise<Position[]>;
  position(id: string): Promise<Position | null>;
  sleeves(): Promise<Sleeve[]>;
  /**
   * Throws when the balance could not be read, so a screen can say so and offer a retry. It used to answer `null`,
   * which kept a zero off the screen and also hid every failure behind a dash no screen could explain.
   */
  balanceUsd(): Promise<number | null>;
  /**
   * The same total, broken into what it is made of.
   *
   * Cash and supplied are different money: one can be spent today, the other is earning and has to
   * be withdrawn first. A screen that sweeps idle cash has to know which is which, and a single
   * total cannot tell it. A failed read throws, for the same reason as above.
   */
  /**
   * What the CHAIN says this wallet holds, split three ways.
   *
   * `holdings` is per-symbol and was being dropped on the way through — the server has always sent
   * it. Without it, any screen wanting a breakdown had to fall back to `positions()`, which is the
   * DB's position ledger and a different source: it tracks cost basis and can drift from the chain.
   * The two then disagreed by hundreds of dollars on two screens that link to each other.
   *
   * For "what do I hold", the chain wins. `positions()` remains right for "what did I pay".
   */
  balance(): Promise<{
    total: number;
    cash: number;
    supplied: number;
    holdings: { symbol: string; units: number; usd: number }[];
  } | null>;
  /**
   * Profit actually taken, by symbol and in total.
   *
   * Separate from `positions()` because a closed position is not a holding — but the money made
   * on it is real, and filtering it out of the holdings list took it out of the app entirely.
   */
  realised(): Promise<{
    total: number;
    bySymbol: {
      symbol: string;
      realised: number;
      unitsSold: number;
      proceeds: number;
      /** Some of what was sold had no recorded cost. The executor counts that part as no gain or loss, so the true outcome could be either way. */
      basisIncomplete: boolean;
    }[];
  }>;
  /**
   * Sell part or all of a holding at the live route — screen 22's "Close {n}%", and the
   * sell side of the order ticket.
   *
   * Goes through `closePosition`, never `spend`, so the daily cap cannot silence it. The
   * executor picks the route and the price; the app sends only how much.
   *
   * Keyed, for the reason `OrderRepository.place` is: a sale asked for again after a timeout is the same sale.
   */
  close(input: { symbol: string; fraction: number }, write: Keyed): Promise<PositionClose>;
}
/** What came back from a close. `txHash` is the on-chain proof. */
export type PositionClose = {
  status: 'closed' | 'blocked' | 'failed';
  symbol?: string;
  units?: number;
  usd?: number;
  txHash?: string;
  reason?: string;
  detail?: string;
  error?: string;
};


export interface ActivityRepository {
  list(): Promise<ActivityEvent[]>;
  /** PLAN.md 12.11: the audit trail is the compliance artifact, so export is a real feature. */
  exportTrail(format: 'csv' | 'json'): Promise<string>;
  /**
   * Every disposal with its cost basis — the document an accountant asks for.
   *
   * Distinct from the audit trail, which records what the bot did. Blocked runs belong in one and
   * cost basis belongs in the other, and a file that tried to be both would be the wrong shape for
   * each.
   */
  exportDisposals(): Promise<string>;
  /**
   * A receipt for every trade that actually settled — and nothing that did not.
   *
   * The third document, narrower than either of the others. The trail records what the bot DID,
   * including the runs a cap blocked and the ones with nothing to do; disposals record what the
   * user OWES. This records what moved: date, asset, size, price, venue and the transaction it
   * settled in. Only a run that reached `filled` and carries a signature appears, because a
   * receipt for something that did not happen is not a weaker receipt — it is a false one.
   */
  exportFills(): Promise<string>;
}

export interface NewsRepository {
  briefing(): Promise<NewsItem[]>;
}

/**
 * Yield — PLAN.md 12.17 [G35].
 *
 * The handoff quotes 12.6% APY on Home, in Activity and in the Briefing. The live figure derived
 * from Solana's own inflation schedule is materially lower. The app shows the LIVE number: an
 * app that advertises a rate it cannot deliver is the thing copy.md's "never oversell" rule
 * exists to prevent.
 */
/**
 * One futures contract, from the venue that lists it — Hyperliquid (2026-09-13). PLAN.md 12.15 [G37].
 *
 * Every field is the venue's own. This used to be a spot price with nulls wherever a venue's book was
 * needed; there is a venue behind it now. xorr still does not trade futures.
 */
export type PerpMetrics = {
  symbol: string;
  markPx: number;
  oraclePx: number;
  markVsIndex: number;
  /** Null when the venue has no price from 24 hours earlier. */
  change24hPct: number | null;
  openInterestUsd: number;
  dayVolumeUsd: number;
  /** Per funding interval, as a fraction. Positive means longs pay shorts. */
  fundingRate: number;
  fundingIntervalHours: number;
  maxLeverage: number;
  nextFundingSeconds: number;
  /** Absolute unix ms — the client counts down from this, purely. */
  nextFundingAt: number;
  venue: string;
  feed: 'live';
};

/** A row in the futures list — the same figures as `PerpMetrics`, for every live contract. */
export type PerpMarket = {
  symbol: string;
  markPx: number;
  oraclePx: number;
  change24hPct: number | null;
  fundingRate: number;
  openInterestUsd: number;
  dayVolumeUsd: number;
  maxLeverage: number;
};

export type PerpRange = '1D' | '1W' | '1M' | '1Y';

export type PerpCandles = {
  symbol: string;
  range: PerpRange;
  interval: string;
  /** Candle open times, unix ms. */
  times: number[];
  /** `[open, high, low, close]`. */
  bars: [number, number, number, number][];
};

export interface PerpRepository {
  metrics(symbol: string): Promise<PerpMetrics | null>;
  /** Every live contract, busiest first, with the venue they come from. */
  markets(): Promise<{ venue: string; markets: PerpMarket[] }>;
  candles(symbol: string, range: PerpRange): Promise<PerpCandles>;
}

export interface YieldRepository {
  /** `estimatedApy` is a FRACTION (0.0388 = 3.88%), not percentage points. */
  staking(): Promise<{
    estimatedApy: number;
    /** Always live: `/yield/supply` answers a rate it cannot read with 503 `rate_unavailable`, never a stand-in number. */
    feed: 'live';
    note: string;
    /**
     * Whether this can be supplied on the chain this build trades.
     *
     * The rate is read from Base mainnet on every build, deliberately — Sepolia answers a rate
     * query with a zeroed struct rather than an error, so asking it produces a confident 0.00%.
     * The consequence is that a Sepolia build showed a real 4% and offered to sweep cash into a
     * pool that is not deployed there, where the executor's own planner refuses every run.
     */
    availableHere?: boolean;
  } | null>;
}

export interface AlertRepository {
  list(): Promise<Alert[]>;
  /** Persist a new alert. It used to be built on screen and discarded. */
  create(input: {
    kind: 'price' | 'agent' | 'risk';
    symbol?: string;
    name: string;
    detail?: string;
    config?: Record<string, unknown>;
  }): Promise<Alert>;
  setEnabled(id: string, enabled: boolean): Promise<void>;
}

/**
 * One address on the signed-in account.
 *
 * `active` is the one every other route resolves to — the policy read, the balance, the strategies,
 * the trail. The executor computes it from the same ordering it picks with, so this flag and what
 * the money actually does cannot come apart.
 */
export type AccountWallet = {
  id: string;
  address: string;
  /** `embedded` was made by Privy for this account; `connected` is a wallet the user brought. */
  kind: 'embedded' | 'connected';
  /** Where the row was created. History, not where the executor settles now. */
  cluster: string;
  active: boolean;
  /** Absent on a row written before the executor recorded this. Never stood in for by `createdAt`. */
  lastActiveAt?: number;
  createdAt: number;
};

export interface WalletRepository {
  current(): Promise<Wallet | null>;
  /**
   * Every address on this account, the one in use first.
   *
   * A user having more than one is not hypothetical: web Privy lists any injected browser extension
   * alongside the embedded wallet. Everything is scoped by wallet, so the other address has its own
   * balance, strategies and trail — and until there was a switcher, nothing in the app could reach
   * them or explain why the numbers looked wrong.
   */
  all(): Promise<AccountWallet[]>;
  createEmbedded(): Promise<Wallet>;
  connect(address: string): Promise<Wallet>;
  delegation(): Promise<Delegation | null>;
  /** What Privy enforces on this wallet — read from Privy, not from our own record of it. */
  privyPolicy(): Promise<PrivyPolicyView | null>;
  /**
   * NOTE: there is deliberately no grant/revoke here.
   *
   * Those are transactions the USER signs with their own Privy wallet (src/auth/useGrantDelegation).
   * A repository method would imply the server could do it, and the whole safety claim rests on
   * the fact that it cannot.
   */
}

export type Repositories = {
  markets: MarketRepository;
  bot: BotRepository;
  strategies: StrategyRepository;
  portfolio: PortfolioRepository;
  activity: ActivityRepository;
  news: NewsRepository;
  yield: YieldRepository;
  perps: PerpRepository;
  alerts: AlertRepository;
  wallet: WalletRepository;
  orders: OrderRepository;
};
