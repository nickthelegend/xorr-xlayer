/**
 * fonts.ts — Inter and Baloo 2, shipped with the app.
 *
 * design.md §2 records why this is not the platform font: the reference was authored in a
 * browser on a Mac, so every screen in it renders in **SF Pro**, while `-apple-system` on
 * Android resolves to **Roboto** — different letterforms, different widths, and the scale's
 * negative tracking (−2px on a 52px amount) was tuned against SF Pro. The app did not look
 * like its own design on half the devices it runs on.
 *
 * ## Why a weight → family MAP rather than one family name
 *
 * React Native does not synthesise weights for a custom family on Android: asking for
 * `fontFamily: 'Inter'` with `fontWeight: '700'` silently renders Regular. Each weight has
 * to name its own registered family. The map is the only way to say "700" and get it.
 *
 * ## Why `fontWeight` is still set alongside it
 *
 * This app runs on the web too — that is how the demo is shown, and Privy's auth is a web
 * SDK. `react-native-web` emits the family name AND the weight into CSS, and the browser
 * matches on both. Dropping `fontWeight` there would leave the browser to pick a weight for
 * a family whose name already encodes one, which it does inconsistently across engines.
 * On native the family already decides, and the extra property is inert.
 *
 * The files themselves are loaded in `app/_layout.tsx` before the first paint.
 */

/** The five Inter faces the scale uses, by weight. Keys are `fontWeight` strings. */
export const FONTS = Object.freeze({
  '400': 'Inter-Regular',
  '500': 'Inter-Medium',
  '600': 'Inter-SemiBold',
  '700': 'Inter-Bold',
  '800': 'Inter-ExtraBold',
} as const);

export type FontWeightKey = keyof typeof FONTS;

/** The display face. The wordmark and nothing else — exactly as the reference uses it. */
export const DISPLAY_FONT = 'Baloo2-ExtraBold';

/**
 * The registered family for a weight, falling back to Regular.
 *
 * A weight the app does not ship must not silently become a synthesised bold; it becomes
 * Regular, which is visibly wrong rather than subtly wrong.
 */
export function familyFor(weight: string | number | undefined): string {
  return FONTS[String(weight ?? '400') as FontWeightKey] ?? FONTS['400'];
}
