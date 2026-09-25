/**
 * Screenshot every route at the design's canvas size.
 *
 * Uses Playwright's Chromium against the running Expo web build with a real Privy session, so the
 * shots show the app as a signed-in user sees it — not the logged-out shell, which is what a naive
 * capture would produce for every authenticated screen.
 *
 * Run:  node tools/shoot.mjs
 */
import { chromium } from 'playwright';
import { execFileSync } from 'node:child_process';
import { Buffer } from 'node:buffer';
import fs from 'node:fs/promises';
import path from 'node:path';

/*
 * The credentials, loaded the way the vitest configs and `demo.mjs` load them.
 *
 * This sweep signs in with `PRIVY_APP_ID`/`PRIVY_APP_SECRET` and asserts its own preconditions,
 * printing "SIGN-IN FAILED … screens will be signed out" when it cannot. That message is only
 * useful if the variables were ever going to be there: a plain node script reads no `.env`, so
 * running it the way the README documents shot every authenticated screen in its signed-out state
 * and said so in one line above a wall of passing output.
 */
try {
  process.loadEnvFile(new URL('../.env', import.meta.url));
} catch {
  // No `.env` is legitimate; the sign-in check below reports what it could not do.
}

const BASE = process.env.APP_URL ?? 'http://localhost:8082';
const API = process.env.EXPO_PUBLIC_API_URL ?? 'http://localhost:8788';
const OUT = path.resolve(import.meta.dirname, '../docs/screens');
// design.md: the canvas is 402 x 874.
const VIEWPORT = { width: 402, height: 874 };

/** route -> file stem. Ordered the way the README groups them. */
const ROUTES = [
  ['01-welcome', '/welcome'],
  ['02-goals', '/goals'],
  ['03-wallet', '/wallet'],
  ['04-fund', '/fund'],
  ['05-delegate', '/delegate'],
  ['06-proposal', '/proposal'],
  ['07-home', '/'],
  ['08-markets', '/markets'],
  ['09-markets-crypto', '/markets/crypto'],
  ['10-markets-stocks', '/markets/stocks'],
  ['11-markets-commodities', '/markets/commodities'],
  ['12-markets-indices', '/markets/indices'],
  ['13-markets-preipo', '/markets/preipo'],
  ['14-watchlist', '/watchlist'],
  ['15-search', '/search'],
  ['16-asset', '/asset/BTC'],
  ['17-asset-stock', '/asset/NVDAx'],
  ['18-chart', '/chart/BTC'],
  ['19-order', '/order/XBTC'],
  ['20-order-stock', '/order/NVDAx'],
  ['21-swap', '/swap'],
  ['22-perp', '/perp/BTC'],
  // The signed-in account's own open position, read at runtime (`resolveIds`), so these two are shot loaded. A
  // hardcoded id belonged to another database and shot both as not-found. QA_POSITION_ID still overrides.
  ['23-position', 'POSITION:/position/{id}'],
  ['24-auto-close', 'POSITION:/auto-close/{id}'],
  ['25-bot', '/bot'],
  ['26-bot-roster', '/bot/roster'],
  ['27-bot-leaderboard', '/bot/leaderboard'],
  // Filled in at runtime from the signed-in account's own roster — see `resolveIds`. Agents are
  // per-wallet rows, so a hardcoded id belongs to somebody else and these screens were being shot
  // in their not-found state.
  ['28-bot-intro', 'AGENT:/bot/{id}/intro'],
  ['29-bot-settings', 'AGENT:/bot/{id}/settings'],
  ['30-bot-backtest', 'AGENT:/bot/{id}/backtest'],
  ['31-strategies', '/strategies'],
  ['32-strategy-dca', '/strategy/dca'],
  ['32b-strategy-yield', '/strategy/yield'],
  ['32c-strategy-grid', '/strategy/grid'],
  ['32d-yield-position', '/yield'],
  ['32e-flatten', '/flatten'],
  ['32f-judge', '/judge'],
  ['33-holdings', '/holdings'],
  ['34-activity', '/activity'],
  ['35-history', '/history'],
  ['36-briefing', '/briefing'],
  ['37-inbox', '/inbox'],
  ['38-safety', '/safety'],
  ['39-settings', '/settings'],
  ['40-alerts', '/alerts'],
  ['41-alerts-new', '/alerts/new'],
  ['42-allowlist', '/allowlist'],
  ['43-send', '/send'],
  ['44-recovery', '/recovery'],
  ['45-legal', '/legal/terms'],
  // `/_dev/components` was never a route — the design harness lives at `/_dev/ui`, and
  // `/_dev/ui-edge` was not swept at all, so the one screen whose whole job is to render every
  // edge case was the one screen nothing checked.
  /*
   * Everything below was reachable and never asserted.
   *
   * The list above covered 49 paths of 98 route files, so half the app was verified only as
   * "rendered without erroring" — which is how `/verify` came to report "0 Failed" by never asking
   * about the wallet it had, and passed every sweep while doing it. These are the rest.
   */
  ['50-explore', '/explore'],
  ['51-limits', '/limits'],
  ['52-balance', '/balance'],
  ['53-delegation', '/delegation'],
  ['54-approvals', '/approvals'],
  ['55-verify', '/verify'],
  ['56-metrics', '/metrics'],
  /*
   * The strategy book. Three routes because the interesting cases are not the happy one: a strategy with a
   * full report, and one that took no trades at all — which is where a screen is tempted to draw a zero.
   */
  ['57-playbook', '/playbook'],
  ['58-playbook-report', '/playbook/b200_sess_8'],
  /*
   * Untraded by the gauntlet AND by the book's replay. It was `adaptive_p99_momentum_perp` — which turned out to be
   * one of the 44 perp strategies the export replayed to zero only because it never loaded the universe; it has 394
   * unseen trades.
   */
  ['59-playbook-untraded', '/playbook/b100_mtf_1'],
  ['57-system', '/system'],
  ['58-network', '/network'],
  ['59-rates', '/rates'],
  ['63-audit-chain', '/audit/chain'],
  ['64-runs', '/runs'],
  ['65-proposals', '/proposals'],
  ['66-pnl', '/pnl'],
  ['67-disposals', '/disposals'],
  ['69-schedule', '/schedule'],
  ['70-allocation', '/allocation'],
  ['71-sources', '/sources'],
  ['72-sponsors', '/sponsors'],
  ['73-venues', '/venues'],
  ['74-tokens', '/tokens'],
  ['75-coverage', '/coverage'],
  ['76-movers', '/movers'],
  ['77-stocks', '/stocks'],
  ['78-earnings', '/earnings'],
  ['79-funding', '/funding'],
  ['80-compare', '/compare'],
  ['81-roster-compare', '/roster-compare'],
  ['82-risk', '/risk'],
  ['83-policy', '/policy'],
  ['84-profile', '/profile'],
  ['85-notifications', '/notifications'],
  ['86-catchup', '/catchup'],
  ['87-export', '/export'],
  ['89-backtest', '/backtest'],
  ['90-sell-everything', '/sell-everything'],
  ['91-voice', '/voice'],
  ['92-not-found', '/no-such-screen-exists'],
  ['93-oracle-equity', '/oracle/NVDAx'],
  ['94-crosscheck', '/crosscheck/BTC'],
  ['95-route', '/route/XBTC'],
  ['96-audit-anchor', '/audit/anchor'],
  ['97-portfolio', '/portfolio'],
  // An agent whose kind can be set up by hand (exit rules); momentum and events run inside the hired agent itself.
  ['98-agent', '/agent/drawdown-guard'],
  // Money and markets screens the sweep never opened (docs/qa/SCREENS.md, "tools/shoot.mjs drift").
  ['99a-deposit', '/deposit'],
  ['99b-withdraw-everything', '/withdraw-everything'],
  ['99e-futures', '/futures'],
  ['46-dev-ui', '/_dev/ui'],
  ['46b-dev-ui-edge', '/_dev/ui-edge'],
  ['47-dev-fidelity', '/_dev/fidelity'],
  ['48-dev-boom', '/_dev/boom'],
];


/**
 * What each screen has to actually SAY, from docs/QA-PLAN.md section A.
 *
 * The sweep used to check only the console and the network, which is why `/markets` rendering
 * "0 shown" with no rows passed for weeks: a screen can be completely broken and completely
 * silent. `must` is text that has to appear; `never` is text that must not.
 *
 * These are deliberately about MEANING rather than layout — a price being present, a tag being
 * applied, an empty state offering a next step. Asserting pixel copy would break on every wording
 * change and teach whoever hits it to delete the assertion.
 */
const EXPECT = {
  // The Terms and the Privacy Policy are links now, inside the same sentence.
  '01-welcome': { must: [/XORR/, /Get started/, /Terms/, /Privacy Policy/], never: [/Total value/i] },
  // The drawdown caption claimed a position-size cap that nothing applies. It must not come back.
  '02-goals': {
    must: [/optimise for/i, /Grow long term/, /Steady/, /Balanced/, /Aggressive/, /selected/],
    never: [/caps single-position size/],
  },
  // "Network ready" was ticked with nothing checked; the third step is the executor registering the wallet.
  '03-wallet': { must: [/Your wallet, your keys/, /Signed in/, /Wallet created/, /Connected/], never: [/Network ready/] },
  /*
   * The address and the network, and nothing invented around them: the presets, the payment methods, the
   * "Free" fee and the arrival date affected nothing and are gone. What may be sent is named with the chain it goes
   * on — "Send USDC or USDT0 to your address on X Layer …" — and no other network is.
   */
  '04-fund': {
    must: [/Fund the wallet/, /SEND USDC( OR USDT0)? TO/i, /0x[0-9a-fA-F]{40}/, /on X Layer/],
    never: [/USDT or SOL/, /on Base/, /^Deposit \$/m, /HOW YOU ARE PAYING/, /Transfer from an exchange/],
  },
  '05-delegate': { must: [/It can place trades/, /cannot move your money out/, /expires on its own/, /\$[\d,]+/] },
  // The button says what it does. "Approve & fund" funded nothing, and "Portfolio approved" was a flag on the phone.
  '06-proposal': {
    must: [/draft portfolio/, /100%/, /Stable yield/, /Start rebalancing|Start watching|Balance to 100% first|Continue/],
    never: [/Staked SOL/, /Approve & fund/, /Portfolio approved/],
  },
  // One balance on top, the Privy wallet above it, agents and gainers below (2026-09-12). The old
  // breakdown moved to the portfolio, so it must not creep back onto Home.
  '07-home': {
    must: [/TOTAL BALANCE/, /\$[\d,]+\.\d\d/, /0x[0-9a-f]{4}|Wallet/i, /Agents/, /Gainers/],
    never: [/Available to trade/, /Ready to trade/, /Your coins/],
  },
  '08-markets': { must: [/Crypto/, /Stocks/, /Commodities/, /\d+ shown/], never: [/^0 shown/m] },
  '09-markets-crypto': { must: [/\$[\d,]+/, /markets/] },
  '10-markets-stocks': { must: [/\$[\d,]+/] },
  // Unpriced rows stay quiet now (a dash, no NO PRICE FEED tag); the count says how many of the class are shown.
  '11-markets-commodities': { must: [/9 of 9/], never: [/SIMULATED/, /\$164\.20|\$121\.55|\$402\.70|\$3,412\.10|\$598\.14|\$38\.71|\$521\.77/] },
  '12-markets-indices': { must: [/of \d+ markets/], never: [/SIMULATED/, /\$164\.20|\$121\.55|\$402\.70|\$3,412\.10|\$598\.14|\$38\.71|\$521\.77/] },
  '13-markets-preipo': { must: [/of \d+ markets/], never: [/SIMULATED/, /\$164\.20|\$121\.55|\$402\.70|\$3,412\.10|\$598\.14|\$38\.71|\$521\.77/] },
  '14-watchlist': { must: [/\$[\d,]+/] },
  '15-search': { must: [/Search/i] },
  // The asset screen headlines the instrument's NAME, not its ticker — "Bitcoin", not "BTC".
  // Trimmed 2026-09-12: no "Your position: None" row and no agent note on a coin nobody holds.
  '16-asset': { must: [/Bitcoin|BTC/, /\$[\d,]+/], never: [/No agent holds this yet/] },
  // A wrapped xStock is charted from the prices this deployment recorded (`/market/stocks/history`), so it has a
  // price AND a chart, and the change names the window those readings actually cover rather than the pill's.
  '17-asset-stock': {
    must: [/Nvidia|NVDA/, /\$[\d,]+/, /1D/, /1W/, /(flat|up|down) .*since|today|past (week|month|year)/],
    never: [/No chart yet/],
  },
  // The pills are the candle lengths the feed can cut (`CHART_PLAN`): 15m is gone, 4H is new.
  '18-chart': { must: [/\$[\d,]+/, /1H/, /4H/, /1D/], never: [/15m/] },
  '19-order': { must: [/XBTC|Bitcoin|BTC/] },
  '20-order-stock': { must: [/NVDA/] },
  '21-swap': { must: [/Swap|swap/] },
  '22-perp': { must: [/BTC/] },
  '23-position': { must: [/Entry|entry|position/i] },
  '24-auto-close': { must: [/Take profit|Stop|stop/i] },
  /*
   * The agent's status line, not a fixed string.
   *
   * This asserted /Watching/ — which passed because the screen hardcoded "Watching 14 markets"
   * whenever there was no proposal: a number nothing had counted, in profit-green, under an
   * agent's name. The assertion was pinning the bug in place. What has to be true is that the
   * line says something about the agent's actual state.
   */
  /*
   * The old pattern listed four sentences the screen never says. What makes `/bot` correct is
   * that the agent answered TODAY — a proposal or a decline, either is the product — so this
   * asserts the persona and a message under today's divider instead of guessing the wording.
   */
  // The Messages inbox: every agent with its latest line. "Today" was the chat's greeting, which this screen no longer
  // opens on. TSLAx is quoted and filled here, so an agent saying it has no market for it is a defect (propose.ts).
  '25-bot': {
    must: [/Momentum Scout/, /Earnings Desk/, /Yield Keeper/, /Drawdown Guard/],
    never: [/No live market for (TSLAx|NVDAx|AAPLx|SPYx|QQQx)/],
  },
  '26-bot-roster': { must: [/Momentum Scout/] },
  '27-bot-leaderboard': { must: [/Momentum Scout|Leaderboard|leaderboard/] },
  // Whichever agent the id names — and never a different one silently substituted.
  '28-bot-intro': { must: [/Momentum Scout|Earnings Desk|Drawdown Guard/], never: [/No such agent/] },
  '29-bot-settings': { must: [/cap|Cap|limit/] },
  '30-bot-backtest': { must: [/Nothing here is a promise|promise/] },
  '31-strategies': { must: [/Strategies/, /Running/, /Add new/] },
  '32-strategy-dca': { must: [/Recurring buy/, /Next three runs/i] },
  // Venue names left the money screens (2026-09-14): the sweep asserts the rate, the preview and who can withdraw.
  // Tier 4 earns on USD₮0 on X Layer's Aave v3, with USDC's rate beside it.
  '32b-strategy-yield': { must: [/(USDT0|USDC) SUPPLY/i, /%/, /If it ran now/i, /Only you can withdraw/] },
  '32c-strategy-grid': { must: [/Range accumulation/, /\$[\d,]+/, /leaves the range it stops/] },
  '32d-yield-position': { must: [/Earning/, /Only you can withdraw|No lending pool here/] },
  // "Doesn’t use your daily cap" since the money screens were distilled; either spelling of the same fact passes.
  '32e-flatten': { must: [/Sell everything/, /(does not|doesn’t|doesn't) use your daily cap/i] },
  /*
   * `never: [/FAIL/]` was wrong, and it was wrong in the direction that matters.
   *
   * This wallet's trail forks at entry 2 — two writers claimed one predecessor before `append`
   * took a per-wallet lock. That is real, it is reported, and it is PERMANENT: the trail is
   * append-only by trigger, so it cannot be rewritten to look clean, which is the whole reason
   * anyone should believe it. Asserting the page never says FAIL asks the console to hide a true
   * result, and a console that goes quiet when something is broken is worth nothing.
   *
   * So the assertion is about the claim that would actually be damning: no row has been ALTERED.
   * A fork is visible damage from a fixed bug; an edited record is the thing this whole structure
   * exists to detect, and that one must never appear.
   */
  '32f-judge': { must: [/Check it yourself/, /\d+\/\d+/, /PASS/], never: [/has been altered/] },
  /*
   * "Target mix", not "Allocation". The word was changed deliberately: these are the weights the
   * user asked the bot to AIM for, sitting above the real holdings list, and calling them an
   * allocation made a wallet holding no equities display "Tokenized equities 30%" as though it
   * did. This expectation pinned the wording that was wrong.
   */
  '33-holdings': { must: [/PORTFOLIO VALUE/, /Target mix/i, /0x[0-9a-fA-F]{40}/] },
  '34-activity': { must: [/Activity/, /Export audit trail/, /Disposals/] },
  '35-history': { must: [/History|settled|spend/i] },
  '36-briefing': { must: [/Briefing|briefing/] },
  '37-inbox': { must: [/Inbox|inbox|catch up/i] },
  /*
   * A state the chain gave, the two parties as short addresses, and the way out. Never the footnote that
   * said stop-losses survive a stop (a revoked policy refuses `closePosition`), and never "1 agents".
   */
  '38-safety': {
    must: [
      /Trading is live|Trading is stopped|Your permission has ended|Nothing can trade/,
      /Your wallet/,
      /Agent key/,
      /0x[0-9a-fA-F]{4}…[0-9a-fA-F]{4}/,
      /Sell everything to cash/,
    ],
    never: [/Positions and stop-losses stay/, /\b1 agents\b/, /\b1 strategies\b/],
  },
  // The row is named for where it goes: "Alerts" opens /alerts.
  '39-settings': { must: [/Settings/, /Alerts/] },
  '40-alerts': { must: [/Alerts/, /What the bot tells you/, /circuit breakers/i], never: [/turns itself off/] },
  /*
   * Not the kind selector — it is gone.
   *
   * This asserted /Price|Agent|Risk/, which passed because the screen offered three kinds and
   * built only one of them: choosing Agent or Risk changed nothing on screen and POSTed an alert
   * the executor could not evaluate. The assertion was holding the broken control in place. What
   * has to be true is that the screen collects a symbol and a level.
   */
  '41-alerts-new': { must: [/New alert/, /SYMBOL/, /ABOVE/] },
  // Either real 0x destinations the user added, or an honest empty state. Never the invented
  // base58 pair the handoff seeded, which were not even addresses on this chain.
  '42-allowlist': { must: [/Allowlist/], never: [/[13-9A-HJ-NP-Za-km-z]{40,}/] },
  // The allowlist is reached through "Manage"; the word itself is no longer on the screen.
  '43-send': { must: [/Send/, /Manage/] },
  // Reading this screen marks nothing done; the step is the export, or saying you can open the email.
  '44-recovery': { must: [/Recovery/, /Your email is the way back/], never: [/Got it/] },
  '45-legal': { must: [/Terms|terms/] },
  /*
   * The `_dev/*` screens are development-only, and `_dev/_layout.tsx` sends them home on a build
   * that is not a dev build. Shot against the DEPLOYED app they therefore render the wallet, and
   * demanding their dev content reported four failures for the router doing exactly its job.
   *
   * So each accepts either: its own content on a dev target, or the wallet screen, which is proof
   * the redirect held. What is NOT accepted is the dev screen appearing in a production build —
   * that would be the real defect, and it would fail the first alternative's absence.
   */
  /*
   * The previously unasserted half. Each one names the thing that would be WRONG if the screen
   * silently degraded — a number missing, a provenance label dropped, an empty state replaced by a
   * confident zero.
   */
  // The screens that worked and had no way in are rows now.
  '50-explore': { must: [/Explore/, /MARKETS/, /Safety|Permission/, /Check it yourself/, /Leaderboard/, /Briefing/] },
  // The cap and the spend must both be money, not a bare 0 — see the $0-with-no-reason bug.
  '51-limits': { must: [/REMAINING TODAY/, /\$[\d,]+\.\d\d/, /cap/] },
  '52-balance': { must: [/TOTAL/, /\$[\d,]+\.\d\d/, /Cash/] },
  '53-delegation': { must: [/STATE/, /Daily cap/, /0x[0-9a-fA-F]{4}/] },
  // "read from the chain rather than from our record of it" is the claim this screen exists for.
  '54-approvals': { must: [/Approvals/, /read from the chain/i, /USDC/] },
  /*
   * A verification console that reports zero failures because it never asked is worse than one
   * that reports a failure. It asks about the signed-in wallet now, so a Failed count must appear
   * and the not-asked count must not be the majority.
   */
  '55-verify': { must: [/Passed/, /Failed/, /Not asked/, /\d+ Passed/] },
  '56-metrics': { must: [/RUNS BY OUTCOME|STRATEGIES BY STATE/, /\d+/] },
  // The book is public: these must render for a signed-out visitor, which is what a judge is.
  '57-playbook': { must: [/\d+ rules measured/, /Showing \d+ of \d+/, /passed all four/] },
  '58-playbook-report': { must: [/RETURN ON UNSEEN DATA/, /WINS AND LOSSES/, /WHAT IT WAS PUT THROUGH/, /TRADES/] },
  /*
   * The one that has to say nothing rather than zero. `+0.00%` here was a measured-looking flat result for a
   * strategy that never opened a position, and 99 of the 313 were drawing it.
   */
  '59-playbook-untraded': {
    must: [/It took no trades on the unseen half/, /—/],
    never: [/\+0\.00%/, /UNDER 30 TRADES/],
  },
  // A dependency's timestamp is an age now; the raw ISO stamp from the database probe must not be back.
  '57-system': {
    must: [/EXECUTOR/, /xlayer-fork|xlayer-testnet|xlayer|localnet/, /postgres/],
    never: [/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/],
  },
  // The chain named as X Layer (mainnet, testnet or a fork of it), and the bot's gas stated in OKB, never ETH.
  '58-network': { must: [/CHAIN/, /BLOCK/, /[\d,]{6,}/, /X Layer/, /OKB/], never: [/\bBase\b/, /\d ETH\b/] },
  /*
   * The rate and its caveat. Where it comes from is named on Sources and How it works; the screen itself stopped naming
   * the pool when the money screens were distilled, and asserting the name here failed a correct screen.
   */
  // The rate is paid on USDT0, which is what idle USDC is swapped into (PLAN.md D15). This said "USDC SUPPLY RATE".
  '59-rates': { must: [/Rate/, /\d+\.\d+%/, /not a promise/, /USDT0 SUPPLY RATE/i], never: [/USDC SUPPLY RATE/i] },
  // A forked chain must say so rather than render as healthy.
  '63-audit-chain': { must: [/HASH CHAIN/, /Entry|Forked|unbroken/i] },
  '64-runs': { must: [/Runs/, /All/] },
  '65-proposals': { must: [/Proposals/, /All/] },
  '66-pnl': { must: [/Realised/] },
  '67-disposals': { must: [/Disposals/] },
  '69-schedule': { must: [/runs next|scheduled/i] },
  '70-allocation': { must: [/Allocation/] },
  // Our own database is a source, and the futures venue is named; "None of them are us" was false.
  '71-sources': { must: [/Sources/, /every number/i, /Hyperliquid/, /database/], never: [/None of them are us/] },
  // Only what the code uses: X Layer is the chain, Uniswap v3 settles, OKX DEX competes, Aave v3 holds idle cash, the
  // xStocks are Backed's, Privy holds the keys. Nothing from the Base build may be named.
  '72-sponsors': {
    must: [/How it works/, /X Layer/, /Uniswap v3/, /OKX DEX/, /Aave v3/, /xStocks/, /Privy/],
    never: [/1inch/i, /Basename/i, /The Graph/i, /Coinbase/i],
  },
  // The venues the grant allows, read from the contract, not the executor's current parameters.
  '73-venues': { must: [/Venues/, /trade can fill/i] },
  '74-tokens': { must: [/Tokens/, /traded/i] },
  '75-coverage': { must: [/Coverage/, /PRICED/i] },
  // Real feeds unlabelled, synthetic ones labelled — the whole point of this screen.
  /*
   * A ranking of moves can only contain instruments that moved. It used to REQUIRE the SIMULATED
   * tag — i.e. it asserted that invented moves were in the list. They must now never be.
   */
  '76-movers': { must: [/Movers/, /UP|DOWN/], never: [/SIMULATED/, /NO PRICE FEED/, /\$164\.20|\$121\.55|\$402\.70|\$3,412\.10|\$598\.14|\$38\.71|\$521\.77/] },
  // The screen is titled Stocks, as its Explore row is.
  '77-stocks': { must: [/Stocks/, /\$[\d,]+/] },
  '78-earnings': { must: [/Earnings/, /EDGAR/i] },
  '79-funding': { must: [/Funding/] },
  '80-compare': { must: [/Compare/] },
  '81-roster-compare': { must: [/Compare agents/i] },
  '82-risk': { must: [/Risk limits/i] },
  // Privy holds the key; the app must not claim it attached the policy itself.
  '83-policy': { must: [/PRIVY POLICY/i], never: [/we attached/i] },
  // Who you are and where things live — the counts and the activity feed moved behind their rows.
  '84-profile': {
    // The wallet's kind in plain words: no vendor and no network on a main sheet.
    must: [/0x[0-9A-Fa-f]{4}/, /Wallet made with your email|Connected wallet/, /Activity/, /Permissions/, /Approvals/, /Settings/],
    never: [/Risk checks/, /Recent activity/, /Privy/],
  },
  // Where the balance goes: what the chain holds, what the book bought, and what it made.
  '97-portfolio': { must: [/TOTAL BALANCE/, /Deposit/, /Withdraw/, /Positions/, /Profit/] },
  // One agent: money in and out, what it runs, and a way to add to it — without the long caveats.
  '98-agent': {
    must: [/Drawdown Guard/, /Add funds/, /Withdraw/, /Strategies/, /Add strategy/],
    never: [/Past performance of a strategy/, /runs are recorded against strategies/],
  },
  /*
   * The five routes the sweep never opened. Each asserts its title and the one line that must stay true, not the copy
   * around it: the address and balance on Deposit (and no raw locale timestamp for the faucet), the division of labour
   * on Withdraw everything, and the disclaimers on the quote-only and data-only screens.
   */
  // The balance card lists USDC, USDT0 where the chain has it, and OKB for gas; the copy names X Layer and OKB.
  '99a-deposit': {
    must: [/Deposit/, /0x[0-9a-fA-F]{40}/, /BALANCE/, /USDC/, /OKB/, /X Layer/],
    never: [/Available again \d{1,2}\/\d{1,2}\/\d{4}/, /\bBase\b/, /\bETH\b/],
  },
  '99b-withdraw-everything': { must: [/Withdraw everything/, /Only you can send/] },
  '99e-futures': { must: [/Futures/, /xorr does not trade futures/] },
  '85-notifications': { must: [/Notifications/] },
  '86-catchup': { must: [/Since you (looked|were)/i] },
  '87-export': { must: [/Export/, /audit trail/i] },
  '89-backtest': { must: [/Backtest/, /real past prices/i] },
  '90-sell-everything': { must: [/would sell|preview/i] },
  '91-voice': { must: [/Voice/] },
  /*
   * The app's own 404, not expo-router's development fallback. `Sitemap` appearing here means the
   * dev screen is back, and the URL being echoed means the reflection is back.
   */
  '92-not-found': { must: [/There is nothing here/], never: [/Unmatched Route/, /Sitemap/] },
  // No oracle for a crypto symbol is a real answer; a retry on it is not.
  '93-oracle-equity': { must: [/NVDAx/, /recorded/i] },
  '94-crosscheck': { must: [/CROSS-CHECK/i, /agree|differ/i] },
  '95-route': { must: [/Route/, /USDC/, /SAME SIZE, EVERY WAY TO FILL/] },
  /*
   * The anchor screen's whole claim is that the reader can repeat the read without us, so it must
   * show a state, the head the chain holds, and the two addresses that reproduce it.
   */
  '96-audit-anchor': {
    must: [/On-chain anchor/, /COMMITTED|DIVERGED|NOT YET ANCHORED/, /CHECK IT YOURSELF/, /0x[0-9a-fA-F]{40}/],
    // "The chain", not "Base": a fork build anchors to a fork. The raw status line of a failed anchor must not show.
    never: [/DIVERGED/, /BASE HOLDS/, /to Base\./, /\d{3} [A-Z][a-z]+: \{/],
  },
  '46-dev-ui': { must: [/Design system|TOTAL (VALUE|BALANCE)/] },
  '46b-dev-ui-edge': { must: [/Edge cases|TOTAL (VALUE|BALANCE)/] },
  '47-dev-fidelity': { must: [/Fidelity|fidelity|TOTAL (VALUE|BALANCE)/] },
  '48-dev-boom': { must: [/Break this screen|TOTAL (VALUE|BALANCE)/] },
};

/** Which expectations a screen's text failed. Empty means it said everything it had to. */
function contentFailures(stem, text) {
  const e = EXPECT[stem];
  if (!e) return [`no expectation defined for ${stem} — every route needs one`];
  /*
   * Matched against the text as rendered AND with whitespace collapsed, because element
   * boundaries are not content.
   *
   * `/verify` renders its tally as two elements — the number, then the label — so `innerText`
   * gives "18\nPassed", and `/\d+ Passed/` failed against a screen that was correct and had been
   * for the whole run. Nothing a reader sees distinguishes that newline from a space.
   *
   * Both forms, not just the flattened one: two `never` patterns anchor with `/m` (`/^0 shown/m`),
   * and on a single collapsed line `^` only matches at position zero — flattening alone would
   * quietly weaken them. So a `must` passes if EITHER form matches, and a `never` fails if either
   * does. Each assertion gets the reading that makes it strictest.
   */
  const flat = text.replace(/\s+/g, ' ');
  const out = [];
  for (const re of e.must ?? []) {
    if (!re.test(text) && !re.test(flat)) out.push(`missing ${re}`);
  }
  for (const re of e.never ?? []) {
    if (re.test(text) || re.test(flat)) out.push(`must not contain ${re}`);
  }
  return out;
}

/**
 * Sign in for real, so the authenticated screens show what a user sees.
 *
 * Privy's own test-credentials endpoint provisions a throwaway account with a known OTP. That is
 * Privy's supported path for exactly this, so the session below is a genuine one — the same
 * verifyAuthToken runs against it as in production. Nothing about auth is bypassed.
 */
const signIn = async (page) => {
  const appId = process.env.PRIVY_APP_ID;
  const secret = process.env.PRIVY_APP_SECRET;
  if (!appId || !secret) {
    console.log('PRIVY_APP_ID/SECRET not set — authenticated screens will show the signed-out state');
    return false;
  }

  const auth = {
    authorization: `Basic ${Buffer.from(`${appId}:${secret}`).toString('base64')}`,
    'privy-app-id': appId,
    'content-type': 'application/json',
  };

  /*
   * Reuse a test account rather than minting one every run.
   *
   * Privy caps an app at twenty test accounts, and creating one per sweep hit that ceiling — after
   * which every run signed in as nobody and shot fifty-three screens in their signed-out state
   * while reporting them as content failures. A sweep that consumes a finite quota to run is a
   * sweep that stops working.
   *
   * Reusing one is also better than a fresh account: it accumulates a wallet, a permission,
   * positions and history, so the screens are exercised loaded rather than empty. The preferred
   * account is the one the executor's own end-to-end tooling uses, so both look at the same wallet.
   */
  const listed = await fetch(`https://auth.privy.io/api/v1/apps/${appId}/test_credentials`, {
    headers: auth,
  });
  const existing = listed.ok ? ((await listed.json()).data ?? []) : [];
  const preferred = process.env.E2E_PRIVY_EMAIL ?? 'test-8958@privy.io';
  let account = existing.find((a) => a.email === preferred) ?? existing[0];

  if (!account) {
    const made = await fetch(`https://auth.privy.io/api/v1/apps/${appId}/test_credentials`, {
      method: 'POST',
      headers: auth,
      body: '{}',
    });
    if (!made.ok) {
      console.log(`could not provision a test account (${made.status}) — screens will show signed out`);
      return false;
    }
    account = await made.json();
  }
  const { email, otp_code: otp } = account;

  await page.goto(BASE + '/wallet', { waitUntil: 'networkidle' });
  await page.fill('input[type=email]', email);
  await page.getByText(/email me a code/i).first().click();
  await page.waitForSelector('input[placeholder*="6-digit"]', { timeout: 30_000 });
  await page.fill('input[placeholder*="6-digit"]', otp);
  await page.getByText(/verify and create/i).first().click();
  // The embedded wallet is created during this step; it is not instant.
  await page.waitForTimeout(15_000);

  /*
   * Check that it worked, rather than announcing that it did.
   *
   * This printed "signed in as …" unconditionally, so a failed sign-in was reported as a success
   * and fifty-three screens were then shot in their signed-out state and blamed for it. A harness
   * that asserts its own preconditions is the only kind whose failures mean anything.
   */
  const token = await page.evaluate(() => {
    try {
      return localStorage.getItem('privy:token');
    } catch {
      return null;
    }
  });
  if (!token) {
    console.log(`SIGN-IN FAILED for ${email} — no Privy token in storage. Screens will be signed out.`);
    return false;
  }
  console.log(`signed in as ${email}`);
  return true;
};

/**
 * Resolve the ids this account actually owns.
 *
 * Agents and positions are per-wallet rows, so a literal id in the route table belongs to whoever
 * happened to be signed in when it was written. The sweep signs in as a fresh account every run,
 * so it asks that account what it has — the same way a user gets there, by tapping a row.
 */
const resolveIds = async () => {
  /*
   * Asked of the executor in Node, not of the page.
   *
   * Reading the token out of `localStorage` inside `page.evaluate` throws SecurityError depending
   * on the document's origin at that moment, and the answer does not need the browser anyway —
   * it is the same account either way.
   */
  try {
    const email = process.env.E2E_PRIVY_EMAIL ?? 'test-8958@privy.io';
    const token = execFileSync('npx', ['tsx', 'server/src/e2e-token.ts', email], {
      encoding: 'utf8',
    }).trim();
    const auth = { headers: { authorization: `Bearer ${token}` } };
    const res = await fetch(`${API}/agents`, auth);
    const agents = res.ok ? await res.json() : [];
    const pos = await fetch(`${API}/positions`, auth);
    const positions = pos.ok ? await pos.json() : [];
    return { agentId: agents[0]?.id, positionId: process.env.QA_POSITION_ID ?? positions[0]?.id };
  } catch {
    return { agentId: undefined, positionId: process.env.QA_POSITION_ID };
  }
};

/**
 * Wait for the executor's boot warm before judging anything.
 *
 * `warmMarketCache` pulls every symbol's chart through a 1.1s-spaced queue, so for about a minute
 * after a restart some charts answer 503 while the entry is still being fetched. That is a real
 * state, handled honestly by the app — and it is not the state a user is in, so measuring it tells
 * you nothing about whether the chart works. Waiting makes the sweep repeatable instead of a race.
 */
/**
 * How long a screen may take to finish saying what it has to say, past the first six seconds.
 *
 * Sized on the slowest real screen rather than a round number: `/verify` runs its checks against
 * live chain, price and Aave calls and lands around twenty seconds cold.
 */
const SETTLE_BUDGET_MS = 30_000;

const waitForWarm = async () => {
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    const res = await fetch(`${API}/market/ohlc?symbol=BTC&days=1`).catch(() => undefined);
    if (res?.ok) return true;
    await new Promise((r) => setTimeout(r, 3_000));
  }
  console.log('charts still warming after 120s — shooting anyway, some may show the fetching state');
  return false;
};

/**
 * What a person reads on the screen: the visible text, then every accessible name. `innerText` alone missed the
 * welcome's XORR. wordmark (an image, named by its label) and Home's balance (a RollingNumber, one element per
 * character, named whole by its label) — both on screen, both reported missing.
 */
async function readScreen(page) {
  const text = await page.innerText('body').catch(() => '');
  const names = await page
    .evaluate(() =>
      [...document.querySelectorAll('[aria-label], img[alt]')]
        .map((el) => el.getAttribute('aria-label') ?? el.getAttribute('alt') ?? '')
        .filter(Boolean)
        .join('\n'),
    )
    .catch(() => '');
  return names ? `${text}\n${names}` : text;
}

const main = async () => {
  await fs.mkdir(OUT, { recursive: true });
  await waitForWarm();
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: VIEWPORT, deviceScaleFactor: 2 });
  const page = await ctx.newPage();
  const signedIn = await signIn(page);
  if (!signedIn) {
    // Every authenticated expectation would fail for one reason. Say it once, loudly, and stop.
    console.error('\nAborting: the sweep cannot judge authenticated screens without a session.');
    await browser.close();
    process.exit(1);
  }

  const errors = [];
  const netFail = [];
  /*
   * The two halves have to agree about the warming handshake.
   *
   * The `response` hook below already excuses a 503 — the client retries it and the screen says
   * "Fetching" while it does. But Chrome ALSO writes "Failed to load resource: … 503" to the
   * console for the same response, and that half was counted, so `/asset/BTC` and
   * `/auto-close/:id` failed the sweep for the one thing the sweep had decided was fine. One
   * rule, stated once, applied to both.
   */
  const WARMING = /Failed to load resource.*\b503\b/i;
  page.on('console', (m) => {
    if (m.type() !== 'error') return;
    const text = m.text().slice(0, 160);
    if (!WARMING.test(text)) errors.push(text);
  });
  page.on('pageerror', (e) => errors.push('UNCAUGHT ' + String(e.message).slice(0, 160)));
  page.on('requestfailed', (r) => {
    /*
     * Expo's dev server probes each route with a HEAD it then aborts, so every navigation records
     * one ERR_ABORTED against the app's own URL. Counting those would mark all 47 screens failed
     * for a thing Metro does on purpose — so only genuinely failed requests are recorded, and the
     * filter names exactly what it excuses rather than swallowing all failures.
     */
    const aborted = (r.failure()?.errorText ?? '').includes('ERR_ABORTED');
    const isDevProbe = aborted && r.method() === 'HEAD' && r.url().startsWith(BASE);
    // A coin icon Hyperliquid's own CDN does not carry (kPEPE.svg): third-party decoration, the row keeps its mark.
    const isVenueIcon = /^https:\/\/app\.hyperliquid\.xyz\/coins\//.test(r.url());
    if (!isDevProbe && !isVenueIcon) netFail.push(`FAILED ${r.method()} ${r.url().slice(0, 110)}`);
  });
  page.on('response', (r) => {
    // 503 is the documented warming handshake, not a failure — the client retries it.
    if (r.status() >= 400 && r.status() !== 503 && !/^https:\/\/app\.hyperliquid\.xyz\/coins\//.test(r.url())) netFail.push(`${r.status()} ${r.url().slice(0, 110)}`);
  });

  const { agentId, positionId } = await resolveIds();
  console.log(agentId ? `agent ${agentId}` : 'no agents on this account — agent screens will show not-found');
  console.log(positionId ? `position ${positionId}` : 'no open position on this account — position screens will show not-found');

  const report = [];
  /*
   * `SHOOT_ONLY=67-disposals,33-holdings` re-takes just those screens, by stem or route substring — for re-checking one
   * item without the whole sweep. Unset, every route runs, as it always has.
   */
  const only = (process.env.SHOOT_ONLY ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  const routes = only.length ? ROUTES.filter(([stem, route]) => only.some((o) => stem === o || route.includes(o))) : ROUTES;
  for (const [stem, template] of routes) {
    // `AGENT:` routes are filled in from this account's own roster.
    const route = template.startsWith('AGENT:')
      ? template.slice('AGENT:'.length).replace('{id}', agentId ?? 'none')
      : template.startsWith('POSITION:')
        ? template.slice('POSITION:'.length).replace('{id}', positionId ?? 'none')
        : template;
    errors.length = 0;
    netFail.length = 0;
    await page.goto(BASE + route, { waitUntil: 'networkidle', timeout: 45_000 }).catch(() => {});
    /*
     * Prices and charts settle after the first paint; the design bans entrance animations, so
     * there is nothing to wait out except the data itself.
     *
     * Six seconds, not three and a half. A cold load now has an extra round trip on its critical
     * path — the wallet is fetched from the executor rather than assumed to be in local storage —
     * and three and a half seconds was catching the screens mid-hydration and reporting an empty
     * wallet as a content failure.
     */
    await page.waitForTimeout(6000);
    /*
     * Then WAIT FOR THE CONTENT, rather than asserting once and hoping six seconds was enough.
     *
     * Two screens do real work before they can say anything: `/bot` asks the proposal engine for
     * today's decision, and `/verify` runs twenty live checks against the chain, the price feeds and
     * Aave. Both finish well past six seconds, so the harness was screenshotting them mid-flight
     * and calling a slow screen a broken one — and on `/bot` it read yesterday's message and
     * reported the absence of today's as a defect in the app.
     *
     * Polling the assertion fixes that class of failure everywhere instead of hand-tuning a
     * timeout per screen: a screen that is already settled costs nothing, and a slow one is given
     * until the budget runs out before it is called wrong.
     */
    let full = await readScreen(page);
    for (let waited = 0; waited < SETTLE_BUDGET_MS && contentFailures(stem, full).length; waited += 1000) {
      await page.waitForTimeout(1000);
      full = await readScreen(page);
    }
    await page.screenshot({ path: path.join(OUT, `${stem}.png`) });
    // Privy's own SDK logs two of these from its confirmation modal and balance reader. They are
    // third-party and attributed rather than excused.
    const bad = [...new Set(errors)].filter((e) => !/isActive|balanceOf|styled-components/i.test(e));
    const net = [...new Set(netFail)];
    if (process.env.QA_TRACE) {
      const w = await page
        .evaluate(() => {
          try {
            return JSON.parse(localStorage.getItem('xorr-store') ?? '{}')?.state?.wallet?.address ?? null;
          } catch {
            return 'ERR';
          }
        })
        .catch(() => 'EVAL-FAIL');
      console.log(`   [trace] ${stem} store.wallet=${w}`);
    }
    const content = contentFailures(stem, full);
    const ok = bad.length === 0 && net.length === 0 && content.length === 0;
    report.push({ stem, route, ok, errors: bad, network: net, content, text: full.slice(0, 400) });
    console.log(
      `${ok ? 'PASS' : 'FAIL'} ${stem.padEnd(24)} ${route}` +
        (bad.length ? `\n       console: ${bad[0]}` : '') +
        (net.length ? `\n       network: ${net.join(' | ')}` : '') +
        (content.length ? `\n       content: ${content.join(' | ')}` : ''),
    );
  }
  // A partial run reports beside the full one rather than over it: the full report is the record of the whole sweep.
  await fs.writeFile(path.join(OUT, only.length ? 'qa-report.partial.json' : 'qa-report.json'), JSON.stringify(report, null, 1));

  await browser.close();
  console.log(`\n${ROUTES.length} screens -> docs/screens/`);
};

await main();
