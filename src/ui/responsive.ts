/**
 * Responsive behaviour — PLAN.md 13.9.
 *
 * The handoff is authored at exactly 402 x 874 (iPhone 16 Pro). Every other device needs an
 * explicit answer, and "scale everything" is the wrong one on a trading surface: shrinking a
 * price below the 9.5px floor breaks design.md §2, and shrinking a hit target breaks §7.
 *
 * The rule this module encodes:
 *   - WIDTH adapts by reflow. Gutters and pill rows already flex; nothing is scaled.
 *   - TYPE scales only DOWN, only on genuinely narrow devices, and never below the 9.5px floor.
 *   - HIT TARGETS never scale. 44pt is 44pt on every device.
 *   - HEIGHT is handled by scrolling, never by compression.
 */
import { Dimensions, PixelRatio } from 'react-native';
import { MIN_FONT_SIZE } from './type';

/** The design target. Everything is authored against this. */
export const DESIGN_WIDTH = 402;
export const DESIGN_HEIGHT = 874;

/** Below this, a 402-wide layout genuinely needs help (iPhone SE is 375). */
export const NARROW_WIDTH = 380;
/** Below this, vertical content must scroll rather than compress (SE is 667). */
export const SHORT_HEIGHT = 700;

export function metrics() {
  const { width, height } = Dimensions.get('window');
  return {
    width,
    height,
    narrow: width < NARROW_WIDTH,
    short: height < SHORT_HEIGHT,
    /** Never above 1: the design is a maximum, not a starting point. */
    widthScale: Math.min(1, width / DESIGN_WIDTH),
  };
}

/**
 * Scale a font size for narrow devices, clamped to the 9.5px floor design.md §2 sets.
 * Also respects the user's own text-size setting rather than fighting it.
 */
export function scaleFont(size: number): number {
  const { widthScale } = metrics();
  if (widthScale >= 1) return size;
  return Math.max(MIN_FONT_SIZE, Math.round(size * widthScale * 10) / 10);
}

/** Hit targets NEVER scale. This exists to make that explicit at the call site. */
export function hitTarget(size: number): number {
  return size;
}

/** Round to the device pixel grid so a hairline stays a hairline. */
export function snap(value: number): number {
  return PixelRatio.roundToNearestPixel(value);
}
