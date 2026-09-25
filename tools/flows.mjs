#!/usr/bin/env node
/**
 * flows — the signed-in journeys, clicked through in a real browser against a deployed build.
 *
 * `shoot.mjs` opens every screen and judges what it renders; this one USES them: it types into the ticket, submits a
 * form twice on purpose, reloads mid-flow, and checks what the executor actually recorded afterwards. Both sign in the
 * same way, through the real Privy form with a test credential (`signIn` there explains why that is a genuine session).
 *
 * Without `FLOWS_SIGN=1` nothing here signs a transaction: every step is a read or a reversible write (an alert created
 * and then deleted), so it is safe to run against the fork deployment repeatedly. With it, on a fork or a testnet only,
 * the owner's own signatures are exercised too — a buy, the stop, the grant, and one agent's budget.
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

/**
 * Open a screen and let it settle — without making "settled" mean "silent".
 *
 * Every page used to wait for `networkidle`, which Playwright defines as half a second with no request in flight.
 * This app polls prices and a heartbeat on purpose, so on a busy minute a screen can be fully drawn and never go
 * quiet: `/alerts` sat there for the whole 30s and failed a run on a page that had rendered. Load is required; a
 * quiet network is waited for when it comes, and not demanded when it does not.
 */
async function open(page, path) {
  await page.goto(`${BASE}${path}`, { waitUntil: 'load' });
  await page.waitForLoadState('networkidle', { timeout: 10_000 }).catch(() => undefined);
}

async function signIn(page) {
  const { email, otp_code: otp } = await credential();
  await open(page, `/wallet`);
  await page.fill('input[type=email]', email);
  await page.getByText(/email me a code/i).first().click();
  /*
   * Privy's send can take its time, and a second press costs nothing: the code field is what says it arrived. Thirty
   * seconds was enough until it was not, and a harness that fails on its own impatience teaches nothing.
   */
  const code = 'input[placeholder*="6-digit"]';
  await page.waitForSelector(code, { timeout: 60_000 }).catch(async () => {
    await page.getByText(/email me a code/i).first().click().catch(() => undefined);
    await page.waitForSelector(code, { timeout: 60_000 });
  });
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
  await open(page, `/order/TSLAx?side=buy`);
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
  /*
   * Compared once the route has answered. Until then the market's estimate stands in and the floor reads "…" — by
   * design (`app/order/[symbol].tsx`) — so a comparison taken at a fixed moment could catch the two halves of that
   * wait and report NaN for a ticket that was simply still quoting.
   */
  await page
    .waitForFunction(() => /Minimum received\s*\n[\d.]+/.test(document.body.innerText), undefined, { timeout: 45_000 })
    .catch(() => undefined);
  const quotedTicket = await body();
  const estimate = Number(quotedTicket.match(/\n([\d.]+) TSLAx\n/)?.[1] ?? NaN);
  const floor = Number(quotedTicket.match(/Minimum received\s*\n([\d.]+)/)?.[1] ?? NaN);
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
  /*
   * Whatever it refuses on, it says so: the permission's allowance, or the cash in the wallet. A brand-new wallet is
   * refused for having no USDC ("You have $0.00.") long before its permission is the reason.
   */
  const said = ticket.match(/(There is no permission[^.]*\.|Your permission[^.]*\.|You have \$[\d,.]+\.|You hold [^.]*\.)/)?.[0] ?? '';
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
    await open(page, `/order/TSLAx?side=buy`);
    await page.waitForTimeout(6000);
    // Clear the default and key in 50, the way a finger does.
    for (let i = 0; i < 6; i += 1) await page.getByRole('button', { name: /Delete|Backspace/i }).first().click().catch(() => undefined);
    for (const digit of ['5', '0']) await page.getByRole('button', { name: new RegExp(`^${digit}$`) }).first().click();
    await page.waitForTimeout(7000);
    const cta = page.getByText(/^Buy \$50 of TSLAx$/).first();
    /*
     * Wait for the quote before judging the button. It is disabled while the route is being re-quoted for the amount
     * just keyed in (`quotePending`), which is the ticket refusing to send an order against a floor nobody was shown
     * — so "disabled right now" is a state to wait out, not a failure.
     */
    let offered = false;
    for (let i = 0; i < 20 && !offered; i += 1) {
      offered = await cta.isEnabled().catch(() => false);
      if (!offered) await page.waitForTimeout(1500);
    }
    check(offered, 'the ticket offers the buy once the quote for that amount lands');
    await cta.click();
    /*
     * Read the confirmation the moment it appears: the ticket says what it bought and then takes itself away after
     * 1.2 seconds (`app/order/[symbol].tsx`), so a check that looks a few seconds later is reading the screen the
     * app went back to, not the one it is judging.
     */
    const said = await page
      .waitForSelector('text=/Bought/i', { timeout: 180_000 })
      .then((el) => el.innerText())
      .catch(() => '');
    check(/Bought/i.test(said), 'the ticket confirms the fill in its own words', said.replace(/\n/g, ' '));
    await page.waitForTimeout(8000);
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

  /*
   * The same ask after a reload, which is what somebody does when a request looks stuck.
   *
   * The key an attempt holds is written down (`src/data/heldKeys.ts`), so the repeat carries it and the executor
   * answers with what it already did. Without that this bought twice: measured on 2026-09-20, two fills and $20 gone
   * for one thing asked for once.
   */
  // Twenty, not ten: this step places a buy and then asks for the same one again, and the second ask needs room to
  // be refused for the RIGHT reason — a ticket that will not send because the day is spent proves nothing about keys.
  if (process.env.FLOWS_SIGN === '1' && (await apiGet('/limits', bearer)).remainingUsd >= 20) {
    console.log('\n1c. reload mid-order, then ask again');
    seen.clear();
    const filledBefore = ((await apiGet('/runs?limit=50', bearer)) ?? []).filter((r) => r.status === 'filled').length;
    const spentBefore = (await apiGet('/limits', bearer)).remainingUsd;
    const keyIn = async () => {
      await open(page, `/order/TSLAx?side=buy`);
      await page.waitForTimeout(6000);
      for (let i = 0; i < 6; i += 1) await page.getByRole('button', { name: /Delete|Backspace/i }).first().click().catch(() => undefined);
      for (const digit of ['1', '0']) await page.getByRole('button', { name: new RegExp(`^${digit}$`) }).first().click();
      await page.waitForTimeout(6000);
      const cta = page.getByText(/^Buy \$10 of TSLAx$/).first();
      for (let i = 0; i < 20 && !(await cta.isEnabled().catch(() => false)); i += 1) await page.waitForTimeout(1500);
      return cta;
    };
    await (await keyIn()).click();
    await page.waitForTimeout(1200);
    await page.reload({ waitUntil: 'domcontentloaded' }).catch(() => undefined);
    await page.waitForTimeout(20_000);
    const retry = await keyIn();
    const offered = await retry.isEnabled().catch(() => false);
    check(offered, 'the ticket still offers the same buy after the reload', `enabled=${offered}`);
    if (offered) await retry.click();
    await page.waitForTimeout(25_000);
    const filledAfter = ((await apiGet('/runs?limit=50', bearer)) ?? []).filter((r) => r.status === 'filled').length;
    const spentAfter = (await apiGet('/limits', bearer)).remainingUsd;
    check(filledAfter - filledBefore === 1, 'one ask, one fill — the repeat replayed the first answer', `${filledBefore} → ${filledAfter} filled`);
    check(Math.abs(spentBefore - spentAfter - 10) < 0.51, "and the day's allowance fell once", `$${spentBefore} → $${spentAfter}`);
    seen.quiet('reload mid-order');
  }

  // ── 2. An alert: created once, even when the button is hit twice, and then removed ────────────
  console.log('\n2. alerts — double submit, reload, delete');
  seen.clear();
  const before = await apiGet('/alerts', bearer);
  await open(page, `/alerts/new`);
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
  await open(page, `/alerts`);
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
  await open(page, `/deposit`);
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
    await open(page, `/safety`);
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
    await open(page, `/delegate`);
    await page.waitForTimeout(6000);
    /*
     * `FLOWS_CAP` sets the daily cap before signing, the way a finger does — down to the floor, then up in the stepper's
     * own steps. The executor keeps its own tally of the day beside the contract's, so a wallet that already traded
     * today needs a cap above what it spent to have anything left.
     */
    const wantCap = Number(process.env.FLOWS_CAP ?? 0);
    if (wantCap > 0) {
      const down = page.getByRole('button', { name: 'Decrease' }).first();
      const up = page.getByRole('button', { name: 'Increase' }).first();
      for (let i = 0; i < 110 && (await down.isEnabled().catch(() => false)); i += 1) await down.click();
      for (let i = 0; i < Math.round((wantCap - 50) / 50); i += 1) await up.click();
    }
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
    if (wantCap > 0) check(granted.dailyCapUsd === wantCap, 'at the daily cap chosen on the screen', `$${granted.dailyCapUsd}`);
    seen.quiet('grant');
  }

  /*
   * One agent's own budget, signed by the owner in the app (`FLOWS_SIGN=1`, 2026-09-25).
   *
   * The Budget card on the agent's page sends `setAgentBudget` from the embedded wallet — one confirmation — and then
   * shows the figure the chain answers, not the one tapped. What is checked afterwards is the executor reading the same
   * figure off the contract, and the trail recording it from the transaction's own event.
   */
  if (process.env.FLOWS_SIGN === '1') {
    const health = await (await fetch(`${API}/health`)).json();
    if (!/fork|localnet|testnet/.test(String(health.chain))) throw new Error(`refusing to sign on ${health.chain}`);

    console.log("\n3e. an agent's own budget, signed in the app");
    seen.clear();
    const roster = await apiGet('/agents', bearer);
    const agent = (Array.isArray(roster) ? roster : []).find((a) => a.hired && a.onChainKey);
    if (!agent) {
      console.log('  – no hired agent on this wallet, so there is no budget to set');
    } else {
      // A figure different from the one it holds, so the change is visible.
      const target = agent.budgetUsd === 50 ? 25 : 50;
      await open(page, `/agent/${agent.id}`);
      await page.waitForSelector('text=/^Budget$/', { timeout: 60_000 });
      // Inside the card: "$50" can appear elsewhere on the page.
      const card = page.locator('[data-testid="agent-budget"]');
      await card.getByText(`$${target}`, { exact: true }).first().click();
      await card.getByText(new RegExp(`^Set budget to \\$${target}\\.00$`)).first().click();
      let signatures = 0;
      for (let i = 0; i < 3; i += 1) {
        const approve = page.getByRole('button', { name: /^Approve$/ }).first();
        await approve.waitFor({ state: 'visible', timeout: 60_000 }).catch(() => undefined);
        if (!(await approve.isVisible().catch(() => false))) break;
        await approve.click();
        signatures += 1;
        await page.waitForTimeout(4000);
      }
      check(signatures === 1, 'one confirmation, in the wallet’s own dialog', `${signatures} signatures`);
      const landed = await page
        .waitForSelector('text=/Set on chain\\./', { timeout: 180_000 })
        .then(() => true)
        .catch(() => false);
      check(landed, 'the card says the budget is set on chain');
      const shown = await card.innerText().catch(() => '');
      check(shown.includes(`$${target}.00`), 'and shows the figure the chain answered', shown.split('\n').slice(0, 3).join(' | '));
      const reread = await apiGet('/agents', bearer);
      const now = (Array.isArray(reread) ? reread : []).find((a) => a.id === agent.id);
      check(now?.budgetUsd === target, 'the executor reads the same budget off the contract', `$${now?.budgetUsd}`);
      const trail = await apiGet('/activity', bearer);
      const row = (Array.isArray(trail) ? trail : []).find((e) => e.action === 'Budget set' && e.agent === agent.name);
      check(Boolean(row?.detail?.includes(`$${target}.00`)), 'the trail records it, from the transaction', row?.detail ?? '');
      seen.quiet("agent's budget");
    }
  }

  // ── 4. The strategy book, from the home sheet, the way a person reaches it ────────────────────
  /*
   * The route sweep opens `/playbook` directly; nobody arrives that way. The path that matters is the tab on
   * the home sheet — which is fifth of five and scrolls in from the right on a phone — and the row that opens
   * a report. A tab nobody can reach is a feature nobody has.
   */
  console.log('\n4. the strategy book, from home');
  seen.clear();
  await open(page, `/`);
  await page.waitForTimeout(4000);

  const tab = page.getByText('Strategies', { exact: true }).first();
  await tab.scrollIntoViewIfNeeded().catch(() => undefined);
  await tab.click({ timeout: 10_000 });
  await page.waitForTimeout(5000);
  const sheet = await body();
  check(/unseen trades/.test(sheet), 'the Strategies tab lists measured strategies', sheet.match(/[\w ]+\n?\d+ unseen trades/)?.[0]?.slice(0, 60) ?? '');
  // The book leads with what a rule did on data it never saw, so the row has to carry the trade count with it.
  check(!/\+0\.00%/.test(sheet), 'no strategy claims a return it did not trade for');

  await page.getByText(/^All \d+ strategies$/).first().click({ timeout: 10_000 });
  await page.waitForTimeout(5000);
  const book = await body();
  check(/Showing \d+ of \d+/.test(book), 'the book says how much of itself it is showing', book.match(/Showing \d+ of \d+[^.]*/)?.[0] ?? '');

  /*
   * The row's TITLE, not its secondary line. `getByText(/unseen trades/)` resolves to the caption `<div>`
   * inside the row, which is not the pressable and reports itself as not visible — the click then retried
   * against a thing that can never take one. The title is the row's own label.
   */
  const firstTitle = (book.match(/^([a-z0-9 ]+)\n\d+ unseen trades/m) ?? [])[1];
  check(Boolean(firstTitle), 'the book has a row to open', firstTitle ?? '');
  /*
   * By ROLE, not by text. On react-native-web a `Row`'s title is a `<div>` inside the pressable, and
   * Playwright reports that inner node as not visible — the click retried for ten seconds against something
   * that could never take one. The row itself is the button, and its accessible name is the title.
   */
  await page
    .getByRole('button', { name: new RegExp(firstTitle ?? 'b200 sess 8', 'i') })
    .first()
    .click({ timeout: 10_000 });
  await page.waitForTimeout(6000);
  const report = await body();
  check(/RETURN ON UNSEEN DATA/.test(report), 'a row opens its report');
  check(/WINS AND LOSSES|It took no trades/.test(report), 'the report shows its record, or says there is none');
  check(/MEASURED OVER/.test(report), 'and it says what window every number came from');
  seen.quiet('the strategy book');

  // ── 5. A screen behind the session, after the session is cleared ──────────────────────────────
  console.log('\n5. signed out mid-session');
  seen.clear();
  await page.evaluate(() => {
    try {
      localStorage.clear();
    } catch {
      /* private mode */
    }
  });
  await open(page, `/safety`);
  /*
   * Waited for, not read at a fixed moment. The prompt appears once Privy has looked for a session and found none,
   * and how long that takes depends on Privy — one run in three read the screen at five seconds, before the answer,
   * and failed on a page that was still asking. Twenty seconds is the patience a person has; past it, what the screen
   * showed instead is printed, so a real failure says what it was.
   */
  const askedAt = Date.now();
  const asked = await page
    .waitForFunction(() => /Sign in/i.test(document.body.innerText), undefined, { timeout: 20_000 })
    .then(() => true)
    .catch(() => false);
  const signedOut = await body();
  check(
    asked,
    'it asks for a sign-in rather than showing an empty screen',
    asked ? `after ${((Date.now() - askedAt) / 1000).toFixed(1)}s` : signedOut.replace(/\n+/g, ' | ').slice(0, 240),
  );
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
