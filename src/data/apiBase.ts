/**
 * Where the executor lives.
 *
 * Deliberately its own module with no native imports. `api.ts` also carries the Privy token
 * plumbing, which reaches expo-application and expo-constants and therefore the native Expo
 * runtime; the market-data layer needs none of that to know a URL, and pulling it in made every
 * pure module untestable under Node.
 *
 * EXPO_PUBLIC_API_URL is inlined at build time by Expo, so it works on web and on device. The
 * app.json `extra.apiUrl` fallback is read lazily, and only if the env var is absent, so a device
 * build can point at a deployed executor without a rebuild.
 */
const DEFAULT_BASE = 'http://localhost:8788';

/**
 * Expo publishes app.json's `extra` on a global at runtime. Reading it there rather than importing
 * expo-constants is what keeps this module free of the native runtime — the import is the whole
 * problem, not the value.
 */
function fromExpoConfig(): string | undefined {
  const g = globalThis as { expo?: { modules?: { ExpoConstants?: { expoConfig?: unknown } } } };
  const cfg = g.expo?.modules?.ExpoConstants?.expoConfig as
    | { extra?: { apiUrl?: string } }
    | undefined;
  return cfg?.extra?.apiUrl;
}

export const API_BASE = process.env.EXPO_PUBLIC_API_URL ?? fromExpoConfig() ?? DEFAULT_BASE;
