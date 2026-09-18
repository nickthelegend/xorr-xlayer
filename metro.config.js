/**
 * Metro configuration.
 *
 * There was no config file at all, which was fine right up until the first native build. On web,
 * bundling never touched `jose` — Privy's JWT verification runs server-side there. On Android the
 * bundle failed outright:
 *
 *   Unable to resolve module zlib from node_modules/jose/dist/node/esm/runtime/zlib.js
 *
 * `jose` publishes a `browser` export that uses WebCrypto and a `node` one that imports `zlib` and
 * `util`. Metro's default export conditions are `require` and `import`, so it picked the Node build
 * — a build that cannot exist in React Native — and there is no `zlib` to give it.
 *
 * The first fix was to add `browser` to `unstable_conditionNames` globally. That fixed Android and
 * silently broke WEB: with those conditions, `tslib` resolves to a build whose default export is
 * undefined, and every route in the app died with
 *
 *   Cannot destructure property '__extends' of 'tslib.default' as it is undefined
 *
 * It went unnoticed for hours because the running Metro still had its pre-config state, so the
 * screen sweep kept passing against a bundler that was no longer what the repo described.
 *
 * So the override is scoped to the one package that needs it, on the platforms that need it.
 * Changing resolution for every package to fix one is how a bundler config becomes load-bearing in
 * ways nobody can explain.
 */
const { getDefaultConfig } = require('expo/metro-config');

const config = getDefaultConfig(__dirname);

/*
 * Agent worktrees live under `.claude/worktrees`, each a full checkout with its own node_modules. Metro crawls and
 * watches the project root, and with five of them installing at once the dev server died mid-session without a stack
 * trace. Nothing the app imports lives there.
 */
config.resolver.blockList = [...[config.resolver.blockList].flat().filter(Boolean), /[\\/]\.claude[\\/].*/];

config.resolver.unstable_enablePackageExports = true;

const defaultResolveRequest = config.resolver.resolveRequest;

config.resolver.resolveRequest = (context, moduleName, platform) => {
  const resolve = defaultResolveRequest ?? context.resolveRequest;

  // React Native is a WebCrypto runtime, not a Node one — but only `jose` is told so.
  if (platform !== 'web' && (moduleName === 'jose' || moduleName.startsWith('jose/'))) {
    return resolve(
      { ...context, unstable_conditionNames: ['browser', 'require', 'import'] },
      moduleName,
      platform,
    );
  }

  return resolve(context, moduleName, platform);
};

module.exports = config;
