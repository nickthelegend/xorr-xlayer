# The strategy book

313 strategies, measured, with the evidence that earned each one its tier.

Regenerated from the research engine that preceded this app — `/Volumes/Extreme SSD/Projects/xorr`:

```
cd backend && . .venv/bin/activate
python -m backtest.export_catalog --out ../../xorr-xlayer/server/data/strategies
```

`index.json` is the whole book in summary, 112 KB. `detail/<slug>.json` is one strategy: its equity curve,
its distribution, its side split, its profit structure and up to 150 of its trades.

## What the numbers are

Every registered strategy replayed over 17,520 hourly candles — two years to 2026-08-31 — across nine
symbols (BTC, ETH, SOL, BNB, XRP, DOGE, ADA, AVAX, LINK), at 6 bps a side, flat 10% of capital per
position, unlevered, from $100.

The window is split in half. The first half is the data each rule was shaped against; the second is data
it had never seen, and the second is what the app headlines. Several strategies here lose money on the
half they were fitted to and make it on the half they did not — which is the shape of a real effect, and
the reason both halves are on screen together.

## What the tiers mean

- **verified** — passed the four-way gauntlet: out-of-sample, a ±30% parameter sweep, doubled commission,
  and a second universe. 10 of 313.
- **measured** — measured positive on unseen data, without the full four-way evidence. 65 of 313.
- **archive** — measured, and it did not hold. 238 of 313, kept in the book on purpose.

## Rules this data follows

- Nothing is invented to fill a field. A strategy that took no trades on the unseen half has no win rate
  and no profit factor: the key is absent, never zero.
- Under 30 unseen trades a row is `trusted: false`. The return is real; the interval around it is wide.
- The export loads the instrument universe before it replays anything, as the gauntlet does. Every `_perp`
  strategy asks whether a symbol is listed before it will trade it, and an export run without the universe
  replayed all 44 of them to zero trades — the book said each "took no trades on the unseen half" while the
  gauntlet had traded them hundreds of times on the same candles. The export now refuses to run without it.
  258 of 313 took at least one trade on the unseen half; 150 took 30 or more.
- Gross, costs and net reconcile. The research engine's per-trade `pnl_usd` is net of the exit fee only —
  the entry fee is charged to cash when the position opens — so the export builds the structure from the
  trade log's own `gross_usd` and `fees_usd`, and `catalog.test.ts` asserts the three sum to the account's
  own result.

These are backtests over recorded candles. Nothing here traded real money, and none of it is a forecast.
