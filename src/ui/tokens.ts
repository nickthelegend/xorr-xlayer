/**
 * tokens.ts — the single source of design values.
 *
 * Every value here is transcribed from `mobile-ui/design.md` §1–3 (colour, type, space,
 * radius, shadow) and §6 (chart geometry). Nothing in `src/ui` may use a colour, size,
 * radius or duration that is not exported from this file.
 *
 * Where design.md gives a range (`radius 22–26px`, `height 48–66px`) the range is
 * expressed as named members rather than a free number, so a component picks a documented
 * value instead of inventing one.
 */

/** Turn `#RRGGBB` into `rgba(r,g,b,a)`. Used for the agent-orb bloom, which is derived
 *  from the agent's own `c1` rather than being a fixed colour. */
export function withAlpha(hex: string, alpha: number): string {
  const h = hex.replace('#', '');
  const full =
    h.length === 3
      ? `${h[0]}${h[0]}${h[1]}${h[1]}${h[2]}${h[2]}`
      : h;
  const r = parseInt(full.slice(0, 2), 16);
  const g = parseInt(full.slice(2, 4), 16);
  const b = parseInt(full.slice(4, 6), 16);
  return `rgba(${r},${g},${b},${alpha})`;
}

/* -------------------------------------------------------------------- Font faces */

/**
 * A palette hex at a given opacity, as an `rgba()` string.
 *
 * `boxShadow` — the only shadow API that keeps its tint on web now that the `shadow*` props
 * are deprecated — takes a CSS colour, and the design's shadows are all "this token at N%".
 * Converting here means a bloom still traces back to a token rather than becoming a raw hex
 * at the call site.
 *
 * The font families live in `fonts.ts`, next to the loader, because this app registers one
 * family PER WEIGHT from local assets rather than one variable family.
 */
export function alpha(hex: string, opacity: number): string {
  const h = hex.replace('#', '');
  const full = h.length === 3 ? h.split('').map((c) => c + c).join('') : h;
  const n = parseInt(full, 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${opacity})`;
}

/* ------------------------------------------------------------------ §1 Colour */

/** Surfaces. `bg` is true black, never a dark grey. */
const surfaces = {
  bg: '#000000',
  surface: '#0C0C0D',
  surfaceAlt: '#141516',
  control: '#1B1C1E',
  /** Press state on `control`. There is no hover on a touch device — see `Press.tsx`. */
  controlPress: '#252629',
  switchOff: '#2A2B2E',
  inputBg: '#121213',
  /**
   * The raised surface between `surface` and `surfaceAlt`. design.md §1's table omits it,
   * but §5 names it for a segmented track on black ("#111214 + inputBorder") and the
   * prototype draws every bot bubble with it. It was inlined as a bare hex in three
   * places before it had a name here.
   */
  bubble: '#111214',
} as const;

/**
 * A QR code is not part of the palette, and must not follow it.
 *
 * The app is true black and it is tempting to draw the code in the ink ramp to match. Scanners
 * expect dark modules on a light ground; an inverted code fails on most phones, and a QR nobody
 * can scan is decoration in the shape of a feature. Named here so the rule is stated once rather
 * than argued in every screen that shows one.
 */
const scan = {
  scanInk: '#000000',
  scanBg: '#FFFFFF',
} as const;

/** Light sheet. Auto Close and the order ticket only. */
const sheet = {
  bg: '#FFFFFF',
  ink: '#0B0B0B',
  muted: '#8A8A90',
  dim: '#9A9A9F',
  fill: '#F2F2F5',
  tick: '#E4E4E9',
} as const;

/**
 * The ink ramp on black. `ink` through `ink28` are design.md §1 verbatim.
 * `ink65` and `ink50` are not in the §1 table but are named in §5 (ghost-button label,
 * unselected pill label) and used throughout the prototype, so they belong to the ramp.
 */
const ink = {
  ink: '#FFFFFF',
  ink70: 'rgba(255,255,255,0.7)',
  ink65: 'rgba(255,255,255,0.65)',
  ink55: 'rgba(255,255,255,0.55)',
  ink50: 'rgba(255,255,255,0.5)',
  ink45: 'rgba(255,255,255,0.45)',
  ink40: 'rgba(255,255,255,0.4)',
  ink38: 'rgba(255,255,255,0.38)',
  ink35: 'rgba(255,255,255,0.35)',
  ink32: 'rgba(255,255,255,0.32)',
  ink30: 'rgba(255,255,255,0.3)',
  ink28: 'rgba(255,255,255,0.28)',
} as const;

/** Hairlines and borders. All are 1px — see `border` below for the width/colour pair. */
const hairline = {
  /** List row dividers. The most-used border in the app. */
  hairline: 'rgba(255,255,255,0.05)',
  /** Tab-bar top edge, section splits. */
  hairlineStrong: 'rgba(255,255,255,0.055)',
  /** Card and sheet outlines. Cards get this instead of an elevation. */
  cardBorder: 'rgba(255,255,255,0.06)',
  /** Composer, segmented track. */
  inputBorder: 'rgba(255,255,255,0.07)',
  /** Ghost / outline buttons. */
  ghostBorder: 'rgba(255,255,255,0.09)',
  /** A step not reached yet — the 2pt ring on a sequential setup row (screens 8/9). */
  pending: 'rgba(255,255,255,0.18)',
  /** Selected radio card (funding). */
  selectedBorder: 'rgba(255,255,255,0.55)',
  /** The 1.5pt ring on an unselected radio. Brighter than a card border: it is a control. */
  radioBorder: 'rgba(255,255,255,0.25)',
} as const;

/**
 * Semantic colour — P&L ONLY.
 *
 * Green and red mean profit and loss. They are never selection, focus, branding or
 * emphasis. Selection is white-on-dark. Reaching for `up` to show that something is
 * chosen is a bug.
 */
const semantic = {
  up: '#2BD87A',
  upBg: 'rgba(43,216,122,0.14)',
  upInk: '#04160C',
  down: '#FF453A',
  downBg: 'rgba(255,69,58,0.14)',
  warn: '#E8C64A',
  /* §1 tabulates `upBg`/`downBg` but not the other two chip fills. These follow the same
     recipe — the semantic colour at .14 — and the neutral tint the prototype uses for a
     category chip that carries no outcome. */
  warnBg: 'rgba(232,198,74,0.14)',
  neutralBg: 'rgba(255,255,255,0.07)',
  /** The "Hired" state on a roster card — `up` at 15%, not a P&L reading. */
  hiredBg: 'rgba(43,216,122,0.15)',
  /** First place on the leaderboard. The only gold that is not the gold contract's. */
  rankFirst: '#F0BE55',
  /** Deeper than `up` so it holds against white. */
  candleUp: '#16C060',
  candleDown: '#EF3B36',
  /**
   * The Auto Close sheet's cancel button — a green so pale it reads as "not the action",
   * on the same green family as Set so the pair reads as one decision. screens.md screen 6.
   */
  /**
   * Gold. The commodity contract's CTA takes the instrument's own colour rather than the
   * P&L green — "Long gold" is not a profit, and colouring it `up` would say it was.
   */
  /**
   * The pre-account blue. The ONE screen that uses it is the splash, which sits before
   * there is an account — and therefore before the P&L colour law applies. Anywhere past
   * the splash, blue on a control would compete with green-means-profit.
   */
  preAccount: '#29A3F5',
  goldFill: '#F5CE5F',
  goldInk: '#1A1204',
  goldBg: 'rgba(245,206,95,0.14)',
  cancelBg: '#E4F7EC',
  cancelInk: '#16A254',
  tpZone: 'rgba(22,192,96,0.10)',
  slZone: 'rgba(255,69,58,0.09)',
} as const;

/**
 * Agent identity gradients. Each is `radial-gradient(circle at 32% 26%, c1, c2 74%)` —
 * the off-centre origin is the specular highlight and must not move.
 * Asset marks reuse the same recipe; every instrument in `data/markets.json` carries c1/c2.
 */
const agent = {
  /** Momentum Scout / Signals */
  momentum: { c1: '#5B93FF', c2: '#1B44CE' },
  /** Earnings Desk / Stocks */
  earnings: { c1: '#F0BE55', c2: '#C98518' },
  /** Yield Keeper / Crypto */
  yield: { c1: '#49E39B', c2: '#12A45F' },
  /** Drawdown Guard */
  drawdown: { c1: '#B58CFF', c2: '#7A45E0' },
  /** Portfolio strategist */
  strategist: { c1: '#C79BFF', c2: '#7B3FE4' },
} as const;

export const colors = Object.freeze({
  ...surfaces,
  ...ink,
  ...hairline,
  ...semantic,
  ...scan,
  sheet,
  agent,
});

export type AgentGradientName = keyof typeof agent;
export type Gradient = { readonly c1: string; readonly c2: string };

/**
 * The categorical palette, for a chart whose slices are CATEGORIES rather than outcomes.
 *
 * Every entry is an existing agent-identity hue, and the set deliberately excludes the yield green — because the one
 * product rule is that green and red mean profit and loss, and a sector drawn in `up` green reads as the sector that
 * made money. A donut is the easiest place in an app to break that rule by accident: it wants eight distinct colours,
 * and the two most distinct ones left are the two that are spoken for.
 *
 * Ordered so neighbours differ in hue family rather than in shade. Eight consecutive slices of nearly the same purple is
 * a legend nobody reads, and a ring nobody can match to it.
 */
export const allocationPalette = Object.freeze([
  agent.momentum.c1,
  agent.earnings.c1,
  agent.drawdown.c1,
  agent.momentum.c2,
  agent.earnings.c2,
  agent.strategist.c1,
  agent.drawdown.c2,
  agent.strategist.c2,
] as const);

/**
 * What the not-known slice is drawn in: the switch's off grey, and never a hue.
 *
 * Unclassified is the absence of an answer, not a category, and giving it a colour of its own would put it in the
 * legend as a peer of the real sectors.
 */
export const allocationUnknown = surfaces.switchOff;

/** Width + colour pairs, because RN has no `border: 1px solid rgba(...)` shorthand. */
export const border = Object.freeze({
  hairline: { borderWidth: 1, borderColor: colors.hairline },
  hairlineStrong: { borderWidth: 1, borderColor: colors.hairlineStrong },
  card: { borderWidth: 1, borderColor: colors.cardBorder },
  input: { borderWidth: 1, borderColor: colors.inputBorder },
  ghost: { borderWidth: 1, borderColor: colors.ghostBorder },
  selected: { borderWidth: 1, borderColor: colors.selectedBorder },
} as const);

/** The only hairline that is a bottom edge rather than a full outline. */
export const divider = Object.freeze({
  borderBottomWidth: 1,
  borderBottomColor: colors.hairline,
} as const);

/* ------------------------------------------------- §3 Space, radius, shadow */

/** The spacing scale. Nothing outside it. Screen gutter is 20; sheet-edge screens use 16
 *  so the card's own padding makes up the difference. */
export const space = Object.freeze({
  s2: 2,
  s4: 4,
  s6: 6,
  s8: 8,
  s10: 10,
  s12: 12,
  s14: 14,
  s16: 16,
  s18: 18,
  s20: 20,
  s22: 22,
  s26: 26,
  s30: 30,
  s34: 34,
  s38: 38,
  s44: 44,
  /** Screen gutter. */
  gutter: 20,
  /** Screens whose card runs to the sheet edge. */
  sheetGutter: 16,
} as const);

export const radius = Object.freeze({
  /** 4–6 · tab icon glyph boxes */
  glyph: 6,
  /** 11–12 · asset squares, small icon buttons */
  square: 12,
  /** 14–16 · inline stat tiles, chat cards */
  tileSm: 14,
  tile: 16,
  /** 18–20 · agent cards, alert cards, note strips */
  note: 18,
  card: 20,
  /** 22–26 · content cards, radio cards, segmented tracks */
  panel: 22,
  panelLg: 24,
  panelXl: 26,
  /** 30–34 · sheets, primary buttons (pill), full-bleed panels */
  sheet: 30,
  sheetLg: 34,
  /** 50% · avatars, orbs, steppers, circular icon buttons */
  full: 9999,
} as const);

/**
 * Durations. 150 / 180 / 250 and nothing else — under 150 reads as a glitch, over 250
 * reads as lag on a screen the user taps repeatedly.
 *
 * animations.md's own inventory lists 200ms for the allocation bars, which contradicts
 * its global rule. The rule wins: those bars use `base` (180).
 */
export const duration = Object.freeze({
  /** Segmented thumb. The fastest thing in the app — selection must feel instant. */
  fast: 150,
  /** Switch knob + track, and every width fill. */
  base: 180,
  /** Leaderboard re-sort, KYC progress. Long enough for the eye to follow one bar. */
  slow: 250,
  /**
   * An arrival: a section or row rising into place when a screen appears (2026-09-12).
   *
   * Outside the 150/180/250 interaction scale on purpose. That scale is for a control the user
   * touched, where anything slower reads as lag. An arrival answers nothing the user did — it is
   * the screen coming in — and at 250 it reads as a flicker rather than a rise.
   */
  enter: 420,
  /** A chart line drawing itself left to right, and a figure's digits rolling into place. */
  draw: 700,
  /**
   * The skeleton pulse, and the one other duration outside the 150/180/250 interaction scale.
   *
   * That scale is calibrated for a transition the user CAUSED — under 150 reads as a glitch, over
   * 250 reads as lag on a control they just touched. A skeleton is neither: nobody pressed it, and
   * it is not going anywhere. At 250 it strobes; at this it breathes, which is the whole job —
   * saying "still coming" without asking to be looked at.
   */
  pulse: 900,
  /**
   * One breath of an agent's orb while it is thinking (2026-09-17).
   *
   * animations.md's own "If you add motion" names this one: "a slow 3–4s scale breathe (1.0 → 1.015)".
   * It is the slowest thing in the app by an order of magnitude, and that is the point — it has to read
   * as a thing being alive rather than a thing signalling. At `pulse` it is a heartbeat under stress;
   * at this it is breathing, and the eye stops going back to it.
   */
  breathe: 3600,
} as const);

/**
 * Shadows — almost none. Two, plus the candle bloom (which is a glow, not a shadow).
 * Written as `boxShadow` strings: RN 0.76+ supports `boxShadow` on both platforms under
 * the New Architecture, which is the only way to get a *coloured* shadow on Android.
 * Cards never get one — they get the 1px `cardBorder` instead of an elevation.
 */
export const shadow = Object.freeze({
  switchKnob: '0px 1px 3px rgba(0,0,0,0.4)',
  chatPill: '0px 8px 24px rgba(0,0,0,0.55)',
  /** What makes the charts read as premium. Keep it. */
  bloomUp: '0px 0px 10px rgba(22,192,96,0.35)',
  bloomDown: '0px 0px 10px rgba(239,59,54,0.32)',
} as const);

/** The agent-orb bloom is derived from that agent's own `c1`. */
export const orbBloom = (c1: string): string => `0px 14px 40px ${withAlpha(c1, 0.4)}`;

/* ------------------------------------------------------ §5 Component metrics */

/** Fixed metrics from the §5 component recipes, so no primitive holds a loose number. */
export const size = Object.freeze({
  /** Minimum hit target. Steppers stay 26px visually and grow their touch area. */
  hit: 44,

  /** Row heights. §5: 48–66px. */
  rowSm: 48,
  row: 56,
  rowLg: 66,
  /** The mark at the head of a list row. §5: 30–34px. */
  markSm: 30,
  mark: 34,

  /** Pill. §5: height 34, padding 0 14. */
  pillH: 34,
  pillPadX: 14,

  /** Segmented. Track padding 3–4; thumb height 34–42. */
  segPad: 4,
  segThumbSm: 34,
  segThumb: 38,
  segThumbLg: 42,

  /** Stepper. 26px circles, 15px glyph, fixed value width so digits don't jitter. */
  stepperCircle: 26,
  stepperCircleSm: 24,
  stepperGlyph: 15,
  stepperValueMinW: 88,
  stepperValueMinWSm: 70,
  stepperGap: 10,

  /** Switch. 50×30 track, 26px knob, 21px travel. Alerts variant is 48×29 / 25 / 19. */
  switchW: 50,
  switchH: 30,
  switchKnob: 26,
  switchTravel: 21,
  switchWSm: 48,
  switchHSm: 29,
  switchKnobSm: 25,
  switchTravelSm: 19,
  switchPad: 2,

  /** AgentOrb. The six sizes the app uses. */
  orb52: 52,
  orb56: 56,
  orb70: 70,
  orb74: 74,
  orb84: 84,
  orb104: 104,

  /** Buttons. §5: primary 52–56, ghost 46–48. */
  buttonSm: 52,
  button: 54,
  buttonLg: 56,
  ghostSm: 46,
  ghost: 48,

  /** Tab bar. 21×21 icon over a 9.5/600 label, 6px status dot. */
  tabIcon: 21,
  tabIconStroke: 1.8,
  tabGap: 5,
  tabDot: 6,

  /** NoteStrip leading dot / orb. §5: 16–22px. */
  noteDot: 16,
  noteOrb: 22,
} as const);

/* --------------------------------------------------------------- §6 Charts */

/** Chart geometry. Positions are always derived from data and measured layout;
 *  these are the only fixed numbers a chart is allowed to use. */
export const chart = Object.freeze({
  /**
   * The right-hand price-axis gutter. §6 derives the labels from the active projection;
   * this is only how much room they get. It is a token rather than a constant inside the
   * candle chart because the volume row underneath has to reserve the SAME width, or the
   * bars stop lining up with the candles above them.
   */
  axisWidth: 56,
  candle: {
    /** Gap between candle columns. Volume bars match it so the two rows line up. */
    gap: 6,
    wickWidth: 1.6,
    wickRadius: 2,
    wickOpacity: 0.8,
    /** Auto Close renders wicks a touch softer than the pro chart. */
    wickOpacitySheet: 0.75,
    bodyRadius: 3,
    /** 1.4% of the plot box — the doji floor, so a flat candle still draws. */
    bodyMinPct: 1.4,
    /**
     * Tight projection (pro chart): candles fill the box.
     *
     * `tightPad` is the CAP, in price. The padding itself is relative (2026-09-12): a fifth of the
     * series' own range, or a tenth of a percent of the price when the range is flat. A fixed ±120
     * suited the $66,000 prototype and flattened every cheap asset into one line — AAVE at $126 drew
     * as a strip, because 120 dollars of padding dwarfed a day's two-dollar range.
     */
    tightPad: 120,
    tightPadOfRange: 0.2,
    tightPadOfPrice: 0.001,
    /** Wide projection (Auto Close): bounds follow the TP/SL prices. */
    widePad: 150,
    axisTicks: [0, 0.25, 0.5, 0.75, 1] as const,
    /** Last-price rule. */
    markDash: [3, 3] as const,
    markStroke: 1,
    markInk: 'rgba(255,255,255,0.22)',
    markInkSheet: 'rgba(11,11,11,0.2)',
  },
  volume: {
    height: 42,
    gap: 6,
    radius: 2,
    upFill: 'rgba(22,192,96,0.5)',
    downFill: 'rgba(239,59,54,0.5)',
  },
  area: {
    strokeWidth: 2,
    fillOpacityTop: 0.28,
    fillOpacityBottom: 0,
    gridColor: 'rgba(255,255,255,0.06)',
    /** Grid lines at 25% intervals, behind the fill. */
    gridAt: [0.25, 0.5, 0.75] as const,
    endDotRadius: 3.2,
  },
  spark: {
    width: 90,
    height: 30,
    strokeWidth: 1.4,
    opacity: 0.9,
  },
  ruler: {
    height: 22,
    /** A 1px tick every 9px, 12px tall, vertically centred. */
    tickWidth: 1,
    tickPitch: 9,
    tickHeight: 12,
    markerWidth: 2,
  },
} as const);

export type Space = keyof typeof space;
export type Radius = keyof typeof radius;
export type Duration = keyof typeof duration;
