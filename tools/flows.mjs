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
    if (m.type() === 'error' && !/isActive|balanceOf|styled-components|Coinbase/i.test(m.text())) errors.push(m.text());
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
   * What the ticket offers has to agree with what the permission allows.
   *
   * With nothing left today the button must not read "Buy $…": the refusal belongs before the signature, in words
   * (`src/markets/ticket.ts`). With an allowance, the offer is expected.
   */
  const offersABuy = /Buy \$[\d,]+/.test(ticket);
  const said = ticket.match(/Your permission[^.]*\./)?.[0] ?? '';
  check(
    limits.remainingUsd >= 10 ? offersABuy : !offersABuy && said !== '',
    limits.remainingUsd >= 10 ? 'with an allowance left, the ticket offers the buy' : 'with nothing left today, the ticket refuses in words',
    said || `$${limits.remainingUsd} left`,
  );

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
  const usdt0 = (tokens.tokens ?? tokens ?? []).find?.((t) => t.symbol === 'USDT0');
  if (usdt0 && Number(usdt0.amount) > 0) {
    check(/USDT0/.test(deposit), 'a held USDT0 balance is shown', `${usdt0.amount}`);
    check(/Convert|convert/.test(deposit), 'converting it to USDC is offered');
  } else {
    console.log('  – no USDT0 held, so the conversion offer is not expected');
  }
  seen.quiet('deposit');

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
  seen.quiet('signed out');

  await browser.close();
  console.log(failures === 0 ? '\nALL FLOWS PASSED\n' : `\n${failures} CHECK(S) FAILED\n`);
  process.exit(failures === 0 ? 0 : 1);
}

await main();
