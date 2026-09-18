#!/usr/bin/env node
/**
 * web-sweep — every route of the hosted web app, opened fresh in a real Chromium, signed out.
 *
 * For each route: the console's errors and warnings, uncaught page errors, every failed request and every response at
 * 400 or above (a 503 carrying Retry-After is the executor's warming handshake and is not a failure), the page's text,
 * and a screenshot at the design's canvas size. Nothing is mocked and nothing signs in: this is what a visitor gets.
 *
 *   APP_URL=https://<the X Layer web app> ROUTES=routes.txt OUT=out-dir node tools/web-sweep.mjs
 *
 * `APP_URL` (or the older `WEB`) is required: app.xorr.finance still serves the Base build, so there is no default.
 *
 * `ROUTES` is one path per line (docs/qa/SCREENS.md's example URLs). Results land in `OUT/results.json`; the lines
 * printed are the routes with something to look at.
 */
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';

const BASE = (process.env.APP_URL ?? process.env.WEB ?? '').trim().replace(/\/+$/, '');
const OUT = process.env.OUT;
const ROUTES = process.env.ROUTES;
const SETTLE_MS = Number(process.env.SETTLE_MS ?? 6000);
if (!/^https?:\/\//.test(BASE) || !OUT || !ROUTES) {
  console.error('usage: APP_URL=<the X Layer web app> ROUTES=routes.txt OUT=dir node tools/web-sweep.mjs — APP_URL has no default');
  process.exit(2);
}
fs.mkdirSync(OUT, { recursive: true });
const routes = fs
  .readFileSync(ROUTES, 'utf8')
  .split('\n')
  .map((s) => s.trim())
  .filter(Boolean);

const clip = (s, n = 300) => String(s).replace(/\s+/g, ' ').slice(0, n);
// Query strings can carry an owner address or a token; the report keeps paths only.
const pathOnly = (u) => u.split('?')[0];

const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: 402, height: 874 }, deviceScaleFactor: 1 });
const results = [];

for (const route of routes) {
  const page = await context.newPage();
  const r = { route, errors: [], warnings: [], pageErrors: [], failed: [], bad: [], aborted: 0, api: [], ms: 0, text: '' };
  page.on('console', (m) => {
    if (m.type() === 'error') r.errors.push(clip(m.text()));
    else if (m.type() === 'warning') r.warnings.push(clip(m.text()));
  });
  page.on('pageerror', (e) => r.pageErrors.push(clip(e)));
  page.on('requestfailed', (q) => {
    const why = q.failure()?.errorText ?? '';
    // A request the page itself abandoned on navigation (a HEAD probe, a superseded chunk) is not a failure.
    if (/ERR_ABORTED/.test(why)) r.aborted += 1;
    else r.failed.push(`${q.method()} ${pathOnly(q.url())} ${why}`);
  });
  page.on('response', (res) => {
    const status = res.status();
    const url = pathOnly(res.url());
    if (!/\/_expo\/|\/assets\/|\.(png|ttf|js|css|ico|webmanifest)$/.test(url) && !url.startsWith(`${BASE}/`)) {
      r.api.push(`${status} ${res.request().method()} ${url}`);
    }
    if (status >= 400 && !(status === 503 && res.headers()['retry-after'])) r.bad.push(`${status} ${res.request().method()} ${url}`);
  });
  const t0 = Date.now();
  try {
    await page.goto(`${BASE}${route}`, { waitUntil: 'load', timeout: 45_000 });
  } catch (e) {
    r.pageErrors.push(`navigation: ${clip(e, 200)}`);
  }
  await page.waitForTimeout(SETTLE_MS);
  r.ms = Date.now() - t0;
  r.text = clip(await page.evaluate(() => document.body.innerText).catch(() => ''), 900);
  const stem = route.replace(/\?.*$/, '').replace(/[^a-z0-9]+/gi, '_').replace(/^_|_$/g, '') || 'home';
  await page.screenshot({ path: path.join(OUT, `${stem}.png`) }).catch(() => {});
  results.push(r);
  await page.close();
}

await browser.close();
fs.writeFileSync(path.join(OUT, 'results.json'), `${JSON.stringify(results, null, 2)}\n`);
const flagged = results.filter((r) => r.errors.length || r.pageErrors.length || r.failed.length || r.bad.length);
console.log(`${results.length} routes · ${flagged.length} with console errors, page errors, failed or 4xx/5xx requests`);
for (const r of flagged) {
  console.log(`${r.route} ${JSON.stringify({ errors: r.errors.slice(0, 3), pageErrors: r.pageErrors.slice(0, 2), failed: r.failed.slice(0, 3), bad: r.bad.slice(0, 4) })}`);
}
const warned = results.filter((r) => r.warnings.length);
console.log(`${warned.length} routes with console warnings`);
for (const r of warned) console.log(`${r.route} warnings: ${JSON.stringify(r.warnings.slice(0, 2))}`);
