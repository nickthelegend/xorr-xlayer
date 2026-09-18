/**
 * Local repository implementation.
 *
 * Not a mock: market data is REAL — CoinGecko for crypto and a live 1inch route for the
 * tokenized equities, both through the executor (src/data/marketData.ts). What is local is
 * the *account* — positions, strategies, the audit trail — which lives in the executor's Postgres
 * once the server is reachable, and falls back to the on-device store when it is not.
 *
 * Anything without a real feed is returned with feed:'unavailable' so the UI can label it.
 * PLAN.md §1.3 item 8: "Never present synthetic data as live."
 */
import { assetClasses } from './fixtures/markets';
import { sleeveFixtures } from './fixtures/sleeves';
import {
  StillWarming,
  fetchCandles,
  fetchQuotes,
  fetchSparklines,
  fetchStockQuotes,
  type Quote,
  type StockQuote,
} from './marketData';
import { ApiError, NotSignedIn, api, apiReason } from './api';
import { waitOutWarming } from './warming';
import { absentOrThrow, goneProposal, markReplayed } from './apiError';
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
import type {
  AccountWallet,
  OrderOutcome,
  PerpCandles,
  PerpMarket,
  PerpMetrics,
  PositionClose,
  Repositories,
} from './repositories';
import { percent, price as fmtPrice } from '../format';

const allInstruments: Instrument[] = assetClasses.flatMap((c) => c.instruments);

/** Which symbols are tokenized equities, and therefore priced by the venue rather than a feed. */
const STOCK_SYMBOLS = new Set(
  assetClasses.find((c) => c.id === 'stocks')?.instruments.map((i) => i.sym) ?? [],
);

export const LocalRepositories: Repositories = {
  markets: {
    async listClasses(): Promise<AssetClass[]> {
      /*
       * Ask for EVERY symbol, not just the crypto class.
       *
       * This asked only for `crypto`, so an instrument filed under another class kept the
       * fixture's price however real its feed was. Gold is the case that made it visible: XAUT
       * has a genuine `tether-gold` feed on the server, and the commodities tab showed the
       * handoff's $3,412.10 under a SIMULATED tag while gold traded near $4,420. The tag was
       * honest and the number was a thousand dollars wrong, which is the failure the tag exists
       * to prevent, not an acceptable use of it.
       *
       * `/market/quotes` already drops symbols it has no feed for, so asking for all of them
       * costs nothing — it is one cache hit on one URL — and everything genuinely unpriced
       * (silver, crude, the indices) still falls through to its indicative price and keeps the
       * label. The tokenized equities come from a real 1inch route instead, because that is the
       * venue that would actually fill them.
       *
       * A quote read that FAILED throws. It was `.catch(() => ({}))`, which turned an outage into
       * every live instrument at a dash under "no price feed" — and Home, finding nothing up, said
       * "No gainers today." about a market it never heard from. The sentence is written here
       * because the transport's own is a status line and a path (`502 Bad Gateway for
       * /market/quotes?symbols=…`). The equities' probe stays soft: its rows already say "No price"
       * one at a time, and one venue being slow is not the whole market failing to load.
       */
      const [live, stocks] = await Promise.all([
        fetchQuotes(allInstruments.map((i) => i.sym)).catch((e: unknown): Record<string, Quote> => {
          throw new Error(
            e instanceof StillWarming
              ? 'Prices are still on their way. Try again in a moment.'
              : 'The price feed did not answer.',
          );
        }),
        fetchStockQuotes().catch((): Record<string, StockQuote> => ({})),
      ]);
      return assetClasses.map((c) => ({
        ...c,
        instruments: c.instruments.map((i) => {
          const s = stocks[i.sym];
          if (s) {
            // No 24h change: a swap quote is a spot price, and inventing a delta from one
            // observation would be the same class of lie as a hardcoded price.
            return s.price === null
              ? { ...i, px: '—', chg: '', feed: 'unavailable' as const }
              : { ...i, px: fmtPrice(s.price), chg: '', feed: 'live' as const };
          }
          const q = live[i.sym];
          if (!q) {
            /*
             * An instrument that HAS a live feed and did not answer shows a dash, not the design's
             * price.
             *
             * Falling back to the fixture put BTC on screen at $66,560 — the handoff's 2024 number
             * — under a SIMULATED tag while the real price was $79,880. The tag satisfies the
             * letter of "real or labelled" and not one bit of its intent: a confident, specific,
             * twenty-percent-wrong price is the failure that rule exists to prevent. An instrument
             * that never had a feed keeps its indicative price, which is what the label is for.
             */
            return i.feed === 'live'
              ? { ...i, px: '—', chg: '', feed: 'unavailable' as const }
              : i;
          }
          return {
            ...i,
            px: fmtPrice(q.price),
            chg: percent(q.change24h, { digits: 2 }),
            up: q.change24h >= 0,
            feed: 'live' as const,
          };
        }),
      }));
    },

    async getInstrument(symbol) {
      return allInstruments.find((i) => i.sym === symbol) ?? null;
    },

    async quotes(symbols) {
      // Two feeds, one answer. Crypto is priced by CoinGecko; the tokenized equities have no
      // CoinGecko listing and are priced off the 1inch route that would fill them. A screen asking
      // for a price should not have to know which kind of asset it is holding.
      const needsStocks = symbols.some((s) => STOCK_SYMBOLS.has(s));
      let warming = false;
      const [live, stocks] = await Promise.all([
        /*
         * Still warming is an answer, and every symbol below says so. Any other failure throws, as `listClasses` does:
         * `{}` made a feed that did not answer look like symbols with no feed, and a ticket then said "No live WETH
         * price" about a price nobody had been able to ask for.
         */
        fetchQuotes(symbols).catch((e: unknown): Record<string, Quote> => {
          if (!(e instanceof StillWarming)) throw new Error('The price feed did not answer.');
          warming = true;
          return {};
        }),
        needsStocks
          ? fetchStockQuotes().catch((): Record<string, StockQuote> => ({}))
          : Promise.resolve({} as Record<string, StockQuote>),
      ]);
      const out: Record<
        string,
        { price: number; change24h?: number; warming?: boolean } | undefined
      > = {};
      for (const s of symbols) {
        const stock = stocks[s];
        if (stock?.price != null) {
          // A swap quote is one observation. No 24h delta exists, so none is reported — a 0 here
          // would read as "unchanged today", which is a claim we have not measured.
          out[s] = { price: stock.price };
          continue;
        }
        const q = live[s];
        out[s] = q
          ? { price: q.price, change24h: q.change24h }
          : warming
            ? { price: 0, change24h: undefined, warming: true }
            : undefined;
      }
      return out;
    },

    async sparklines(symbols: string[]): Promise<Record<string, number[]>> {
      // Empty on failure, not an error: a row without its glyph is a row, and a market list that
      // refuses to render because a decoration is unavailable is the wrong trade.
      return (await fetchSparklines(symbols).catch(() => undefined)) ?? {};
    },
    async candles(symbol: string, timeframe: Timeframe): Promise<Candles> {
      /*
       * "Not yet" and "not ever" are different answers and the screen shows different words — and a request that failed
       * is a third, so it throws. It was folded into "no feed", which told a person this market has no chart when a read
       * had merely failed, and gave the screen nothing to offer a retry on.
       */
      let live: Candles | null;
      try {
        live = await fetchCandles(symbol, timeframe);
      } catch (e) {
        if (e instanceof StillWarming) return { symbol, timeframe, bars: [], feed: 'warming' };
        throw e;
      }
      if (live) return live;
      // No feed for this symbol means NO CHART. Handing back another asset's bars under this
      // symbol's name would be the most misleading thing this app could do.
      return { symbol, timeframe, bars: [], feed: 'unavailable' };
    },
  },

  bot: {
    async listAgents(): Promise<Agent[]> {
      // The persisted roster: who is hired, how they are configured, and their real metrics. The
      // roster used to read hired-ness from browser state and metrics from a fixture, so the same
      // fact had two answers and one of them was invented.
      //
      // No stand-in roster when the server cannot answer. This fell back to the fixture personas "without performance
      // claims", which was still four agents, a hire count and a row of zeros the server never gave. A failed read is
      // said by the screen that asked — and a signed-out one asks for a sign-in.
      return api.get<Agent[]>('/agents');
    },
    async hire(personaId: string): Promise<Agent> {
      return api.post<Agent>('/agents', { personaId });
    },
    async createAgent(input): Promise<Agent> {
      // Made on the executor, which refuses a name another agent on the wallet already has.
      return api.post<Agent>('/agents/custom', input);
    },
    async fire(agentId: string): Promise<{ pausedStrategies: number }> {
      return api.del<{ pausedStrategies: number }>(`/agents/${agentId}`);
    },
    async updateAgent(agentId, patch): Promise<Agent> {
      return api.patch<Agent>(`/agents/${agentId}`, patch);
    },
    async currentProposal(): Promise<Proposal | null> {
      // No fixture fallback: a proposal the user could approve must be a real one the server
      // stands behind, or there is none.
      return (await api.get<Proposal | null>('/proposals/current').catch(() => null)) ?? null;
    },
    async generateProposal() {
      /*
       * A `warming` 503 is a WAIT, not a failure.
       *
       * The agent prices every tradable asset to reach a decision, and on a cold cache the
       * executor now bounds that at ten seconds and answers 503 with a Retry-After rather than
       * letting the browser abandon the request — which it did, at twenty-two seconds, reporting
       * it as a CORS error. Treating that 503 like any other error put "I could not reach the
       * market just now" on the Bot tab, which is false: the market was reached, and the answer
       * was seconds away.
       *
       * Waited out the same way `marketData.ts` waits out its own warming 503s, and for the same
       * reason: the work continues server-side, so the retry is the one that reads a warm cache.
       */
      type Generated =
        | ({ created: true; id: string; agent: string; expiresAt: number } & Record<string, string>)
        | { created: false; reason: string; detail: string };

      let res: Generated | null = null;
      let notSignedIn = false;
      try {
        res = await waitOutWarming(() => api.post<Generated>('/proposals/generate', {}));
      } catch (e) {
        notSignedIn = e instanceof NotSignedIn;
      }
      /*
       * Say which failure it was.
       *
       * "I could not reach the market just now" is false for a signed-out visitor: the market was
       * fine, and nobody had asked on their behalf. Same shape as the `NotSignedIn`-as-absence bug
       * on `/safety` — a screen answering a question it never got to put.
       */
      if (!res) {
        return {
          proposal: null,
          declined: notSignedIn
            ? 'Sign in and I will tell you what I am seeing.'
            : 'I could not reach the market just now.',
        };
      }
      if (!res.created) return { proposal: null, declined: res.detail };
      const { created, ...rest } = res;
      return { proposal: rest as unknown as Proposal };
    },
    async decideProposal(id, decision) {
      // A decision must reach the server or it did not happen. Reporting a local "filled" for a
      // request that never landed is the worst possible lie on this screen.
      try {
        return await api.post<ProposalDecision>(`/proposals/${id}/decide`, { decision });
      } catch (e) {
        // A proposal that is not there any more is an answer, not a failure — the executor's 404
        // keeps the thread's sentence. Only that answer: every other refusal is still the error it is.
        const gone = goneProposal(e);
        if (gone) return gone;
        throw e;
      }
    },
    async backtest(agentId, lookback, symbol): Promise<BacktestResult> {
      /*
       * No fallback: a backtest is a performance claim. Showing a designer's numbers when the
       * engine is unreachable would be exactly the overselling copy.md forbids.
       *
       * But a cold backtest replays ninety days of real history, and the executor bounds that at
       * twelve seconds and answers `503 warming` rather than hanging. Read as a plain error, that
       * put the screen into its ErrorState — which deliberately hides "run against real history at
       * your current limits. Nothing here is a promise.", so the disclaimer disappeared while the
       * engine was merely still computing.
       */
      return waitOutWarming(() =>
        api.get<BacktestResult>(
          `/agents/${agentId}/backtest?lookback=${lookback}${symbol ? `&symbol=${encodeURIComponent(symbol)}` : ''}`,
        ),
      );
    },
    async leaderboard(): Promise<Agent[]> {
      // Same reasoning as backtest: a leaderboard is a performance claim.
      return api.get<Agent[]>('/agents/leaderboard');
    },
    async ask({ agentId, question, tone, as }) {
      const res = await api
        .post<{ text: string | null; source: 'model' | 'none'; reason?: string }>('/bot/say', {
          persona: agentId,
          situation: `${as ? `You are ${as.name}, an agent the user made to ${as.role.toLowerCase()}. ` : ''}The user asks: "${question}". Answer in one or two sentences, without naming any figure.`,
          tone,
        })
        .catch(() => undefined);
      /*
       * An unreachable server is not a model that declined, so it does not claim to be one.
       *
       * `source: 'none'` says the same thing the server says when no model wrote a line, and the
       * text names the actual condition — the request failed — rather than putting words in an
       * agent's mouth about a market it never looked at. `reason` says which it was: the chat
       * showed "no language model is configured" for a request that never arrived.
       */
      return (
        res ?? {
          text: 'I cannot reach my own reasoning right now, so I will not guess.',
          source: 'none' as const,
          reason: 'unreachable',
        }
      );
    },
  },

  strategies: {
    async setState(id, state) {
      return api.patch<Strategy>(`/strategies/${id}`, { state });
    },
    async runNow(id) {
      return api.post<{ status: string; reason?: string; units?: number; price?: number }>(
        `/strategies/${id}/run`,
        {},
      );
    },
    /**
     * "None running" is not "could not ask" — and a signed-out visitor is the second one.
     *
     * The comment above this said exactly that while the code below it returned `[]` for
     * `NotSignedIn`, so `/strategies` told a signed-out visitor **"0 running · Nothing running
     * yet"** about a wallet it had never asked about. The screen was already built for the
     * distinction: it renders `—` rather than a count when it has no answer, and it has an error
     * state that says "Not signed in, so /strategies was not requested" — the same sentence
     * `/limits` and `/activity` already show. It just never got the chance to.
     */
    async list(): Promise<Strategy[]> {
      return api.get<Strategy[]>('/strategies');
    },
    async create(s) {
      /*
       * Say what the executor said.
       *
       * This was `.catch(() => undefined)` followed by "The strategy service is unreachable —
       * nothing was created", which is the one sentence that is almost never true. A refusal
       * arrives as a 400 with a written reason — the daily cap, an equity that cannot settle on
       * this chain, a buy of the token the buy is paid in — and all of it was thrown away and
       * reported as the backend being down. Watched on a simulator: `POST /strategies 400` in
       * 304ms, and the screen blamed the network.
       *
       * `apiReason` is the same unwrapping `/orders` already does, and for the same reason: the
       * difference between a user who changes the amount and a user who retries forever.
       */
      try {
        return await api.post<Strategy>('/strategies', s);
      } catch (e) {
        const reason = apiReason(e);
        if (reason) throw new Error(reason);
        // Genuinely no sentence to report — a transport failure, or a body without one.
        throw new Error(
          e instanceof ApiError
            ? `The strategy service refused this (${e.status}) and gave no reason.`
            : 'The strategy service is unreachable — nothing was created.',
        );
      }
    },
    async pause(id) {
      return api.post<Strategy>(`/strategies/${id}/pause`, {});
    },
    async resume(id) {
      return api.post<Strategy>(`/strategies/${id}/resume`, {});
    },
    async end(id) {
      return api.post<Strategy>(`/strategies/${id}/end`, {});
    },
  },

  orders: {
    async place(input, write): Promise<OrderOutcome> {
      // A 409 is a POLICY refusal, not a transport failure — the body carries the reason the
      // user needs to read, so it is unwrapped rather than thrown as "409".
      try {
        return await api.post<OrderOutcome>('/orders', input, write);
      } catch (e) {
        if (e instanceof ApiError && e.body && typeof e.body === 'object') {
          const b = e.body as Partial<OrderOutcome>;
          /*
           * The refusal is unwrapped, so the fact that it was a REPLAY has to come with it.
           *
           * The executor stores a keyed refusal exactly as it stores a fill, and answers the same key with
           * it again (`server/src/http/idempotency.ts`). Without this, the second tap's stored 409 reads as
           * a second, separate rejection — see `markets/placed.ts`.
           */
          if (b.status) return markReplayed(b as OrderOutcome, e.replayed === true);
        }
        throw e;
      }
    },
  },

  portfolio: {
    /*
     * An empty list means the wallet holds nothing. It must not also mean "the read failed".
     *
     * This was `.catch(() => undefined) ?? []`, which turned every failure — a 500, a timeout, a
     * dropped connection — into a confident empty portfolio. On /swap that renders as "Balance
     * 0.0000" and "You hold no WETH. There is nothing to swap." to someone holding 0.4890 WETH,
     * and `useAsync` never sees an error, so no screen can tell the two apart or offer a retry.
     * The whole app draws the absent-versus-not-known line carefully and this one line erased it
     * underneath every screen that reads positions.
     *
     * `NotSignedIn` is the exception the catch was actually written for: no session means no
     * positions, which genuinely is an empty list and not a failure. That one stays swallowed;
     * everything else now reaches the screen.
     */
    async positions(): Promise<Position[]> {
      // Signed out is not an empty book — see the note on `absentOrThrow`. The screens that read
      // this render "could not ask" from the error rather than printing a holding count.
      return api.get<Position[]>('/positions');
    },
    /*
     * `null` only for "not in this wallet's book", which the route answers with a 404. A failed read THROWS.
     *
     * This swallowed every failure into `null`, so an outage — or a signed-out visit — told someone
     * holding the position that it was "no longer open", and the screen's error state could never show.
     * Same repair as `wallet.current()` below.
     */
    async position(id) {
      try {
        return (await api.get<Position | null>(`/positions/${encodeURIComponent(id)}`)) ?? null;
      } catch (e) {
        if (e instanceof ApiError && e.status === 404) return null;
        throw e;
      }
    },
    async sleeves(): Promise<Sleeve[]> {
      // The three sleeves are product config, not measured data — legitimately local.
      return sleeveFixtures;
    },
    async balanceUsd(): Promise<number | null> {
      /*
       * A read that failed THROWS, and it matters twice.
       *
       * Returning 0 put "TOTAL VALUE $0.00" on the home screen of a funded wallet whenever the
       * server was down — a specific, confident, wrong number, which is the one thing this app is
       * not allowed to show. That became `null`, which fixed the number and lost the failure: every
       * error was swallowed into it, so Assets' "Couldn’t load your balance." could never appear and
       * no screen could offer a retry. The screen still renders a dash for a balance it does not
       * have; now it can also say why.
       */
      return (await api.get<{ usd: number }>('/wallet/balance')).usd;
    },
    async realised() {
      // No fallback. An invented profit figure is the single worst number this app could show.
      return api.get<{
        total: number;
        bySymbol: {
          symbol: string;
          realised: number;
          unitsSold: number;
          proceeds: number;
          basisIncomplete: boolean;
        }[];
      }>('/pnl/realised');
    },
    async balance() {
      // No catch, for the reason on `balanceUsd`: a failed read reaches the screen as an error, so
      // "$0.00 supplied · $0.00 idle" and "Nothing is held" are no longer what an outage looks like.
      const b = await api.get<{
        usd: number;
        cashUsd: number;
        suppliedUsd?: number;
        holdings?: { symbol: string; units: number; usd: number }[];
      }>('/wallet/balance');
      return {
        total: b.usd,
        cash: b.cashUsd,
        supplied: b.suppliedUsd ?? 0,
        // Was dropped here. See the note on the interface — it cost two screens their agreement.
        holdings: b.holdings ?? [],
      };
    },
    async close(input, write): Promise<PositionClose> {
      // No catch. A sale that did not happen must surface on the screen that asked for it —
      // a swallowed failure here reads to the user as a completed exit.
      try {
        return await api.post<PositionClose>('/positions/close', input, write);
      } catch (e) {
        if (e instanceof ApiError && e.body && typeof e.body === 'object') {
          const b = e.body as Partial<PositionClose>;
          // The replay mark travels with the unwrapped refusal, as it does on an order.
          if (b.status) return markReplayed(b as PositionClose, e.replayed === true);
        }
        throw e;
      }
    },
  },

  activity: {
    async list(): Promise<ActivityEvent[]> {
      // The audit trail is the compliance artifact. A fabricated row in it would be worse than
      // an empty screen, so there is no fallback — an empty trail shows the empty state.
      return api.get<ActivityEvent[]>('/activity');
    },
    async exportTrail(format) {
      return api.getText(`/activity/export?format=${format}`);
    },
    async exportDisposals() {
      return api.getText('/pnl/disposals.csv');
    },
    async exportFills() {
      return api.getText('/activity/fills.csv');
    },
  },

  news: {
    async briefing(): Promise<NewsItem[]> {
      // Real headlines or none. Stale hand-written news presented as today's briefing is a lie
      // with a timestamp on it.
      return api.get<NewsItem[]>('/briefing');
    },
  },

  perps: {
    async metrics(symbol) {
      /*
       * Null only for "there is no such contract".
       *
       * Catching everything turned a venue that was merely slow — the route's 503 "warming" — into the
       * same null as a symbol nobody lists, so a busy minute read as "no contract". That one is an
       * error the screen states and retries. It still never falls back to the design's figures.
       */
      try {
        return await api.get<PerpMetrics>(`/perp/${encodeURIComponent(symbol)}`);
      } catch (e) {
        if (e instanceof ApiError && e.status === 404) return null;
        throw e;
      }
    },
    async markets() {
      // No catch: a venue that did not answer is an error the screen states, not an empty market.
      return api.get<{ venue: string; markets: PerpMarket[] }>('/market/futures');
    },
    async candles(symbol, range) {
      return api.get<PerpCandles>(`/perp/${encodeURIComponent(symbol)}/candles?range=${range}`);
    },
  },

  yield: {
    async staking() {
      /*
       * Reads the live USDC supply rate on Aave v3 (Base). No live rate means no rate — quoting
       * the design's 12.6% would be advertising a yield nobody verified.
       *
       * And a rate that could not be READ is an error, not an absence. This swallowed every failure
       * into `null`, so /rates answered a timeout with "No lending pool here" — a claim about the
       * chain made from a request that never came back. The executor answers a slow pool with a 503
       * and a sentence, and that sentence is what the screen now shows, with a retry.
       */
      return api.get<{
        symbol: string;
        estimatedApy: number;
        feed: 'live';
        note: string;
        availableHere?: boolean;
      }>('/yield/supply');
    },
  },

  alerts: {
    async list(): Promise<Alert[]> {
      /*
       * The user's own alerts, persisted. Nothing else.
       *
       * A thrown request is an outage and the screen already knows how to say so — that part was
       * right. What was wrong was the other half: an empty list fell through to a "starting
       * catalogue" of fixtures, defended in the old comment here as product config rather than a
       * stand-in for saved state. It was not either.
       *
       *   - It listed `NVDAx earnings` and `SOL above $95`. This app's tokenized Nvidia is
       *     `NVDAc`; `NVDAx` is the design prototype's spelling, which `fixtures/markets.ts` warns
       *     about in its own header. SOL is not settleable on Base at all. So the catalogue
       *     offered to watch two things that do not exist here.
       *   - The header counted them: "2 of 5 on", stated about alerts nobody had set.
       *   - The switches were live. Toggling one called `setEnabled` with a fixture id the server
       *     has never seen, and `setEnabled` swallows its own failure — so the row flipped, the
       *     store remembered it, and nothing was ever armed. A user could leave that screen
       *     believing they had an alert on their position.
       *
       * A new user has no alerts. The screen says so and offers the button that makes one.
       */
      return api.get<Alert[]>('/alerts');
    },
    async create(input: {
      kind: 'price' | 'agent' | 'risk';
      symbol?: string;
      name: string;
      detail?: string;
      config?: Record<string, unknown>;
    }): Promise<Alert> {
      return api.post<Alert>('/alerts', input);
    },
    async setEnabled(id, enabled) {
      /*
       * A save that did not happen reaches the screen that asked for it.
       *
       * This was `.catch(() => undefined)`, so a refused or unreachable write resolved exactly like
       * a saved one: the switch on `/alerts` stayed where the user left it, and the executor went on
       * evaluating the alert in its old state. `/alerts` now puts the switch back and says why.
       */
      await api.post(`/alerts/${id}`, { enabled });
    },
  },

  wallet: {
    async current(): Promise<Wallet | null> {
      /*
       * `null` only when the server says so. A failed read THROWS.
       *
       * This swallowed every error into `null`, which is the same value the server returns for "no
       * wallet" — so a moment's network trouble was indistinguishable from not having an account.
       * The entry gate redirects to onboarding on a null wallet, so that ambiguity could bounce a
       * signed-in user out of their own session to recover from a blip.
       */
      return await api.get<Wallet | null>('/wallet');
    },
    async all(): Promise<AccountWallet[]> {
      return api.get<AccountWallet[]>('/wallets');
    },
    async createEmbedded(): Promise<Wallet> {
      return api.post<Wallet>('/wallet/create', {});
    },
    async connect(address) {
      return api.post<Wallet>('/wallet/connect', { address });
    },
    /**
     * The permission itself. A failure THROWS; only "there is no grant" returns null.
     *
     * This swallowed every error into `null`, which made "the executor did not answer" and "this
     * wallet has granted nothing" the same value — and `/safety` reads exactly this to decide
     * between them. With the executor unreachable and a live $1,600/day grant on chain, the
     * screen announced **NOT GRANTED · "No permission has been granted, so nothing can trade."**
     *
     * The screen was given a fifth state for this, and it could never reach it: the error had
     * already been destroyed one layer down. So the distinction is restored where it is made.
     *
     * `NotSignedIn` still returns null, because a signed-out visitor genuinely has no permission —
     * an answer rather than a failure to get one — and the route itself returns null before a
     * grant exists, which is the other legitimate null.
     */
    async delegation(): Promise<Delegation | null> {
      return absentOrThrow(() => api.get<Delegation | null>('/delegation'));
    },
    async privyPolicy(): Promise<PrivyPolicyView | null> {
      /*
       * A failed read THROWS. The executor answers a policy or an error, never null.
       *
       * This swallowed every failure into `null`, on the reasoning that a second opinion about
       * safety should not stop a screen rendering. No screen stopped — each one lost the row
       * instead: Safety's "Wallet policy" disappeared when the read failed, and `/policy` showed a
       * header over nothing, its error state unreachable. A lock nobody could read now says so,
       * on every screen that shows it, beside the locks that could be read.
       */
      return api.get<PrivyPolicyView>('/privy/policy');
    },
  },
};
