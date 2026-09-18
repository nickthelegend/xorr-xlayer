/**
 * E12 and E14 — two things a signed-in browser cannot check about itself.
 *
 * E12, cross-tenant isolation: a SECOND real Privy account must see none of the first's data. Run
 * from one session it is untestable, because the only session available is the one that owns the
 * data. So this signs in as a different account in a clean context and compares.
 *
 * E14, the signed-out state: an authenticated screen with no session must SAY it needs one.
 * Rendering an empty balance and an empty list is the failure mode — a screen that shows "$0.00"
 * to a signed-out visitor is stating a fact about a wallet it has not looked at.
 *
 * Run: node tools/isolation-check.mjs
 */
import { Buffer } from 'node:buffer';
import { chromium } from 'playwright';

try { process.loadEnvFile(new URL('../.env', import.meta.url)); } catch {}

const APP = process.env.APP_URL ?? 'https://app.xorr.finance';
const API = process.env.EXPO_PUBLIC_API_URL ?? 'https://executor-production-1659.up.railway.app';
const appId = process.env.PRIVY_APP_ID;
const secret = process.env.PRIVY_APP_SECRET;
const auth = {
  authorization: `Basic ${Buffer.from(`${appId}:${secret}`).toString('base64')}`,
  'privy-app-id': appId,
  'content-type': 'application/json',
};

const listed = await fetch(`https://auth.privy.io/api/v1/apps/${appId}/test_credentials`, { headers: auth });
const accounts = (await listed.json()).data ?? [];
const primaryEmail = process.env.E2E_PRIVY_EMAIL ?? 'test-8958@privy.io';
const other = accounts.find((a) => a.email !== primaryEmail);
if (!other) throw new Error('needs a second Privy test credential and there is only one');

let pass = 0, fail = 0;
const check = (id, ok, detail) => {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${id} ${detail}`);
  if (ok) pass++;
  else fail++;
};

const browser = await chromium.launch();

// ── E14 — a clean context, never signed in ─────────────────────────────────
{
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  const errors = [];
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });

  const results = [];
  for (const route of ['/', '/limits', '/strategies', '/activity', '/safety']) {
    await page.goto(APP + route, { waitUntil: 'networkidle', timeout: 45_000 }).catch(() => {});
    await page.waitForTimeout(6000);
    const text = (await page.innerText('body').catch(() => '')).replace(/\s+/g, ' ');
    // Correct: it asks you to sign in, or states that it cannot know. Not: an empty figure as fact.
    /*
     * "Not signed in" does not contain "sign in" — the space matters, and an earlier version of
     * this pattern failed four correct screens for it. Match what the screens actually say.
     */
    const asksForSignIn =
      /not signed in|sign in|signed out|was not requested|get started|create your wallet/i.test(text);
    results.push({ route, asksForSignIn, sample: text.slice(0, 110) });
  }
  for (const r of results) check('E14', r.asksForSignIn, `${r.route.padEnd(12)} ${r.sample}`);
  const bad = [...new Set(errors)].filter((e) => !/isActive|balanceOf|styled-components/i.test(e));
  check('E14', bad.length === 0, `console on signed-out screens: ${bad.length} error(s) ${bad[0] ?? ''}`);
  await ctx.close();
}

// ── E12 — a second real account, clean context ─────────────────────────────
{
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await page.goto(APP + '/wallet', { waitUntil: 'networkidle' });
  await page.fill('input[type=email]', other.email);
  await page.getByText(/email me a code/i).first().click();
  await page.waitForSelector('input[placeholder*="6-digit"]', { timeout: 30_000 });
  await page.fill('input[placeholder*="6-digit"]', other.otp_code);
  await page.getByText(/verify and create/i).first().click();
  await page.waitForTimeout(18_000);

  /*
   * Let the app register the wallet before asking the server about it.
   *
   * `/wallet/connect` is how the client tells the executor which address it is on, and it fires
   * when a screen that needs a wallet mounts. Asking `/wallet` straight after the OTP raced that,
   * and the probe read an empty answer as a missing wallet rather than as its own impatience.
   */
  await page.goto(APP + '/limits', { waitUntil: 'networkidle' }).catch(() => {});
  await page.waitForTimeout(10_000);

  const token = await page.evaluate(() => localStorage.getItem('privy:token'));
  if (!token) throw new Error(`sign-in failed for ${other.email}`);
  const addr = await page.evaluate(() => {
    const m = (localStorage.getItem('xorr-store') ?? '').match(/0x[0-9a-fA-F]{40}/);
    return m ? m[0] : null;
  });
  console.log(`\n  second account ${other.email} -> ${addr}`);

  const as = async (path) => {
    const r = await fetch(API + path, { headers: { authorization: `Bearer ${token.replace(/^"|"$/g, '')}` } });
    return { s: r.status, j: await r.json().catch(() => null) };
  };

  const wallet = await as('/wallet');
  /*
   * The claim is isolation, not onboarding.
   *
   * A browser OTP sign-in provisions a FRESH Privy user, so the executor legitimately has no wallet
   * row for it yet and `/wallet` answers `200 null`. That is the correct answer to "which wallet is
   * this user's" for a user who has registered none — and it is emphatically not the first
   * account's wallet, which is the property under test. Asserting a populated wallet here would be
   * testing that a new account has been onboarded, which is a different item.
   */
  const own = (wallet.j?.address ?? '').toLowerCase();
  check('E12', own !== '0x95a0b368588713011a15f4b1041423f31b08e615',
    `wallet is ${wallet.j?.address ?? 'null (no row yet — a fresh user)'}, not the first account's`);

  const strategies = await as('/strategies');
  const leaked = (strategies.j ?? []).filter((s) =>
    /UTC stamp check|anchor append-only probe|\$50 of WETH, weekly|\$5 of WETH, weekly/.test(s.label ?? ''));
  check('E12', leaked.length === 0, `sees ${(strategies.j ?? []).length} strategies, ${leaked.length} belonging to the first account`);

  const activity = await as('/activity?limit=50');
  const rows = Array.isArray(activity.j) ? activity.j : (activity.j?.entries ?? []);
  const leakedTrail = rows.filter((r) => /UTC stamp check|anchor append-only probe/.test(r.action ?? ''));
  check('E12', leakedTrail.length === 0, `sees ${rows.length} trail rows, ${leakedTrail.length} belonging to the first account`);

  const limits = await as('/limits');
  // Same reasoning: whatever it is, it must not be the first account's $1,600 cap.
  check('E12', limits.j?.dailyCapUsd !== 1600,
    `cap is ${limits.j?.dailyCapUsd ?? 'unset (no grant)'}, not the first account's $1,600`);

  await ctx.close();
}

await browser.close();
console.log(`\nE12/E14: ${pass} pass, ${fail} fail`);
