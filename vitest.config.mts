import { defineConfig } from 'vitest/config';
import path from 'node:path';
const dir = import.meta.dirname;

/*
 * The live tests need the same environment the app does.
 *
 * `npm run test:live` did not load `.env`, so `EXPO_PUBLIC_API_URL` was undefined, every request
 * went to the default base URL, and the suite the README tells people to run failed on data that
 * was there the whole time. Loading it here rather than in each script means one place decides,
 * and a shell that already exported something keeps it — dotenv does not override.
 */
try {
  // Node's own loader — no dependency, and like dotenv it does not override what the shell set.
  process.loadEnvFile(path.resolve(dir, '.env'));
} catch {
  // No .env is a legitimate state: the unit tests need nothing from it, and the live ones say
  // plainly which variable they were missing.
}

/**
 * Unit tests run on Node against the PURE modules — tokens, formatting, derived values, chart
 * projection, the strategy engine. `react-native` is aliased to a stub because RN ships Flow
 * source that the test parser cannot read; see src/test/react-native-stub.ts.
 * Component rendering is verified in the app itself (the fidelity harness), not here.
 */
export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    /*
     * The client AND the server.
     *
     * This was `src/**` only, so eight server test files — the rules engine, the audit chain, the
     * planners, the failure translator, the Graph decision, the news feed, the backtest — existed
     * on disk and had never been executed by `npm test`. Tests nobody runs are worse than no
     * tests: they are read as coverage and they rot silently.
     */
    include: ['src/**/*.test.ts', 'server/src/**/*.test.ts'],
    exclude: process.env.LIVE ? [] : ['**/node_modules/**', '**/*.live.test.ts'],
    /*
     * Placeholder credentials for the unit run, only where none are set.
     *
     * `venues/oneinch.ts` and `auth/privy.ts` throw at import without their keys — deliberately, since
     * neither has an offline mode — and unit suites import them transitively. They passed only because
     * this file loads the developer's `.env`; a clean checkout, CI included, could not even collect
     * them. No unit test calls 1inch or Privy, and the live run (LIVE=1) still requires the real keys.
     */
    env: process.env.LIVE
      ? {}
      : {
          ONEINCH_API_KEY: process.env.ONEINCH_API_KEY ?? 'unit-test-placeholder',
          PRIVY_APP_ID: process.env.PRIVY_APP_ID ?? 'unit-test-placeholder',
          PRIVY_APP_SECRET: process.env.PRIVY_APP_SECRET ?? 'unit-test-placeholder',
        },
    /*
     * The live suite runs one file at a time.
     *
     * `http/get.ts` serialises outbound requests per host with a minimum spacing, which is the
     * only thing keeping this repo inside CoinGecko's free tier — and that state is per worker.
     * Running twelve live files in parallel gave twelve independent lanes all asking the same
     * host at once, so the suite rate-limited itself and two files timed out at 120s on data
     * that answers in under a second when asked politely. The unit tests keep full parallelism;
     * they touch nothing.
     */
    fileParallelism: !process.env.LIVE,
    /*
     * The live suite waits for the executor's cache to fill before judging anything. See
     * `tools/wait-for-warm.ts`; it is a no-op without LIVE.
     */
    globalSetup: ['tools/wait-for-warm.ts'],
  },
  resolve: {
    alias: {
      'react-native': path.resolve(dir, 'src/test/react-native-stub.ts'),
      '@': path.resolve(dir, 'src'),
    },
  },
});
