const expoConfig = require('eslint-config-expo/flat');

module.exports = [
  ...expoConfig,
  {
    ignores: [
      'node_modules/**',
      '.expo/**',
      // Agent worktrees: each a full checkout of this repo, with its own node_modules and build output.
      '.claude/**',
      'dist/**',
      // Web build output. `npm run build:base` and `scripts/build-web.mjs` write these; linting a
      // 12MB minified bundle finds ten thousand "errors" in code nobody wrote.
      'dist-base/**',
      'dist-web/**',
      'server/**',
      // The marketing site is its own Next.js app, linted by its own config.
      'landing/**',
      'ui/**',
      // Vendored Solidity dependencies — not our source to lint.
      'contracts/**',
      'subgraph/**',
      'subgraph-aqua/**',
    ],
  },
];
