/**
 * Deploy an executor, stamped with the commit it was built from.
 *
 * The executors are CLI uploads rather than git-linked deploys, so Railway records no commit and the
 * running code could not be matched to the repository. This sets `XORR_BUILD_SHA` on the service
 * without triggering a deploy of its own, uploads `server/`, and then waits until `/health` reports
 * that exact SHA — a deploy is not done because the upload finished.
 *
 *   node scripts/deploy-executor.mjs executor
 *   node scripts/deploy-executor.mjs executor-fork
 *
 * `-dirty` is appended when `server/` has uncommitted changes, so a hand-patched deploy says so.
 */
import { execFileSync } from 'node:child_process';

const SERVICES = {
  executor: 'https://api.xorr.finance',
  'executor-fork': 'https://executor-fork-production.up.railway.app',
};

const service = process.argv[2];
if (!(service in SERVICES)) {
  console.error(`\n  usage: node scripts/deploy-executor.mjs ${Object.keys(SERVICES).join(' | ')}\n`);
  process.exit(1);
}

const git = (...args) => execFileSync('git', args, { encoding: 'utf8' }).trim();
const sha = git('rev-parse', 'HEAD');
const dirty = git('status', '--porcelain', '--', 'server') !== '';
const stamp = dirty ? `${sha}-dirty` : sha;

/*
 * Project and environment named explicitly, and the upload run from inside server/.
 *
 * `railway up server` from the repo root failed with "prefix not found" before uploading anything —
 * the path argument and the directory the project is linked from did not agree. Naming the target
 * outright means neither the working directory's link nor a path argument decides where this goes.
 */
const PROJECT = '7bceeadb-7a50-462a-9554-3282d389ebff';
const ENVIRONMENT = 'production';
const target = ['--project', PROJECT, '--environment', ENVIRONMENT, '--service', service];

console.log(`\n  ${service} <- ${stamp}\n`);
execFileSync('railway', ['variable', 'set', `XORR_BUILD_SHA=${stamp}`, ...target, '--skip-deploys'], {
  stdio: 'inherit',
});
execFileSync('railway', ['up', ...target, '--ci'], { stdio: 'inherit', cwd: 'server' });

/* The upload returning is not the deploy being live: wait for the service to say which commit it runs. */
const base = SERVICES[service];
const deadline = Date.now() + 10 * 60_000;
for (;;) {
  const health = await fetch(`${base}/health`)
    .then((r) => r.json())
    .catch(() => null);
  if (health?.ok && health.version === stamp) {
    console.log(`\n  ${base} is up on ${health.chain} at ${stamp}\n`);
    break;
  }
  if (Date.now() > deadline) {
    console.error(`\n  ${base} did not report ${stamp} within 10 minutes (last: ${health?.version ?? 'no answer'})\n`);
    process.exit(1);
  }
  await new Promise((resolve) => setTimeout(resolve, 10_000));
}
