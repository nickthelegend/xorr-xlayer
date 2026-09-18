# design.md — tokens, layout, components

Everything below is exact. Where a value looks arbitrary (`.055`, `13.5px`) it is deliberate.

---

## 1. Color

### Surfaces
| Token | Value | Use |
|---|---|---|
| `bg` | `#000000` | Screen background. True black, never a dark grey. |
| `surface` | `#0C0C0D` | Cards, sheets, panels sitting on `bg`. |
| `surfaceAlt` | `#141516` | Icon buttons, inactive tabs. |
| `control` | `#1B1C1E` | Pills, steppers, secondary buttons. |
| `controlHover` | `#252629` | Hover/press on `control`. |
| `switchOff` | `#2A2B2E` | Switch track, off. |
| `inputBg` | `#121213` | Chat composer field. |

### Light sheet (Auto Close, Order ticket only)
| Token | Value | Use |
|---|---|---|
| `sheetBg` | `#FFFFFF` | Sheet body. |
| `sheetInk` | `#0B0B0B` | Primary text on white. |
| `sheetMuted` | `#8A8A90` | Secondary text. |
| `sheetDim` | `#9A9A9F` | Tertiary / footnotes. |
| `sheetFill` | `#F2F2F5` | Steppers, segmented track on white. |
| `sheetTick` | `#E4E4E9` | Ruler tick marks. |

### Ink on black
| Token | Value | Use |
|---|---|---|
| `ink` | `#FFFFFF` | Primary text, values, active labels. |
| `ink70` | `rgba(255,255,255,.7)` | Secondary button labels. |
| `ink55` | `rgba(255,255,255,.55)` | Icon glyphs, chevrons. |
| `ink45` | `rgba(255,255,255,.45)` | Agent-note body copy. |
| `ink40` | `rgba(255,255,255,.4)` | Screen subtitles. |
| `ink38` | `rgba(255,255,255,.38)` | List row secondary line. |
| `ink35` | `rgba(255,255,255,.35)` | Placeholder text. |
| `ink32` | `rgba(255,255,255,.32)` | Eyebrow labels, disabled. |
| `ink30` | `rgba(255,255,255,.3)` | Inactive tab icon+label. |
| `ink28` | `rgba(255,255,255,.28)` | Footnotes, counts. |

### Hairlines & borders
| Token | Value | Use |
|---|---|---|
| `hairline` | `1px solid rgba(255,255,255,.05)` | List row dividers. **The most-used border in the app.** |
| `hairlineStrong` | `1px solid rgba(255,255,255,.055)` | Tab-bar top edge, section splits. |
| `cardBorder` | `1px solid rgba(255,255,255,.06)` | Card and sheet outlines. |
| `inputBorder` | `1px solid rgba(255,255,255,.07)` | Composer, segmented track. |
| `ghostBorder` | `1px solid rgba(255,255,255,.09)` | Ghost/outline buttons. |
| `selectedBorder` | `1px solid rgba(255,255,255,.55)` | Selected radio card (funding). |

### Semantic — P&L ONLY
| Token | Value | Use |
|---|---|---|
| `up` | `#2BD87A` | Gains, active agent status, positive delta. |
| `upBg` | `rgba(43,216,122,.14)` | Delta chip background. |
| `upInk` | `#04160C` | Text on a solid `up` fill. |
| `down` | `#FF453A` | Losses, negative delta, stop loss. |
| `downBg` | `rgba(255,69,58,.14)` | Negative delta chip. |
| `warn` | `#E8C64A` | Caution: risk mid-band, unbacked recovery phrase. |
| `candleUp` | `#16C060` | Bullish candle body+wick, TP band. Deeper than `up` so it holds against white. |
| `candleDown` | `#EF3B36` | Bearish candle, SL band. |
| `tpZone` | `rgba(22,192,96,.10)` | Take-profit region wash. |
| `slZone` | `rgba(255,69,58,.09)` | Stop-loss region wash. |

**Rule: green and red are reserved for P&L.** Selection state is white-on-dark, never green.

### Agent identity gradients
Each agent is `radial-gradient(circle at 32% 26%, <c1>, <c2> 74%)` — the off-center origin is the
specular highlight and must not move.

| Agent | c1 | c2 |
|---|---|---|
| Momentum Scout / Signals | `#5B93FF` | `#1B44CE` |
| Earnings Desk / Stocks | `#F0BE55` | `#C98518` |
| Yield Keeper / Crypto | `#49E39B` | `#12A45F` |
| Drawdown Guard | `#B58CFF` | `#7A45E0` |
| Portfolio strategist | `#C79BFF` | `#7B3FE4` |

Asset marks reuse the same recipe — see `data/markets.json`, every instrument carries `c1`/`c2`.

---

## 2. Type

**Inter, bundled with the app.** Weights 400/500/600/700/800 ship as assets and are loaded before
the first paint.

This section used to read "System sans (`-apple-system`). No custom font — a trading UI needs the
platform's numeral metrics." That reasoning was sound and the conclusion was still wrong, because
`-apple-system` is not one font. The reference in `reference/` was authored and reviewed in a
browser on a Mac, so every screen in it renders in **SF Pro** — while on Android the same rule
resolves to **Roboto**, whose letterforms and widths are visibly different, and the negative
letter-spacing below (−2px on a 52px amount) was tuned against SF Pro. The app did not look like
its own design on half the devices it runs on.

Inter is the closest open-licensed face to SF Pro's metrics, and — the part that actually matters —
it is identical on every platform. The design is now something the app carries rather than
something it hopes to find.

**Baloo 2 ExtraBold** is the display face, used for the wordmark and nothing else, exactly as
`reference/Orbit Trading App.dc.html` uses it (`font-family:'Baloo 2'`, weight 800, 42px).

| Role | Size | Weight | Extra |
|---|---|---|---|
| Hero balance | 46px | 700 | `letter-spacing:-1.4px` |
| Hero (keypad amount) | 52px | 700 | `-2px` |
| Price large | 36–42px | 700 | `-1.2px` |
| P&L hero | 46px | 700 | `-1.4px` |
| Onboarding title | 26px | 700 | `line-height:1.2` |
| Screen title | 22px | 700 | — |
| Sheet title | 19px | 700 | — |
| Card title | 16–17px | 600–700 | — |
| List row primary | 14.5–15.5px | 600 | — |
| Body / row label | 13.5–14.5px | 500 | `line-height:1.5` |
| Secondary line | 11.5–12.5px | 400–500 | `line-height:1.45` |
| Eyebrow | 10–11px | 600 | `letter-spacing:.12em`, uppercase |
| Tag / badge | 9.5–10px | 700 | `letter-spacing:.09em`, uppercase |
| Tab label | 9.5px | 600 | `letter-spacing:.03em` |
| Footnote | 10.5–11px | 400 | — |

**Nothing below 9.5px.** Tabular numerals on every price column and every stepper value.

---

## 3. Space, radius, shadow

**Spacing** — 2, 4, 6, 8, 10, 12, 14, 16, 18, 20, 22, 26, 30, 34, 38, 44. Screen gutter is **20px**
(sheet-edge screens use 16px so the card's own padding makes up the difference).

**Radius**
| Value | Use |
|---|---|
| 4–6px | Tab icon glyph boxes |
| 11–12px | Asset squares, small icon buttons |
| 14–16px | Inline stat tiles, chat cards |
| 18–20px | Agent cards, alert cards, note strips |
| 22–26px | Content cards, radio cards, segmented tracks |
| 30–34px | Sheets, primary buttons (pill), full-bleed panels |
| 50% | Avatars, orbs, steppers, circular icon buttons |

**Shadows** — almost none. Two only:
- Switch knob: `0 1px 3px rgba(0,0,0,.4)`
- Floating chat pill: `0 8px 24px rgba(0,0,0,.55)`

Candle bodies carry a bloom, not a shadow: `0 0 10px rgba(22,192,96,.35)` up /
`0 0 10px rgba(239,59,54,.32)` down. This is what makes the charts read as premium — keep it.

---

## 4. Screen shell & navigation

Every screen: `height:100%; background:#000; display:flex; flex-direction:column`.
Top padding **54px** (status bar + breathing room). Bottom padding **26px**, or **22px** when a
tab bar is present.

**Layout law:** the *content* region takes `flex:1`, never a trailing spacer. An empty
`<div flex:1>` above a footer collects all leftover height and produces a visible hole — this bug
appeared twice in review. Give `flex:1` to the chart, the list, or the scroll area.

### Bottom tab bar
5 destinations, `flex:1` each, `padding:8px 8px 22px`, top edge `hairlineStrong`.
Per tab: 21×21 inline SVG (`viewBox 0 0 24 24`, `stroke-width 1.8`, round cap+join, no fill) over
a 9.5px/600 label, `gap:5px`.

| Tab | Icon |
|---|---|
| Home | House: `M3 10.5 L12 3.5 L21 10.5 V20 a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1Z` + door `M9.5 21v-6h5v6` |
| Markets | Axes `M4 4v16h16` + line `M7.5 15.5 L11 11 L14 13.5 L19.5 7` |
| Agents | Circle r=8.5, two filled eye dots r=1.15 at (9.3,10.4)/(14.7,10.4), smile `M9.4 15.2a3.6 3.6 0 0 0 5.2 0` |
| Trade | Two opposed arrows: `M7 4v16` `M4 7.5 L7 4 L10 7.5` `M17 20V4` `M20 16.5 L17 20 L14 16.5` |
| Assets | Card `rect x3 y6.5 w18 h13 rx2.5` + stripe `M3 10.5h18` + chip `M16.5 15h2` |

Active `#fff`, inactive `rgba(255,255,255,.3)` — applied to icon and label together via
`currentColor`. **Agents carries a 6px status dot** at `top:-1px; right:-3px`, `#2BD87A` when
agents are live and `rgba(255,255,255,.3)` when stopped — the only always-visible signal that
something is trading on the user's behalf. Wire it to the kill-switch state.

Agents sits center because agent supervision, not order entry, is what distinguishes this app.

---

## 5. Component recipes

### Row — hairline list row
```
height 48–66px · display:flex · align-items:center · gap:12px
border-bottom: hairline · no horizontal padding (the screen gutter provides it)
[mark 30–34px] [primary 14.5/600 + secondary 11.5/ink38 (gap 2px)] [flex:1] [value 14.5/600 right-aligned + delta 12/500]
```
Never wrap the last row's border — drop `border-bottom` on the final item or accept it as a
section terminator (the app does the latter consistently).

### Pill — filter / segment chip
`height 34px · padding 0 14px · radius 20px · 13px/600`. Selected `#fff` on `#0B0B0B`;
unselected `#141516` on `ink50`. Rows of pills: `overflow-x:auto`, `flex:none` per pill,
`scrollbar-width:none`. **Pills must never shrink to fit** — the market tabs broke this way; they
scroll horizontally instead.

### Segmented — 2–3 exclusive options
Track `padding 3–4px · radius 14–24px · background rgba(255,255,255,.05)` (or `#111214` +
`inputBorder` on black). Thumb `flex:1 · height 34–42px · radius 11–22px`, selected `#fff`/
`#0B0B0B`, `transition: background .15s`.

### Stepper
`[26px circle −] [value 14.5/700, min-width 70–88px, center] [26px circle +]`, gap 8–10px,
circles `#1B1C1E` (dark) or `#F2F2F5` (light sheet), glyph 15px. Fixed `min-width` on the value is
mandatory — without it the row jitters as digits change.

### Switch
Track `50×30` (alerts `48×29`) `radius 15px · padding 2px`. Knob `26×26` white, shadow
`0 1px 3px rgba(0,0,0,.4)`. On `#2BD87A`, off `#2A2B2E`. `transform: translateX(0 → 19–21px)`,
`transition: transform .18s, background .18s`. **Always paired with a caption line that changes
with state** — see `autoNote` in `state.md`; a bare switch label is not enough on a screen where
the toggle authorises autonomous spending.

### AgentOrb
```
size 52 / 56 / 70 / 74 / 84 / 104px · border-radius 50%
background: radial-gradient(circle at 32% 26%, c1, c2 74%)
optional bloom: 0 14px 40px rgba(<c1>,.4)
optional specular: absolutely-positioned white ellipse, ~28% width, blur(2–3px), top ~17%, left ~24%
optional face: two 9×13px round-rect eyes at ~40% height, 16×7px smile arc (radius 0 0 12px 12px)
optional badge: P&L chip at top:-8px left:-6px, 10px/700 upInk on up
```
Under the orb: name 12–12.5px/600 white, then status 10.5px/600 — `#2BD87A` Active/New,
`ink40` Paused.

### SheetCard
`background #0C0C0D · border cardBorder · radius 22–34px · padding 16–26px`.
A full-bleed sheet uses `radius: 30px 30px 0 0` and sits at the bottom of the frame.

### PrimaryButton
`height 52–56px · radius 30px · 15.5–16px/600`. Default `#fff` on `#000`, hover
`rgba(255,255,255,.88)`. Destructive `#EF3B36` on `#fff`. Disabled `#1B1C1E` on `ink35`.
Confirmed/success `#2BD87A` on `#04160C`.
Secondary: `#1B1C1E` on white. Ghost: `ghostBorder`, `height 46–48px`, label `ink65`.
**One primary button per screen.** Two-button rows are `flex:1` / `flex:1.3` with the affirmative
action wider and on the right.

### Note strip — agent commentary
```
display:flex · gap 10px · background #0C0C0D · radius 18px · padding 13px
[16–22px orb or dot, flex:none, margin-top 1px] [11.5px/1.5 ink45]
```
Used wherever an agent explains itself. The dot color encodes the event class:
`#2BD87A` acted, `#E8C64A` adjusted risk, `#FF453A` blocked.

---

## 6. Charts

### Candlestick — the centerpiece

Author OHLC in **price space**, then project to percentage of the plot box. Never hand-place pixels.

```js
const y = v => ((hi - v) / (hi - lo)) * 100;   // price → % from top

const up   = close >= open;
const bodyTop = y(Math.max(open, close));
const bodyH   = Math.max(1.4, y(Math.min(open, close)) - bodyTop);  // 1.4% floor = doji
const wickTop = y(high);
const wickH   = y(low) - wickTop;
```

Per candle, inside a `flex:1; position:relative` column (parent `display:flex; gap:6px`):
- **Wick** — `position:absolute; left:50%; translateX(-50%); width:1.6px; radius:2px; opacity:.75–.8`, color = body color, `top:wickTop%; height:wickH%`
- **Body** — `position:absolute; left:0; right:0; radius:3px`, `background` candleUp/candleDown, `box-shadow` bloom, `top:bodyTop%; height:bodyH%`

**Two projections, deliberately.** The same series renders at two scales:
- **Tight** (`tHi = maxHigh + 120`, `tLo = minLow − 120`) — the pro chart. Candles fill the box.
- **Wide** (`hi = max(maxHigh, tpPrice) + 150`, `lo = min(minLow, slPrice) − 150`) — Auto Close.
  The bounds follow the TP/SL prices so both markers stay in frame at any setting.

Using one projection for both is a bug: the wide scale flattens the candles, the tight scale pushes
the TP marker off-canvas. Price axis labels derive from the active projection —
`[0,.25,.5,.75,1].map(t => (tHi - t*(tHi-tLo))/1000)` — never hardcode them.

**Last-price marker** — dashed rule `1px dashed rgba(255,255,255,.22)` (or `rgba(11,11,11,.2)` on
white) at `top: y(lastClose)%`, `transform:translateY(-50%)`, with a chip at the end: white on
black in the dark chart, `#0B0B0B` on white in the light sheet, prefixed `Mark` where a TP chip
occupies the right edge.

### Volume
Row under the candles, `height 42px · align-items:flex-end · gap 6px`, matching the candle gutter.
Bars `flex:1 · radius 2px 2px 0 0`, fill `rgba(22,192,96,.5)` / `rgba(239,59,54,.5)` following
that candle's direction.

### Area / equity curve
SVG `viewBox="0 0 360 110" preserveAspectRatio="none"`. Gradient fill polygon
(`stop-opacity .26–.3` → `0`) under a `stroke-width:2`, `stroke-linejoin/linecap:round` polyline.
Grid lines `rgba(255,255,255,.06)` at 25% intervals, behind the fill. End dot `r=3.2`.

### Sparkline
`90×30` SVG, `stroke #fff`, `stroke-width 1.4`, `stroke-linejoin:round`, no fill,
`opacity:.9`. Sits between the symbol and the price in market rows. Direction is carried by the
adjacent change text, not the line color.

### Ruler (TP/SL scrub track)
`height 22px`, `repeating-linear-gradient(90deg, #E4E4E9 0 1px, transparent 1px 9px)`,
`background-size:100% 12px`, vertically centered. Marker `width 2px`, full height, TP green /
SL red.

---

## 7. Accessibility

- Hit targets ≥44px. Steppers are 26px visually — **expand the touch area**, don't grow the circle.
- Contrast: white on `#000` and on `#0C0C0D` passes everywhere. `ink28`/`ink30` are for
  decorative counts and inactive tabs only; never put a value or an action in them.
- Both P&L colors are paired with a sign (`+`/`−`) or an explicit word, so the information
  survives color blindness. Use `−` (U+2212), not a hyphen, in numeric output.
- Every price and quantity uses `toLocaleString('en-US')` with explicit fraction digits.
  Raw `toFixed()` on a 4-figure number drops the thousands separator — this was a review finding.
