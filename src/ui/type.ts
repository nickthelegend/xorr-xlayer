/**
 * type.ts — the type scale.
 *
 * One entry per role in design.md §2. Where §2 gives a size range (`Price large 36–42px`)
 * the range is expanded into the discrete sizes the prototype actually uses, so a screen
 * picks a variant instead of overriding a size and breaking its tracking.
 *
 * Every variant carries `fontFamily`, `fontSize`, `lineHeight` and `letterSpacing` in
 * **absolute points**. React Native has no `em` and no unitless `line-height`: a bare
 * ratio is not a legal value, and a missing `lineHeight` leaves the box height to the
 * platform's own font metrics, which differ between iOS and Android.
 *
 * ## Weight is named twice, on purpose
 *
 * Each variant sets BOTH a registered family (`Inter-SemiBold`) and the matching
 * `fontWeight`. Neither alone is enough for the three platforms this app ships to:
 *
 *   - **Android** does not synthesise weights for a custom family. `fontFamily: 'Inter'`
 *     with `fontWeight: '700'` renders Regular, silently. The family has to name the weight.
 *   - **Web** — where the demo is shown, and where Privy's auth SDK runs — matches on family
 *     *and* weight through `react-native-web`'s CSS. Leaving the weight off asks the browser
 *     to pick one for a family whose name already encodes it, which engines do differently.
 *
 * So `v()` derives the family from the weight and keeps both. `fonts.ts` owns the map.
 *
 * NOTE ON DERIVED VALUES — the letter-spacing and line-height below are derived from
 * design.md §2:
 *
 *   letterSpacing = em × fontSize      (design.md gives `.12em`, `.09em`, `.03em`)
 *   lineHeight    = ratio × fontSize   (design.md gives 1.2 / 1.5 / 1.45 where it gives one)
 *
 * Roles where §2 gives no line-height use the ratio for their band, stated per group below.
 */
import type { TextStyle } from 'react-native';
import { familyFor } from './fonts';
import { colors } from './tokens';

/** Shared by every variant. `includeFontPadding: false` removes Android's extra
 *  ascent/descent padding, which is the difference between an iOS and an Android build
 *  laying a row out identically. Tabular numerals keep a price column from re-flowing as
 *  digits change. */
const base = {
  includeFontPadding: false,
  fontVariant: ['tabular-nums'],
} satisfies TextStyle;

type Variant = TextStyle & {
  fontFamily: string;
  fontWeight: TextStyle['fontWeight'];
  fontSize: number;
  lineHeight: number;
  letterSpacing: number;
};

/** design.md §2's five weights. Anything else is not in the scale. */
type Weight = '400' | '500' | '600' | '700' | '800';

const v = (
  weight: Weight,
  fontSize: number,
  lineHeight: number,
  letterSpacing: number,
  extra?: TextStyle,
): Variant => ({
  ...base,
  fontFamily: familyFor(weight),
  fontWeight: weight,
  fontSize,
  lineHeight,
  letterSpacing,
  ...extra,
});

/**
 * Line-height ratios by band:
 *   display  1.15  — numerals only, no descenders; matches the browser default the
 *                    prototype rendered at without loosening the composition
 *   title    1.20  — design.md gives 1.2 explicitly for the onboarding title
 *   row      1.30  — single-line labels and values
 *   body     1.50  — design.md §2
 *   second.  1.45  — design.md §2
 *   micro    1.20  — eyebrows, tags, tab labels
 */
export const type = Object.freeze({
  /* ---- Display. All 700, all negative tracking, all tabular. ---- */

  /** Keypad amount / deposit amount. 52 · 700 · −2 */
  heroAmount: v('700', 52, 60, -2),
  /** Total value on the wallet home. 46 · 700 · −1.4 */
  heroBalance: v('700', 46, 53, -1.4),
  /** Unrealised P&L. Same metrics as the balance; separate role because it is coloured. */
  pnlHero: v('700', 46, 53, -1.4),
  /** Asset detail. 42 · 700 · −1.2 */
  priceLg: v('700', 42, 48, -1.2),
  /** Pro chart. 38 · 700 · −1.2 */
  priceMd: v('700', 38, 44, -1.2),
  /** Contract screen. 36 · 700 · −1.2 */
  priceSm: v('700', 36, 41, -1.2),
  /** Swap amount. 32 · 700 · −1 */
  amountLg: v('700', 32, 37, -1),
  /** Backtest end value. 30 · 700 · −1 */
  amountMd: v('700', 30, 35, -1),

  /* ---- Titles ---- */

  /** Onboarding title. 26 · 700 · line-height 1.2 (the one §2 states outright). */
  onboardingTitle: v('700', 26, 31.2, 0),
  /** Kill-switch headline. 24 · 700 */
  titleLg: v('700', 24, 29, 0),
  /** Screen title. 22 · 700 */
  screenTitle: v('700', 22, 26, 0),
  /** Sheet title. 19 · 700 */
  sheetTitle: v('700', 19, 23, 0),
  /** Card title, heavy. 17 · 700 */
  cardTitleLg: v('700', 17, 20, 0),
  /** Card title. 16 · 600 */
  cardTitle: v('600', 16, 19, 0),

  /* ---- List rows ---- */

  /** Row primary, large (watchlist symbol, nav title). 15.5 · 600 */
  rowPrimaryLg: v('600', 15.5, 20, 0),
  /** Row primary (symbol, name, price column). 14.5 · 600 */
  rowPrimary: v('600', 14.5, 19, 0),
  /** Stepper and stat value. §5 asks for 700 here so digits hold their weight. 14.5 · 700 */
  value: v('700', 14.5, 19, 0),

  /* ---- Body / row label ---- */

  /** Settings row label. 14.5 · 500 · 1.5 */
  bodyLg: v('500', 14.5, 21.75, 0),
  /** Body. 14 · 500 · 1.5 */
  body: v('500', 14, 21, 0),
  /** Screen subtitle, description copy. 13.5 · 500 · 1.5 */
  bodySm: v('500', 13.5, 20.25, 0),

  /* ---- Secondary ---- */

  /** Secondary line. 12.5 · 400 · 1.45 */
  secondary: v('400', 12.5, 18, 0),
  /** Row secondary line, agent-note body. 11.5 · 400 · 1.45 */
  secondarySm: v('400', 11.5, 17, 0),
  /** Delta under a price — same size as `secondarySm`, one step heavier. 12 · 500 */
  delta: v('500', 12, 17, 0),

  /* ---- Component labels ----
     Sizes §5 names inside a component recipe rather than in the §2 table. They live here
     so a primitive never carries a loose fontSize. */

  /** Pill and segment label. §5: 13 · 600 */
  control: v('600', 13, 17, 0),
  /** Button label. §5: 15.5–16 · 600 */
  button: v('600', 15.5, 20, 0),
  /** Agent name under an orb. §5: 12–12.5 · 600 */
  orbName: v('600', 12.5, 16, 0),
  /** Agent status word under the name. §5: 10.5 · 600 */
  orbStatus: v('600', 10.5, 13, 0),

  /* ---- Chips ----
     Numeric markers. §2 tabulates text roles; these are the chip recipes from §5 (the
     orb's P&L badge) and §6 (the last-price rule and the TP/SL markers), which carry
     numbers rather than labels — so they are 700 without the uppercase or the tracking
     that a `tag` gets. */

  /** Orb P&L badge. §5: 10 · 700 */
  chipSm: v('700', 10, 12, 0),
  /** Last-price marker. §6: 10.5 · 700 */
  chip: v('700', 10.5, 13, 0),
  /** TP / SL marker. §6: 11.5 · 700 */
  chipLg: v('700', 11.5, 14, 0),
  /** The delta chip under a hero balance. 11.5 · 600 */
  chipDelta: v('600', 11.5, 14, 0),

  /* ---- Micro ---- */

  /** Eyebrow. 11 · 600 · .12em → 1.32 · uppercase */
  eyebrow: v('600', 11, 13, 1.32, { textTransform: 'uppercase' }),
  /** Eyebrow, small. 10 · 600 · .12em → 1.2 · uppercase */
  eyebrowSm: v('600', 10, 12, 1.2, { textTransform: 'uppercase' }),
  /** Tag / badge. 10 · 700 · .09em → 0.9 · uppercase */
  tag: v('700', 10, 12, 0.9, { textTransform: 'uppercase' }),
  /** Tag / badge, small. The floor of the scale. 9.5 · 700 · .09em → 0.855 · uppercase */
  tagSm: v('700', 9.5, 11.5, 0.855, { textTransform: 'uppercase' }),
  /** Tab label. 9.5 · 600 · .03em → 0.285 */
  tabLabel: v('600', 9.5, 11.5, 0.285),
  /** Footnote. 11 · 400 */
  footnote: v('400', 11, 16, 0),
  /** Footnote, small. 10.5 · 400 */
  footnoteSm: v('400', 10.5, 15, 0),
} as const);

export type TypeVariant = keyof typeof type;

/**
 * The floor. design.md §2's smallest role is `tagSm` at 9.5px, and nothing — including a
 * font scaled down for a narrow device — may go under it.
 */
export const MIN_FONT_SIZE = 9.5;

/**
 * Default ink per variant. A caller can override with `color`, but the default is the
 * one design.md pairs with that role, so a screen that says nothing still reads right.
 */
export const variantColor: Readonly<Record<TypeVariant, string>> = Object.freeze({
  heroAmount: colors.ink,
  heroBalance: colors.ink,
  pnlHero: colors.ink,
  priceLg: colors.ink,
  priceMd: colors.ink,
  priceSm: colors.ink,
  amountLg: colors.ink,
  amountMd: colors.ink,
  onboardingTitle: colors.ink,
  titleLg: colors.ink,
  screenTitle: colors.ink,
  sheetTitle: colors.ink,
  cardTitleLg: colors.ink,
  cardTitle: colors.ink,
  rowPrimaryLg: colors.ink,
  rowPrimary: colors.ink,
  value: colors.ink,
  bodyLg: colors.ink,
  body: colors.ink,
  bodySm: colors.ink55,
  secondary: colors.ink55,
  secondarySm: colors.ink55,
  delta: colors.ink55,
  control: colors.ink,
  button: colors.ink,
  orbName: colors.ink,
  orbStatus: colors.up,
  chipSm: colors.ink,
  chip: colors.ink,
  chipLg: colors.ink,
  chipDelta: colors.ink,
  eyebrow: colors.ink50,
  eyebrowSm: colors.ink50,
  tag: colors.ink50,
  tagSm: colors.ink50,
  tabLabel: colors.ink50,
  footnote: colors.ink50,
  footnoteSm: colors.ink50,
});

/** The numeric roles. `<Value>` and `<Price>` refuse to leave these without tabular figures. */
export const numericVariants = Object.freeze([
  'heroAmount',
  'heroBalance',
  'pnlHero',
  'priceLg',
  'priceMd',
  'priceSm',
  'amountLg',
  'amountMd',
  'value',
  'chipSm',
  'chip',
  'chipLg',
  'chipDelta',
] as const satisfies readonly TypeVariant[]);
