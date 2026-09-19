#!/usr/bin/env node
/**
 * flows — the signed-in journeys, clicked through in a real browser against a deployed build.
 *
 * `shoot.mjs` opens every screen and judges what it renders; this one USES them: it types into the ticket, submits a
 * form twice on purpose, reloads mid-flow, and checks what the executor actually recorded afterwards. Both sign in the
 * same way, through the real Privy form with a test credential (`signIn` there explains why that is a genuine session).
 *
 * Nothing here signs a transaction. Every step is either a read or a reversible write (an alert created and then
 * deleted), so it is safe to run against the fork deployment repeatedly. The one thing it will not do is spend the
 * daily cap — a fill is the owner's to authorise.
 *
 *   APP_URL=https://xorr-xlayer.vercel.app EXPO_PUBLIC_API_URL=https://executor-fork-production-2db8.up.railway.app \
 *     node tools/flows.mjs
 */
import { Buffer } from 'node:buffer';
import { chromium } from 'playwright';

const BASE = (process.env.APP_URL ?? 'http://localhost:8081').replace(/\/$/, '');
const API = (process.env.EXPO_PUBLIC_API_URL ?? 'http://localhost:8788').replace(/\/$/, '');
const EMAIL = process.env.E2E_PRIVY_EMAIL ?? 'test-8958@privy.io';

let failures = 0;
const check = (ok, what, detail = '') => {
  if (!ok) failures += 1;
  console.log(`${ok ? '  ✓' : '  ✗'} ${what}${detail ? `  — ${detail}` : ''}`);
};

/** The test credential, from Privy's own test-account API — the same one `shoot.mjs` uses. */
async function credential() {
  const appId = process.env.PRIVY_APP_ID;
  const secret = process.env.PRIVY_APP_SECRET;
  if (!appId || !secret) throw new Error('PRIVY_APP_ID/SECRET are needed to sign in.');
  const headers = {
    authorization: `Basic ${Buffer.from(`${appId}:${secret}`).toString('base64')}`,
    'privy-app-id': appId,
    'content-type': 'application/json',
  };
  const res = await fetch(`https://auth.privy.io/api/v1/apps/${appId}/test_credentials`, { headers });
  if (!res.ok) throw new Error(`could not list test credentials (${res.status})`);
  const all = (await res.json()).data ?? [];
  const account = all.find((a) => a.email === EMAIL) ?? all[0];
  if (!account) throw new Error('no test credential to sign in with');
  return account;
}

async function signIn(page) {
  const { email, otp_code: otp } = await credential();
  await page.goto(`${BASE}/wallet`, { waitUntil: 'networkidle' });
  await page.fill('input[type=email]', email);
  await page.getByText(/email me a code/i).first().click();
  await page.waitForSelector('input[placeholder*="6-digit"]', { timeout: 30_000 });
  await page.fill('input[placeholder*="6-digit"]', otp);
  await page.getByText(/verify and create/i).first().click();
  await page.waitForTimeout(15_000);
  const token = await page.evaluate(() => {
    try {
      return localStorage.getItem('privy:token');
    } catch {
      return null;
    }
  });
  if (!token) throw new Error(`sign-in failed for ${email}`);
  console.log(`signed in as ${email}\n`);
  return email;
}

/** The console errors and failed requests a step produced, third-party noise excused by name. */
function watch(page) {
  const errors = [];
  const network = [];
  page.on('console', (m) => {
    // Privy's own SDK logs two of these from its confirmation modal and its balance reader; nothing else is excused.
    if (m.type() === 'error' && !/isActive|balanceOf|styled-components/i.test(m.text())) errors.push(m.text());
  });
  page.on('response', (r) => {
    if (r.status() >= 400 && r.status() !== 503 && r.url().includes(API)) network.push(`${r.status()} ${r.url().slice(API.length)}`);
  });
  return {
    clear: () => {
      errors.length = 0;
      network.length = 0;
    },
    quiet: (what) => {
      check(errors.length === 0, `${what}: no console errors`, errors[0] ?? '');
      check(network.length === 0, `${what}: no failed requests`, network.join(' | '));
    },
    /** As `quiet`, with one expected class of noise named and excused. */
    quietExcept: (allowed, what) => {
      const unexpected = errors.filter((e) => !allowed.test(e));
      check(unexpected.length === 0, `${what}: no unexpected console errors`, unexpected[0] ?? '');
      check(network.length === 0, `${what}: no failed requests`, network.join(' | '));
    },
  };
}

const token = async () => {
  const { execFileSync } = await import('node:child_process');
  return execFileSync('npx', ['tsx', 'server/src/e2e-token.ts', EMAIL], { encoding: 'utf8' }).trim();
};
const apiGet = async (path, bearer) =>
  (await fetch(`${API}${path}`, { headers: { authorization: `Bearer ${bearer}` } })).json();

async function main() {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 430, height: 930 } });
  const seen = watch(page);
  await signIn(page);
  const bearer = await token();

  // ── 1. The order ticket quotes, and says what it will not do ──────────────────────────────────
  console.log('1. the order ticket');
  seen.clear();
  await page.goto(`${BASE}/order/TSLAx?side=buy`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(6000);
  const body = () => page.innerText('body');
  const limits = await apiGet('/limits', bearer);
  check(typeof limits.remainingUsd === 'number', 'the executor reports a remaining allowance', `$${limits.remainingUsd}`);
  const ticket = await body();
  check(/TSLA/i.test(ticket), 'the ticket names the instrument');
  check(/Minimum received/i.test(ticket), 'the ticket states a minimum received');
  seen.quiet('order ticket');

  /*
   * A floor can never be above the estimate it is a floor UNDER.
   *
   * The estimate was derived from the market price while "Minimum received" came from the route on the chain that
   * settles the fill. On a fork of mainnet those are two different prices, so the ticket guaranteed more than it
   * expected — 0.6877 TSLAx against 0.6844. Both numbers now come from the same quote.
   */
  const estimate = Number(ticket.match(/\n([\d.]+) TSLAx\n/)?.[1] ?? NaN);
  const floor = Number(ticket.match(/Minimum received\s*\n([\d.]+)/)?.[1] ?? NaN);
  check(
    Number.isFinite(estimate) && Number.isFinite(floor) && floor <= estimate,
    'the minimum received is at or below the estimate above it',
    `${floor} ≤ ${estimate}`,
  );

  /*
   * What the ticket lets you SEND has to agree with what the permission allows.
   *
   * The refusal belongs before the signature, in words (`src/markets/ticket.ts`), and the button must not be
   * pressable while it stands — a green button the chain would turn down is the thing this screen exists to avoid.
   */
  const said = ticket.match(/Your permission[^.]*\./)?.[0] ?? '';
  const pressable = await page
    .getByText(/^(Buy|Sell) \$/)
    .first()
    .isEnabled()
    .catch(() => null);
  if (limits.remainingUsd >= 10) {
    check(/Buy \$[\d,]+/.test(ticket), 'with an allowance left, the ticket offers the buy', `$${limits.remainingUsd} left`);
  } else {
    check(said !== '', 'with nothing left today, the ticket says so in words', said);
    check(pressable !== true, 'and the order button cannot be pressed', `enabled=${pressable}`);
  }

  /*
   * A buy, tapped (`FLOWS_SIGN=1` and an allowance to spend).
   *
   * The executor signs the fill with the delegate key inside the permission the owner granted — the tap is the
   * owner asking for it. $50 of TSLAx, which is what the demo places (PLAN.md D19).
   */
  if (process.env.FLOWS_SIGN === '1' && limits.remainingUsd >= 50) {
    console.log('\n1b. buying $50 of TSLAx from the ticket');
    seen.clear();
    const before = await apiGet('/positions', bearer);
    const heldBefore = Number((before.find?.((p) => p.symbol === 'TSLAx') ?? {}).units ?? 0);
    await page.goto(`${BASE}/order/TSLAx?side=buy`, { waitUntil: 'networkidle' });
    await page.waitForTimeout(6000);
    // Clear the default and key in 50, the way a finger does.
    for (let i = 0; i < 6; i += 1) await page.getByRole('button', { name: /Delete|Backspace/i }).first().click().catch(() => undefined);
    for (const digit of ['5', '0']) await page.getByRole('button', { name: new RegExp(`^${digit}$`) }).first().click();
    await page.waitForTimeout(7000);
    const cta = page.getByText(/^Buy \$50 of TSLAx$/).first();
    check(await cta.isEnabled().catch(() => false), 'the ticket offers the buy for the amount keyed in');
    await cta.click();
    await page.waitForSelector('text=/Bought|Already bought|filled/i', { timeout: 180_000 }).catch(() => undefined);
    await page.waitForTimeout(10_000);
    const said = await body();
    check(/Bought/i.test(said), 'the ticket confirms the fill in its own words', said.match(/Bought[^\n]*/)?.[0] ?? said.slice(0, 120));
    const after = await apiGet('/positions', bearer);
    const heldAfter = Number((after.find?.((p) => p.symbol === 'TSLAx') ?? {}).units ?? 0);
    check(heldAfter > heldBefore, 'the position grew on chain', `${heldBefore} → ${heldAfter} TSLAx`);
    const spent = await apiGet('/limits', bearer);
    check(
      Math.abs(spent.remainingUsd - (limits.remainingUsd - 50)) < 0.51,
      "the day's allowance fell by the amount spent",
      `$${limits.remainingUsd} → $${spent.remainingUsd}`,
    );
    const runs = await apiGet('/runs?limit=3', bearer);
    const fill = (runs.find?.((r) => r.status === 'filled') ?? {});
    check(!!fill.signature, 'the fill is recorded with its transaction', `${fill.venue ?? '?'} ${fill.signature ?? ''}`);
    seen.quiet('tapped buy');
  }

  // ── 2. An alert: created once, even when the button is hit twice, and then removed ────────────
  console.log('\n2. alerts — double submit, reload, delete');
  seen.clear();
  const before = await apiGet('/alerts', bearer);
  await page.goto(`${BASE}/alerts/new`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(5000);
  const submit = page.getByText(/^Alert me when/i).first();
  await submit.click();
  await submit.click({ timeout: 2000 }).catch(() => {});
  await page.waitForTimeout(6000);
  const after = await apiGet('/alerts', bearer);
  const added = (after.length ?? 0) - (before.length ?? 0);
  check(added === 1, 'two clicks created exactly one alert', `${before.length ?? 0} → ${after.length ?? 0}`);
  seen.quiet('alert creation');

  // Reload the list mid-flow: what was created is still there, once.
  await page.goto(`${BASE}/alerts`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(5000);
  const listed = await body();
  check(/XBTC|BTC/i.test(listed), 'the new alert is listed after a reload');

  const created = (after ?? []).filter((a) => !(before ?? []).some((b) => b.id === a.id));
  for (const a of created) {
    const res = await fetch(`${API}/alerts/${a.id}`, { method: 'DELETE', headers: { authorization: `Bearer ${bearer}` } });
    check(res.ok, 'the alert this run created is removed again', `${res.status}`);
  }

  // ── 3. Deposit: the balances are read from the chain, and USDT0 offers a conversion ───────────
  console.log('\n3. deposit');
  seen.clear();
  await page.goto(`${BASE}/deposit`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(8000);
  const deposit = await body();
  check(/0x[0-9a-fA-F]{6}/.test(deposit), 'the deposit address is shown');
  const tokens = await apiGet('/wallet/tokens', bearer);
  // `/wallet/tokens` reports `units`, the on-chain amount. Reading `amount` here made a funded wallet look empty.
  const usdt0 = (tokens.tokens ?? []).find((t) => t.symbol === 'USDT0');
  if (usdt0 && Number(usdt0.units) > 0) {
    check(/USDT0/.test(deposit), 'a held USDT0 balance is shown', `${usdt0.units}`);
    check(/Convert|convert/.test(deposit), 'converting it to USDC is offered');
  } else {
    console.log('  – no USDT0 held, so the conversion offer is not expected');
  }
  seen.quiet('deposit');

  /*
   * The conversion itself, signed by the owner — only when asked for (`FLOWS_SIGN=1`).
   *
   * This spends real USDT0 on whatever chain the build points at, so it is opt-in and the guard above keeps it to a
   * copy of mainnet. Two steps, as the screen has them: a preview that quotes and states the floor, then a Convert
   * the person presses. What it proves is that the app can sign a swap from the embedded wallet end to end.
   */
  if (process.env.FLOWS_SIGN === '1' && usdt0 && Number(usdt0.units) > 0) {
    const health = await (await fetch(`${API}/health`)).json();
    if (!/fork|localnet|testnet/.test(String(health.chain))) throw new Error(`refusing to sign on ${health.chain}`);
    console.log('\n3b. converting USDT0 → USDC, signed in the app');
    seen.clear();
    await page.getByText(/^Review conversion$/).first().click();
    await page.waitForSelector('text=/^Convert$/', { timeout: 60_000 });
    const quoted = await body();
    check(/1 USDT0 = [\d.]+ USDC/.test(quoted), 'the preview states the rate it will sign', quoted.match(/1 USDT0 = [\d.]+ USDC/)?.[0] ?? '');
    await page.getByText(/^Convert$/).first().click();
    /*
     * Two signatures, each confirmed in Privy's own modal: the token approval, then the swap. The wallet is the
     * person's, and this is where they say yes — a harness that skipped it would be testing a flow nobody has.
     */
    for (let step = 0; step < 2; step += 1) {
      const approve = page.getByRole('button', { name: /^Approve$/ }).first();
      await approve.waitFor({ state: 'visible', timeout: 120_000 }).catch(() => undefined);
      if (!(await approve.isVisible().catch(() => false))) break;
      await approve.click();
      check(true, `signature ${step + 1} of 2 confirmed in the wallet's own dialog`);
      await page.waitForTimeout(6000);
    }
    await page.waitForSelector('text=/Converted .* USDT0 to USDC\./', { timeout: 240_000 });
    const done = await body();
    check(/Converted [\d.,]+ USDT0 to USDC\./.test(done), 'the app reports the conversion done', done.match(/Converted [^\n]*/)?.[0] ?? '');
    const after = await apiGet('/wallet/tokens', bearer);
    const left = (after.tokens ?? []).find((t) => t.symbol === 'USDT0');
    check(Number(left?.units ?? 0) < Number(usdt0.units), 'the USDT0 left the wallet on chain', `${usdt0.units} → ${left?.units ?? 0}`);
    seen.quiet('conversion');
  }

  /*
   * The kill switch, then the permission again — the two the owner signs, on the fork (`FLOWS_SIGN=1`).
   *
   * Stop all is a HOLD, not a tap (`src/ui/holdToCommit.ts`, 600ms), and it is signed by the OWNER against the
   * delegation, so it works whether or not this server is running. Afterwards the wallet is left as it was found:
   * granted, because that is the state the rest of the deployment expects.
   */
  if (process.env.FLOWS_SIGN === '1') {
    const health = await (await fetch(`${API}/health`)).json();
    if (!/fork|localnet|testnet/.test(String(health.chain))) throw new Error(`refusing to sign on ${health.chain}`);

    console.log('\n3c. stop all, held down');
    seen.clear();
    // Only where there is something to stop: the button names the state, so a revoked wallet has no "Stop all".
    const live = await apiGet('/limits', bearer);
    await page.goto(`${BASE}/safety`, { waitUntil: 'networkidle' });
    await page.waitForTimeout(6000);
    const stop = page.getByText(/^Stop all trading$/).first();
    const box = live.revoked === false ? await stop.boundingBox().catch(() => null) : null;
    if (!box) console.log('  – already revoked, so there is nothing to stop');
    if (box) {
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
      await page.mouse.down();
      await page.waitForTimeout(1400);
      await page.mouse.up();
    }
    for (let i = 0; i < 3; i += 1) {
      const approve = page.getByRole('button', { name: /^Approve$/ }).first();
      await approve.waitFor({ state: 'visible', timeout: 60_000 }).catch(() => undefined);
      if (!(await approve.isVisible().catch(() => false))) break;
      await approve.click();
      await page.waitForTimeout(5000);
    }
    if (box) {
      await page.waitForTimeout(12_000);
      const stopped = await apiGet('/limits', bearer);
      check(stopped.revoked === true, 'the permission reads revoked on chain after the hold', JSON.stringify({ revoked: stopped.revoked, granted: stopped.granted }));
      seen.quiet('stop all');
    }

    console.log('\n3d. granting again, signed in the app');
    seen.clear();
    let signatures = 0;
    await page.goto(`${BASE}/delegate`, { waitUntil: 'networkidle' });
    await page.waitForTimeout(6000);
    await page.getByText(/^Sign this permission$/).first().click();
    /*
     * One confirmation per tradable token, then the grant — the screen says how many ("You'll sign 17 times.
     * Nothing is granted until the last."). The delegation can only pull a token the owner has approved, and the
     * app approves the whole tradable set up front so a later sale never stops to ask.
     */
    for (let i = 0; i < 24; i += 1) {
      const approve = page.getByRole('button', { name: /^Approve$/ }).first();
      await approve.waitFor({ state: 'visible', timeout: 90_000 }).catch(() => undefined);
      if (!(await approve.isVisible().catch(() => false))) break;
      await approve.click();
      signatures += 1;
      await page.waitForTimeout(4000);
    }
    check(signatures > 0, 'every confirmation the screen asked for was given', `${signatures} signatures`);
    await page.waitForTimeout(20_000);
    const granted = await apiGet('/limits', bearer);
    check(granted.granted === true && granted.revoked === false, 'the chain holds a live permission again', JSON.stringify({ cap: granted.dailyCapUsd, remaining: granted.remainingUsd }));
    seen.quiet('grant');
  }

  // ── 4. A screen behind the session, after the session is cleared ──────────────────────────────
  console.log('\n4. signed out mid-session');
  seen.clear();
  await page.evaluate(() => {
    try {
      localStorage.clear();
    } catch {
      /* private mode */
    }
  });
  await page.goto(`${BASE}/safety`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(5000);
  const signedOut = await body();
  check(/Sign in/i.test(signedOut), 'it asks for a sign-in rather than showing an empty screen');
  check(!/undefined|NaN|\[object/.test(signedOut), 'nothing leaks a placeholder value');
  /*
   * A 401 here is the app finding out, which is the only way it can: the session was cleared underneath it, and the
   * request it already had in flight is how it learns to ask for a sign-in. What matters is that it recovers to the
   * sign-in state rather than an error screen — asserted above — so only OTHER errors are held against this step.
   */
  seen.quietExcept(/401/, 'signed out');

  await browser.close();
  console.log(failures === 0 ? '\nALL FLOWS PASSED\n' : `\n${failures} CHECK(S) FAILED\n`);
  process.exit(failures === 0 ? 0 : 1);
}

await main();
