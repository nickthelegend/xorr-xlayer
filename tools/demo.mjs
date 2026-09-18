/**
 * Record the demo, for real, against the running app.
 *
 * Every sponsor track asks for two to four minutes of video and none existed. `docs/DEMO-SCRIPT.md`
 * has the beats and the words; this walks them with a real signed-in session and Playwright's own
 * video recorder, so the output is the actual product doing the actual thing rather than a mockup.
 *
 * It records SILENT. Narration is a person's job — the script has the words. What this produces is
 * the footage to speak over, and a GIF for the top of the README, which nobody clicks a video from.
 *
 * Deliberately tolerant: a beat whose control cannot be found is logged and skipped rather than
 * aborting. A recording that ends at beat three because a button moved is worth less than one that
 * misses a beat and keeps going, and the log says exactly which beats landed.
 *
 * Run (records the deployed app):
 *   PRIVY_APP_ID=… PRIVY_APP_SECRET=… node tools/demo.mjs
 *
 * Or point it somewhere else:
 *   APP_URL=http://localhost:8082 PRIVY_APP_ID=… PRIVY_APP_SECRET=… node tools/demo.mjs
 *
 * Then:  ffmpeg -i docs/demo/demo.webm -vf "fps=12,scale=402:-1" docs/demo/demo.gif
 */
import { chromium } from 'playwright';
import { Buffer } from 'node:buffer';
import fs from 'node:fs/promises';
import path from 'node:path';

/*
 * The credentials, loaded the way every other entry point in this repo loads them.
 *
 * `signIn` needs `PRIVY_APP_ID` and `PRIVY_APP_SECRET`, and a plain node script gets neither —
 * nothing here reads `.env`. So a run with no exported variables recorded seven of eight beats and
 * skipped the one that signs in, which is the beat every later beat depends on: the footage is of
 * a SIGNED-OUT app, showing the empty state of screens the demo is meant to show working. It is
 * tolerant by design, so it reported the miss and carried on producing a video that looks fine
 * until you watch it.
 *
 * `loadEnvFile` does not override what the shell already set, so `APP_URL=… node tools/demo.mjs`
 * still behaves exactly as before.
 */
try {
  process.loadEnvFile(path.resolve(import.meta.dirname, '../.env'));
} catch {
  // No `.env` is legitimate; `signIn` already says which variable it needed.
}

/*
 * The SHIPPED app by default, not a machine only I can reach.
 *
 * This defaulted to `localhost:8082`, and that is how the previous recording came to be shot
 * against a dev server: it ran, it worked, and nothing said the footage was of something nobody
 * else could open. A demo of the deployed product is the only demo worth having, so the deployed
 * product is what this records unless told otherwise.
 */
const BASE = process.env.APP_URL ?? 'https://app.xorr.finance';
const OUT = path.resolve(import.meta.dirname, '../docs/demo');
/** design.md's canvas. A phone layout recorded at desktop width looks like a mistake. */
const VIEWPORT = { width: 402, height: 874 };

/** How long a beat sits on screen before moving on — long enough to read, short enough to watch. */
const BEAT = 2_600;

const landed = [];
const missed = [];

/** Run a beat, and let the recording survive one that cannot find its control. */
async function beat(name, fn) {
  try {
    await fn();
    landed.push(name);
    console.log(`  ✓ ${name}`);
  } catch (e) {
    missed.push(name);
    console.log(`  ✗ ${name} — ${e instanceof Error ? e.message.split('\n')[0] : e}`);
  }
}

/** Tap by visible text, the way the screens are actually labelled. */
async function tap(page, text, timeout = 8_000) {
  await page.getByText(text, { exact: false }).first().click({ timeout });
}

/**
 * Sign in through Privy's own test-credentials flow — a real session, real `verifyAuthToken`.
 * Lifted from `shoot.mjs`, which has been signing in this way for every screenshot sweep.
 */
async function signIn(page) {
  const appId = process.env.PRIVY_APP_ID;
  const secret = process.env.PRIVY_APP_SECRET;
  if (!appId || !secret) throw new Error('PRIVY_APP_ID/SECRET required — the demo is of a signed-in app');

  const auth = {
    authorization: `Basic ${Buffer.from(`${appId}:${secret}`).toString('base64')}`,
    'privy-app-id': appId,
    'content-type': 'application/json',
  };
  const listed = await fetch(`https://auth.privy.io/api/v1/apps/${appId}/test_credentials`, { headers: auth });
  const existing = listed.ok ? ((await listed.json()).data ?? []) : [];
  const account = existing.find((a) => a.email === (process.env.E2E_PRIVY_EMAIL ?? 'test-8958@privy.io')) ?? existing[0];
  if (!account) throw new Error('no Privy test account available');

  await page.goto(`${BASE}/wallet`, { waitUntil: 'networkidle' });
  await page.fill('input[type=email]', account.email);
  await page.getByText(/email me a code/i).first().click();
  await page.waitForSelector('input[placeholder*="6-digit"]', { timeout: 30_000 });
  await page.fill('input[placeholder*="6-digit"]', account.otp_code);
  await page.getByText(/verify and create/i).first().click();
  // The embedded wallet is created here and it is not instant.
  await page.waitForTimeout(14_000);

  const token = await page.evaluate(() => {
    try {
      return localStorage.getItem('privy:token');
    } catch {
      return null;
    }
  });
  if (!token) throw new Error('sign-in did not produce a session');
}

async function main() {
  await fs.mkdir(OUT, { recursive: true });

  const browser = await chromium.launch();
  const ctx = await browser.newContext({
    viewport: VIEWPORT,
    deviceScaleFactor: 2,
    recordVideo: { dir: OUT, size: VIEWPORT },
  });
  const page = await ctx.newPage();

  console.log(`recording ${BASE} at ${VIEWPORT.width}×${VIEWPORT.height}\n`);

  // 1 — what it is
  await beat('welcome', async () => {
    await page.goto(`${BASE}/welcome`, { waitUntil: 'networkidle' });
    await page.waitForTimeout(BEAT);
  });

  // 2 — a real Privy session
  await beat('sign in', () => signIn(page));

  // 3 — the permission, the centrepiece
  await beat('the permission', async () => {
    await page.goto(`${BASE}/delegate`, { waitUntil: 'networkidle' });
    await page.waitForTimeout(BEAT + 1_500);
  });

  // 4 — markets, so the prices are visibly live
  await beat('live markets', async () => {
    await page.goto(`${BASE}/markets/crypto`, { waitUntil: 'networkidle' });
    await page.waitForTimeout(BEAT);
  });

  // 5 — give it a job
  await beat('recurring buy', async () => {
    await page.goto(`${BASE}/strategy/dca`, { waitUntil: 'networkidle' });
    await page.waitForTimeout(BEAT);
    await tap(page, /Buy \$\d+ of/);
    await page.waitForTimeout(BEAT);
  });

  // 6 — what it has actually done, with hashes
  await beat('the activity trail', async () => {
    await page.goto(`${BASE}/activity`, { waitUntil: 'networkidle' });
    await page.waitForTimeout(BEAT + 1_000);
  });

  // 7 — check it yourself. The FAIL stays on screen deliberately.
  await beat('judge', async () => {
    await page.goto(`${BASE}/judge`, { waitUntil: 'networkidle' });
    // `/verify` runs nineteen live checks; give them time to land on camera.
    await page.waitForTimeout(14_000);
    await page.mouse.wheel(0, 600);
    await page.waitForTimeout(BEAT);
  });

  // 8 — take it back
  await beat('the kill switch', async () => {
    await page.goto(`${BASE}/safety`, { waitUntil: 'networkidle' });
    await page.waitForTimeout(BEAT + 1_200);
  });

  await ctx.close();
  await browser.close();

  // Playwright names the file by an internal id; give it the name the README will link to.
  const files = await fs.readdir(OUT);
  const webm = files.filter((f) => f.endsWith('.webm')).sort();
  const newest = webm[webm.length - 1];
  if (newest && newest !== 'demo.webm') {
    await fs.rename(path.join(OUT, newest), path.join(OUT, 'demo.webm'));
  }

  console.log(`\n${landed.length} beats landed, ${missed.length} missed${missed.length ? `: ${missed.join(', ')}` : ''}`);
  console.log(`video → ${path.join(OUT, 'demo.webm')}`);
  console.log('\nGIF:  ffmpeg -y -i docs/demo/demo.webm -vf "fps=10,scale=402:-1:flags=lanczos" docs/demo/demo.gif');
  console.log('MP4:  ffmpeg -y -i docs/demo/demo.webm -c:v libx264 -pix_fmt yuv420p docs/demo/demo.mp4');
}

await main();
