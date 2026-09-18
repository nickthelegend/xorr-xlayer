# Orbit — mobile trading UI handoff

Agent-driven trading app: crypto, tokenized equities, commodity perps, indices, pre-IPO.
25 mobile screens, all designed at **402 × 874** (iPhone 16 Pro logical resolution).

## Read these in order

| File | What's in it |
|---|---|
| `README.md` | This file. Orientation, stack guidance, build order. |
| `design.md` | Design tokens, layout system, component recipes. **Start here for anything visual.** |
| `screens.md` | All 25 screens: purpose, layout, exact content, interactive state. |
| `animations.md` | Every transition, duration, easing, and the motion rules. |
| `state.md` | The full state model + every derived value and its formula. |
| `data/markets.json` | The complete asset universe (5 classes, 45 instruments — 9 per class) as data. |
| `data/copy.json` | Every string in the app, keyed by screen. |
| `reference/` | The original HTML prototype. Open in a browser to interact with it. |

## About the reference files

`reference/Orbit Trading App.dc.html` is a **design reference**, not production code. It's a
single-file HTML prototype: inline styles, a template dialect, and one logic class. Do not port
it line by line and do not copy its architecture.

The job is to **rebuild these screens natively** in the target codebase using that codebase's
existing component library, navigation, theming and state patterns. Open the prototype, interact
with it, use it to resolve any ambiguity in these docs — the prototype is the source of truth for
look and feel; `design.md` is the source of truth for values.

If there is no codebase yet: React Native (Expo) is the closest fit. Everything here is designed
around native mobile primitives — safe-area insets, a 5-tab bottom navigator, bottom sheets,
44pt minimum hit targets. `react-native-reanimated` covers all the motion in `animations.md`;
`react-native-svg` covers the charts.

## Fidelity

**High fidelity.** Colors, type sizes, spacing, radii and copy are all final and exact — recreate
them precisely. The only deliberately loose parts:

- **Chart data is illustrative.** The OHLC series, sparklines and equity curves are hand-authored
  so the visuals read correctly. Wire them to real feeds; keep the projection math in `design.md`.
- **Agent avatars are CSS radial gradients** standing in for real character art. They look
  intentional at this size, but a designer should replace them with actual illustrated spheres.
- **Icons** are hand-drawn inline SVG paths (24×24, 1.8 stroke, round caps). Swap for the
  codebase's icon set at the same optical weight.

## Build order

1. **Tokens + shell** — colors, type scale, the `Screen` container, safe-area padding, the 5-tab
   bottom navigator (`design.md` §1–4). Nothing else works until the shell is right.
2. **Primitives** — `Row` (hairline list row), `Pill`, `Segmented`, `Stepper`, `Switch`,
   `AgentOrb`, `SheetCard`, `PrimaryButton` (`design.md` §5). These 8 build 90% of the app.
3. **Markets + asset detail + order ticket** — the core trading loop (screens 24, 13, 14).
4. **Charts** — candlestick, area, volume, sparkline (`design.md` §6). Highest-risk piece; the
   candle projection is documented exactly.
5. **Agent surfaces** — roster, controls, chat with approve-before-execute, leaderboard, backtest.
6. **Onboarding** — goals, KYC, funding, portfolio proposal (screens 7–10).
7. **Everything else** — alerts, swap, kill switch, activity, news.

## The one product rule

Green and red mean **profit and loss, nothing else**. Never use them for selection, focus,
branding or emphasis. Selection is white-on-dark. This is why the app has no accent color: on a
trading surface, a second meaning for green is a bug.
