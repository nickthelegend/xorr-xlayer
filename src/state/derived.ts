/**
 * Derived values — state.md "Derived values", implemented verbatim.
 *
 * state.md: "keep the derived-value formulas exactly — they're the app's business logic and
 * several were corrected during review." Every function here is pure and unit-tested against the
 * handoff's own stated outputs in derived.test.ts.
 */
import { MINUS, money, percent, price, quantity, signedMoney } from '../format';
import type { Bar } from '../data/types';
import type { FigureKind } from '../ui/mask';
import { DEFAULT_BUY } from '@/data/tradable';
import type { ChainStanding } from '@/wallet/delegationChain';
import { NotSignedIn } from '@/data/apiError';

// ── Agent controls (screen 4) ────────────────────────────────────────────────

/*
 * `RISK_LEVELS`, `autoNote` and `runLabel` went with the controls they served — a "Risk Level" pill and
 * a "Trade Autonomously" switch that nothing signed, sent or read. See app/bot/[id]/settings.tsx.
 */
export const RUN_FOR = ['1 Day', '3 Days', '7 Days', '30 Days'] as const;
export const CAP_MIN = 50;
export const CAP_MAX = 5000;
export const CAP_STEP = 50;

export function capLabel(cap: number): string {
  return `${money(cap, { fractionDigits: 0 })}/day`;
}

/** Marker position along the $50–$5,000 risk rail, as a 0–100 percentage. */
export function capMarkerPct(cap: number): number {
  return ((cap - CAP_MIN) / (CAP_MAX - CAP_MIN)) * 100;
}

/** "Run For" as a real expiry — the pivot turns this control into the delegation's lifetime. */
export function runForMs(index: number): number {
  const days = [1, 3, 7, 30][index] ?? 1;
  return days * 24 * 60 * 60 * 1000;
}

// ── Auto Close (screen 6) ────────────────────────────────────────────────────

/** state.md: mid = 66000, size = $2500. */
export const AUTOCLOSE_MID = 66000;
export const AUTOCLOSE_SIZE = 2500;

export const TP_MIN = 0.5;
export const TP_MAX = 3.0;
export const SL_MIN = -3.0;
export const SL_MAX = -0.5;
export const TPSL_STEP = 0.5;

export function tpPrice(tp: number, mid = AUTOCLOSE_MID): number {
  return mid * (1 + tp / 100);
}
export function slPrice(sl: number, mid = AUTOCLOSE_MID): number {
  return mid * (1 + sl / 100);
}
export function tpPnl(tp: number, size = AUTOCLOSE_SIZE): number {
  return (size * tp) / 100;
}
export function slPnl(sl: number, size = AUTOCLOSE_SIZE): number {
  return Math.abs((size * sl) / 100);
}

/** state.md ruler marker positions, as percentages. */
export function tpTickPct(tp: number): number {
  return 20 + tp * 22;
}
export function slTickPct(sl: number): number {
  return 80 + sl * 22;
}

// ── Order ticket (screen 14) ─────────────────────────────────────────────────

export const ORDER_MAX_CHARS = 7;

/**
 * How many units a dollar amount buys.
 *
 * `unitPrice` and `symbol` are required on purpose. They used to default to SOL at $88.32 — the
 * prototype's number, three years stale and the wrong chain — which meant a missed prop quoted a
 * fictional price rather than failing.
 */
export function orderUnits(amount: number, unitPrice: number, symbol: string): string {
  return `${(amount / unitPrice).toFixed(4)} ${symbol}`;
}
export function orderFee(amount: number): number {
  return amount * 0.001;
}
export function orderCta(side: 'buy' | 'sell', amountStr: string, symbol = DEFAULT_BUY): string {
  return `${side === 'buy' ? 'Buy' : 'Sell'} $${amountStr} of ${symbol}`;
}

/**
 * The keypad reducer — state.md: "max 7 chars, single '.', '⌫' pops last, leading '0' replaced
 * by a digit."
 *
 * `decimals` caps what can be typed after the point, and exists because two different things are entered on
 * the same keypad. A DOLLAR field stops at the cent: `$12.345` is not a smaller order, it is a typo, and
 * catching it at the keypress means nobody has to be told about it afterwards. A TOKEN field — swap,
 * crosschain — is entered in the token's own units, where eighteen decimals are real, so those pass nothing
 * and keep the only limit they ever had, which is the seven characters.
 *
 * Refusing the keypress rather than correcting the field: silently truncating what someone typed is how an
 * amount ends up different from the one they read back before tapping a green button.
 *
 * An options object and not a third positional number, because `seq.reduce(keypadPress, '0')` is how this is
 * called in more than one place and `reduce` passes the INDEX third — which as a bare `decimals` would have
 * silently capped the field at wherever in the sequence the point happened to fall.
 */
export function keypadPress(current: string, key: string, options?: { decimals?: number }): string {
  if (key === '⌫') {
    const next = current.slice(0, -1);
    return next === '' ? '0' : next;
  }
  if (key === '.') {
    if (current.includes('.')) return current;
    if (current.length >= ORDER_MAX_CHARS) return current;
    return `${current}.`;
  }
  // A leading '0' is replaced, not appended to — otherwise you get "0250".
  if (current === '0') return key;
  if (current.length >= ORDER_MAX_CHARS) return current;
  const dot = current.indexOf('.');
  const decimals = options?.decimals;
  if (decimals !== undefined && dot !== -1 && current.length - dot - 1 >= decimals) return current;
  return `${current}${key}`;
}

// ── Leverage (screen 25) ─────────────────────────────────────────────────────

/** state.md: margin = 800, gold = 3412.10. */
export const PERP_MARGIN = 800;
export const GOLD_PRICE = 3412.1;
export const LEVERAGE_OPTIONS = [2, 5, 10] as const;

export function notional(lev: number, margin = PERP_MARGIN): number {
  return margin * lev;
}
/**
 * How much of the margin an adverse move eats before liquidation.
 *
 * One constant, used by both the price and the sentence about it. They were separate: the price
 * came from this ratio and the warning was three hardcoded strings, so changing the ratio would
 * have moved the liquidation line while the sentence underneath kept quoting the old number — a
 * screen stating two different liquidation points, one of them in the reassuring direction.
 */
const MARGIN_AT_RISK = 0.92;

export function liquidation(lev: number, mark = GOLD_PRICE): number {
  return mark * (1 - MARGIN_AT_RISK / lev);
}

/**
 * "An", not "A", before eight, eleven and eighteen.
 *
 * The screen read "A 18% move against you wipes the margin." Written out it is "a eighteen
 * per cent move", which is wrong — and it sits directly under the liquidation price on a
 * leverage screen, which is the last place to look careless.
 */
function article(pct: number): 'A' | 'An' {
  return /^(8|11|18)/.test(String(pct)) ? 'An' : 'A';
}

export function leverageWarning(lev: number): string {
  const pct = Math.round((MARGIN_AT_RISK / lev) * 100);
  return `${article(pct)} ${pct}% move against you wipes the margin.`;
}
export type WarnBand = 'calm' | 'warn' | 'danger';
export function leverageWarnBand(lev: number): WarnBand {
  if (lev >= 10) return 'danger';
  if (lev >= 5) return 'warn';
  return 'calm';
}

// ── Position close (screen 22) ───────────────────────────────────────────────

/** state.md: unrealised = 318.40, margin = 3800. */
export const POSITION_UNREALISED = 318.4;
export const POSITION_MARGIN = 3800;
export const CLOSE_STEPS = [25, 50, 75, 100] as const;

export function closeRealise(pct: number, unrealised = POSITION_UNREALISED): number {
  return (unrealised * pct) / 100;
}
export function closeFree(pct: number, margin = POSITION_MARGIN): number {
  return (margin * pct) / 100;
}
export function closeCta(pct: number): string {
  return pct === 100 ? 'Close position' : `Close ${pct}%`;
}

// ── Swap (screen 19) ─────────────────────────────────────────────────────────

/**
 * The swap a person composed, as the executor takes it — the body `POST /swap` receives (PLAN.md 3.9).
 *
 * The amount stays the decimal they typed: the executor parses it into the token's own base units, so no float
 * stands between "0.1 WOKB" and the wei the delegation pulls. `null` when there is nothing to send — no amount, or
 * the same token on both sides — so the screen cannot build a request the executor would only refuse.
 *
 * It replaced `swapOut`, `swapFee` and the slider bounds: the prototype's arithmetic, with a 0.25% fee nobody charges.
 */
export function swapRequest(input: {
  pay: string;
  receive: string;
  amount: string;
  slippagePct: number;
}): { from: string; to: string; amount: string; slippagePct: number } | null {
  const amount = input.amount.trim();
  if (!/^\d+(\.\d+)?$/.test(amount) || !(Number(amount) > 0)) return null;
  if (input.pay.toUpperCase() === input.receive.toUpperCase()) return null;
  return { from: input.pay, to: input.receive, amount, slippagePct: input.slippagePct };
}

/** The tolerances the swap screen offers, in percent. The executor accepts 0.05 to 3. */
export const SWAP_SLIPPAGES = [0.1, 0.3, 0.5, 1] as const;

/**
 * How much of `symbol` a balance can pay: the settlement token is cash, anything else is the holding the chain
 * reports. `undefined` while the balance is unknown — never a zero standing in for "not loaded yet".
 */
/**
 * What the "you receive" line says while there is no quote to show.
 *
 * "No quote" is a claim about the market — that nothing will price this pair — and it was shown to anyone signed out,
 * because the client refuses the request rather than sending a 401 (`NotSignedIn`). The screen's own button already
 * says to sign in; the line under the amount now agrees with it instead of blaming the venues.
 */
export function receiveHint(params: {
  amount: number;
  loading: boolean;
  error: unknown;
  reason: string | undefined;
}): string {
  if (!(params.amount > 0)) return 'Enter an amount';
  if (params.loading) return 'Quoting…';
  if (params.error instanceof NotSignedIn) return 'Sign in to see a quote';
  return params.reason ?? 'No quote';
}

export function swapSpendable(
  balance: { cash: number; holdings: readonly { symbol: string; units: number }[] } | null | undefined,
  symbol: string,
): number | undefined {
  if (!balance) return undefined;
  if (symbol === 'USDC') return balance.cash;
  return balance.holdings.find((h) => h.symbol === symbol)?.units ?? 0;
}

// ── Portfolio proposal (screen 10) ───────────────────────────────────────────

export const WEIGHT_STEP = 5;

export function weightTotal(weights: readonly number[]): number {
  return weights.reduce((a, b) => a + b, 0);
}
/** Bar widths normalise to the total, so the bar stays full while the user is mid-edit. */
export function weightBarPct(weights: readonly number[], i: number): number {
  const total = Math.max(weightTotal(weights), 1);
  return ((weights[i] ?? 0) / total) * 100;
}
export function canApprove(weights: readonly number[]): boolean {
  return weightTotal(weights) === 100;
}
export function proposalCta(weights: readonly number[], approved: boolean): string {
  if (approved) return 'Portfolio approved ✓';
  return canApprove(weights) ? 'Approve & fund' : 'Balance to 100% first';
}

// ── Onboarding ───────────────────────────────────────────────────────────────

/** Wallet setup replaced KYC after the pivot, but the 4-step progress model is unchanged. */
export function stepPct(step: number, total = 4): number {
  return (step / total) * 100;
}

export function depositFee(amount: number, feePct: number): number {
  return (amount * feePct) / 100;
}

// ── Backtest (screen 17) ─────────────────────────────────────────────────────

export const BT_CAPITAL_MIN = 1000;
export const BT_CAPITAL_MAX = 50000;
export const BT_CAPITAL_STEP = 1000;

export function btEnd(capital: number, ret: number): number {
  return capital * (1 + ret / 100);
}
export function btGain(capital: number, ret: number): number {
  return btEnd(capital, ret) - capital;
}
/**
 * state.md: "U+2212, not a hyphen" — this was called out explicitly for Max DD.
 *
 * And only on a drawdown there was. A replay that never fell below its peak printed "−0.0%", a minus
 * sign on a zero. The sign follows the rounded figure, so a dip too small to show reads as none.
 */
export function btDrawdown(dd: number): string {
  const figure = Math.abs(dd).toFixed(1);
  return `${Number(figure) === 0 ? '' : MINUS}${figure}%`;
}

// ── Leaderboard (screen 16) ──────────────────────────────────────────────────

export type LeaderboardKey = 'pnl30d' | 'win' | 'trades';
export const LEADERBOARD_KEYS: LeaderboardKey[] = ['pnl30d', 'win', 'trades'];
/**
 * Each sort named for the number it sorts by. The third was "Volume" and ordered by trade count, so
 * an agent with forty small buys outranked one with two large ones under a word meaning the opposite.
 * `/agents/leaderboard` sends no volume to sort by, so the label moved to the number there is.
 */
export const LEADERBOARD_LABELS = ['P&L', 'Win rate', 'Trades'] as const;

export function sortLeaderboard<T extends Record<LeaderboardKey, number>>(
  rows: readonly T[],
  key: LeaderboardKey,
): T[] {
  return [...rows].sort((a, b) => b[key] - a[key]);
}
/** Bar width normalised to the largest absolute P&L in the set. */
export function leaderboardBarPct(pnlValue: number, rows: readonly { pnl30d: number }[]): number {
  const max = Math.max(...rows.map((r) => Math.abs(r.pnl30d)), 1);
  return (Math.abs(pnlValue) / max) * 100;
}

/**
 * A win rate is a share of trades, so an agent with none has no rate.
 *
 * The server sends `win: 0` beside `trades: 0` — honestly, as "no record" — and the agent page, the
 * comparison and the leaderboard printed it as "0%", which reads as an agent that lost every trade it
 * made. It made none.
 */
export function winRate(agent: { win: number; trades: number }): string {
  return agent.trades > 0 ? `${agent.win}%` : '—';
}

/** A signed P&L that does not sign a zero. "+$0.00" is a gain nobody made. */
export function signedPnl(value: number): string {
  return Math.abs(value) < 0.005 ? money(0) : signedMoney(value);
}

// ── Kill switch (screen 20) ──────────────────────────────────────────────────

/**
 * There is a third state, and leaving it out was a lie on the one screen that must not tell one.
 *
 * A permission can be perfectly valid — unrevoked, unexpired, cap intact — and still name a
 * delegate the executor is not. `spend` compares the caller against the address the user signed
 * for, so such a grant buys the bot nothing: every run reverts, and the only visible symptom is
 * trades that quietly never happen.
 *
 * Observed here: a wallet held a live grant to `0xe992FE…` while the executor signed as
 * `0xC38f38f4…`, and this screen said "Agents are live — 1 agents can place orders inside your
 * limits right now." Both halves were false.
 *
 * `delegateIsCurrent` is undefined against a server that predates the field. Undefined is not
 * false: an older executor cannot answer the question, and claiming a fault we have not observed
 * is its own kind of wrong. Only an explicit `false` counts.
 */
export function delegateUnusable(
  delegation: { delegateIsCurrent?: boolean } | null | undefined,
  killed: boolean,
): boolean {
  return !killed && delegation?.delegateIsCurrent === false;
}

/**
 * A permission whose clock has run out.
 *
 * The docblock above says a policy can be "unrevoked, unexpired, cap intact" — expiry was known to
 * matter and nothing here checked it. So an expired grant reached this screen as a green **Live**
 * dot headed "Agents are live", and every trade under it reverts `PolicyExpired`. Observed on the
 * hosted deployment: a policy that lapsed at 13:35 on 8 September still reading Live thirteen hours
 * later, with `/limits` reporting `$0 left today` and no reason for the zero.
 *
 * It is a sibling of `delegateUnusable` rather than a variant of `killed`: the user did not stop
 * anything, and the remedy is to grant again rather than to resume. Kept separate from `unusable`
 * because the two say different things to the person reading them — one is a bot key that moved,
 * the other is a permission that ended on schedule, exactly as the user chose when they set it.
 *
 * An absent `expiresAt` is not an expired one. A server that predates the field cannot answer the
 * question, and asserting a fault we have not observed is the mistake `delegateIsCurrent` already
 * documents.
 */
export function delegationExpired(
  delegation: { expiresAt?: number } | null | undefined,
  killed: boolean,
  now: number = Date.now(),
): boolean {
  // Built on `expiryState` rather than beside it: the banner further down the screen already reads
  // expiry from there, and two answers to "has this ended" is how the badge and the banner came to
  // disagree in the first place.
  return !killed && expiryState(delegation?.expiresAt, now) === 'expired';
}

/**
 * We could not read the permission — which is not the same as there not being one.
 *
 * `/safety` loaded the delegation with `.catch(() => undefined)`, so a request that failed left
 * `delegation` null and the screen said **NOT GRANTED · "No permission has been granted, so
 * nothing can trade."** With the executor unreachable and a live $1,600/day grant on chain, every
 * word of that was false.
 *
 * It is the same defect as the one `positions()` had — a failed read rendered as a definitive
 * negative — on the screen least able to afford it: a user told they have granted nothing may
 * believe their money is untouchable when a bot is in fact authorised to spend it.
 *
 * `NotSignedIn` is excluded deliberately. A signed-out visitor genuinely has no permission, and
 * that is an answer rather than a failure to get one.
 */
export function permissionUnreadable(
  loadError: unknown,
  delegation: unknown,
  signedOut = false,
): boolean {
  return Boolean(loadError) && !signedOut && (delegation === null || delegation === undefined);
}

/**
 * The headline on Safety, in words that are true of whatever the permission runs.
 *
 * It named agents in every state, and the switch governs strategies just as much: a wallet with nine live strategies
 * and no agent hired was headed "Agents are live", and after a stop "All agents stopped", above a sentence that counted
 * the strategies correctly. What the switch turns on and off is trading, so trading is what the title names.
 */
export function killTitle(
  killed: boolean,
  unusable = false,
  granted = true,
  expired = false,
): string {
  if (unusable) return 'Nothing can trade';
  // "Trading is live" over an ungranted wallet is the same false claim as the explanation below.
  if (!granted) return 'Nothing can trade yet';
  if (expired) return 'Your permission has ended';
  return killed ? 'Trading is stopped' : 'Trading is live';
}
/** What is scheduled against the permission right now, counted by kind. */
export type RunningCount = { agents: number; strategies: number };

/**
 * What is actually able to place an order, said in a sentence that survives the number being one.
 *
 * `liveAgents` used to be the count of HIRED agents, which is not the same set as the things that
 * can trade: a wallet with no agent hired and five live strategies was told "0 agents can place
 * orders inside your limits right now" — under a green LIVE badge headed "Agents are live", on the
 * screen whose entire job is to say what the bot may do, minutes after one of those strategies
 * placed an order.
 *
 * The fix passed the sum, and the sentence then called the sum agents: a wallet with no agent hired
 * and nine live strategies read "9 agents can trade within your limits" while Home showed all four
 * agents "Not hired". Both kinds stop when the switch is pulled, so both belong in the sentence —
 * each under its own name. The two counts arrive separately for that reason.
 *
 * `running` is undefined when it could not be counted. That is not zero: "Nothing is running" over
 * a roster or a strategy list that failed to load is the same false negative as a failed permission
 * read reported as "Not granted".
 *
 * And "1 agents" was reachable. The docblock above records seeing it on screen; nothing pluralised
 * it, because the only test used 3.
 */
export function killExplanation(
  killed: boolean,
  running: RunningCount | undefined,
  unusable = false,
  granted = true,
  expired = false,
): string {
  if (unusable) {
    return 'Reconnect to trade again. Your funds are untouched.';
  }
  /*
   * No permission at all is its own state, and it outranks the rest.
   *
   * Without this the zero-agents branch below said "the permission is live" to a signed-out
   * visitor — directly above the card that reads "Nothing is granted yet. No bot can touch this
   * wallet until you sign a permission." Two contradictory sentences in one viewport, on the
   * screen whose entire job is to say what the bot may do. Introduced by the fix for the previous
   * bug in this same function, which is how a copy change becomes a correctness change.
   */
  if (!granted) {
    return 'Nothing is granted yet, so nothing can trade.';
  }
  if (expired) {
    return 'It reached its end date. Grant again to continue.';
  }
  if (killed) return 'Nothing trades until you resume.';
  if (!running) return 'Couldn’t count what is running.';
  const { agents, strategies } = running;
  if (agents + strategies === 0) {
    // Not "0 agents can place orders", which reads as a stopped bot next to a LIVE badge. The
    // permission is live and unused, and those are different facts.
    return 'Nothing is running. Anything you start can trade.';
  }
  const named = [
    agents > 0 ? `${agents} ${agents === 1 ? 'agent' : 'agents'}` : undefined,
    strategies > 0 ? `${strategies} ${strategies === 1 ? 'strategy' : 'strategies'}` : undefined,
  ].filter((part): part is string => part !== undefined);
  return `${named.join(' and ')} can trade within your limits.`;
}
/**
 * What the big button on Safety should offer.
 *
 * `killTitle` has taken `granted` since a wallet with no permission was headed "Agents are live";
 * this did not, so the same wallet was shown a red **Stop all agents** underneath the words "There
 * is nothing to stop yet". Caught in the closing frame of the demo recording, which is where a
 * judge would have seen it too.
 *
 * Offering a destructive stop for something that was never started is not only wrong copy — the
 * handler would have called `revoke()` on a policy that does not exist. The action on an ungranted
 * wallet is to grant, and the screen's own permission card already routes there.
 */
export function killCta(
  killed: boolean,
  unusable = false,
  granted = true,
  expired = false,
): string {
  // Trading, not agents, for the reason `killTitle` gives: the switch stops strategies too.
  if (unusable) return 'Reconnect';
  if (!granted) return 'Set the limits';
  if (expired) return 'Grant a new permission';
  return killed ? 'Resume trading' : 'Stop all trading';
}

/**
 * What Safety may show from the chain when the executor's read failed (FEATURES.md #1).
 *
 * A live policy, as a rule. That is a positive fact — something can trade, and here is the stop — and showing it risks
 * nothing. A revoked, expired or absent policy on the build's pinned contract is a different kind of answer: with the
 * executor down there is no asking whether a permission stands anywhere else (a stop itself falls back to the contract
 * the executor names, `useGrantDelegation`), so "Stopped" or "Not granted" on one contract's word could be the false
 * negative this screen exists not to tell. Those keep the unknown state.
 *
 * Except the stop this screen sent. `revoke` returns only once the chain shows the policy revoked (`confirmStopped`), and
 * that policy is the live one shown a moment before, so the chain reading it revoked is the answer to what was done here
 * rather than a claim about a permission nobody looked at.
 */
export function permissionOnChain(
  standing: ChainStanding | undefined,
  stoppedHere: boolean,
): 'live' | 'stopped' | undefined {
  if (standing?.kind === 'live') return 'live';
  if (standing?.kind === 'revoked' && stoppedHere) return 'stopped';
  return undefined;
}

// ── Cap and term rings (Safety, FEATURES.md #34) ─────────────────────────────

/**
 * How much of today's cap is spent: `spentTodayUsd` over `dailyCapUsd`, as one permission read returned them.
 *
 * `/delegation` sends the contract's own `spentToday` tally beside the cap it counts against
 * (`server/src/routes/index.ts`), so the two cannot disagree; `Delegation` does not declare the field, hence the shape
 * taken here. Undefined when either is missing or unusable — a policy read off the chain alone carries no tally, and an
 * executor older than the field sends none — because an unmeasured spend drawn as an empty ring is a spend of zero. Not
 * capped at one: a cap lowered mid-day can leave more spent than the new cap, and the figure should say so.
 */
export function capUsed(
  permission: { dailyCapUsd?: number; spentTodayUsd?: number } | null | undefined,
): number | undefined {
  const cap = permission?.dailyCapUsd;
  const spent = permission?.spentTodayUsd;
  if (typeof cap !== 'number' || typeof spent !== 'number') return undefined;
  if (!Number.isFinite(cap) || !Number.isFinite(spent) || cap <= 0 || spent < 0) return undefined;
  return spent / cap;
}

/**
 * The cap ring's figure: "29%". Rounded down, so a cap never reads used up before it is — the epsilon is float noise,
 * since 464 of 1,600 is 28.999…% in binary. Unsigned, as a share of a whole is. A dash when unknown.
 */
export function capUsedFigure(used: number | undefined): string {
  if (used === undefined) return '—';
  return percent(Math.floor(used * 100 + 1e-9), { digits: 0, explicitSign: false });
}

/**
 * How much of the permission's term is left, 0 to 1: the time to `expiresAt` over the whole run from `grantedAt`.
 *
 * The chain keeps the expiry and not the start (`Delegation.grantedAt`), so without a recorded start there is no term to
 * take a share of, and this is undefined rather than a length made up.
 */
export function termLeft(
  permission: { expiresAt?: number; grantedAt?: number | null } | null | undefined,
  now: number,
): number | undefined {
  const end = permission?.expiresAt;
  const start = permission?.grantedAt;
  if (typeof end !== 'number' || typeof start !== 'number') return undefined;
  if (!Number.isFinite(end) || !Number.isFinite(start) || end <= start) return undefined;
  return Math.min(1, Math.max(0, (end - now) / (end - start)));
}

const TIME_UNITS = [
  { ms: 86_400_000, short: 'd', long: 'day' },
  { ms: 3_600_000, short: 'h', long: 'hour' },
  { ms: 60_000, short: 'm', long: 'minute' },
] as const;

/**
 * The time to `expiresAt`, as the term ring's figure ("5d") and as the words a screen reader says ("5 days").
 *
 * Its largest whole unit, rounded down, so it never promises time that is not there. A dash with no expiry to count to.
 */
export function timeLeft(expiresAt: number | undefined, now: number): { figure: string; words: string } {
  if (typeof expiresAt !== 'number' || !Number.isFinite(expiresAt) || expiresAt <= 0) {
    return { figure: '—', words: 'unknown' };
  }
  const ms = Math.max(0, expiresAt - now);
  for (const unit of TIME_UNITS) {
    const n = Math.floor(ms / unit.ms);
    if (n >= 1) return { figure: `${n}${unit.short}`, words: `${n} ${unit.long}${n === 1 ? '' : 's'}` };
  }
  return { figure: '0m', words: 'under a minute' };
}

// ── Activity (screen 15) ─────────────────────────────────────────────────────

/**
 * state.md: kindFor = [null, 'trade', 'risk', 'block'].
 *
 * [G41] The fixture carries a 5th kind, 'yield' (the "Staked 120 SOL" row), which no tab selected
 * — it appeared under All and nowhere else. Resolved by folding yield into Trades: a staking
 * action moves money and belongs with the money-moving events, and adding a 5th pill would
 * overflow the filter row at 402px.
 */
export const ACTIVITY_FILTERS = ['All', 'Trades', 'Risk', 'Blocked'] as const;

export function activityFilterKinds(index: number): readonly string[] | null {
  switch (index) {
    case 1:
      return ['trade', 'yield'];
    case 2:
      return ['risk'];
    case 3:
      return ['block'];
    default:
      return null;
  }
}

export function filterActivity<T extends { kind: string }>(rows: readonly T[], index: number): T[] {
  const kinds = activityFilterKinds(index);
  if (!kinds) return [...rows];
  return rows.filter((r) => kinds.includes(r.kind));
}

export type ActivityDot = 'acted' | 'risk' | 'blocked';
export function activityDot(kind: string): ActivityDot {
  if (kind === 'block') return 'blocked';
  if (kind === 'risk') return 'risk';
  return 'acted';
}
/** state.md: credits are `up`, debits are ink55. A debit is anything starting with U+2212. */
export function activityAmountIsCredit(amount: string): boolean {
  return amount !== '' && !amount.startsWith(MINUS);
}

// ── Chart projection helpers used by derived screens ─────────────────────────

export function barHigh(bars: readonly Bar[]): number {
  return Math.max(...bars.map((b) => b[1]));
}
export function barLow(bars: readonly Bar[]): number {
  return Math.min(...bars.map((b) => b[2]));
}
export function lastClose(bars: readonly Bar[]): number {
  return bars[bars.length - 1]![3];
}

// ── Display helpers that combine derived values with formatting ──────────────

export function autoCloseFootnote(tp: number, sl: number): { make: string; lose: string } {
  return { make: money(tpPnl(tp)), lose: money(slPnl(sl)) };
}

export function closeSummary(pct: number): { realises: string; frees: string } {
  return { realises: money(closeRealise(pct)), frees: money(closeFree(pct)) };
}

export function leverageSummary(lev: number, mark = GOLD_PRICE) {
  return {
    notional: money(notional(lev), { fractionDigits: 0 }),
    liquidation: price(liquidation(lev, mark)),
    warning: leverageWarning(lev),
    band: leverageWarnBand(lev),
  };
}

export function backtestSummary(capital: number, ret: number, dd: number) {
  return {
    end: money(btEnd(capital, ret)),
    gain: signedMoney(btGain(capital, ret)),
    ret: percent(ret),
    dd: btDrawdown(dd),
  };
}

// ── Asset screen (screen 8) ──────────────────────────────────────────────────

/**
 * What the change on the asset header actually measures.
 *
 * The header computed its percentage from the candle series — first close to last, over whatever
 * range the pills were set to — and then labelled it "today", always. Switching to 1M produced
 * **"up 38.4% today"** over a real asset that had moved 2% since midnight. Not a rounding
 * difference or a stale read: a flatly false sentence about somebody's money, on the screen they
 * open to decide whether to buy.
 *
 * The 1D case takes the quote's own 24h change rather than the series. Every other screen prices
 * the day from that field, and computing it a second way here is how the same asset showed 2.1%
 * on this screen and 2.55% in the market list at the same moment, with nothing to tell the user
 * which was true. One number, one source.
 */
export const RANGE_WINDOW_LABEL: Record<string, string> = {
  '1D': 'today',
  '1W': 'past week',
  '1M': 'past month',
  '1Y': 'past year',
  All: 'all time',
};

const RANGE_MS: Record<string, number> = { '1D': 86_400_000, '1W': 7 * 86_400_000, '1M': 30 * 86_400_000, '1Y': 365 * 86_400_000 };

/**
 * The window a change was really measured over, when the history is shorter than the pill.
 *
 * A wrapped xStock's chart is the prices this deployment recorded, which begin when it first priced the token — so a
 * 1Y pill over two days of readings would read "up 0.9% past year", a claim about a year nobody saw. When the first
 * candle starts more than a tenth of the window after the window opens, the label says when it really starts.
 */
export function coveredLabel(
  range: string,
  label: string,
  firstStartMs: number | undefined,
  since: (ms: number) => string,
  now: number = Date.now(),
): string {
  const windowMs = RANGE_MS[range];
  if (firstStartMs === undefined || windowMs === undefined || !Number.isFinite(firstStartMs)) return label;
  return firstStartMs - (now - windowMs) > windowMs * 0.1 ? `since ${since(firstStartMs)}` : label;
}

export function rangeChange(
  range: string,
  seriesPct: number,
  change24h: number | undefined,
): { pct: number; label: string } {
  const pct = range === '1D' && Number.isFinite(change24h) ? (change24h as number) : seriesPct;
  return { pct, label: RANGE_WINDOW_LABEL[range] ?? range };
}

// ── Permission expiry ────────────────────────────────────────────────────────

/**
 * How close the permission is to running out, and what to say about it.
 *
 * The grant is time-boxed on purpose — a permission that never expires is a permission nobody
 * revisits, and the contract enforces the deadline whether or not anyone is watching. But nothing
 * in the app ever read `expiresAt`. It is written at grant time, returned by `/delegation`, and
 * displayed nowhere, so the bot simply stops one day and every screen goes on saying "Agents are
 * live". Same silent-stop as a rotated delegate key: nothing is broken, nothing is wrong, and
 * nothing happens.
 *
 * A day of warning because re-granting costs a signature per tradable token and then the grant — seventeen on X
 * Layer today — and a user should not discover that
 * requirement at the moment the permission has already lapsed.
 */
export const EXPIRY_WARNING_MS = 24 * 60 * 60 * 1000;

export type ExpiryState = 'none' | 'ok' | 'soon' | 'expired';

export function expiryState(expiresAt: number | undefined, now = Date.now()): ExpiryState {
  if (!expiresAt || !Number.isFinite(expiresAt)) return 'none';
  if (expiresAt <= now) return 'expired';
  return expiresAt - now <= EXPIRY_WARNING_MS ? 'soon' : 'ok';
}

/** Plain words, and never a bare timestamp — "1788908350000" is not a deadline anyone can act on. */
export function expiryNote(expiresAt: number | undefined, now = Date.now()): string | undefined {
  const state = expiryState(expiresAt, now);
  if (state === 'none' || state === 'ok') return undefined;
  if (state === 'expired') {
    return 'Permission expired. Your funds are untouched.';
  }
  const hours = Math.max(1, Math.round((expiresAt! - now) / 3_600_000));
  return `Permission ends in ${hours === 1 ? 'an hour' : `${hours} hours`}.`;
}

/**
 * Where a position's recorded units and the wallet's own balance disagree (PLAN.md 2.7).
 *
 * `missing` — the ledger records more than the wallet holds. The executor already caps the size at
 * the balance, so this explains a size smaller than the trade history suggests.
 * `unrecorded` — the wallet holds more than was bought here. That extra has no recorded cost, so it
 * is not counted. Null when the two agree to within a millionth of a unit (the server's dust line),
 * or when the chain could not be asked.
 */
export function holdingDrift(p: { driftUnits?: number | null }): { kind: 'missing' | 'unrecorded'; units: number } | null {
  const d = p.driftUnits;
  if (d === null || d === undefined || !Number.isFinite(d) || Math.abs(d) <= 0.000001) return null;
  return d > 0 ? { kind: 'missing', units: d } : { kind: 'unrecorded', units: -d };
}

/** The drift, said plainly beside the numbers it changes. */
export function driftSentence(symbol: string, drift: { kind: 'missing' | 'unrecorded'; units: number }): string {
  return drift.kind === 'missing'
    ? `${quantity(drift.units)} ${symbol} on record isn’t in your wallet.`
    : `${quantity(drift.units)} ${symbol} in your wallet wasn’t bought here.`;
}

/** Which tradable symbols each onboarding sleeve means (PLAN.md 2.17). Stable yield is Aave, not a swap: cash here. */
export const SLEEVE_SYMBOLS: Readonly<Record<string, readonly string[]>> = {
  'Blue-chip crypto': ['XBTC', 'WOKB'],
  'Tokenized equities': [
    'NVDAx', 'AAPLx', 'TSLAx', 'METAx', 'MSFTx', 'AMZNx', 'GOOGLx', 'MSTRx', 'COINx', 'SPYx', 'QQQx',
  ],
  'Stable yield': [],
};

/**
 * Whether a sleeve's weight is held as cash on this network because nothing it names settles here: the equities on a
 * build whose executor finds the xStock wrappers non-functional. The onboarding screen said "NVDAx, AAPLx and nine more
 * tokenized stocks" beside 30% where approving would hold that 30% as cash. Not the stable-yield sleeve, which names nothing to swap on any chain; not
 * where nothing settles at all, which the screen says on its own; and not before the executor has said what settles.
 */
export function sleeveHeldAsCash(name: string, tradable: readonly string[] | undefined): boolean {
  const named = SLEEVE_SYMBOLS[name] ?? [];
  if (!tradable || tradable.length === 0 || named.length === 0) return false;
  const settles = new Set(tradable.map((s) => s.toUpperCase()));
  return !named.some((s) => settles.has(s.toUpperCase()));
}

/**
 * The onboarding weights as a rebalance holds them (PLAN.md 2.17): each sleeve's percent split evenly across
 * the symbols it names that this chain can settle. What is left — a sleeve with nothing tradable here, like
 * the equities where their wrappers do not function, and the stable-yield sleeve — is cash, because a rebalance's untargeted weight
 * is cash. Rounded down to a hundredth of a percent, so the targets never add up past the whole.
 */
export function targetsFromSleeves(
  sleeves: readonly { name: string; weight: number }[],
  tradable: readonly string[],
): { targets: Record<string, number>; cashPct: number } {
  const settles = new Set(tradable.map((s) => s.toUpperCase()));
  const targets: Record<string, number> = {};
  let placed = 0;
  for (const sleeve of sleeves) {
    const symbols = (SLEEVE_SYMBOLS[sleeve.name] ?? []).filter((s) => settles.has(s.toUpperCase()));
    if (symbols.length === 0 || !(sleeve.weight > 0)) continue;
    const each = Math.floor((sleeve.weight / symbols.length) * 100) / 100;
    for (const s of symbols) {
      targets[s] = Math.round(((targets[s] ?? 0) + each) * 100) / 100;
      placed += each;
    }
  }
  return { targets, cashPct: Math.round((100 - placed) * 100) / 100 };
}

/**
 * What approving the onboarding proposal creates (PLAN.md 2.17, 3.7): a live rebalance over what this network
 * settles or — where nothing settles, as on the X Layer testnet — a watched one over what it can follow, which reports
 * what it would trade and moves nothing. `watchable` is used only when nothing settles.
 */
export function proposalRebalance(
  sleeves: readonly { name: string; weight: number }[],
  tradable: readonly string[],
  watchable: readonly string[],
): { state: 'live' | 'watch'; targets: Record<string, number>; cashPct: number } {
  const settles = tradable.length > 0;
  return { state: settles ? 'live' : 'watch', ...targetsFromSleeves(sleeves, settles ? tradable : watchable) };
}

/**
 * Whether this deployment fills nothing (PLAN.md 4.3): the executor offers nothing to trade while it still offers
 * things to watch. `/market/tradable` answers `[]` exactly where nothing settles (3.7); an empty watch list beside it
 * would be an executor with no registry, not a chain without a DEX, so that says nothing — and neither does a read
 * that has not answered.
 */
export function nothingSettles(
  tradable: readonly unknown[] | null | undefined,
  watchable: readonly unknown[] | null | undefined,
): boolean {
  return Array.isArray(tradable) && tradable.length === 0 && (watchable?.length ?? 0) > 0;
}

// ── Setup progress (Home) ────────────────────────────────────────────────────

/** A read a setup step is decided from, as a screen holds it: the answer, or the failure that came back instead. */
export type SetupRead<T> = { data: T | undefined; error: unknown };

/** What of a permission decides whether the bot can use it — the fields Safety decides that from. */
export type SetupPermission = { revoked: boolean; expiresAt?: number; delegateIsCurrent?: boolean };

export type SetupStepKey = 'fund' | 'permit' | 'trade';

/**
 * What a setup step can be.
 *
 * Four, not two, and the difference between the last three is the whole point of this module.
 *
 *   `done`     the chain or the executor says so.
 *   `todo`     it has genuinely not been done.
 *   `checking` the read is still out. NOT the same as "not done": a step drawn as to-do before its read answers
 *              tells a wallet that has funded and granted that it has done neither.
 *   `unknown`  the read came back and could not answer. NOT the same as "still checking": one resolves itself, the
 *              other will not, and telling someone to wait for an answer that is not coming is its own small lie.
 */
export type SetupStepState = 'done' | 'todo' | 'checking' | 'unknown';

/**
 * The chain's own account of the permission, as `standingOnChain` reports it (`src/wallet/delegationChain.ts`).
 *
 * Named here as plain strings so this module stays free of the wallet layer. `undefined` is a read still out.
 */
export type SetupStanding = 'live' | 'revoked' | 'expired' | 'none' | 'unreadable';

export type SetupStep = {
  key: SetupStepKey;
  label: string;
  /** Where the step is taken. */
  href: '/deposit' | '/delegate' | '/strategies';
  state: SetupStepState;
};

/**
 * The three things that have to be true before this app has done what it says (FEATURES.md #14): money in, a
 * permission the chain agrees exists, and a trade that actually filled.
 *
 * `null` means one thing only: nobody is signed in, so there is no wallet to set up. Every other case draws the card,
 * including one where nothing has answered yet — those steps say they are being checked. It used to return `null`
 * while any read was in flight, on the reading that a step drawn before its read answers is a guess. That was right
 * about the guess and wrong about the remedy: the card vanished for as long as the executor took, on the one screen a
 * new wallet is looking at to find out what to do next. A step that says it is checking is not guessing.
 *
 * ## Where each step's answer comes from
 *
 * **Fund** — the wallet's real balance. A balance nobody gave is not a zero.
 *
 * **Permit** — **the chain**, whenever it can be asked. Not a stored flag and not the executor's record of what it
 * once wrote: both drift the moment anything happens elsewhere, and this app has already shipped a green LIVE badge
 * over a permission the contract said was revoked. The executor's record is the fallback for where the chain cannot be
 * reached at all, and it is only ever a fallback.
 *
 * **Trade** — a fill the executor recorded. Not a strategy created, which is an intention: the demo's claim, and the
 * product's, is that the bot *traded*, and the step that says so must not be satisfied by anything less.
 */
export function setupSteps(input: {
  signedOut: boolean;
  balance: SetupRead<{ total: number } | null>;
  /** The chain's answer, and `undefined` while the read is out. Preferred over `permission` whenever it is present. */
  standing?: SetupRead<SetupStanding>;
  /** The executor's record of the permission — the fallback for where the chain could not be asked. */
  permission: SetupRead<SetupPermission | null>;
  /** The recorded runs. A `filled` one among them is the trade. */
  fills: SetupRead<readonly { status: string }[]>;
  now?: number;
}): SetupStep[] | null {
  const { signedOut, balance, standing, permission, fills, now = Date.now() } = input;
  if (signedOut) return null;

  return [
    { key: 'fund', label: 'Fund', href: '/deposit', state: fundState(balance) },
    { key: 'permit', label: 'Permit', href: '/delegate', state: permitState(standing, permission, now) },
    { key: 'trade', label: 'First trade', href: '/strategies', state: tradeState(fills) },
  ];
}

/** Whether every step is done — what a caller uses to decide there is nothing left to show. */
export function setupComplete(steps: SetupStep[] | null): boolean {
  return steps !== null && steps.every((step) => step.state === 'done');
}

/** A read still out, as every step decides it: no answer and no failure. */
function stillReading(read: SetupRead<unknown> | undefined): boolean {
  return read !== undefined && read.data === undefined && read.error === undefined;
}

function fundState(read: SetupRead<{ total: number } | null>): SetupStepState {
  if (stillReading(read)) return 'checking';
  // A balance the executor did not give is not a zero, whatever shape the absence took.
  if (read.error || !read.data || !Number.isFinite(read.data.total)) return 'unknown';
  return read.data.total > 0 ? 'done' : 'todo';
}

/**
 * The permission, from the chain where the chain can be asked.
 *
 * `unreadable` is the contract's address being unreachable, which is unknown rather than ungranted — the one mistake
 * this step must never make is reporting a live permission as absent, or an absent one as live.
 */
function permitState(
  standing: SetupRead<SetupStanding> | undefined,
  permission: SetupRead<SetupPermission | null>,
  now: number,
): SetupStepState {
  if (standing !== undefined) {
    if (stillReading(standing)) return 'checking';
    if (standing.error) return 'unknown';
    switch (standing.data) {
      case 'live':
        return 'done';
      case 'none':
      case 'revoked':
      case 'expired':
        return 'todo';
      // The chain was asked and would not say. Falling through to the executor's record here would answer a question
      // about the chain with something that is not the chain.
      default:
        return 'unknown';
    }
  }

  if (stillReading(permission)) return 'checking';
  if (permission.error) return 'unknown';
  // Null is the executor's own answer that nothing was ever granted.
  if (!permission.data) return 'todo';
  const p = permission.data;
  // `killed` is false because those helpers stand aside for a stop, and here a stop is simply `revoked`.
  const usable = !p.revoked && !delegationExpired(p, false, now) && !delegateUnusable(p, false);
  return usable ? 'done' : 'todo';
}

/**
 * A trade that filled — the executor's own record of one, not a strategy that might one day make one.
 *
 * A strategy is an intention. This product's claim is that the bot traded, and the step that says so is not satisfied
 * by anything less than a fill the executor wrote down.
 */
function tradeState(read: SetupRead<readonly { status: string }[]>): SetupStepState {
  if (stillReading(read)) return 'checking';
  if (read.error || !Array.isArray(read.data)) return 'unknown';
  return read.data.some((run) => run.status === 'filled') ? 'done' : 'todo';
}

// ── Stored records as rows (/risk, /strategy/[id]) ───────────────────────────

/**
 * One row of a stored record: where it came from, what to call it, the value as a person reads it, and what the value
 * is — so a screen can hide the money in it while balances are hidden and keep the prices (FEATURES.md #47).
 */
export type RecordEntry = { key: string; label: string; value: string; unit?: RecordUnit };

export type RecordUnit = 'money' | 'price' | 'percent';

/**
 * What a record's value is while balances are hidden (FEATURES.md #47): what it spends or allows is the person's money
 * and hides; a range's bounds, an entry or a high are prices and stay. A count or a percentage is no amount either way.
 */
export function recordFigure(entry: RecordEntry): FigureKind | undefined {
  return entry.unit === 'money' ? 'own' : entry.unit === 'price' ? 'market' : undefined;
}

/**
 * Names and units for the keys the app and the executor write, in the words the setup screens use.
 * Anything not listed keeps its own key, spaced out, and a plain value — named plainly beats hidden.
 */
const RECORD_FIELDS: Readonly<Record<string, { label: string; unit?: RecordUnit }>> = {
  // An agent's own limits — `RiskLimits` in server/src/agents/routes.ts.
  maxUsdPerTrade: { label: 'Most per trade', unit: 'money' },
  maxUsdPerDay: { label: 'Most per day', unit: 'money' },
  // Recurring buy and idle cash.
  usd: { label: 'Per run', unit: 'money' },
  keepCashUsd: { label: 'Keep spendable', unit: 'money' },
  minMoveUsd: { label: 'Smallest move', unit: 'money' },
  // Range accumulation.
  lower: { label: 'Bottom of range', unit: 'price' },
  upper: { label: 'Top of range', unit: 'price' },
  steps: { label: 'Rungs' },
  usdPerStep: { label: 'Each rung buys', unit: 'money' },
  // Exit rules.
  entryPrice: { label: 'Entry', unit: 'price' },
  takeProfitPct: { label: 'Take profit', unit: 'percent' },
  stopLossPct: { label: 'Stop loss', unit: 'percent' },
  trailPct: { label: 'Trailing stop', unit: 'percent' },
  peakPrice: { label: 'Highest since set', unit: 'price' },
  // Rebalance. Targets and weights are percents of the whole portfolio.
  targets: { label: 'Target', unit: 'percent' },
  cashPct: { label: 'Cash', unit: 'percent' },
  weights: { label: 'Weights', unit: 'percent' },
  sleeves: { label: 'Sleeves' },
  // Momentum and events.
  usdPerEntry: { label: 'Per entry', unit: 'money' },
  usdPerEvent: { label: 'Per event', unit: 'money' },
  stopPct: { label: 'Stop', unit: 'percent' },
};

function recordField(key: string): { label: string; unit?: RecordUnit } | undefined {
  // Own keys only: a stored key named `constructor` is data, not the object prototype.
  return Object.prototype.hasOwnProperty.call(RECORD_FIELDS, key) ? RECORD_FIELDS[key] : undefined;
}

/** `usdPerEntry` → "USD per entry". */
function spacedKey(key: string): string {
  const words = key
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[_-]+/g, ' ')
    .trim()
    .toLowerCase()
    .replace(/\busd\b/g, 'USD');
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** As many decimals as the figure has, up to two: 55%, 27.5%, 3.75%. */
function percentDigits(n: number): number {
  const hundredths = Math.round(Math.abs(n) * 100);
  if (hundredths % 100 === 0) return 0;
  return hundredths % 10 === 0 ? 1 : 2;
}

function recordValue(value: unknown, unit: RecordUnit | undefined): string {
  if (typeof value === 'number') {
    // NaN and Infinity are not values anyone set; they are what an unreadable one looks like.
    if (!Number.isFinite(value)) return '—';
    if (unit === 'money') return money(value);
    if (unit === 'price') return price(value);
    if (unit === 'percent') return percent(value, { digits: percentDigits(value), explicitSign: false });
    return `${value < 0 ? MINUS : ''}${Math.abs(value).toLocaleString('en-US', { maximumFractionDigits: 6 })}`;
  }
  if (typeof value === 'string') return value.trim() === '' ? '—' : value;
  if (typeof value === 'boolean') return value ? 'Yes' : 'No';
  return '—';
}

/**
 * A stored record — an agent's limits, a strategy's params — as rows a person can read.
 *
 * Both screens rendered `String(value)` key by key, so anything nested reached the screen as
 * `[object Object]` (a rebalance's targets) or as `55,30,15` (its weights). Nested objects are flattened
 * into rows like "Target · XBTC" rather than dropped, because the shape differs per strategy and per
 * agent, and a layout that skipped what it did not expect would hide a field without saying so. A value
 * that cannot be read is a dash, never `NaN`, `null` or `undefined`.
 */
export function recordEntries(
  record: Readonly<Record<string, unknown>> | null | undefined,
): RecordEntry[] {
  const rows: RecordEntry[] = [];
  const visit = (key: string, label: string, value: unknown, unit: RecordUnit | undefined): void => {
    if (Array.isArray(value)) {
      if (value.every((v) => v === null || typeof v !== 'object')) {
        const joined = value.map((v) => recordValue(v, unit)).join(', ');
        rows.push({ key, label, value: value.length > 0 ? joined : '—', unit });
      } else {
        value.forEach((v, i) => visit(`${key}.${i}`, `${label} ${i + 1}`, v, unit));
      }
      return;
    }
    if (value !== null && typeof value === 'object') {
      const children = Object.entries(value as Record<string, unknown>);
      if (children.length === 0) rows.push({ key, label, value: '—' });
      for (const [k, v] of children) {
        const field = recordField(k);
        // A child key is usually data — a symbol, a sleeve — so it keeps its own spelling: "Target · XBTC".
        visit(`${key}.${k}`, `${label} · ${field?.label ?? k}`, v, field?.unit ?? unit);
      }
      return;
    }
    rows.push({ key, label, value: recordValue(value, unit), unit });
  };
  for (const [k, v] of Object.entries(record ?? {})) {
    const field = recordField(k);
    visit(k, field?.label ?? spacedKey(k), v, field?.unit);
  }
  return rows;
}
