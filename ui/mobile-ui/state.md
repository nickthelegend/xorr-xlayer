# state.md — state model & derived values

The prototype holds everything in one flat store. In a real app, split it as noted, but keep the
**derived-value formulas exactly** — they're the app's business logic and several were corrected
during review.

## Store

```js
{
  // agent controls (screen 4)          → per-agent config, server-persisted
  auto: true,           // trade without asking
  runFor: 1,            // index into ['1 Day','3 Days','7 Days','30 Days']
  risk: 0,              // index into ['Low','Medium','High']
  cap: 1600,            // daily spend cap, $200–$5000 step 200
  stocksPaused: false,

  // markets                            → client UI state
  tab: 0,               // watchlist group (screen 5)
  mkt: 2,               // asset class (screen 24), default Commodities
  tab5: 1,              // bottom tab, default Markets

  // auto close (screen 6)              → per-position order params
  tp: 1.0,              // take profit %, 0.5–3.0 step 0.5
  sl: -1.0,             // stop loss %, -0.5 to -3.0 step 0.5

  // order entry
  orderAmt: '250',      // string — it's keypad input, not a number
  side: 'buy',
  lev: 5,               // 2 | 5 | 10
  closePct: 50,         // 25 | 50 | 75 | 100
  swapAmt: 12,          // SOL, 1–1750 step 4

  // onboarding                         → server-persisted profile
  goals: ['Grow long term'],
  riskQ: 1,             // 0–2 → Steady | Balanced | Aggressive
  weights: [55, 30, 15],
  approved: false,
  kyc: 1,               // 0–4 completed steps
  dep: 500, method: 0,

  // agents & alerts
  hired: { 'Momentum Scout': true },
  alerts: { 'SOL above $95': true, 'NVDAx earnings': true },
  decision: null,       // null | 'yes' | 'no' — chat trade proposal
  killed: false,        // kill switch

  // views
  actFilter: 0,         // 0 All | 1 Trades | 2 Risk | 3 Blocked
  lbSort: 0,            // 0 P&L | 1 Win rate | 2 Volume
  btLook: 1, btCapital: 5000
}
```

## Derived values

```js
// ── Agent controls
autoNote = auto ? 'Executes inside your limits without asking'
                : 'Every trade waits for your approval'
capLabel   = money(cap) + '/day'
capMarker  = ((cap - 200) / 4800 * 100) + '%'
runLabel   = auto ? 'Run Agent' : 'Save Settings'
switchKnob = auto ? 'translateX(21px)' : 'translateX(0px)'

// ── Auto Close  (mid = 66000, size = $2500)
tpPrice = mid * (1 + tp/100)          slPrice = mid * (1 + sl/100)
tpPnl   = size * tp / 100             slPnl   = |size * sl / 100|
// positions use the WIDE projection, which brackets the TP/SL prices:
hi = max(maxHigh, tpPrice) + 150      lo = min(minLow, slPrice) - 150
y  = v => (hi - v) / (hi - lo) * 100
tpLineTop = y(tpPrice)   slLineTop = y(slPrice)
tpZoneH   = y(tpPrice)   slZoneH   = 100 - y(slPrice)   // washes from top / bottom
tpTick = 20 + tp*22 + '%'   slTick = 80 + sl*22 + '%'   // ruler markers
// the pro chart uses the TIGHT projection instead:
tHi = maxHigh + 120   tLo = minLow - 120

// ── Order ticket
orderUnits = (amt / 88.32).toFixed(4) + ' SOL'
orderFee   = amt * 0.001
orderCta   = (side==='buy' ? 'Buy ' : 'Sell ') + '$' + orderAmt + ' of SOL'
// keypad: max 7 chars, single '.', '⌫' pops last, leading '0' replaced by a digit

// ── Leverage (margin = 800, gold = 3412.10)
notional = 800 * lev
liq      = 3412.10 * (1 - 0.92 / lev)
warn     = lev>=10 ? 'A 9% move against you wipes the margin.'
         : lev>=5  ? 'A 18% move against you wipes the margin.'
                   : 'A 46% move against you wipes the margin.'
warnColor= lev>=10 ? down : lev>=5 ? warn : ink40

// ── Position close (unrealised = 318.40, margin = 3800)
closeRealise = 318.40 * closePct/100
closeFree    = 3800   * closePct/100
closeCta     = closePct===100 ? 'Close position' : 'Close ' + closePct + '%'

// ── Swap
swapOut = swapAmt * 88.32 * 0.9975    swapFee = swapAmt * 88.32 * 0.0025
swapPct = swapAmt / 1750 * 100 + '%'

// ── Portfolio proposal
total        = sum(weights)
barW[i]      = weights[i] / max(total,1) * 100 + '%'
canApprove   = total === 100
proposalCta  = approved ? 'Portfolio approved ✓'
             : canApprove ? 'Approve & fund' : 'Balance to 100% first'
// any weight edit sets approved = false

// ── Onboarding
kycPct  = kyc / 4 * 100 + '%'
kycCta  = kyc >= 4 ? 'You are verified' : 'Continue — ' + steps[kyc].label
depFee  = method===1 ? dep * 0.015 : 0
depLands= ['Tue, Sep 8', 'Right away', 'After 1 confirmation'][method]

// ── Backtest
btEnd  = btCapital * (1 + ret/100)
btGain = btEnd - btCapital
btDd   = '\u2212' + |dd| + '%'        // U+2212, not a hyphen

// ── Leaderboard
sorted  = agents.sort((a,b) => b[key] - a[key])   // key: pnl | win | trades
barW[i] = |pnl[i]| / 1204 * 100 + '%'             // 1204 = max abs P&L
rankFg  = i===0 ? '#F0BE55' : ink30

// ── Kill switch
killTitle = killed ? 'All agents stopped' : 'Agents are live'
killCta   = killed ? 'Resume agents' : 'Stop all agents'
tabDot    = killed ? ink30 : up      // drives the Agents tab badge

// ── Activity
rows = activity.filter(a => !kindFor[actFilter] || a.kind === kindFor[actFilter])
// kindFor = [null, 'trade', 'risk', 'block']; dot = block→down, risk→warn, else up
amountColor = amount.startsWith('\u2212') ? ink55 : up
```

## Formatting rules

- **`toLocaleString('en-US', {minimumFractionDigits:2, maximumFractionDigits:2})`** for any money
  that can exceed 999. Bare `toFixed(2)` drops thousands separators — a real review finding on the
  swap screen.
- **U+2212 (−), not a hyphen**, for negative numbers. Applies to Max DD, funding paid, debits.
- Percentages: 1dp with an explicit sign (`+1.0%`, `−1.0%`).
- Crypto quantities: 4dp (SOL), 2dp for display balances.
- Prices ≥ 1000: no decimals plus separators (`$66,560`). Under 1000: 2dp. Sub-dollar: 4dp.
