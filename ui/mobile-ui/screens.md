# screens.md — all 25 screens

Every screen is 402 × 874, black background, 54px top padding. Gutter 20px unless noted.
"(live)" marks interactive state that exists in the prototype — see `state.md` for the formulas.

---

## Group A — Onboarding (7 → 8 → 9 → 10)

### 7. Goals & risk (live)
**Purpose** Capture what the user wants so strategy offers and hard limits can be derived.
**Layout** Back circle + 4px progress track (33%) + "1/3". Title 26/700 two lines. Subtitle.
Wrapping chip row (gap 9px, chips 40px tall, radius 22px — selected white/`#0B0B0B`, unselected
`#111214` + `inputBorder`). Then a drawdown question with a 3-up segmented control (42px thumbs).
Caption reacts to the pick. `flex:1`. Summary line above a white Continue.
**Copy** "What should your / agents optimise for?" · "Pick as many as apply. This sets the
strategies you get offered, and the hard limits they run inside." · Chips: Grow long term / Trade
actively / Earn yield / Hedge my job / Learn first · "How much drawdown can you sit through?" ·
Steady / Balanced / Aggressive · "{risk} caps single-position size and how far a stop can sit from
entry."
**State** `goals[]` (multi), `riskQ` 0–2.

### 8. Verify identity (live)
**Purpose** KYC, framed as automatic rather than as a form.
**Layout** Same progress header (width = `kycPct`, "2/3"). Four 66px rows, each a 26px status
circle + label/sub. Done = filled `#2BD87A` with a ✓ in `#04160C`; current = 2px white ring;
pending = 2px `rgba(255,255,255,.18)` ring and dimmed text. Note strip. `flex:1`. CTA advances one
step per tap.
**Copy** "Verify it's you" · "Checks run automatically and usually clear in under a minute. Nothing
is shared with the agents." · Phone verified / +1 ••• ••• 4417 · Photo ID / Front and back, well lit
· Liveness check / A short selfie video · Funding source / Bank or card · "Your documents are
checked against sanctions and watchlists once at signup, then quietly re-screened in the
background." · CTA "Continue — {next step}" → "You are verified"
**State** `kyc` 0–4.

### 9. Add funds (live)
**Purpose** Fund the account; make settlement timing explicit before the agents can trade.
**Layout** Progress at 100%, "3/3". Title + subtitle. 52px/700 amount, centered. Preset pill row
($250/$500/$1,000/$2,500). Eyebrow "How you're paying". Three radio cards (`surface`, radius 22px,
padding 16px) — selected gets `selectedBorder` and a `6px solid #fff` dot; unselected a
`1.5px rgba(255,255,255,.25)` ring. Each carries a right-aligned tag chip. Fee + availability rows.
**Copy** "Fund the account" · "Agents can only trade what's settled. You can top up or withdraw
whenever you like." · Bank transfer / Free · lands in 1–2 days / Free · Debit card / Instant · 1.5%
fee / Instant · Send crypto / USDC, USDT or SOL / On-chain · CTA "Deposit ${amount}"
**State** `dep`, `method`. Fee = 1.5% on card only. Availability: "Tue, Sep 8" / "Right away" /
"After 1 confirmation".

### 10. AI portfolio proposal (live)
**Purpose** The agent drafts; the user adjusts and approves. Nothing executes unapproved.
**Layout** Centered 56px strategist orb, title, subtitle. Card containing: a 8px stacked
proportion bar (three segments, 2px gaps, widths = normalised weights), three sleeve blocks
(dot + name + stepper, then an indented 11.5px rationale), an "Allocated" total row, then the CTA.
**Copy** "Your draft portfolio" · "Built from your goals and a {risk} risk setting. Move the
weights — nothing is placed until you approve." · Blue-chip crypto / "BTC, ETH, SOL — the liquid
core the agent rebalances weekly." · Tokenized equities / "NVDAx, AAPLx. Tracks earnings dates and
gaps out before prints." · Stable yield / "Staked SOL and T-bill tokens. Funds the agent's dry
powder."
**State** `weights[3]` (default 55/30/15), ±5 per tap. Total must equal 100 to approve — CTA reads
"Balance to 100% first" (disabled), then "Approve & fund", then "Portfolio approved ✓". Total color
`up` at 100, `warn` otherwise. Any weight edit clears `approved`.

---

## Group B — Core trading

### 1. Onboarding splash
Wordmark "ORBIT" 42/800, tagline "Your crypto & stocks AI desk". A card previewing the wallet
(large $63.28, red delta chip, three grey placeholder pills, three faced orbs). Blue `#29A3F5` CTA
"Get started" + terms line. The only screen using blue — it's pre-account, before the P&L color
law applies.

### 2. Wallet home
**Layout** Gear / "Wallets ⌄" / ··· header. Eyebrow "Total value", $4,862.18 at 46/700, `up` delta
chip. Three equal action pills (Send / Swap / More) — `flex:1`, gutter-padded, never fixed-width.
Cash row. "Agents ›" header with count. Two 106px agent cards (`surface`, radius 20px) with faced
orbs, name, status. "Coins ›" → Solana row + a staking note strip. Floating chat pill
(white, 46px, right-aligned, shadow `0 8px 24px rgba(0,0,0,.55)`) above a full-width tab bar.
**Copy** "You can earn **12.6% yield** every day on your SOL through staking"
**State** `stocksPaused` — tapping an agent card toggles Active ↔ Paused.

### 24. Markets — all asset classes (live)
**Purpose** The full tradable universe, one class at a time.
**Layout** "Markets" 22/700 + search circle. Horizontally scrolling class pills (Crypto / Stocks /
Commodities / Indices / Pre-IPO) — `flex:none`, `overflow-x:auto`. A two-part caption row: class
note left (max 220px, 11.5px), "{n} shown · 24/7" right. `flex:1` list of 66px rows: 34px gradient
mark, symbol + "{name} · {tag}", price + change. Footer "See all {n} …" link. Tab bar.
**Data** `data/markets.json` — 9 crypto, 9 equities, 9 commodities, 9 indices, 9 pre-IPO (45 total).
**State** `mkt` 0–4, `tab5`.

### 5. Watchlist (live)
Earlier, lighter variant of 24: "Markets" title, five scrolling tabs, group eyebrow +
"{n} markets · 24h", 64px rows with a 90×30 white sparkline between symbol and price. Footer is a
**white** floating bar (gear / "Wallets ⌄" / ···) — an alternative to the tab bar; ship one, not
both. Tabs: Conviction List / Metals / Stocks / Defi / Overview.

### 13. Asset detail
Back / mark + "Solana" / star. $88.32 at 42/700 + "up 2.4% today". 170px area chart with gradient
fill. Range pills 1D/1W/1M/1Y/All. Three rows: Your position 1,750.30 SOL · Avg cost $81.14 ·
Unrealised +$12,566. Agent note: "Momentum Scout holds this. It'll trim at $91.20 unless you say
otherwise." Sell (`control`) / Buy (white).

### 21. Pro chart
BTC/USD. $66,560 at 38/700, +0.67% chip, "+$442 today". 230px candlestick using the **tight**
projection: 4 grid lines, 12 candles, a 56px right price axis derived from the projection, dashed
mark line + white chip. 42px volume row beneath. Timeframe pills 15m/**1H**/4H/1D/1W. Agent note:
"Three green closes off the $65.2K shelf. Momentum Scout is watching for a break of $66.6K to add."
Short (`control`) / Long (`#16C060`).

### 25. Gold perpetual — contract (live)
**Purpose** Show how a commodity perp differs from spot: no expiry, funding, liquidation.
**Layout** XAUT/USDT header. $3,412.10 + `up` change. Three tag chips: PERPETUAL (amber-tinted) /
NO EXPIRY / SPOT FEED. 132px gold area chart. Leverage card: "Leverage / on $800 margin" + 22/700
multiplier, 2×/5×/10× segmented, then Position size / Liquidation / Funding rows and a warning line
that changes color with leverage. 2×2 stat grid (1px gaps over `rgba(255,255,255,.06)`, so the
gutters read as hairlines): Open interest $182.4M · 24h volume $1.06B · Mark vs index +$0.42 ·
Next funding 02:14:38. Short (`control`) / Long (`#F5CE5F` on `#1A1204`). Tab bar.
**State** `lev` ∈ {2,5,10}. Notional = 800 × lev. Liq = 3412.10 × (1 − 0.92/lev).
Warning: 46% / 18% / 9% adverse move, colored `ink40` / `warn` / `down`.

### 14. Order ticket (live keypad)
**White sheet**, radius 30px 30px 0 0. "Solana" title + ✕. Buy/Sell segmented on `#F2F2F5`.
52/700 amount + unit conversion (÷88.32, 4dp). Quick pills $100 / $500 / Max. 3×4 numeric keypad
(56px rows, 24px glyphs, hover `#F2F2F5`) — keys 1-9, ".", 0, "⌫". Fee row (0.1%). CTA
"{side} ${amount} of SOL", `#16C060` buy / `#EF3B36` sell. Footnote "Auto Close is on:
TP +1.0% / SL −1.0%".
**State** `orderAmt` string, `side`. Max 7 chars, one decimal point.

### 6. Auto Close (live TP/SL)
**Purpose** Set take-profit and stop-loss against the chart, with P&L shown before committing.
**White sheet.** "Auto Close" + ✕. Chart region `flex:1; min-height:230px` — **the chart takes the
leftover height, not a spacer.** Contains: TP wash band from the top, SL wash from the bottom,
12 candles on the **wide** projection, a "Mark $66,560" chip at left, and TP/SL marker rows
(pill left "✕ Take Profit", price pill right) at their projected prices. Time axis
1:30 PM / 5:30 PM / 10:00 PM. Below: two control blocks (label + stepper with a colored value pill,
then a 22px ruler with a colored marker), gap 26px. Cancel (`#E4F7EC` on `#16A254`) / Set
(`#16C060`). Footnote "Make **{tpPnl}** at TP or lose **{slPnl}** at SL".
**State** `tp` 0.5–3.0%, `sl` −0.5 to −3.0%, 0.5 steps. Mid 66,000; size $2,500.

### 22. Position & close (live)
Mark + "BTC long" + "2× lev" chip. Eyebrow + "+$318.40" at 46/700 in `up`, "+4.2% on $7,600
notional". Stat card: Entry $63,880 / Mark $66,560 / Liquidation $58,110 (`down`) / Funding paid
−$4.22. Close card: percentage + a 6px fill bar + 25/50/75/100 pills + "Realises **{x}** and frees
**{y}** of margin." Edit TP/SL (`flex:1`) / "Close {n}%" (`flex:1.3`, white).
**State** `closePct` ∈ {25,50,75,100}, default 50. Realises 318.40 × pct; frees 3,800 × pct.

### 19. Swap (live)
Back / "Swap" / gear. Pay card (`surface`, radius 26px): eyebrow + "Balance 1,750.30", 32/700
amount + USD line, token selector pill, then a −/track/+ row. A 40px ⇅ circle with a `3px solid
#000` ring overlaps the seam (`margin:-14px 0`, `z-index:2`). Receive card mirrors it. Rows:
Route "Best of 3 venues" / Fee / Max slippage 0.30%. "Review swap".
**State** `swapAmt` 1–1750, ±4. Out = amt × 88.32 × 0.9975; fee 0.25%.

---

## Group C — Agents

### 3. Agent intro sheet
Full-bleed `surface` card, radius 34px, with a ✕ at top-right. 104px amber orb, "Stocks Trader",
"Autonomous stock trading agent". Three benefit blocks (22px outline glyph — circle, rounded
square, rotated square — + title + 12.5/1.5 body), gap 26px. White "Get Started". Footnote
"All agents can make mistakes. Markets are risky."
**Copy** Runs for you 24/7 / "Keeps watching your markets and running your rules, even when you're
offline." · Never miss big moves / "Tracks big price moves and key news, then triggers your preset
actions." · You're always in control / "Set limits, edit or pause strategies anytime. The agent
never trades outside your rules."

### 4. Trade settings (live)
Header block (name + description + ✕). Card: 34px violet ⚡ orb, "Trade Settings" + chevron, then
"You can change these anytime. The agent always stays within these limits." Four 56px rows —
Run For (pill, cycles 1/3/7/30 Days) · Trade Autonomously (switch **plus** a state caption) ·
Risk Level (pill, Low/Medium/High) · Daily Spend Cap (stepper, $200–$5,000 by $200). Under the cap:
a 6px green→amber→red gradient rail with a white marker at `(cap−200)/4800`, and endpoint labels
"$200 · conservative" / "$5,000 · max". CTA "Run Agent" / "Save Settings".

### 11. Hire agents (live)
"Agents" + "{n} of 4 hired". Four cards (`surface`, radius 24px, padding 16px): 52px orb, name,
role, `up` metric, and a Hire/Hired pill (white/`#000` → `rgba(43,216,122,.15)`/`#2BD87A`).
Footnote "Past performance of a strategy says nothing about tomorrow."
**Data** Momentum Scout / Rides breakouts on liquid majors / 61% win rate · Earnings Desk / Trades
tokenized equity earnings / 54% win rate · Yield Keeper / Moves idle cash into best APY / 12.6% APY
· Drawdown Guard / Cuts risk when the book bleeds / Always on

### 12. Agent chat + approval (live)
**The most important screen in the app.** Header: 34px orb, name, "Watching 14 markets" in `up`.
Thread: a date divider, an agent bubble (`#111214`, radius `20 20 20 6`, max-width 78%), then a
**proposed-trade card** — "PROPOSED TRADE" eyebrow in `up` + "expires 4:12", "Buy 12.4 SOL" 21/700
+ "$1,095", three 14px stat tiles (Entry $88.32 / Stop $87.44 in `down` / Target $91.20 in `up`),
rationale "Risking $10.90 to make $35.70. Within your $1,600 daily cap.", then Skip (`flex:1`,
`control`) / Approve (`flex:1.4`, white). On decision the buttons are replaced by a reply bubble:
approve → "Filled 12.4 SOL at $88.32. Stop set at $87.44." (`up`); skip → "Skipped. I will not
re-propose SOL today." (`down`). Composer: "Ask about this trade…".
**Copy (opening)** "SOL just cleared its 20-day high on twice the usual volume. Funding is still
flat, so this isn't a crowded long yet."

### 16. Agent leaderboard (live sort)
"Leaderboard" + sort circle. Subtitle "How your agents are actually doing against each other. Fire
the laggards." Segmented: P&L / Win rate / Volume. Four cards, each: rank ("01" in `#F0BE55` for
first, else `ink30`), 38px orb, name + "{win}% win · {n} trades", P&L 15/700 signed, then a 4px
bar normalised to the max (`transition: width .25s`). Footer "Ranked by {metric} · last 30 days".
**Data** Momentum Scout +$842 / 61% / 37 · Yield Keeper +$318 / 94% / 11 · Earnings Desk +$1,204 /
54% / 22 · Drawdown Guard −$96 / 48% / 8

### 17. Backtest (live)
Back + "Backtest". "Momentum Scout, run against real history at your current limits. Nothing here
is a promise." Lookback pills 30d / **90d** / 6m / 1y. 150px equity curve with 3 grid lines. Four
stat tiles: Return (`up`) / Max DD (`down`, shown with U+2212) / Sharpe / Trades. Card: "If you'd
started with" + a capital stepper ($1k–$50k by $1k), then the projected end value 30/700 and the
gain in `up`. "Run this strategy live".
**Data** 30d +4.2% / −2.1% / 1.4 / 18 · 90d +11.8% / −5.4% / 1.7 / 54 · 6m +23.5% / −9.2% / 1.2 /
121 · 1y +41.9% / −14.6% / 1.1 / 244

### 20. Kill switch (live)
Back + "Safety". A state chip (7px dot + "LIVE"/"STOPPED"). Title + explanation, both state-driven.
Three consequence cards, each a 9px dot + label + detail: New orders (`down`, "Stopped
immediately") · Stops and take-profits (`up`, "Stay active — your risk is still covered") · Open
positions (`up`, "Left exactly as they are"). Three settings rows: Face ID for every payout (On) /
Withdrawal allowlist (2 addresses) / Recovery phrase (Not backed up, `warn`). A 56px/700 button —
`#EF3B36` "Stop all agents" ↔ white "Resume agents". Footnote "Takes effect in under a second
across every device."
**Copy (live)** "Agents are live" / "3 agents can place orders inside your limits right now."
**Copy (stopped)** "All agents stopped" / "Nothing will be placed until you resume. Open positions
are untouched."

---

## Group D — Awareness

### 15. Activity / audit log (live filters)
"Activity" + "Every action an agent took, and every one it chose not to take." Filter pills All /
Trades / Risk / Blocked. Rows: an 8px classification dot (`up` acted / `warn` risk / `down`
blocked), then action + detail + "{agent} · {time}", with a right-aligned amount (`up` for credits,
`ink55` for debits). Empty state "Nothing here yet." Ghost button "Export audit trail" — the
structured trail is the compliance artifact, so it stays a first-class action.
**Data** 09:41 Bought 4.2 SOL / "Breakout above 20d high · $88.10 avg" / −$370.02 · 09:12 Stop loss
moved / "Trailing to −1.0% after +2.4% run" · 08:55 Skipped NVDAx / "Spread 0.42% > your 0.25%
limit" · Yst Staked 120 SOL / "12.6% APY · unlock in 3 days" / +$4.11/day · Yst Take profit hit /
"Closed HYPE at +1.8%" / +$44.90

### 18. Alerts (live toggles)
"Alerts" + "{n} of 5 on". "The agents watch everything. These are the moments they interrupt you
for." Five 70px switch rows. Note strip: "Circuit breakers stay on even when notifications are
muted. They stop trading, not just your phone." Ghost "Add custom alert".
**Data** SOL above $95 / Price alert · push + agent note · ON · NVDAx earnings / 48h before the
print · ON · Agent hits daily cap / So you can raise it or stop · Drawdown past 5% /
Whole-portfolio circuit breaker · Staking unlock ready / 120 SOL, 3 days out

### 23. News, with agent takes
"Briefing" + "Updated 18m ago". "Only what moved your book, and what each agent did about it."
Three cards: a class tag chip + relative time, headline 15/600, then a hairline-separated agent
take (8px `up` dot + 11.5/1.5 body). Ghost "Ask for the full rundown".
**Data** MACRO 18m "Fed holds, signals one more cut this year" → "Momentum Scout: risk-on. Raising
crypto sleeve exposure to the top of your band." · EARNINGS 2h "NVDAx reports Thursday after the
close" → "Earnings Desk: flattening the position Wednesday. Spread widens too much into prints." ·
ON-CHAIN 5h "Solana staking yield ticks up to 12.6%" → "Yield Keeper: moved $1,240 of idle cash in.
Unlock is 3 days."
