# src/ui — the design system

Tokens, one text primitive, the design.md §5 component recipes and the §6 charts. Screens
compose from here and hold no design values of their own.

Scratch screen: **`app/_dev/ui.tsx`** — every primitive in every state, using the
prototype's own OHLC series and copy, for a side-by-side against
`mobile-ui/reference/Orbit Trading App.dc.html`.

## The three rules that outrank convenience

1. **Green and red mean profit and loss.** Selection is white-on-dark. Reaching for `up`
   to show that something is chosen is a bug. The only greens in here are: P&L text
   (`Price tone="up"`), candle bodies and TP bands, the switch track (design.md §5 names
   it), the agent status word, the `NoteStrip` "acted" dot, the Agents-tab kill-switch
   dot, and `Button variant="success"` — which is a filled order, a P&L fact.
2. **Hit targets ≥44pt.** `Press` grows the touch area to 44 in both axes when the drawn
   control is smaller. The stepper circles stay 26px.
3. **Nothing animates that isn't in animations.md**, and a price never animates at all.
   Only `Switch` (180ms) and `Segmented` (150ms) move; both collapse to an instant state
   change under reduced motion.

## Type

`type.ts` has one variant per design.md §2 role, expanded where §2 gives a size range.
Every variant carries `fontFamily`, `fontSize`, `lineHeight` and `letterSpacing` in
absolute points, and no `fontWeight` — weights are selected by family name
(`Inter_600SemiBold`), because a `fontWeight` on a custom family makes Android synthesise
a fake bold off the regular face.

Load the faces before rendering:

```tsx
const [loaded] = useUiFonts();
if (!loaded) return <Screen />;
```

## Judgement calls, so they're reviewable

- **`platform-notes.md` is missing.** It is not in `xorr-dev.zip` and not anywhere on this
  machine. Its §2 was said to carry the line-heights and letter-spacings precomputed in
  points. They are derived instead: `letterSpacing = em × fontSize`, and
  `lineHeight = ratio × fontSize` using design.md's stated ratios (1.2 / 1.5 / 1.45) and,
  where §2 states none, a documented ratio per band. Diff `type.ts` against the real file
  if it turns up.
- **Durations.** animations.md's global rule allows 150 / 180 / 250 only, but its own
  inventory lists 200ms for the allocation bars. The rule wins; those bars use 180.
- **Two ink tokens beyond the §1 ramp.** `ink50` and `ink65` are not in the §1 table but
  §5 names both (unselected pill label, ghost-button label), so they are part of the ramp.
- **`AreaChart` drops `preserveAspectRatio="none"`.** §6 writes the equity curve as a
  fixed `viewBox` because the prototype was HTML. The *values* are kept — stroke 2,
  end dot r 3.2, grid at 25%, gradient .28 → 0 — but a non-uniform scale would make the
  stroke a different thickness horizontally and vertically and turn the dot into an
  ellipse, so it measures its box and draws in points.
- **`StatRow` pads its tiles at 8, not 13.** Four tiles across a 402pt screen leave 84.5pt
  each. `+11.8%` at 17/700 with tabular figures measures 65.8pt in Inter against about 57
  in the SF Pro the prototype was drawn on — so the prototype's padding fits there and
  wraps here. A single `StatTile` and `StatGrid` keep the roomier padding.
- **`format.ts` was added.** `Price` and `Value` deliberately don't format, but state.md's
  two formatting rules (U+2212, and `toLocaleString` rather than `toFixed` above 999) were
  both review findings on the prototype, so they live where a screen can reach them.

## What the QA pass changed

`docs/QA-UI-PLAN.md` is the plan and its results — 199 items against this system plus a
43-route smoke pass, executed in the browser and on an Android device. Seven defects came
out of it; the ones that changed this system's behaviour:

- **`StatRow` pads at 8, not 13** (above). Found by a four-across row wrapping.
- **`AreaChart` insets both axes**, not just vertically — the end dot was clipped in half.
- **The price axis is keyed by index.** A flat or empty projection makes all five labels
  the same string, which collided as React keys and logged an error every render.
- **An empty series draws nothing** — no candles, no axis, no rule. It used to invent a
  price scale from a `{maxHigh: 1, minLow: 0}` fallback, and a fabricated axis on a
  trading surface is worse than an empty box.
- **A stat value wraps rather than truncating.** `+1,234....` hides digits; a number that
  does not fit should be visibly wrong, not quietly wrong. Only its label may truncate.
- **`Switch` and `Segmented` seed their shared value** with the current state and drive it
  from an effect, so a control that mounts selected is simply selected rather than
  animating itself in — which animations.md forbids.

## What is not built

Screens. Also the screen-level motion in animations.md — the spend-cap marker, allocation
bars, leaderboard bars, close-position and swap fills, KYC progress — which belongs with
the screens that own that state.
