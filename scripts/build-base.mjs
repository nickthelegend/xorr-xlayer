/**
 * Build the web app for Base mainnet, or refuse to.
 *
 * `expo export` with no arguments produces a perfectly valid build for the WRONG chain. The client
 * reads `EXPO_PUBLIC_XORR_CHAIN` and falls back to `base-sepolia`, and that variable is not in
 * `.env` — so the default command yields a Sepolia bundle pointing at `http://localhost:8788`,
 * which looks exactly like a successful production build and is not one.
 *
 * A footgun that silently produces the wrong artifact is worse than one that fails, so this
 * refuses rather than documents. It checks the inputs before building and the artifact afterwards:
 * the point is not that the command was typed correctly, it is that the bundle that came out is
 * actually for Base.
 *
 *   EXPO_PUBLIC_API_URL=https://your-executor node scripts/build-base.mjs
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const OUT = 'dist-base';
const problems = [];

const api = process.env.EXPO_PUBLIC_API_URL ?? '';
if (!api) {
  problems.push('EXPO_PUBLIC_API_URL is not set — the app would have no executor to talk to.');
} else if (/localhost|127\.0\.0\.1/.test(api)) {
  /*
   * The default in `.env` and useless once deployed: a browser on someone else's machine resolves
   * localhost to their own machine. This is the mistake that ships silently, because it works
   * perfectly on the machine that built it.
   */
  problems.push(`EXPO_PUBLIC_API_URL is ${api} — a deployed build cannot reach your localhost.`);
}

if (problems.length > 0) {
  console.error('\n  Refusing to build for Base:\n');
  for (const p of problems) console.error(`    - ${p}`);
  console.error('\n  See docs/BASE-MAINNET.md.\n');
  process.exit(1);
}

/*
 * Does that executor actually settle on Base?
 *
 * A Base app pointed at a Sepolia executor is the mistake this whole script exists to prevent, and
 * it is invisible: both halves work, they just disagree about which chain the money is on. The
 * executor says which it is on, so ask it rather than trusting the URL to be named honestly.
 *
 * A health check that cannot be reached is a warning, not a refusal — the executor may simply not
 * be deployed yet, and refusing to build until it is would be the wrong order to do things in.
 */
const health = await fetch(new URL('/health', api), { signal: AbortSignal.timeout(20_000) })
  .then((r) => r.json())
  .catch(() => null);

if (!health) {
  console.warn(`\n  Warning: could not reach ${api}/health — building anyway.\n`);
} else if (health.chain !== 'base') {
  console.error(
    `\n  Refusing to build for Base:\n\n    - ${api} settles on "${health.chain}", not base.` +
      '\n      A Base app talking to that executor would show one chain and trade on another.\n',
  );
  process.exit(1);
} else {
  console.log(`  executor confirms chain "${health.chain}"`);
}

const env = {
  ...process.env,
  /* Explicit, not inherited. The whole point is that this cannot fall back to Sepolia. */
  EXPO_PUBLIC_XORR_CHAIN: 'base',
  XORR_CHAIN: 'base',
  ALLOW_MAINNET: 'yes',
};

console.log(`\n  Building for Base mainnet → ${OUT}\n  executor: ${api}\n`);
execFileSync('npx', ['expo', 'export', '--platform', 'web', '--output-dir', OUT], {
  env,
  stdio: 'inherit',
});

/*
 * Verify the ARTIFACT, not the intent.
 *
 * `chainLabel` folds to a literal at minify time, so a Base build contains "settles on Base" and a
 * Sepolia one does not. Checking the output is the only way to know the substitution actually
 * happened — an env var that was set and then ignored produces the same console output as one that
 * worked.
 */
const dir = join(OUT, '_expo/static/js/web');
const bundle = readdirSync(dir)
  .filter((f) => f.startsWith('index-') && f.endsWith('.js'))
  .map((f) => join(dir, f))
  .sort((a, b) => readFileSync(b).length - readFileSync(a).length)[0];

if (!bundle) {
  console.error('\n  Built, but no main bundle found to verify.\n');
  process.exit(1);
}

const js = readFileSync(bundle, 'utf8');
if (!js.includes('settles on Base.') || js.includes('settles on Base Sepolia')) {
  console.error(
    '\n  Built, but the bundle is NOT for Base — the chain constant did not fold through.\n',
  );
  process.exit(1);
}
if (js.includes('http://localhost:8788')) {
  console.error('\n  Built, but localhost is baked into the bundle.\n');
  process.exit(1);
}

console.log(`\n  Verified: ${bundle} is a Base mainnet bundle.\n`);
