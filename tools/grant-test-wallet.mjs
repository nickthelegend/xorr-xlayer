/**
 * Renew the demo wallet's permission, through the real app, signed by the wallet itself.
 *
 * WHY THIS EXISTS
 *
 * A grant expires — that is one of the four things it promises — and when the demo wallet's lapses,
 * a judge opening the hosted app sees `/safety` read EXPIRED and `/limits` read $0 remaining. That
 * is the app telling the truth, and it is still the wrong first impression of a product whose claim
 * is the permission.
 *
 * Nothing on the server can renew it, by design: a grant is signed by the wallet's OWNER, and the
 * executor never holds that key. So this does what a person does — signs in with Privy's test
 * credentials, opens the permission screen, chooses 30 days, presses "Sign this permission", and
 * approves each Privy dialog — and then reads the result back from the executor, which reads it
 * from the chain. On X Layer testnet or the fork, so the only thing spent is test OKB for gas.
 *
 * WHAT THE PRIVY FLOW LOOKS LIKE, measured on 2026-09-11
 *
 * One dialog per transaction — an approval for each token the bot may need to sell, then the grant
 * — and after each one Privy shows a success screen whose only control is "All Done". The next
 * dialog does not open until that is pressed. The first version of this script pressed "Approve"
 * once, waited three minutes for a second dialog that was never going to appear, and granted
 * nothing.
 *
 * Run: APP_URL=<the X Layer web app> node tools/grant-test-wallet.mjs [days]      (days: 1, 3, 7 or 30 — default 30)
 *      EXPO_PUBLIC_API_URL picks the executor that reads the permission back (default: the hosted X Layer fork's).
 */
import { Buffer } from 'node:buffer';
import { chromium } from 'playwright';

try {
  process.loadEnvFile(new URL('../.env', import.meta.url));
} catch {
  // No `.env` is legitimate; the checks below say what is missing.
}

/*
 * The web app to drive. Required: the X Layer build's hosted URL is not settled yet, and app.xorr.finance still serves
 * the Base build — a default there would sign in to, record or change the wrong product without saying so.
 */
const APP_URL = (process.env.APP_URL ?? '').trim().replace(/\/+$/, '');
if (!/^https?:\/\//.test(APP_URL)) {
  console.error('APP_URL is required: the X Layer web app to use, e.g. APP_URL=http://localhost:8082. There is no default.');
  process.exit(2);
}
const APP = APP_URL;
const API = (process.env.EXPO_PUBLIC_API_URL ?? 'https://executor-fork-production-2db8.up.railway.app').replace(/\/+$/, '');
const EMAIL = process.env.E2E_PRIVY_EMAIL ?? 'test-8958@privy.io';
const WANT = `${process.argv[2] ?? '30'} Day${process.argv[2] === '1' ? '' : 's'}`;

const appId = process.env.PRIVY_APP_ID;
const secret = process.env.PRIVY_APP_SECRET;
if (!appId || !secret) throw new Error('PRIVY_APP_ID and PRIVY_APP_SECRET are required');

const auth = {
  authorization: `Basic ${Buffer.from(`${appId}:${secret}`).toString('base64')}`,
  'privy-app-id': appId,
};
const listed = await fetch(`https://auth.privy.io/api/v1/apps/${appId}/test_credentials`, { headers: auth });
if (!listed.ok) throw new Error(`could not list Privy test credentials (${listed.status})`);
const account = ((await listed.json()).data ?? []).find((a) => a.email === EMAIL);
if (!account) throw new Error(`no Privy test credential for ${EMAIL}`);

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 430, height: 932 } });
const errors = [];
page.on('console', (m) => {
  if (m.type() === 'error') errors.push(m.text().slice(0, 160));
});

// ── Sign in ─────────────────────────────────────────────────────────────────
await page.goto(`${APP}/wallet`, { waitUntil: 'networkidle' });
await page.fill('input[type=email]', account.email);
await page.getByText(/email me a code/i).first().click();
await page.waitForSelector('input[placeholder*="6-digit"]', { timeout: 30_000 });
await page.fill('input[placeholder*="6-digit"]', account.otp_code);
await page.getByText(/verify and create/i).first().click();
await page.waitForTimeout(16_000);
const token = await page.evaluate(() => localStorage.getItem('privy:token'));
if (!token) throw new Error(`sign-in failed for ${EMAIL} — no Privy token in storage`);
const bearer = token.replace(/^"|"$/g, '');
const limits = async () =>
  (await fetch(`${API}/limits`, { headers: { authorization: `Bearer ${bearer}` } })).json();

const before = await limits();
console.log(`signed in as ${EMAIL}`);
console.log(`before: $${before.dailyCapUsd}/day, expires ${before.expiresAt ? new Date(before.expiresAt).toISOString() : 'never granted'}`);

// ── Choose the duration on the permission screen ────────────────────────────
await page.goto(`${APP}/delegate`, { waitUntil: 'networkidle' });
await page.waitForTimeout(6000);
for (let i = 0; i < 4; i += 1) {
  const shown = /For how long (\d+ Days?)/.exec((await page.innerText('body')).replace(/\s+/g, ' '))?.[1];
  if (shown === WANT) break;
  await page.getByText(/^\d+ Days?$/).first().click();
  await page.waitForTimeout(700);
}
console.log(`duration: ${WANT}`);

// ── Sign, approving every Privy dialog and dismissing each success screen ───
await page.getByText('Sign this permission', { exact: true }).click();
const CONTROL = /^(approve|confirm|all done)$/i;
let pressed = 0;
/**
 * What was on screen when nothing could be pressed.
 *
 * On 2026-09-13 this script approved both token approvals, pressed Approve on the grant and then
 * waited out its four minutes with no grant ever broadcast — and all it could say was "NOT
 * RENEWED". The dialog or error that stopped it was on screen the whole time. So a stall now
 * records the buttons and the text it could see, once, and the end of a failed run prints them.
 */
let idle = 0;
let stalledOn = '';
for (let t = 0; t < 120 && pressed < 20; t += 1) {
  await page.waitForTimeout(2000);
  // The app leaves the grant screen only after the grant is recorded: on to the proposal in onboarding, back otherwise.
  if (!/\/delegate/.test(page.url())) break;
  let clicked = false;
  const seen = [];
  for (const frame of page.frames()) {
    const buttons = frame.locator('button:visible');
    const n = await buttons.count().catch(() => 0);
    for (let i = 0; i < n; i += 1) {
      const label = ((await buttons.nth(i).innerText().catch(() => '')) || '').trim();
      if (label) seen.push(label);
      if (CONTROL.test(label)) {
        await buttons.nth(i).click({ timeout: 5000 }).catch(() => {});
        pressed += 1;
        console.log(`  pressed "${label}"`);
        clicked = true;
        break;
      }
    }
    if (clicked) break;
  }
  idle = clicked ? 0 : idle + 1;
  if (idle === 10 && !stalledOn) {
    const texts = [];
    for (const frame of page.frames()) {
      const text = await frame.locator('body').innerText().catch(() => '');
      if (text.trim()) texts.push(text.replace(/\s+/g, ' ').trim().slice(0, 400));
    }
    stalledOn = `buttons: [${[...new Set(seen)].join(' | ')}] · text: ${texts.join(' ‖ ')}`;
    console.log(`  stalled 20s with nothing to press — ${stalledOn.slice(0, 900)}`);
  }
}

// ── Read it back — from the executor, which reads the chain ─────────────────
const after = await limits();
const finalUrl = page.url();
const finalText = (await page.innerText('body').catch(() => '')).replace(/\s+/g, ' ').trim();
if (process.env.SHOT_DIR) {
  await page.screenshot({ path: `${process.env.SHOT_DIR}/grant-test-wallet.png`, fullPage: true }).catch(() => {});
}
await browser.close();

const renewed = after.expiresAt && after.expiresAt > Date.now() && !after.revoked;
console.log(`after:  $${after.dailyCapUsd}/day, $${after.remainingUsd} remaining, expires ${after.expiresAt ? new Date(after.expiresAt).toISOString() : '—'}`);
const bad = errors.filter((e) => !/isActive|balanceOf|styled-components/i.test(e));
if (bad.length) console.log(`console errors: ${bad.length} — ${bad[0]}`);
if (!renewed) {
  console.log('NOT RENEWED — the chain does not show a live permission. Nothing above should be read as success.');
  console.log(`  ended on ${finalUrl}`);
  if (stalledOn) console.log(`  last stall: ${stalledOn.slice(0, 900)}`);
  // The app's own sentence, when it wrote one — the error line sits near the Sign button.
  const said = /(?:could not|couldn't|failed|error|rejected|insufficient|reverted|not confirmed)[^.]{0,160}\.?/i.exec(finalText)?.[0];
  if (said) console.log(`  the app said: ${said}`);
  process.exit(1);
}
console.log('renewed.');
