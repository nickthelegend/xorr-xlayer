import { defineConfig } from 'vitest/config';
import path from 'node:path';

/*
 * The repo-root `.env`, loaded before the suite collects.
 *
 * `venues/oneinch.ts` throws at import when `ONEINCH_API_KEY` is missing — deliberately, because
 * swap routing has no offline fallback — and there is no `server/.env`. So `(cd server && npm
 * test)`, a command the README tells people to run, failed to COLLECT `news/feed.test.ts` while
 * the same file passed from the repo root, where the root config already loads this file. One
 * suite passing and the other failing on the same code is the kind of thing that gets blamed on
 * the test.
 *
 * `loadEnvFile` does not override what the shell already set, so CI keeps its own values.
 */
try {
  process.loadEnvFile(path.resolve(import.meta.dirname, '../.env'));
} catch {
  // No `.env` is legitimate: the unit tests need nothing from it, and anything that does says
  // plainly which variable was missing.
}

/**
 * The server's own suite, run from `server/`.
 *
 * It shares the reasoning of the root config and needs its own file for two of the same reasons:
 * the live tests must not run in parallel — `http/get.ts` serialises outbound requests per host and
 * that state is per worker, so parallel files give each one an independent lane and the suite
 * rate-limits itself — and they must not start while the executor is still filling its cache.
 */
export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['src/**/*.test.ts'],
    // The live suites need a running executor and database; `LIVE=1` runs them, as in the root config.
    exclude: process.env.LIVE ? ['**/node_modules/**'] : ['**/node_modules/**', '**/*.live.test.ts'],
    // The same placeholders as the root config, for the same reason — see vitest.config.mts.
    env: process.env.LIVE
      ? {}
      : {
          /*
           * The chain is pinned, not inherited: a developer's `.env` naming another network (the Base build's
           * `base-sepolia`, carried over in a copy) made every suite that loads the chain config fail to collect.
           * The unit tests describe X Layer's testnet; the fork and mainnet runs set their own.
           */
          XORR_CHAIN: 'xlayer-testnet',
          EXPO_PUBLIC_XORR_CHAIN: 'xlayer-testnet',
          /*
           * A signing key for modules that load the executor's client at import. Anvil's default account #0 — a key
           * published in every Foundry tutorial, so it holds nothing anywhere and is no secret. Without it a clean
           * checkout (CI) failed to collect suites that a laptop with a generated key file passed.
           */
          DELEGATE_PRIVATE_KEY:
            process.env.DELEGATE_PRIVATE_KEY ?? '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80',
          PRIVY_APP_ID: process.env.PRIVY_APP_ID ?? 'unit-test-placeholder',
          PRIVY_APP_SECRET: process.env.PRIVY_APP_SECRET ?? 'unit-test-placeholder',
        },
    fileParallelism: !process.env.LIVE ? undefined : false,
    globalSetup: ['../tools/wait-for-warm.ts'],
  },
  /*
   * The app's `@/` alias, as `vitest.config.mts` resolves it at the repo root.
   *
   * Two of these tests read the app's modules on purpose — `evm/chain-agreement.test.ts` holds the two
   * chain vocabularies to each other, and `routes/order-amount.test.ts` checks the executor's bounds
   * against the ones the app enforces before sending. Both collect from the root config, which resolves
   * `@/`; without the same mapping here they failed to collect under `(cd server && npm test)`, the
   * command the README gives. The same suite passing from one directory and not the other is exactly
   * what the note above this config exists to prevent.
   */
  resolve: {
    alias: {
      '@': path.resolve(import.meta.dirname, '../src'),
    },
  },
});
