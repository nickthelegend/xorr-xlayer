/**
 * Brand — PLAN.md §0.5. The handoff was authored under the working name "Orbit"; every
 * app-visible occurrence is renamed here so no screen hardcodes a product name.
 *
 * Occurrences audited in ui/mobile-ui (2026-09-05):
 *   - screens.md screen 1: wordmark "ORBIT" 42/800          -> WORDMARK
 *   - screens.md screen 1: tagline "Your crypto & stocks AI desk" -> TAGLINE (revised for the
 *     pivot: the bot is the product, not the desk)
 *   - README.md / design.md prose: documentation only, not app-visible.
 *   - reference/Orbit Trading App.dc.html: filename only, not app-visible.
 */
export const brand = {
  /** Screen 1 wordmark. design.md: 42px/800. */
  WORDMARK: 'XORR',
  name: 'xorr',
  domain: 'xorr.finance',
  /** Revised for the pivot — PLAN.md §1.1 "the bot is the product". */
  TAGLINE: 'A bot that trades while you get on with your life',
  /** screens.md screen 1 terms line. */
  TERMS: 'By continuing you agree to the Terms and Privacy Policy.',
} as const;
