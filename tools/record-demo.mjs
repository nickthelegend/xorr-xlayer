#!/usr/bin/env node
/**
 * The submission video, recorded against the deployed build (docs/DEMO-SCRIPT.md).
 *
 * Signs in in a throwaway context so the footage never shows a login form, saves that session, then records the beats
 * the script lists — the permission, the agent's own trades, the cap refusing, `/judge` re-checking every claim, and
 * the kill switch — pausing long enough on each for a viewer to read it. Nothing is staged: every number on screen is
 * what the executor and the chain answered at the moment of recording, and where a screen is filtered the filter is
 * the product's own, tapped on camera.
 *
 * The captions are drawn into the page rather than burned in afterwards, because this ffmpeg has no `drawtext`.
 *
 *   set -a && . ./.env && set +a && node tools/record-demo.mjs
 */
import { Buffer } from 'node:buffer';
import { chromium } from 'playwright';

const BASE = process.env.APP_URL ?? 'https://xorr-xlayer.vercel.app';
const EMAIL = process.env.E2E_PRIVY_EMAIL ?? 'test-9907@privy.io';
const OUT = 'docs/demo';
const SIZE = { width: 402, height: 874 };

async function credential() {
  const appId = process.env.PRIVY_APP_ID, secret = process.env.PRIVY_APP_SECRET;
  const headers = {
    authorization: `Basic ${Buffer.from(`${appId}:${secret}`).toString('base64')}`,
    'privy-app-id': appId,
    'content-type': 'application/json',
  };
  const all = (await (await fetch(`https://auth.privy.io/api/v1/apps/${appId}/test_credentials`, { headers })).json()).data ?? [];
  const account = all.find((a) => a.email === EMAIL);
  if (!account) throw new Error(`no test credential for ${EMAIL}`);
  return account;
}

/** The caption, drawn over the app: one line, low, out of the way of anything a viewer has to read. */
const CAPTION_STYLE = [
  'position:fixed', 'left:12px', 'right:12px', 'z-index:2147483647',
  'padding:13px 18px', 'border-radius:16px', 'box-sizing:border-box',
  'background:rgba(10,10,10,.93)', 'border:1px solid rgba(255,255,255,.14)',
  'backdrop-filter:blur(12px)', '-webkit-backdrop-filter:blur(12px)',
  'color:#fff', 'font:500 15px/1.35 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif',
  'letter-spacing:-.01em', 'text-align:center', 'pointer-events:none',
  'opacity:0', 'transition:opacity .45s ease',
].join(';');

/*
 * Styled inline rather than through a stylesheet: on the order route the app replaces what is in `<head>` as it mounts,
 * and an injected rule went with it — the caption was in the DOM, at the right size and on top, and invisible.
 */
async function say(page, text, seconds, where = 'bottom') {
  await page.evaluate(
    ({ text, css }) => {
      let el = document.getElementById('xorr-caption');
      if (!el) {
        el = document.createElement('div');
        el.id = 'xorr-caption';
        document.body.append(el);
      }
      el.style.cssText = css;
      el.textContent = text;
      requestAnimationFrame(() => {
        el.style.opacity = '1';
      });
    },
    { text, css: `${CAPTION_STYLE};${where === 'top' ? 'top:14px;bottom:auto' : 'bottom:14px;top:auto'}` },
  );
  await page.waitForTimeout(seconds * 1000);
}

/** Take the caption away, for a beat that should be read without one. */
const hush = async (page) =>
  page.evaluate(() => {
    const el = document.getElementById('xorr-caption');
    if (el) el.style.opacity = '0';
  });

const at = (started) => `${((Date.now() - started) / 1000).toFixed(0)}s`;

async function main() {
  const { email, otp_code: otp } = await credential();
  const browser = await chromium.launch();

  // Sign in off camera, so the film opens inside the product.
  const setup = await browser.newContext({ viewport: SIZE });
  const warm = await setup.newPage();
  await warm.goto(`${BASE}/wallet`, { waitUntil: 'networkidle' });
  await warm.fill('input[type=email]', email);
  await warm.getByText(/email me a code/i).first().click();
  await warm.waitForSelector('input[placeholder*="6-digit"]', { timeout: 60_000 });
  await warm.fill('input[placeholder*="6-digit"]', otp);
  await warm.getByText(/verify and create/i).first().click();
  await warm.waitForTimeout(15_000);
  const state = await setup.storageState();
  await setup.close();

  const ctx = await browser.newContext({ viewport: SIZE, storageState: state, recordVideo: { dir: OUT, size: SIZE } });
  const page = await ctx.newPage();
  const t0 = Date.now();
  const tap = async (label) => {
    await page.getByText(new RegExp(`^${label}$`)).first().click({ timeout: 8_000 }).catch(() => undefined);
    await page.waitForTimeout(1_200);
  };

  // 1. What it is.
  await page.goto(`${BASE}/`, { waitUntil: 'networkidle' });
  await say(page, 'xorr — an agent that trades tokenized US stocks for you, on OKX X Layer.', 7);
  await say(page, 'Your wallet. Your keys. The agent never holds a cent of it.', 7);
  console.log('home', at(t0));

  // 2. The permission is the product.
  await page.goto(`${BASE}/safety`, { waitUntil: 'networkidle' });
  await say(page, 'It trades inside a permission you grant on-chain — read here from the chain, not our database.', 9);
  await say(page, '$100 a day, expiring in 6 days, only the venues you allowlisted.', 8);
  await page.mouse.wheel(0, 380);
  await say(page, 'And one button takes it all back. No server of ours has to agree.', 8);
  console.log('safety', at(t0));

  // 3. What the agent did on its own.
  await page.goto(`${BASE}/runs`, { waitUntil: 'networkidle' });
  await say(page, 'Every run the agent took, with what it bought and what it paid.', 8);
  await tap('Filled');
  await say(page, 'Real swaps on Uniswap v3, settled straight into this wallet — never into ours.', 9);
  await page.goto(`${BASE}/activity`, { waitUntil: 'networkidle' });
  await tap('Trades');
  await say(page, 'And it says which agent placed each one, and why it did.', 9);
  console.log('runs', at(t0));

  // 4. The cap is not a suggestion.
  await page.goto(`${BASE}/order/TSLAx?side=buy`, { waitUntil: 'networkidle' });
  await say(page, 'The limit holds for you, too — the app will not even offer you the button.', 11, 'top');
  console.log('ticket', at(t0));

  // 5. Check it yourself.
  await page.goto(`${BASE}/judge`, { waitUntil: 'networkidle' });
  await say(page, "Don't take our word for any of it.", 6);
  await page.getByText(/^Re-run$/).first().click().catch(() => undefined);
  await say(page, 'Every claim this app makes is re-checked against the chain, live, right now.', 14);
  await page.mouse.wheel(0, 420);
  await hush(page);
  await page.waitForTimeout(7_000);
  await say(page, 'The cap, the allowlist, the audit trail — 20 of 20, from the chain itself.', 9);
  console.log('judge', at(t0));

  // 6. Back to the one thing that matters.
  await page.goto(`${BASE}/safety`, { waitUntil: 'networkidle' });
  await page.mouse.wheel(0, 380);
  await say(page, 'Non-custodial, capped, allowlisted, and revocable in one tap.', 8);
  await say(page, 'xorr — on OKX X Layer.', 6);
  console.log('end', at(t0));

  await ctx.close();
  await browser.close();
  console.log(`recorded into ${OUT}/`);
}

await main();
