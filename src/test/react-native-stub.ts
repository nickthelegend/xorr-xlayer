/**
 * Test-only stand-in for `react-native`.
 *
 * The RN package ships Flow-typed source that vitest's parser cannot read. Our pure modules
 * (tokens, formatting, derived values, chart projection) import only `Platform`, `StyleSheet`
 * and types from it, so this stub is enough to unit-test them on Node without a RN runtime.
 * Aliased in vitest.config.ts. NEVER imported by app code.
 */
export const Platform = {
  OS: 'ios' as const,
  select: <T,>(spec: { ios?: T; android?: T; default?: T }): T | undefined =>
    'ios' in spec ? spec.ios : spec.default,
};

export const StyleSheet = {
  /** iOS @3x device pixel — the value RN reports on the design target (iPhone 16 Pro). */
  hairlineWidth: 0.3333333333333333,
  create: <T extends Record<string, unknown>>(s: T): T => s,
  absoluteFill: {} as Record<string, never>,
  flatten: (s: unknown) => s,
};

export const AccessibilityInfo = {
  isReduceMotionEnabled: async () => false,
  addEventListener: () => ({ remove: () => {} }),
};

export const Dimensions = { get: () => ({ width: 402, height: 874, scale: 3, fontScale: 1 }) };

/** The phone's appearance. Node has none, and the pure modules only need the hook to exist. */
export type ColorSchemeName = 'light' | 'dark' | null;
export const useColorScheme = (): ColorSchemeName => null;

export type TextStyle = Record<string, unknown>;
export type ViewStyle = Record<string, unknown>;
export type StyleProp<T> = T | T[] | null | undefined;
