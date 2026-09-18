/**
 * The hosted build: a static web bundle pointed at a PUBLIC executor, and at the chain it settles on.
 *
 * Everything in this repo could be run, and almost nothing could be opened. A judge, or anyone
 * else, got two JSON endpoints and a GIF unless they were willing to clone, create a Postgres and
 * supply three API keys. This produces the thing that was missing.
 *
 * The fork, by default, since PLAN.md 4.2. The hosted build was Base Sepolia because Privy previews
 * and broadcasts through its own RPC for a chain it knows, and a fork of Base is chain 8453 — so on
 * a fork build every user-signed transaction was simulated against mainnet, where the wallet holds
 * nothing. A fork build now has the wallet only sign, and sends the transaction to the fork itself
 * (`src/wallet/userSigning.ts`, proven with a Privy wallet on the Railway fork). And the fork is
 * where fills are real, so it is the one environment where the whole loop completes in one place:
 * sign in, take test funds, grant, watch the bot fill, withdraw. Sepolia fills nothing.
 * `XORR_WEB_API=https://api.xorr.finance` still builds Sepolia.
 *
 * A fork build carries the fork's own RPC (`EXPO_PUBLIC_CHAIN_RPC`), or `src/chain.ts` reads
 * 127.0.0.1:8545 in every visitor's browser. It comes from `XORR_WEB_CHAIN_RPC`, else from
 * `server/.env.fork` — what `npm run rebuild:fork` wrote — and is refused unless it answers, from
 * here, as anvil on chain 8453.
 *
 * Every build also pins the delegation contract it was built against (`EXPO_PUBLIC_PINNED_DELEGATION`,
 * FEATURES.md #24), names the commit it was built from (`EXPO_PUBLIC_APP_COMMIT`, #53), and installs
 * like an app (#66): see the steps below.
 *
 * WHY THIS REWRITES .env RATHER THAN SETTING A VARIABLE
 *
 * Two things were tried first and both produced a flawless build log and a bundle still wired to
 * localhost. Passing EXPO_PUBLIC_API_URL in the shell environment does nothing, because Expo loads
 * `.env` afterwards and wins. Adding `.env.production` did nothing either — whatever mode this
 * export runs in, `.env` is the file that won. So the only thing that reliably decides the value is
 * `.env` itself: it is swapped for the duration of the build and restored in a `finally`, which
 * runs on a failed export and on a Ctrl-C alike.
 *
 * This is the trap `build-base.mjs` documents, and it caught both attempts. Nothing here is trusted
 * without reading the artifact at the end.
 */
import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const OUT = 'dist-web';
const API = process.env.XORR_WEB_API ?? 'https://executor-fork-production.up.railway.app';
const ENV_FILE = '.env';
const FORK_ENV_FILE = 'server/.env.fork';

const refuse = (why) => {
  console.error(`\n  Refusing to build: ${why}\n`);
  process.exit(1);
};
const local = (url) => /localhost|127\.0\.0\.1/.test(url);

/* Refuse to ship a bundle that talks to a machine nobody else can reach. */
if (local(API)) refuse(`${API} is not reachable from anywhere but this machine.`);

/* And refuse to ship one pointed at an executor that is down or on the wrong chain. */
const health = await fetch(`${API}/health`).then((r) => r.json());
if (!health.ok) refuse(`${API} reports status "${health.status}".`);
console.log(`  executor up on chain "${health.chain}"`);

/** A value from a dotenv file, or undefined. Only public build settings are read this way. */
function envValue(file, name) {
  if (!existsSync(file)) return undefined;
  const line = readFileSync(file, 'utf8')
    .split('\n')
    .find((l) => l.startsWith(`${name}=`));
  return line?.slice(name.length + 1).trim().replace(/^["']|["']$/g, '') || undefined;
}

async function rpc(url, method, params = []) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  const body = await res.json();
  if (body.error) throw new Error(`${method}: ${body.error.message}`);
  return body.result;
}

/* A fork build names the fork's RPC, and the RPC has to be the fork. */
const FORK = health.chain === 'base-fork' || health.chain === 'localnet';
const CHAIN_RPC = FORK ? process.env.XORR_WEB_CHAIN_RPC ?? envValue(FORK_ENV_FILE, 'EXPO_PUBLIC_CHAIN_RPC') : undefined;
if (FORK) {
  if (!CHAIN_RPC) refuse(`${API} settles on ${health.chain}, and neither XORR_WEB_CHAIN_RPC nor ${FORK_ENV_FILE} names its RPC.`);
  if (local(CHAIN_RPC)) refuse(`${CHAIN_RPC} is not reachable from a visitor's browser.`);
  const [chainId, client] = await Promise.all([rpc(CHAIN_RPC, 'eth_chainId'), rpc(CHAIN_RPC, 'web3_clientVersion')]);
  if (Number(chainId) !== 8453 || !String(client).startsWith('anvil')) {
    refuse(`${CHAIN_RPC} answers as ${client} on chain ${Number(chainId)}, not as a fork of Base.`);
  }
  console.log(`  fork RPC ${CHAIN_RPC} answers as ${client} on chain ${Number(chainId)}`);
}

/*
 * The delegation contract this build pins (FEATURES.md #24).
 *
 * A grant approves the wallet's tokens to the contract the executor names, and a stop revokes one. The app refuses a
 * grant to any contract but the one it was built against, and tries that one first when stopping, so a stop does not
 * wait on the executor — which means the address baked in here has to be right, three ways, before anything is built:
 *   - the executor this build talks to reports it (`/health` → `delegation`);
 *   - the deployment's own record agrees, where there is one: `XORR_WEB_DELEGATION`, else `server/.env.fork` on a fork;
 *   - and the chain has a contract at that address.
 * The developer's `.env` is not asked. Its `EXPO_PUBLIC_DELEGATION_ADDRESS` named neither the fork's contract nor
 * Sepolia's when this was written (2026-09-14), and a pin taken from it would have refused every grant.
 */
const PUBLIC_RPC = { base: 'https://mainnet.base.org', 'base-sepolia': 'https://sepolia.base.org' };
const PIN = String(health.delegation ?? '').toLowerCase();
if (!/^0x[0-9a-f]{40}$/.test(PIN)) refuse(`${API} does not report its delegation contract, so there is nothing to pin.`);
const RECORD = (
  process.env.XORR_WEB_DELEGATION ?? (FORK ? envValue(FORK_ENV_FILE, 'EXPO_PUBLIC_DELEGATION_ADDRESS') : undefined)
)?.toLowerCase();
if (RECORD && RECORD !== PIN) refuse(`${API} names the delegation contract ${PIN}, and the deployment record names ${RECORD}.`);
const CODE_RPC = CHAIN_RPC ?? PUBLIC_RPC[health.chain];
if (!CODE_RPC) refuse(`there is no RPC to confirm the delegation contract on ${health.chain}.`);
const code = await rpc(CODE_RPC, 'eth_getCode', [PIN, 'latest']);
if (!code || code === '0x') refuse(`there is no contract at ${PIN} on ${health.chain}.`);
console.log(
  `  delegation contract ${PIN} pinned: ${RECORD ? 'the executor and the deployment record agree' : 'as the executor reports it (no deployment record to compare)'}, and the chain holds its code`,
);

if (!existsSync(ENV_FILE)) refuse(`there is no ${ENV_FILE} to build from. Copy .env.example and fill it in.`);

/*
 * The commit this bundle is built from (FEATURES.md #53), so the app can say which code it is and whether the executor
 * it reads runs the same (`src/version.ts`; every executor reports `/health` → `version`). Only a clean checkout names
 * one: a build of uncommitted changes is not any commit, and saying it was would be the one wrong answer.
 */
const COMMIT = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
const DIRTY = execFileSync('git', ['status', '--porcelain', '--untracked-files=no'], { encoding: 'utf8' }).trim() !== '';
const APP_COMMIT = DIRTY ? undefined : COMMIT;
console.log(`  app commit ${APP_COMMIT ?? `none named: the checkout at ${COMMIT.slice(0, 7)} has uncommitted changes`}`);

/*
 * Whether the executor's commit carries this build's server code (`src/version.ts` → `serverMatch`). A web-only deploy
 * leaves the executors where they were, and when nothing under `server/` (the executor's whole build, per
 * `server/railway.json`) has changed since, the app would report two commits in the warning colour about identical
 * code. Git answers. A difference, or a commit this checkout does not have, leaves it unset and the difference shown.
 */
const EXECUTOR_COMMIT = /^[0-9a-f]{7,40}$/i.test(String(health.version ?? '')) ? String(health.version).toLowerCase() : undefined;
let SERVER_MATCH;
if (APP_COMMIT && EXECUTOR_COMMIT && !APP_COMMIT.startsWith(EXECUTOR_COMMIT)) {
  try {
    execFileSync('git', ['diff', '--quiet', EXECUTOR_COMMIT, COMMIT, '--', 'server'], { stdio: 'ignore' });
    SERVER_MATCH = EXECUTOR_COMMIT;
  } catch {
    // Exit 1 is a difference and 128 a commit this checkout does not have: no match to claim either way.
  }
}
console.log(
  `  executor commit ${EXECUTOR_COMMIT ? EXECUTOR_COMMIT.slice(0, 7) : 'not named'}${SERVER_MATCH ? `, whose server code is this build's` : ''}`,
);

/* The developer's own file, restored verbatim below whatever happens. */
const original = readFileSync(ENV_FILE, 'utf8');

try {
  const patched = original
    .split('\n')
    .filter((l) => !/^EXPO_PUBLIC_(API_URL|XORR_CHAIN|CHAIN_RPC|PINNED_DELEGATION|APP_COMMIT|SERVER_MATCH)=/.test(l))
    .concat([
      `EXPO_PUBLIC_API_URL=${API}`,
      `EXPO_PUBLIC_XORR_CHAIN=${health.chain}`,
      ...(CHAIN_RPC ? [`EXPO_PUBLIC_CHAIN_RPC=${CHAIN_RPC}`] : []),
      `EXPO_PUBLIC_PINNED_DELEGATION=${PIN}`,
      ...(APP_COMMIT ? [`EXPO_PUBLIC_APP_COMMIT=${APP_COMMIT}`] : []),
      ...(SERVER_MATCH ? [`EXPO_PUBLIC_SERVER_MATCH=${SERVER_MATCH}`] : []),
      '',
    ])
    .join('\n');
  writeFileSync(ENV_FILE, patched);
  rmSync(OUT, { recursive: true, force: true });
  console.log(`\n  Building the hosted app → ${OUT}\n  executor: ${API}${CHAIN_RPC ? `\n  chain RPC: ${CHAIN_RPC}` : ''}\n`);
  /*
   * `--clear`, always. Metro caches transformed modules, and an inlined `process.env` value is
   * baked into that cache — so changing the variable and rebuilding reuses the old constant and
   * emits a bundle pointed at the previous URL. The third failed attempt at this build was exactly
   * that: `.env` correct on disk, cache stale, log clean.
   */
  execFileSync('npx', ['expo', 'export', '--clear', '--platform', 'web', '--output-dir', OUT], {
    stdio: 'inherit',
  });
} finally {
  writeFileSync(ENV_FILE, original);
}

/*
 * Verify the ARTIFACT, not the intent — the whole reason this script exists.
 *
 * The first attempt at this build set the variable in the shell, printed a flawless log, and
 * produced a bundle still wired to localhost:8788. Only reading the output caught it.
 */
const dir = join(OUT, '_expo/static/js/web');
const bundle = readdirSync(dir)
  .filter((f) => f.startsWith('index-') && f.endsWith('.js'))
  .map((f) => join(dir, f))
  .sort((a, b) => readFileSync(b).length - readFileSync(a).length)[0];
const js = readFileSync(bundle, 'utf8');

/*
 * `localhost:8788` is `DEFAULT_BASE` in `apiBase.ts` — a source literal that is in every bundle ever
 * built, so checking for its absence failed a build that was actually fine. A public URL can only
 * reach the bundle by being inlined, so its presence is proof the substitution happened — for the
 * executor, and on a fork build for the chain's RPC too.
 */
const problems = [];
if (!js.includes(API)) problems.push(`the bundle does not contain ${API}`);
if (CHAIN_RPC && !js.includes(CHAIN_RPC)) problems.push(`the bundle does not contain the fork RPC ${CHAIN_RPC}`);
if (!js.includes(PIN)) problems.push(`the bundle does not contain the pinned delegation contract ${PIN}`);
if (APP_COMMIT && !js.includes(APP_COMMIT)) problems.push(`the bundle does not name its commit ${APP_COMMIT}`);
if (SERVER_MATCH && !js.includes(SERVER_MATCH)) problems.push(`the bundle does not carry the matching executor commit ${SERVER_MATCH}`);

if (problems.length) {
  console.error(`\n  Build produced the wrong artifact:\n${problems.map((p) => `    - ${p}`).join('\n')}\n`);
  process.exit(1);
}

/*
 * An app a phone can install (FEATURES.md #66): a manifest, icons, and the tags a phone reads when the page is added to a
 * home screen — standalone, black, the app's own mark. The icons in `assets/web/` are cut from `assets/icon.png`.
 *
 * No service worker. An offline shell for an app whose every number is live would open on stale money, and a cache
 * that holds a deploy wrong is how a fix never reaches anyone; that is a separate decision from being installable.
 */
mkdirSync(join(OUT, 'icons'), { recursive: true });
for (const file of ['icon-192.png', 'icon-512.png', 'apple-touch-icon.png']) {
  copyFileSync(join('assets/web', file), join(OUT, 'icons', file));
}
writeFileSync(
  join(OUT, 'manifest.webmanifest'),
  JSON.stringify(
    {
      name: 'xorr',
      short_name: 'xorr',
      description: 'A bot that trades while you get on with your life',
      start_url: '/',
      scope: '/',
      display: 'standalone',
      orientation: 'portrait',
      background_color: '#000000',
      theme_color: '#000000',
      icons: [
        { src: '/icons/icon-192.png', sizes: '192x192', type: 'image/png' },
        { src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png' },
      ],
    },
    null,
    2,
  ) + '\n',
);
const INDEX = join(OUT, 'index.html');
const html = readFileSync(INDEX, 'utf8');
if (!html.includes('</head>')) {
  console.error(`\n  ${INDEX} has no </head> to add the app manifest to.\n`);
  process.exit(1);
}
const installTags = [
  '<link rel="manifest" href="/manifest.webmanifest" />',
  '<meta name="theme-color" content="#000000" />',
  '<link rel="apple-touch-icon" href="/icons/apple-touch-icon.png" />',
  '<meta name="mobile-web-app-capable" content="yes" />',
  '<meta name="apple-mobile-web-app-capable" content="yes" />',
  '<meta name="apple-mobile-web-app-title" content="xorr" />',
  '<meta name="apple-mobile-web-app-status-bar-style" content="black" />',
].join('');
writeFileSync(INDEX, html.replace('</head>', `${installTags}</head>`));

/*
 * Make the output deployable on Vercel, where the frontend lives.
 *
 * xorr.finance splits its hosting: the frontend is served by Vercel and the backend — executor,
 * Postgres and the fork — stays on Railway. This script used to emit a zero-dependency Node server
 * and a package.json so Railway could serve the bundle; that was a whole always-on service whose
 * only job was falling back to index.html for routes that are not files.
 *
 * `vercel.json` does the same job without a server. expo export emits ONE index.html and every
 * route in this app is client-side, so a plain file host answers /markets with a 404 and the app
 * never boots. Vercel checks the filesystem before applying a rewrite, so real files — the hashed
 * bundles, fonts, the favicon — are served as themselves and everything else falls back to the app,
 * which then renders its own not-found screen for a route that really does not exist.
 *
 * Hashed assets are immutable; index.html must not be cached, or a deploy never reaches anyone.
 *
 * And the headers any money app should send (FEATURES.md #76): no framing of this app by another site (Privy's own
 * iframes are framed BY this app, which these do not touch), no MIME sniffing, no referrer beyond the origin, HTTPS
 * only, and no camera or location. No content-security policy yet: Privy, its RPCs and the executor need a list that
 * has to be proven in a browser before it is enforced, and a wrong one fails sign-in silently.
 */
writeFileSync(
  join(OUT, 'vercel.json'),
  JSON.stringify(
    {
      rewrites: [{ source: '/(.*)', destination: '/index.html' }],
      headers: [
        {
          source: '/(.*)',
          headers: [
            { key: 'X-Frame-Options', value: 'DENY' },
            { key: 'X-Content-Type-Options', value: 'nosniff' },
            { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
            { key: 'Strict-Transport-Security', value: 'max-age=31536000' },
            { key: 'Permissions-Policy', value: 'camera=(), geolocation=()' },
          ],
        },
        {
          source: '/_expo/static/(.*)',
          headers: [{ key: 'Cache-Control', value: 'public, max-age=31536000, immutable' }],
        },
        { source: '/index.html', headers: [{ key: 'Cache-Control', value: 'no-cache' }] },
        { source: '/', headers: [{ key: 'Cache-Control', value: 'no-cache' }] },
      ],
    },
    null,
    2,
  ) + '\n',
);

console.log(
  `\n  ${bundle}\n  points at ${API}${CHAIN_RPC ? ` and ${CHAIN_RPC}` : ''}, pins ${PIN}${APP_COMMIT ? `, names ${APP_COMMIT.slice(0, 7)}` : ''}, installable — verified in the bundle, not assumed.\n`,
);
