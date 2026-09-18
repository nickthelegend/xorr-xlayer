#!/usr/bin/env node
/**
 * qa-full — every HTTP endpoint of the xorr executor, checked against what its handler promises.
 *
 * Modelled on tools/qa-api.mjs: each check states the expected result as predicates, so a pass is
 * "matched what the handler and the app say", not "did not throw". Every result is a real HTTP call
 * against a deployed executor; nothing is mocked.
 *
 *   QA_BASE_URL=https://executor-fork-production-2db8.up.railway.app \
 *   QA_TOKEN="$TOKEN" QA_OUT=docs/qa/endpoints-xlayer.json node tools/qa-full.mjs
 *
 * The token is a Privy access token for the test account, minted outside this script with
 * `cd server && npx tsx --env-file=../.env src/e2e-token.ts test-8958@privy.io` (last line of stdout).
 * This script never prints, logs or writes it.
 *
 * Optional: QA_EXPECT_CHAIN (xlayer-fork | xlayer-testnet | xlayer | localnet), QA_EXPECT_VERSION (the
 * commit the executor must report), QA_ONLY (comma-separated check ids, or a path substring),
 * QA_TESTNET_RPC (X Layer testnet's public RPC by default, used only to find a real, unrelated
 * transaction hash on X Layer testnet for refusal checks).
 *
 * Definitions every check uses:
 *   - a NAMED error is a machine-readable code, /^[a-z][a-z0-9_]*$/, in `error` — or in `reason`
 *     beside `status: 'blocked'` on the withdrawal and faucet routes. Never a sentence.
 *   - a 503 carrying Retry-After (`warming`, `rate_unavailable`) and the limiter's 429 are part of the
 *     contract and are waited out, as the app does (src/data/warming.ts).
 *   - no single request may take longer than the app waits for it: 45s for a read, 180s for a write
 *     (src/data/api.ts READ_TIMEOUT_MS, WRITE_TIMEOUT_MS).
 *
 * State-changing happy paths run only where they are safe and reversible, and clean up after
 * themselves. Anything that trades, moves funds, signs on chain, anchors, mirrors, pushes or calls a
 * model is exercised through its refusals only — see NOT_EXECUTED at the bottom.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';

const BASE = (process.env.QA_BASE_URL ?? '').trim().replace(/\/+$/, '');
const TOKEN = (process.env.QA_TOKEN ?? '').trim();
const OUT = process.env.QA_OUT ?? `qa-full-${BASE.replace(/^https?:\/\//, '').replace(/[^a-z0-9]+/gi, '-')}.json`;
const ONLY = (process.env.QA_ONLY ?? '').split(',').map((s) => s.trim()).filter(Boolean);
const TESTNET_RPC = process.env.QA_TESTNET_RPC ?? 'https://testrpc.xlayer.tech';

if (!/^https?:\/\//.test(BASE)) throw new Error('QA_BASE_URL is required (the executor base URL).');
if (TOKEN.length < 100) throw new Error('QA_TOKEN is required (a Privy access token for the test account).');

const READ_BUDGET_MS = 45_000;
const WRITE_BUDGET_MS = 180_000;

/* ───────────────────────────────────────────────────────────── small helpers */

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const CODE = /^[a-z][a-z0-9_]*$/;
const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const TX = /^0x[0-9a-fA-F]{64}$/;
const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';
const MAX_UINT256 = (1n << 256n) - 1n;

class Fail extends Error {}

const must = (cond, msg) => {
  if (!cond) throw new Fail(msg);
};

/** Nothing secret leaves this process: the token, agent keys, JWTs and credential-shaped URL paths are cut. */
function redact(value) {
  let s = typeof value === 'string' ? value : JSON.stringify(value) ?? String(value);
  if (TOKEN) s = s.split(TOKEN).join('<token>');
  return s
    .replace(/eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g, '<jwt>')
    .replace(/xagt_[0-9a-f]{16,}/g, '<agent-key>')
    .replace(/(https?:\/\/[^\s/"'<>]+)(\/[^\s"'<>]*)?/g, (_m, host, path) => {
      if (!path) return host;
      return /[A-Za-z0-9_-]{32,}/.test(path) || /api[-_]?key|token=|secret/i.test(path) ? `${host}/<redacted>` : `${host}${path}`;
    });
}

const clip = (v, n = 240) => {
  const s = redact(v);
  return s.length > n ? `${s.slice(0, n)}…` : s;
};

const near = (a, b, abs = 1e-6, rel = 1e-9) =>
  typeof a === 'number' && typeof b === 'number' && Math.abs(a - b) <= Math.max(abs, rel * Math.max(Math.abs(a), Math.abs(b)));

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const isMs = (v) => isNum(v) && v > 1_600_000_000_000 && v < 4_200_000_000_000;
const isIso = (v) => typeof v === 'string' && !Number.isNaN(Date.parse(v)) && /^\d{4}-\d{2}-\d{2}T/.test(v);
const lower = (s) => String(s ?? '').toLowerCase();
const sameAddr = (a, b) => typeof a === 'string' && typeof b === 'string' && a.toLowerCase() === b.toLowerCase();
const randomAddress = () => `0x${randomBytes(20).toString('hex')}`;
const randomHash = () => `0x${randomBytes(32).toString('hex')}`;

/* ───────────────────────────────────────────────────────────── pacing */

/**
 * The executor limits each identity: 300 requests a minute in general and 60 on the routes that
 * spend an upstream quota (server/src/http/rate-limit.ts). Public routes share one anonymous bucket
 * with every signed-out visitor, and /market/* also carries a 240-per-IP ceiling. The suite stays
 * under all of them rather than spending real users' headroom.
 */
const UPSTREAM_PATHS = [
  '/swap', '/wallet/tokens', '/history', '/faucet', '/orders',
  '/strategies/', '/agent/strategies/', '/positions/close', '/panic/flatten', '/agent/positions/close',
  '/yield/supply', '/yield/withdraw-calldata', '/withdrawals/', '/agents/', '/strategies/backtest', '/bot/say',
];
const windows = { upstream: [], general: [], anonymous: [] };
const LIMITS = { upstream: 45, general: 240, anonymous: 150 };

async function pace(pathname, auth) {
  const bucket = !auth ? 'anonymous' : UPSTREAM_PATHS.some((p) => pathname.startsWith(p)) ? 'upstream' : 'general';
  const w = windows[bucket];
  for (;;) {
    const now = Date.now();
    while (w.length && now - w[0] > 60_000) w.shift();
    if (w.length < LIMITS[bucket]) {
      w.push(now);
      return;
    }
    await sleep(60_000 - (now - w[0]) + 100);
  }
}

/* ───────────────────────────────────────────────────────────── http */

let currentCalls = null;

/**
 * One real request. Waits out a Retry-After 503 and the limiter's 429 (bounded), and records every
 * attempt on the running check so the results file carries what was actually asked and answered.
 */
async function http(method, path, opts = {}) {
  const { auth = true, token, body, raw, headers = {}, retry = true, timeoutMs } = opts;
  const pathname = path.split('?')[0];
  const budget = method === 'GET' ? READ_BUDGET_MS : WRITE_BUDGET_MS;
  let waited = 0;
  for (let attempt = 1; ; attempt += 1) {
    if (auth) await pace(pathname, true);
    else await pace(pathname, false);
    const ctl = new AbortController();
    const limit = timeoutMs ?? budget + 15_000;
    const timer = setTimeout(() => ctl.abort(), limit);
    const t0 = Date.now();
    let res;
    let text = '';
    try {
      res = await fetch(BASE + path, {
        method,
        headers: {
          ...(body !== undefined || raw !== undefined ? { 'content-type': 'application/json' } : {}),
          ...(auth ? { authorization: `Bearer ${token ?? TOKEN}` } : {}),
          ...headers,
        },
        body: raw ?? (body === undefined ? undefined : JSON.stringify(body)),
        signal: ctl.signal,
      });
      text = await res.text();
    } catch (e) {
      clearTimeout(timer);
      const ms = Date.now() - t0;
      currentCalls?.push({ method, path: redact(path), status: 0, ms, attempt });
      throw new Fail(`${method} ${redact(path)}: no response after ${ms}ms (${e?.name === 'AbortError' ? 'timed out' : e?.message})`);
    }
    clearTimeout(timer);
    const ms = Date.now() - t0;
    let json;
    try {
      json = text ? JSON.parse(text) : undefined;
    } catch {
      json = undefined;
    }
    const code = json && typeof json === 'object' && !Array.isArray(json) ? json.error ?? json.reason ?? json.status : undefined;
    currentCalls?.push({
      method,
      path: redact(path),
      status: res.status,
      ms,
      attempt,
      ...(typeof code === 'string' ? { code: clip(code, 80) } : {}),
    });
    const retryAfter = Number(res.headers.get('retry-after'));
    const limiter429 = res.status === 429 && json?.error === 'rate_limited';
    const waiting503 = res.status === 503 && (json?.error === 'warming' || (Number.isFinite(retryAfter) && retryAfter > 0));
    if (retry && (limiter429 || waiting503) && waited < 150_000) {
      const wait = Math.min(Math.max(Number.isFinite(retryAfter) ? retryAfter : 3, 1) * 1000, 30_000);
      waited += wait;
      await sleep(wait);
      continue;
    }
    return { status: res.status, headers: res.headers, text, json, ms, attempt };
  }
}

const get = (path, opts) => http('GET', path, opts);
const post = (path, body, opts = {}) => http('POST', path, { body, ...opts });
const patch = (path, body, opts = {}) => http('PATCH', path, { body, ...opts });
const del = (path, opts) => http('DELETE', path, opts);

const show = (r) => `${r.status} ${clip(r.text, 200)}`;

/** The response's machine-readable error name, when it has one. */
function named(r) {
  const b = r.json;
  if (!b || typeof b !== 'object' || Array.isArray(b)) return undefined;
  if (typeof b.error === 'string' && CODE.test(b.error)) return b.error;
  if (b.status === 'blocked' && typeof b.reason === 'string' && CODE.test(b.reason)) return b.reason;
  return undefined;
}

const prose = (r) => {
  const b = r.json ?? {};
  return [b.detail, b.message].find((x) => typeof x === 'string' && x.trim().length > 0);
};

function expectStatus(r, status, what) {
  const ok = Array.isArray(status) ? status.includes(r.status) : r.status === status;
  must(ok, `${what}: expected ${Array.isArray(status) ? status.join('/') : status}, got ${show(r)}`);
}

/** A refusal: the status, a named error (optionally a specific one) and a sentence a person can read. */
function expectRefusal(r, status, code, what) {
  expectStatus(r, status, what);
  const name = named(r);
  must(name !== undefined, `${what}: ${r.status} without a named error: ${clip(r.text, 200)}`);
  if (code) {
    const codes = Array.isArray(code) ? code : [code];
    must(codes.includes(name), `${what}: expected error ${codes.join('|')}, got ${name}: ${clip(r.text, 200)}`);
  }
  return name;
}

/** Every unauthenticated call to a private path: 401, `error: "unauthorized"`, and a reason. */
function expectUnauthorized(r, what) {
  expectStatus(r, 401, what);
  must(r.json?.error === 'unauthorized', `${what}: 401 without error "unauthorized": ${clip(r.text)}`);
  must(typeof r.json?.detail === 'string' && r.json.detail.length > 0, `${what}: 401 without a detail`);
}

/* ───────────────────────────────────────────────────────────── checks */

const checks = [];
let seq = 0;

/**
 * Register a check. IDs are assigned in registration order, which follows the endpoint inventory,
 * so an ID means the same check on every executor.
 */
function check(meta, fn) {
  seq += 1;
  checks.push({ id: `E${String(seq).padStart(3, '0')}`, ...meta, fn });
}

/** The standard auth check for a private path. */
function unauthorized(method, path, { body, extra } = {}) {
  check(
    {
      method,
      path,
      auth: 'user',
      kind: 'auth',
      correct: `Without a bearer token: 401 {error:"unauthorized", detail}. A forged token is 401 too.${extra ? ` ${extra}` : ''}`,
    },
    async () => {
      const concrete = path.replace(':id', randomUUID()).replace(':hash', randomHash()).replace(':symbol', 'BTC');
      const r = await http(method, concrete, { auth: false, body, retry: false });
      expectUnauthorized(r, `no token ${method} ${concrete}`);
      const forged = await http(method, concrete, { token: 'eyJhbGciOiJFUzI1NiJ9.eyJzdWIiOiJxYSJ9.c2lnbmF0dXJl', body, retry: false });
      expectUnauthorized(forged, `forged token ${method} ${concrete}`);
      return `401 unauthorized (${r.json.detail}); forged 401`;
    },
  );
}

/** `/agent/*` is the machine surface: no token, a Privy session and an unknown agent key are all 401. */
function agentSurface(method, path, body) {
  check(
    {
      method,
      path,
      auth: 'agent-key',
      kind: 'auth',
      correct:
        'Agent-key surface: no token, a valid Privy user token and an unknown xagt_ key each get 401 {error:"unauthorized"} — the user token with detail "This surface needs an agent key." Nothing runs.',
    },
    async () => {
      const concrete = path.replace(':id', randomUUID());
      const none = await http(method, concrete, { auth: false, body, retry: false });
      expectUnauthorized(none, `no token ${method} ${concrete}`);
      const user = await http(method, concrete, { body, retry: false });
      expectUnauthorized(user, `user token ${method} ${concrete}`);
      must(/agent key/i.test(user.json.detail), `user token: detail does not name the agent key: ${user.json.detail}`);
      const fake = await http(method, concrete, { token: `xagt_${'0'.repeat(64)}`, body, retry: false });
      expectUnauthorized(fake, `unknown agent key ${method} ${concrete}`);
      return `401 for no token, user token ("${user.json.detail}") and unknown agent key`;
    },
  );
}

/** Operator-only routes outside `/agent/`: no token is 401; a user token is 403 forbidden. */
function operatorOnly(method, path, body) {
  check(
    {
      method,
      path,
      auth: 'operator',
      kind: 'auth',
      correct:
        'Operator-only (requireScope admin): no token → 401 {error:"unauthorized"}; a signed-in user → 403 {error:"forbidden", detail:"This route needs an agent key."}. Nothing runs.',
    },
    async () => {
      const none = await http(method, path, { auth: false, body, retry: false });
      expectUnauthorized(none, `no token ${method} ${path}`);
      const user = await http(method, path, { body, retry: false });
      expectStatus(user, 403, `user token ${method} ${path}`);
      must(user.json?.error === 'forbidden', `user token: error ${user.json?.error}`);
      must(/agent key/i.test(user.json?.detail ?? ''), `user token: detail ${user.json?.detail}`);
      return `401 without a token; 403 forbidden for a user ("${user.json.detail}")`;
    },
  );
}

/* ───────────────────────────────────────────────────────────── context */

/** What every check may assume, read once before the first check: the chain, the wallet, the permission. */
const ctx = {};

async function bootstrap() {
  const health = await get('/health', { auth: false });
  must(health.json && typeof health.json.chain === 'string', `GET /health gave no chain: ${show(health)}`);
  ctx.health = health.json;
  ctx.chain = health.json.chain;
  ctx.fork = ctx.chain === 'xlayer-fork';
  ctx.testnet = ctx.chain === 'xlayer-testnet';
  /** Mainnet state (mainnet and its fork): the xStocks, Uniswap's pools, OKX DEX and Aave exist only there. */
  ctx.mainnetState = ctx.chain === 'xlayer' || ctx.fork;
  if (process.env.QA_EXPECT_CHAIN && process.env.QA_EXPECT_CHAIN !== ctx.chain) {
    throw new Error(`QA_EXPECT_CHAIN is ${process.env.QA_EXPECT_CHAIN} but ${BASE} serves ${ctx.chain}`);
  }
  const wallet = await get('/wallet');
  if (wallet.status !== 200 || !wallet.json?.address) {
    throw new Error(`the token was not accepted, or the account has no wallet: GET /wallet → ${show(wallet)}`);
  }
  ctx.wallet = wallet.json;
  ctx.owner = wallet.json.address;
  ctx.params = (await get('/delegation/params')).json;
  ctx.delegation = (await get('/delegation')).json;
  // Circle's native USDC on X Layer (server/src/evm/chains.ts): the testnet and its local copy have their own.
  ctx.usdc = ctx.mainnetState ? '0xB6CEceAB302E2E4948951eE7843FC24E92933061' : '0xDec90b78111Ba2fc6FC6d84d8B9ec159A2d4b9B3';
  ctx.verifyAtStart = (await get('/activity/verify')).json;
}

/** Where each chain shows a transaction — `EXPLORER_TX` in server/src/evm/chains.ts. */
const explorerFor = (hash) =>
  ctx.fork
    ? `fork:${hash}`
    : ctx.chain === 'xlayer'
      ? `https://www.oklink.com/xlayer/tx/${hash}`
      : ctx.testnet
        ? `https://www.oklink.com/xlayer-test/tx/${hash}`
        : `local:${hash}`;

/** X Layer's venues (server/src/evm/chains.ts). */
const UNISWAP_ROUTER = '0x4f0C28f5926AFDA16bf2506D5D9e57Ea190f9bcA';
const OKX_DEX_ROUTER = '0x7c5bee2a8091c3ef39072f64f18fac913060aeaf';
const OKX_DEX_APPROVE_SPENDER = '0x8b773D83bc66Be128c60e07E17C8901f7a64F000';
const AAVE_V3_POOL = '0xE3F3Caefdd7180F884c01E57f65Df979Af84f116';
/** What `server/src/executor/settle.ts` records as a fill's venue. */
const VENUES = ['uniswap-v3', 'okx-dex', 'aave'];

const PERSONAS = ['momentum-scout', 'earnings-desk', 'yield-keeper', 'drawdown-guard'];

/* ───────────────────────────────────────────────────────────── /activity */

check(
  {
    method: 'GET',
    path: '/activity',
    auth: 'user',
    kind: 'contract',
    correct:
      '200 array of at most 200 rows, newest first (ids strictly decreasing), each {id: numeric string, t: "hh:mm AM|PM", agent, action (non-empty), detail, amount, kind ∈ trade|risk|block|yield}. A row with a signature carries explorer "fork:<hash>" on xlayer-fork, "https://www.oklink.com/xlayer-test/tx/<hash>" on xlayer-testnet or "https://www.oklink.com/xlayer/tx/<hash>" on xlayer; a row without one has no explorer.',
  },
  async () => {
    const r = await get('/activity');
    expectStatus(r, 200, 'GET /activity');
    must(Array.isArray(r.json) && r.json.length <= 200, `not an array of ≤200 rows: ${clip(r.text)}`);
    let prev = Number.POSITIVE_INFINITY;
    let signed = 0;
    for (const a of r.json) {
      must(/^\d+$/.test(a.id ?? ''), `id ${a.id} is not a sequence number`);
      must(Number(a.id) < prev, `ids are not strictly decreasing at ${a.id}`);
      prev = Number(a.id);
      must(/^\d{2}:\d{2}\s?(AM|PM)$/.test(a.t ?? ''), `row ${a.id}: t "${a.t}"`);
      must(typeof a.agent === 'string' && a.agent.length > 0, `row ${a.id}: no agent`);
      must(typeof a.action === 'string' && a.action.length > 0, `row ${a.id}: no action`);
      must(typeof a.detail === 'string' && typeof a.amount === 'string', `row ${a.id}: detail/amount not strings`);
      must(['trade', 'risk', 'block', 'yield'].includes(a.kind), `row ${a.id}: kind ${a.kind}`);
      if (a.signature) {
        signed += 1;
        must(a.explorer === explorerFor(a.signature), `row ${a.id}: explorer ${clip(a.explorer)} for ${a.signature}`);
      } else {
        must(a.explorer === undefined, `row ${a.id}: explorer without a signature`);
      }
    }
    return `${r.json.length} rows, newest #${r.json[0]?.id}, ${signed} signed`;
  },
);
unauthorized('GET', '/activity');

check(
  {
    method: 'GET',
    path: '/activity/export',
    auth: 'user',
    kind: 'contract',
    correct:
      'Default CSV: 200, content-type text/csv, attachment filename "xorr-audit.csv"; header exactly seq,at,agent,action,detail,amount,kind,signature,prev_hash,hash; the file ends "# chain_verified=<ok> rows=<n>", agreeing with GET /activity/verify (n between the counts read just before and just after).',
  },
  async () => {
    const before = (await get('/activity/verify')).json;
    const r = await get('/activity/export');
    const after = (await get('/activity/verify')).json;
    expectStatus(r, 200, 'GET /activity/export');
    must(/text\/csv/.test(r.headers.get('content-type') ?? ''), `content-type ${r.headers.get('content-type')}`);
    must(/attachment; filename="xorr-audit\.csv"/.test(r.headers.get('content-disposition') ?? ''), `content-disposition ${r.headers.get('content-disposition')}`);
    const lines = r.text.split('\n');
    must(lines[0] === 'seq,at,agent,action,detail,amount,kind,signature,prev_hash,hash', `header: ${clip(lines[0])}`);
    const foot = /^# chain_verified=(true|false) rows=(\d+)$/.exec(lines.at(-1) ?? '');
    must(foot, `no verification footer: ${clip(lines.at(-1))}`);
    const n = Number(foot[2]);
    must(n >= before.checked && n <= after.checked, `footer rows=${n}, verify said ${before.checked}..${after.checked}`);
    must(foot[1] === String(before.ok) || foot[1] === String(after.ok), `footer chain_verified=${foot[1]}, verify ok=${before.ok}`);
    return `CSV with ${n} rows, chain_verified=${foot[1]}`;
  },
);

check(
  {
    method: 'GET',
    path: '/activity/export?format=json',
    auth: 'user',
    kind: 'contract',
    correct:
      '?format=json: 200 application/json, attachment "xorr-audit.json"; {walletId = GET /wallet id, verified: the /activity/verify shape, rows}; rows.length = verified.checked, seq ascending, rows[0].prev_hash is 64 zeros, and the number of rows whose prev_hash is not the previous row\'s hash equals verified.linkBreaks.',
  },
  async () => {
    const r = await get('/activity/export?format=json');
    expectStatus(r, 200, 'GET /activity/export?format=json');
    must(/application\/json/.test(r.headers.get('content-type') ?? ''), `content-type ${r.headers.get('content-type')}`);
    must(/filename="xorr-audit\.json"/.test(r.headers.get('content-disposition') ?? ''), `content-disposition ${r.headers.get('content-disposition')}`);
    const { walletId, verified, rows } = r.json ?? {};
    must(walletId === ctx.wallet.id, `walletId ${walletId} is not this wallet`);
    must(Array.isArray(rows) && rows.length === verified?.checked, `rows ${rows?.length} vs verified.checked ${verified?.checked}`);
    let prev = '0'.repeat(64);
    let breaks = 0;
    let lastSeq = 0;
    for (const row of rows) {
      must(Number(row.seq) > lastSeq, `seq not ascending at ${row.seq}`);
      lastSeq = Number(row.seq);
      if (row.prev_hash !== prev) breaks += 1;
      prev = row.hash;
    }
    must(breaks === verified.linkBreaks, `counted ${breaks} link breaks, verified says ${verified.linkBreaks}`);
    return `${rows.length} rows, ${breaks} link break(s), ok=${verified.ok}`;
  },
);

check(
  {
    method: 'GET',
    path: '/activity/verify',
    auth: 'user',
    kind: 'contract',
    correct:
      '200 {ok, checked, intact, linkBreaks}; intact = checked (no row altered; kind is never "content"); ok=false only with kind "link". xlayer-fork and xlayer-testnet: ok true and linkBreaks 0 (the X Layer trails started after the per-wallet append lock). checked matches /audit/anchor entryCount within 3 (concurrent appends).',
  },
  async () => {
    const r = await get('/activity/verify');
    const anchor = await get('/audit/anchor');
    expectStatus(r, 200, 'GET /activity/verify');
    const v = r.json;
    must(Number.isInteger(v.checked) && Number.isInteger(v.intact) && Number.isInteger(v.linkBreaks), `shape: ${clip(r.text)}`);
    must(v.intact === v.checked, `${v.checked - v.intact} row(s) do not hash to their own contents (kind ${v.kind})`);
    must(v.kind !== 'content', `content tampering reported at ${v.brokenAtSeq}`);
    must(v.ok === (v.kind === undefined), `ok=${v.ok} with kind=${v.kind}`);
    if (ctx.fork || ctx.testnet) must(v.ok === true && v.linkBreaks === 0, `${ctx.chain} trail: ok=${v.ok}, linkBreaks=${v.linkBreaks}`);
    if (anchor.status === 200) must(Math.abs(anchor.json.entryCount - v.checked) <= 3, `anchor entryCount ${anchor.json.entryCount} vs checked ${v.checked}`);
    return `ok=${v.ok}, ${v.checked} checked, ${v.intact} intact, ${v.linkBreaks} link break(s)${v.kind ? ` (first at ${v.brokenAtSeq})` : ''}`;
  },
);
unauthorized('GET', '/activity/verify');

check(
  {
    method: 'GET',
    path: '/activity/verify',
    auth: 'user',
    kind: 'invariant',
    runLast: true,
    correct:
      'Run after every other check: the trail still verifies after all the writes this suite made — no new link break, no altered row (linkBreaks unchanged from the start of the run, intact = checked).',
  },
  async () => {
    const r = await get('/activity/verify');
    expectStatus(r, 200, 'GET /activity/verify');
    must(r.json.intact === r.json.checked, `${r.json.checked - r.json.intact} altered row(s)`);
    must(r.json.linkBreaks === ctx.verifyAtStart.linkBreaks, `link breaks went from ${ctx.verifyAtStart.linkBreaks} to ${r.json.linkBreaks}`);
    return `${ctx.verifyAtStart.checked} → ${r.json.checked} rows during the run, linkBreaks still ${r.json.linkBreaks}`;
  },
);

/* ───────────────────────────────────────────────────────────── /agent/* (machine surface) */

agentSurface('GET', '/agent/due');
agentSurface('GET', '/agent/keys');
agentSurface('POST', '/agent/keys', { name: 'qa-full', scopes: ['read'] });
agentSurface('DELETE', '/agent/keys/:id');
agentSurface('POST', '/agent/positions/close', { owner: randomAddress(), symbol: 'XBTC', fraction: 1 });
agentSurface('POST', '/agent/strategies/:id/run');
agentSurface('POST', '/agent/tick');
agentSurface('GET', '/agent/whoami');

/* ───────────────────────────────────────────────────────────── /agents */

function agentContract(rows, what) {
  must(Array.isArray(rows) && rows.length === 4, `${what}: expected 4 personas, got ${clip(rows)}`);
  rows.forEach((a, i) => {
    const persona = a.personaId ?? a.id;
    must(persona === PERSONAS[i], `${what}: row ${i} is ${persona}, expected ${PERSONAS[i]}`);
    must(typeof a.name === 'string' && a.name && typeof a.role === 'string' && a.role, `${what}: ${persona} has no name/role`);
    must(/^#[0-9A-Fa-f]{6}$/.test(a.c1) && /^#[0-9A-Fa-f]{6}$/.test(a.c2), `${what}: ${persona} colours ${a.c1} ${a.c2}`);
    must(Number.isInteger(a.trades) && a.trades >= 0, `${what}: ${persona} trades ${a.trades}`);
    must(Number.isInteger(a.win) && a.win >= 0 && a.win <= 100, `${what}: ${persona} win ${a.win}`);
    must(isNum(a.pnl30d), `${what}: ${persona} pnl30d ${a.pnl30d}`);
    if (a.trades === 0) must(a.win === 0 && a.pnl30d === 0 && a.metric === 'No trades yet', `${what}: ${persona} has no trades but win=${a.win} pnl=${a.pnl30d} metric="${a.metric}"`);
    else must(a.metric === `${a.win}% win rate`, `${what}: ${persona} metric "${a.metric}" for win ${a.win}`);
  });
}

check(
  {
    method: 'GET',
    path: '/agents',
    auth: 'user',
    kind: 'contract',
    correct:
      '200: exactly the four personas in order momentum-scout, earnings-desk, yield-keeper, drawdown-guard, each {id, personaId, name, role, hired: bool, tone ∈ dry|sharp|flat, riskLimits: object, c1/c2 hex colours, pnl30d, win 0–100, trades ≥ 0, metric}. id equals personaId only when no agent row exists (so a hired agent has a row id); trades 0 ⇒ win 0, pnl30d 0, metric "No trades yet", else metric "<win>% win rate"; pnl30d, win and trades equal /agents/leaderboard for the same persona.',
  },
  async () => {
    const r = await get('/agents');
    expectStatus(r, 200, 'GET /agents');
    agentContract(r.json, 'GET /agents');
    for (const a of r.json) {
      must(typeof a.hired === 'boolean' && ['dry', 'sharp', 'flat'].includes(a.tone), `${a.personaId}: hired ${a.hired}, tone ${a.tone}`);
      must(a.riskLimits && typeof a.riskLimits === 'object' && !Array.isArray(a.riskLimits), `${a.personaId}: riskLimits ${clip(a.riskLimits)}`);
      if (a.hired) must(a.id !== a.personaId, `${a.personaId} is hired but has no row id`);
    }
    const board = await get('/agents/leaderboard');
    expectStatus(board, 200, 'GET /agents/leaderboard');
    for (const a of r.json) {
      const b = board.json.find((x) => x.id === a.personaId);
      must(b && b.trades === a.trades && b.win === a.win && near(b.pnl30d, a.pnl30d, 0.011), `${a.personaId}: roster ${a.trades}/${a.win}/${a.pnl30d} vs leaderboard ${b?.trades}/${b?.win}/${b?.pnl30d}`);
    }
    return r.json.map((a) => `${a.personaId}${a.hired ? ' (hired)' : a.id !== a.personaId ? ' (row, not hired)' : ''}`).join(', ');
  },
);
unauthorized('GET', '/agents');

check(
  {
    method: 'POST',
    path: '/agents',
    auth: 'user',
    kind: 'validation',
    correct:
      'Refusals: {personaId:"nope"} → 400 invalid_request naming personaId; {} → 400 invalid_request; malformed JSON → 400 invalid_json; nothing is hired by any of them. Where an agent is already hired, hiring it again is idempotent: 200 with the same row id, hired true, tone unchanged, and the roster unchanged.',
  },
  async () => {
    const before = (await get('/agents')).json;
    const bad = await post('/agents', { personaId: 'nope' });
    expectRefusal(bad, 400, 'invalid_request', '{personaId:"nope"}');
    must(/personaId/.test(bad.json.detail ?? ''), `detail does not name personaId: ${bad.json.detail}`);
    expectRefusal(await post('/agents', {}), 400, 'invalid_request', '{}');
    expectRefusal(await http('POST', '/agents', { raw: '{"personaId":' }), 400, 'invalid_json', 'malformed JSON');
    const hired = before.find((a) => a.hired);
    let note = 'idempotent re-hire not applicable: no hired agent on this account (hiring one is only undone by firing, which pauses its strategies)';
    if (hired) {
      const again = await post('/agents', { personaId: hired.personaId });
      expectStatus(again, 200, `re-hire ${hired.personaId}`);
      must(again.json.id === hired.id && again.json.hired === true && again.json.tone === hired.tone, `re-hire changed the agent: ${clip(again.text)}`);
      note = `re-hiring ${hired.personaId} kept row ${hired.id}`;
    }
    const after = (await get('/agents')).json;
    must(JSON.stringify(after.map((a) => [a.id, a.hired])) === JSON.stringify(before.map((a) => [a.id, a.hired])), `the roster changed: ${clip(after.map((a) => [a.id, a.hired]))}`);
    return `400 invalid_request ×2, 400 invalid_json; ${note}`;
  },
);
unauthorized('POST', '/agents', { body: { personaId: 'momentum-scout' } });

check(
  {
    method: 'DELETE',
    path: '/agents/:id',
    auth: 'user',
    kind: 'refusal',
    correct:
      'An id that is not one of this wallet\'s agents (unknown or another account\'s) → 404 {error:"not_found"}, and nothing is paused. Happy path (firing) not executed here: it pauses the agent\'s live strategies, which re-hiring does not resume.',
  },
  async () => {
    const r = await del(`/agents/${randomUUID()}`);
    expectRefusal(r, 404, 'not_found', 'DELETE unknown agent');
    return '404 not_found';
  },
);
unauthorized('DELETE', '/agents/:id');

check(
  {
    method: 'PATCH',
    path: '/agents/:id',
    auth: 'user',
    kind: 'contract',
    correct:
      'Validation: tone "loud" → 400 invalid_request; riskLimits {maxUsdPerTrade:-1} → 400 invalid_request; an unknown riskLimits key → 400 invalid_request (strict); a valid body for an id that is not this wallet\'s → 404 not_found. Happy path (reversible): on an agent row, changing tone answers 200 with the new tone and the same id, GET /agents shows it, and setting it back restores the original.',
  },
  async () => {
    const roster = (await get('/agents')).json;
    const row = roster.find((a) => a.id !== a.personaId);
    const target = row?.id ?? randomUUID();
    expectRefusal(await patch(`/agents/${target}`, { tone: 'loud' }), 400, 'invalid_request', 'tone "loud"');
    expectRefusal(await patch(`/agents/${target}`, { riskLimits: { maxUsdPerTrade: -1 } }), 400, 'invalid_request', 'negative maxUsdPerTrade');
    expectRefusal(await patch(`/agents/${target}`, { riskLimits: { bogus: 1 } }), 400, 'invalid_request', 'unknown riskLimits key');
    expectRefusal(await patch(`/agents/${randomUUID()}`, { tone: 'flat' }), 404, 'not_found', 'unknown agent');
    if (!row) return 'refusals pass; no agent row on this account to change and restore';
    const original = row.tone;
    const next = original === 'flat' ? 'sharp' : 'flat';
    try {
      const changed = await patch(`/agents/${row.id}`, { tone: next });
      expectStatus(changed, 200, `PATCH tone ${next}`);
      must(changed.json.id === row.id && changed.json.tone === next && changed.json.personaId === row.personaId, `answer: ${clip(changed.text)}`);
      const seen = (await get('/agents')).json.find((a) => a.id === row.id);
      must(seen?.tone === next, `GET /agents shows tone ${seen?.tone}`);
    } finally {
      const restored = await patch(`/agents/${row.id}`, { tone: original });
      expectStatus(restored, 200, `restore tone ${original}`);
    }
    const final = (await get('/agents')).json.find((a) => a.id === row.id);
    must(final?.tone === original && JSON.stringify(final.riskLimits) === JSON.stringify(row.riskLimits), `not restored: tone ${final?.tone}, riskLimits ${clip(final?.riskLimits)}`);
    return `refusals pass; ${row.personaId} tone ${original} → ${next} → ${original}`;
  },
);
unauthorized('PATCH', '/agents/:id', { body: { tone: 'flat' } });

function backtestContract(r, lookback, cap, what) {
  expectStatus(r, 200, what);
  const b = r.json;
  must(b.lookback === lookback, `${what}: lookback ${b.lookback}`);
  must(isNum(b.ret) && isNum(b.sharpe) && isNum(b.maxDd) && b.maxDd <= 0, `${what}: ret ${b.ret}, sharpe ${b.sharpe}, maxDd ${b.maxDd}`);
  must(Number.isInteger(b.trades) && b.trades >= 0, `${what}: trades ${b.trades}`);
  must(Array.isArray(b.equity) && b.equity.length >= 2 && b.equity.every(isNum), `${what}: equity ${clip(b.equity, 120)}`);
  must(near(b.equity[0], Math.min(500, cap), 1e-6), `${what}: equity starts at ${b.equity[0]}, expected the $${Math.min(500, cap)} entry size`);
  must(b.feed === 'live' && /breakout/.test(b.source ?? '') && typeof b.disclaimer === 'string' && b.disclaimer.length > 0, `${what}: feed ${b.feed}, source ${b.source}`);
}

check(
  {
    method: 'GET',
    path: '/agents/:id/backtest',
    auth: 'user',
    kind: 'contract',
    correct:
      'momentum-scout ?lookback=90d and ?lookback=30d (the app\'s pills): 200 {lookback echoed, ret, maxDd ≤ 0, sharpe, trades ≥ 0, equity: ≥2 numbers starting at min($500, the on-chain daily cap), feed "live", source naming the breakout rule, disclaimer}. A 503 warming is waited out; no single attempt may exceed the app\'s 45s.',
  },
  async () => {
    const cap = ctx.delegation?.dailyCapUsd ?? 1600;
    const r90 = await get('/agents/momentum-scout/backtest?lookback=90d');
    backtestContract(r90, '90d', cap, '90d');
    const r30 = await get('/agents/momentum-scout/backtest?lookback=30d');
    backtestContract(r30, '30d', cap, '30d');
    return `90d ret ${r90.json.ret}% over ${r90.json.trades} trade(s); 30d ret ${r30.json.ret}%`;
  },
);

check(
  {
    method: 'GET',
    path: '/agents/:id/backtest',
    auth: 'user',
    kind: 'app-contract',
    correct:
      'Exactly what the app sends: the roster screen routes with the agent\'s `id` from GET /agents (app/bot/roster.tsx:111 → app/bot/[id]/backtest.tsx:57 → src/data/local.ts:270), which is the row id once an agent has a row. For every roster entry, /agents/<that id>/backtest?lookback=90d must answer as its persona does: momentum-scout 200, the other three 422 {error:"not_backtestable", message}.',
  },
  async () => {
    const roster = (await get('/agents')).json;
    const wrong = [];
    for (const a of roster) {
      const r = await get(`/agents/${a.id}/backtest?lookback=90d`);
      const want = a.personaId === 'momentum-scout' ? 200 : 422;
      if (r.status !== want || (want === 422 && r.json?.error !== 'not_backtestable')) {
        wrong.push(`${a.personaId} via id ${a.id} → ${r.status} ${r.json?.error ?? ''} (expected ${want}${want === 422 ? ' not_backtestable' : ''})`);
      }
    }
    must(wrong.length === 0, wrong.join('; '));
    return roster.map((a) => `${a.personaId}→${a.personaId === 'momentum-scout' ? 200 : 422}`).join(', ');
  },
);

check(
  {
    method: 'GET',
    path: '/agents/:id/backtest',
    auth: 'user',
    kind: 'validation',
    correct:
      'Bad parameters are refused, never answered with a made-up result: ?lookback=7d (not one of 30d|90d|6m|1y) → 400 with a named error; an agent that is not on the roster → 404 {error:"unknown_agent", message}.',
  },
  async () => {
    const unknown = await get('/agents/nope/backtest?lookback=90d');
    expectRefusal(unknown, 404, 'unknown_agent', 'unknown agent');
    const bad = await get('/agents/momentum-scout/backtest?lookback=7d');
    expectRefusal(bad, 400, undefined, '?lookback=7d');
    return `unknown agent 404; lookback=7d ${bad.status} ${named(bad)}`;
  },
);
unauthorized('GET', '/agents/:id/backtest');

check(
  {
    method: 'GET',
    path: '/agents/leaderboard',
    auth: 'user',
    kind: 'contract',
    correct:
      '200: four rows in order momentum-scout, earnings-desk, yield-keeper, drawdown-guard, each {id, name, role, c1, c2, trades ≥ 0, win 0–100, pnl30d (≤ 2 decimals), metric}; trades 0 ⇒ win 0, pnl30d 0, "No trades yet"; otherwise "<win>% win rate".',
  },
  async () => {
    const r = await get('/agents/leaderboard');
    expectStatus(r, 200, 'GET /agents/leaderboard');
    agentContract(r.json, 'leaderboard');
    for (const a of r.json) must(near(a.pnl30d, Number(a.pnl30d.toFixed(2)), 1e-9), `${a.id}: pnl30d ${a.pnl30d} has more than 2 decimals`);
    return r.json.map((a) => `${a.id} ${a.trades}t ${a.win}%`).join(', ');
  },
);
unauthorized('GET', '/agents/leaderboard');

check(
  {
    method: 'POST',
    path: '/agents/resume',
    auth: 'user',
    kind: 'contract',
    correct:
      'Idempotent: while the agents are running (GET /agents/stopped → stopped:false) resuming is a no-op that answers 200 {stopped:false, since:null} and changes nothing.',
  },
  async () => {
    const state = (await get('/agents/stopped')).json;
    if (state.stopped) return 'not applicable: the agents are stopped on this account, and resuming them is the account owner\'s call';
    const r = await post('/agents/resume', {});
    expectStatus(r, 200, 'POST /agents/resume');
    must(r.json.stopped === false && r.json.since === null, `answer ${clip(r.text)}`);
    must((await get('/agents/stopped')).json.stopped === false, 'the agents read as stopped afterwards');
    return '200 {stopped:false, since:null}';
  },
);
unauthorized('POST', '/agents/resume', { body: {} });

check(
  {
    method: 'POST',
    path: '/agents/stop',
    auth: 'user',
    kind: 'contract',
    correct:
      'Reversible happy path, only when no live strategy is due within 5 minutes: stop → 200 {stopped:true, since: now}; GET /agents/stopped agrees; the executor enforces it (POST /limits/check {usd:1} → allowed:false, reason "agents_stopped"); resume → {stopped:false, since:null}. The agents are always resumed, even when an assertion fails.',
  },
  async () => {
    const state = (await get('/agents/stopped')).json;
    if (state.stopped) return 'not applicable: the agents were already stopped; left as found';
    const strategies = (await get('/strategies')).json;
    const due = strategies.filter((s) => ['live', 'watch'].includes(s.state) && s.nextRunAt && Math.abs(s.nextRunAt - Date.now()) < 5 * 60_000);
    if (due.length > 0) return `not executed this run: ${due.length} live strateg${due.length === 1 ? 'y is' : 'ies are'} due within 5 minutes`;
    const t0 = Date.now();
    let stopped;
    try {
      stopped = await post('/agents/stop', {});
      expectStatus(stopped, 200, 'POST /agents/stop');
      must(stopped.json.stopped === true && isMs(stopped.json.since) && Math.abs(stopped.json.since - t0) < 120_000, `answer ${clip(stopped.text)}`);
      const seen = (await get('/agents/stopped')).json;
      must(seen.stopped === true && seen.since === stopped.json.since, `GET /agents/stopped ${clip(seen)}`);
      const gate = await post('/limits/check', { usd: 1 });
      expectStatus(gate, 200, 'POST /limits/check while stopped');
      must(gate.json.allowed === false && gate.json.reason === 'agents_stopped', `not enforced: ${clip(gate.text)}`);
    } finally {
      const resumed = await post('/agents/resume', {});
      must(resumed.status === 200 && resumed.json?.stopped === false && resumed.json?.since === null, `RESUME FAILED — the agents may still be stopped: ${show(resumed)}`);
    }
    return 'stopped (enforced by /limits/check: agents_stopped), then resumed';
  },
);
unauthorized('POST', '/agents/stop', { body: {} });

check(
  {
    method: 'GET',
    path: '/agents/stopped',
    auth: 'user',
    kind: 'contract',
    correct: '200 {stopped: boolean, since: epoch ms | null}; stopped false ⇔ since null; since is not in the future; agrees with GET /wallet agents_stopped.',
  },
  async () => {
    const r = await get('/agents/stopped');
    expectStatus(r, 200, 'GET /agents/stopped');
    must(typeof r.json.stopped === 'boolean', `stopped ${r.json.stopped}`);
    must(r.json.stopped ? isMs(r.json.since) && r.json.since <= Date.now() + 60_000 : r.json.since === null, `since ${r.json.since} with stopped ${r.json.stopped}`);
    const w = (await get('/wallet')).json;
    must((w.agents_stopped === true) === r.json.stopped, `wallet agents_stopped ${w.agents_stopped}`);
    return `stopped=${r.json.stopped}`;
  },
);
unauthorized('GET', '/agents/stopped');

/* ───────────────────────────────────────────────────────────── /alerts */

function alertShape(a, what) {
  must(typeof a.id === 'string' && ['price', 'agent', 'risk'].includes(a.kind), `${what}: id/kind ${clip(a)}`);
  must(a.symbol === null || typeof a.symbol === 'string', `${what}: symbol ${a.symbol}`);
  must(typeof a.name === 'string' && a.name.length > 0 && typeof a.detail === 'string', `${what}: name/detail`);
  must(typeof a.enabled === 'boolean' && a.default === a.enabled, `${what}: enabled ${a.enabled}, default ${a.default}`);
  must(a.config && typeof a.config === 'object' && !Array.isArray(a.config), `${what}: config ${clip(a.config)}`);
  must(typeof a.armed === 'boolean' && Number.isInteger(a.fireCount) && a.fireCount >= 0, `${what}: armed ${a.armed}, fireCount ${a.fireCount}`);
  must(a.fireCount === 0 ? a.lastFiredAt === null : isIso(a.lastFiredAt), `${what}: fireCount ${a.fireCount} with lastFiredAt ${a.lastFiredAt}`);
}

/** A price alert no market will ever reach, unique per call, so it never fires and never duplicates. */
const probeAlert = (label) => ({
  kind: 'price',
  symbol: 'BTC',
  name: `qa-full ${label} ${Date.now()}`,
  detail: 'qa-full probe; deleted by the same check',
  config: { above: 900_000_000 + Math.floor(Math.random() * 1_000_000) + 0.5 },
});

async function createAlert(label, opts) {
  const body = probeAlert(label);
  const r = await post('/alerts', body, opts);
  expectStatus(r, 200, `create alert (${label})`);
  must(typeof r.json?.id === 'string', `create alert (${label}): no id: ${clip(r.text)}`);
  return { r, body, id: r.json.id };
}

check(
  {
    method: 'GET',
    path: '/alerts',
    auth: 'user',
    kind: 'contract',
    correct:
      '200 array of {id (unique), kind ∈ price|agent|risk, symbol: string|null, name, detail, enabled, default = enabled, config: object, armed: bool, fireCount ≥ 0, lastFiredAt: ISO once fired, null before}.',
  },
  async () => {
    const r = await get('/alerts');
    expectStatus(r, 200, 'GET /alerts');
    must(Array.isArray(r.json), `not an array: ${clip(r.text)}`);
    r.json.forEach((a) => alertShape(a, `alert ${a.id}`));
    must(new Set(r.json.map((a) => a.id)).size === r.json.length, 'duplicate ids');
    return `${r.json.length} alert(s), ${r.json.filter((a) => a.enabled).length} enabled`;
  },
);
unauthorized('GET', '/alerts');

check(
  {
    method: 'POST',
    path: '/alerts',
    auth: 'user',
    kind: 'contract',
    correct:
      'Reversible happy path: a price alert on BTC with an Idempotency-Key → 200 {id, enabled:true, armed:true, fireCount:0, lastFiredAt:null, config as sent}; the same request with the same key replays (idempotent-replay: true, same id); GET /alerts lists it exactly once; the same alert without a key → 409 {error:"duplicate_alert"} naming it; deleted afterwards.',
  },
  async () => {
    const key = `qa-full-${randomUUID()}`;
    const { r, body, id } = await createAlert('create', { headers: { 'idempotency-key': key } });
    try {
      alertShape(r.json, 'created');
      must(r.json.enabled && r.json.armed && r.json.fireCount === 0 && r.json.lastFiredAt === null, `new alert state: ${clip(r.text)}`);
      must(r.json.name === body.name && r.json.symbol === 'BTC' && r.json.config.above === body.config.above, `not what was sent: ${clip(r.text)}`);
      const replay = await post('/alerts', body, { headers: { 'idempotency-key': key } });
      expectStatus(replay, 200, 'replay with the same Idempotency-Key');
      must(replay.headers.get('idempotent-replay') === 'true' && replay.json?.id === id, `not a replay: header ${replay.headers.get('idempotent-replay')}, id ${replay.json?.id}`);
      const listed = (await get('/alerts')).json.filter((a) => a.id === id);
      must(listed.length === 1, `listed ${listed.length} times`);
      const dup = await post('/alerts', body);
      expectRefusal(dup, 409, 'duplicate_alert', 'the same alert again, without a key');
      must((dup.json.message ?? '').includes(body.name), `refusal does not name the existing alert: ${dup.json.message}`);
    } finally {
      await del(`/alerts/${id}`);
    }
    return 'created, replayed by key, listed once, duplicate refused 409, deleted';
  },
);

check(
  {
    method: 'POST',
    path: '/alerts',
    auth: 'user',
    kind: 'validation',
    correct:
      'Refusals, none of which creates a row: kind "weather" → 400 invalid_request; a price alert on "NOPE" → 400 unevaluable_alert ("nothing prices NOPE…"); a price alert with no above/below → 400 unevaluable_alert; an agent alert without blockedRuns → 400 unevaluable_alert; malformed JSON → 400 invalid_json.',
  },
  async () => {
    const before = (await get('/alerts')).json.length;
    expectRefusal(await post('/alerts', { kind: 'weather', name: 'qa-full' }), 400, 'invalid_request', 'kind "weather"');
    const nope = await post('/alerts', { kind: 'price', symbol: 'NOPE', name: 'qa-full', config: { above: 1 } });
    expectRefusal(nope, 400, 'unevaluable_alert', 'price alert on NOPE');
    must(/NOPE/.test(nope.json.message ?? ''), `message does not name the symbol: ${nope.json.message}`);
    expectRefusal(await post('/alerts', { kind: 'price', symbol: 'BTC', name: 'qa-full', config: {} }), 400, 'unevaluable_alert', 'price alert without a level');
    expectRefusal(await post('/alerts', { kind: 'agent', name: 'qa-full', config: {} }), 400, 'unevaluable_alert', 'agent alert without blockedRuns');
    expectRefusal(await http('POST', '/alerts', { raw: '{"kind":' }), 400, 'invalid_json', 'malformed JSON');
    const after = (await get('/alerts')).json.length;
    must(after === before, `alert count changed ${before} → ${after}`);
    return '400 invalid_request, 400 unevaluable_alert ×3, 400 invalid_json; nothing created';
  },
);
unauthorized('POST', '/alerts', { body: probeAlert('unauth') });

check(
  {
    method: 'DELETE',
    path: '/alerts/:id',
    auth: 'user',
    kind: 'contract',
    correct:
      'Deleting this wallet\'s own alert → 200 {ok:true} and GET /alerts no longer lists it; deleting it again, or an id that is not this wallet\'s → 404 {error:"not_found"}.',
  },
  async () => {
    const { id } = await createAlert('delete');
    const r = await del(`/alerts/${id}`);
    expectStatus(r, 200, 'DELETE own alert');
    must(r.json?.ok === true, `answer ${clip(r.text)}`);
    must(!(await get('/alerts')).json.some((a) => a.id === id), 'still listed after delete');
    expectRefusal(await del(`/alerts/${id}`), 404, 'not_found', 'DELETE again');
    expectRefusal(await del(`/alerts/${randomUUID()}`), 404, 'not_found', 'DELETE unknown id');
    return 'deleted → 200 {ok:true}; again → 404; unknown → 404';
  },
);
unauthorized('DELETE', '/alerts/:id');

check(
  {
    method: 'POST',
    path: '/alerts/:id',
    auth: 'user',
    kind: 'contract',
    correct:
      'The toggle the alerts screen sends ({enabled}): on this wallet\'s alert → 200 with enabled and default both set, and GET /alerts shows it; back on → enabled:true. {enabled:"no"} → 400 invalid_request; an id that is not this wallet\'s → 404 not_found.',
  },
  async () => {
    const { id } = await createAlert('toggle');
    try {
      const off = await post(`/alerts/${id}`, { enabled: false });
      expectStatus(off, 200, 'toggle off');
      must(off.json.id === id && off.json.enabled === false && off.json.default === false, `answer ${clip(off.text)}`);
      must((await get('/alerts')).json.find((a) => a.id === id)?.enabled === false, 'GET /alerts does not show it off');
      const on = await post(`/alerts/${id}`, { enabled: true });
      expectStatus(on, 200, 'toggle on');
      must(on.json.enabled === true, `answer ${clip(on.text)}`);
      expectRefusal(await post(`/alerts/${id}`, { enabled: 'no' }), 400, 'invalid_request', '{enabled:"no"}');
      expectRefusal(await post(`/alerts/${randomUUID()}`, { enabled: false }), 404, 'not_found', 'unknown id');
    } finally {
      await del(`/alerts/${id}`);
    }
    return 'off → on persisted; bad body 400; unknown 404';
  },
);
unauthorized('POST', '/alerts/:id', { body: { enabled: false } });

unauthorized('POST', '/alerts/evaluate', {
  extra: 'Happy path not executed: the sweep is global — it evaluates every account\'s alerts and pushes to the owners of any that fire.',
});

/* ───────────────────────────────────────────────────────────── /approvals, /audit */

function formatUnits(value, decimals) {
  const neg = value < 0n;
  const v = neg ? -value : value;
  const base = 10n ** BigInt(decimals);
  const frac = (v % base).toString().padStart(decimals, '0').replace(/0+$/, '');
  return `${neg ? '-' : ''}${v / base}${frac ? `.${frac}` : ''}`;
}

function allowanceShape(t, what) {
  // server/src/venues/tokens.ts: the stablecoins are 6, OKX's XBTC 8, WETH and WOKB 18.
  const decimals = { USDC: 6, USDT0: 6, USDG: 6, XBTC: 8, WETH: 18, WOKB: 18 }[t.symbol];
  must(ADDRESS.test(t.address) && (decimals === undefined || t.decimals === decimals), `${what} ${t.symbol}: address/decimals ${t.address} ${t.decimals}`);
  if (t.allowance === null) {
    must(t.unread === true && t.display === null && t.none === false && t.unlimited === false, `${what} ${t.symbol}: unread shape ${clip(t)}`);
    return;
  }
  must(/^\d+$/.test(t.allowance) && t.unread === false, `${what} ${t.symbol}: allowance ${t.allowance}`);
  const raw = BigInt(t.allowance);
  must(t.display === formatUnits(raw, t.decimals), `${what} ${t.symbol}: display ${t.display} for ${t.allowance}`);
  must(t.unlimited === raw >= 1n << 254n && t.none === (raw === 0n), `${what} ${t.symbol}: unlimited ${t.unlimited}, none ${t.none} for ${t.allowance}`);
}

check(
  {
    method: 'GET',
    path: '/approvals',
    auth: 'user',
    kind: 'contract',
    correct:
      '200 {spender, tokens, spenders}: spender = /delegation/params contract = /health delegation; tokens are exactly the /delegation/params tokens (same symbols, addresses), each {symbol, address, decimals (USDC/USDT0/USDG 6, XBTC 8, WETH/WOKB 18), allowance: uint256 string | null, display = allowance in token units, unlimited ⇔ allowance ≥ 2^254, none ⇔ "0", unread ⇔ null}. spenders[0] = {role "delegation", address = spender, source "chain", tokens = tokens}; spenders[1] = {role "router", name "Uniswap v3 router"} at SwapRouter02 0x4f0C…9bcA, read from the chain, same token shape; on mainnet state (xlayer, xlayer-fork) spenders[2] = {role "router", name "OKX DEX approval contract"} at 0x8b77…F000. A router with no address is {address:null, tokens:null, unread:true}.',
  },
  async () => {
    const r = await get('/approvals');
    expectStatus(r, 200, 'GET /approvals');
    const a = r.json;
    must(sameAddr(a.spender, ctx.params.contract) && sameAddr(a.spender, ctx.health.delegation), `spender ${a.spender} vs params ${ctx.params.contract} / health ${ctx.health.delegation}`);
    must(JSON.stringify(a.tokens.map((t) => [t.symbol, lower(t.address)])) === JSON.stringify(ctx.params.tokens.map((t) => [t.symbol, lower(t.address)])), `tokens ${clip(a.tokens.map((t) => t.symbol))} vs params ${clip(ctx.params.tokens.map((t) => t.symbol))}`);
    a.tokens.forEach((t) => allowanceShape(t, 'delegation'));
    const [dlg, router] = a.spenders ?? [];
    must(dlg?.role === 'delegation' && sameAddr(dlg.address, a.spender) && dlg.source === 'chain' && JSON.stringify(dlg.tokens) === JSON.stringify(a.tokens), `delegation spender ${clip(dlg)}`);
    must(router?.role === 'router' && router.name === 'Uniswap v3 router', `router spender ${clip(router)}`);
    if (router.unread) {
      must(router.address === null && router.tokens === null, `unread router shape ${clip(router)}`);
    } else {
      must(sameAddr(router.address, UNISWAP_ROUTER) && router.source === 'chain', `router ${router.address} source ${router.source}`);
      router.tokens.forEach((t) => allowanceShape(t, 'router'));
    }
    const okx = a.spenders[2];
    if (ctx.mainnetState) {
      must(okx?.role === 'router' && okx.name === 'OKX DEX approval contract' && sameAddr(okx.address, OKX_DEX_APPROVE_SPENDER), `OKX DEX spender ${clip(okx)}`);
      okx.tokens.forEach((t) => allowanceShape(t, 'okx-dex'));
    } else {
      must(okx === undefined, `an OKX DEX spender on ${ctx.chain}, which has no OKX DEX: ${clip(okx)}`);
    }
    return a.tokens.map((t) => `${t.symbol} ${t.unlimited ? 'unlimited' : t.none ? 'none' : t.display}`).join(', ');
  },
);
unauthorized('GET', '/approvals');

check(
  {
    method: 'GET',
    path: '/audit/anchor',
    auth: 'user',
    kind: 'contract',
    correct:
      '200 {configured, contract, anchoredBy = /delegation/params delegate, chain = /health chain, state ∈ match|ahead|none — never "diverged", entryCount = /activity/verify checked (±3), latest: null iff state "none", history}. Configured: non-zero contract; latest = the last history entry; latest.entryCount ≤ entryCount (equal on "match"); history entry counts and blocks never decrease; heads are 32-byte hashes. Unconfigured: zero contract, empty history, state "none".',
  },
  async () => {
    const r = await get('/audit/anchor');
    const v = (await get('/activity/verify')).json;
    expectStatus(r, 200, 'GET /audit/anchor');
    const a = r.json;
    must(a.chain === ctx.chain && sameAddr(a.anchoredBy, ctx.params.delegate), `chain ${a.chain}, anchoredBy ${a.anchoredBy}`);
    must(['match', 'ahead', 'none'].includes(a.state), `state ${a.state}`);
    must(Math.abs(a.entryCount - v.checked) <= 3, `entryCount ${a.entryCount} vs verify ${v.checked}`);
    must((a.latest === null) === (a.state === 'none'), `latest ${clip(a.latest)} with state ${a.state}`);
    if (!a.configured) {
      must(a.contract === ZERO_ADDRESS && a.history.length === 0 && a.state === 'none', `unconfigured shape ${clip(a)}`);
      return 'not configured on this deployment';
    }
    must(ADDRESS.test(a.contract) && a.contract !== ZERO_ADDRESS, `contract ${a.contract}`);
    for (let i = 0; i < a.history.length; i += 1) {
      const h = a.history[i];
      must(TX.test(h.head) && Number.isInteger(h.entryCount) && Number.isInteger(h.blockNo), `history[${i}] ${clip(h)}`);
      if (i > 0) must(h.entryCount >= a.history[i - 1].entryCount && h.blockNo >= a.history[i - 1].blockNo, `history goes backwards at ${i}`);
    }
    if (a.latest) {
      must(JSON.stringify(a.latest) === JSON.stringify(a.history.at(-1)), `latest ${clip(a.latest)} is not the last history entry`);
      must(a.state === 'match' ? a.latest.entryCount === a.entryCount : a.latest.entryCount <= a.entryCount, `${a.state} with latest ${a.latest.entryCount} of ${a.entryCount}`);
    }
    return `${a.state}: ${a.latest?.entryCount ?? 0} of ${a.entryCount} anchored, ${a.history.length} anchor(s)`;
  },
);
unauthorized('GET', '/audit/anchor');
unauthorized('POST', '/audit/anchor', { body: {}, extra: 'Happy path not executed: it publishes the trail head to X Layer and spends gas (OKB).' });

/* ───────────────────────────────────────────────────────────── /bot, /briefing, /catchup */

check(
  {
    method: 'POST',
    path: '/bot/say',
    auth: 'user',
    kind: 'validation',
    correct:
      'Refused before any model is asked: persona "nope" → 400 invalid_request; a situation shorter than 3 characters → 400 invalid_request; tone "loud" → 400 invalid_request. Happy path not executed: it calls the language model.',
  },
  async () => {
    expectRefusal(await post('/bot/say', { persona: 'nope', situation: 'The user asks nothing.' }), 400, 'invalid_request', 'persona "nope"');
    expectRefusal(await post('/bot/say', { persona: 'momentum-scout', situation: 'hi' }), 400, 'invalid_request', 'situation "hi"');
    expectRefusal(await post('/bot/say', { persona: 'momentum-scout', situation: 'The user asks nothing.', tone: 'loud' }), 400, 'invalid_request', 'tone "loud"');
    return '400 invalid_request ×3';
  },
);
unauthorized('POST', '/bot/say', { body: { persona: 'momentum-scout', situation: 'The user asks nothing.' } });

unauthorized('GET', '/briefing', {
  extra: 'Happy path not executed: every card asks the language model for a take (server/src/bot/llm.ts speak).',
});

check(
  {
    method: 'GET',
    path: '/catchup',
    auth: 'user',
    kind: 'contract',
    correct:
      '200 {since: ISO | null, isFirstVisit = (since === null), counts: {kind: n}, entries: at most 50 {action, detail, kind ∈ trade|risk|block|yield, at: ISO, signature: string | null}}; counts sum to entries.length; every entry is newer than since (or than a day ago on a first visit); newest first. Reading it does not move the marker (since is unchanged on a second read).',
  },
  async () => {
    const r = await get('/catchup');
    expectStatus(r, 200, 'GET /catchup');
    const c = r.json;
    must(c.since === null || isIso(c.since), `since ${c.since}`);
    must(c.isFirstVisit === (c.since === null), `isFirstVisit ${c.isFirstVisit} with since ${c.since}`);
    must(Array.isArray(c.entries) && c.entries.length <= 50, `entries ${clip(c.entries, 80)}`);
    const total = Object.values(c.counts ?? {}).reduce((s, n) => s + n, 0);
    must(total === c.entries.length, `counts sum ${total} vs ${c.entries.length} entries`);
    const floor = c.since ? Date.parse(c.since) : Date.now() - 86_400_000 - 60_000;
    let prev = Number.POSITIVE_INFINITY;
    for (const e of c.entries) {
      must(['trade', 'risk', 'block', 'yield'].includes(e.kind) && isIso(e.at) && typeof e.action === 'string', `entry ${clip(e)}`);
      must(e.signature === null || typeof e.signature === 'string', `entry signature ${e.signature}`);
      must(Date.parse(e.at) > floor, `entry at ${e.at} is not after ${c.since ?? 'a day ago'}`);
      must(Date.parse(e.at) <= prev + 2_000, `entries not newest first at ${e.at}`);
      prev = Date.parse(e.at);
    }
    const again = (await get('/catchup')).json;
    must(again.since === c.since, `reading moved the marker: ${c.since} → ${again.since}`);
    return `${c.entries.length} entries since ${c.since ?? 'a day ago'} (${clip(c.counts, 80)})`;
  },
);
unauthorized('GET', '/catchup');
unauthorized('POST', '/catchup/seen', {
  body: {},
  extra: 'Happy path not executed: it moves the account\'s last-seen marker, which cannot be put back.',
});

/* ───────────────────────────────────────────────────────────── /delegation */

/** Tokens the grant approves on mainnet state (server/src/evm/chains.ts APPROVABLE_TOKENS). */
const USDT0 = '0x779Ded0c9e1022225f8E0630b35a9b54bE713736';

async function rpc(method, params) {
  const res = await fetch(TESTNET_RPC, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  const j = await res.json();
  if (j.error) throw new Error(`${method}: ${j.error.message}`);
  return j.result;
}

/**
 * A real, successful transaction this wallet did not send and that grants nothing: one of the
 * delegate's settlements from /history on the fork (its RPC is private), an unrelated transaction
 * from a recent block on X Layer testnet (QA_TESTNET_RPC).
 */
async function realTxNotFromOwner() {
  if (ctx.txProbe !== undefined) return ctx.txProbe;
  ctx.txProbe = null;
  if (!ctx.testnet) {
    const h = await get('/history?limit=10');
    const item = h.json?.items?.find((i) => i.kind === 'spent') ?? h.json?.items?.[0];
    if (item) ctx.txProbe = { hash: item.txHash, source: `this wallet's ${item.kind} settlement ${item.txHash.slice(0, 10)}…, sent by the delegate` };
    return ctx.txProbe;
  }
  const head = parseInt(await rpc('eth_blockNumber', []), 16);
  for (let back = 6; back < 30 && !ctx.txProbe; back += 1) {
    const block = await rpc('eth_getBlockByNumber', [`0x${(head - back).toString(16)}`, true]);
    for (const t of block?.transactions ?? []) {
      // 0x7e is the OP Stack's deposit transaction, which X Layer (OP Stack since 2025-10) has at the top of each block.
      if (t.type === '0x7e' || !t.to || sameAddr(t.from, ctx.owner)) continue;
      const receipt = await rpc('eth_getTransactionReceipt', [t.hash]);
      if (receipt?.status === '0x1') {
        ctx.txProbe = { hash: t.hash, source: `an unrelated X Layer testnet transaction ${t.hash.slice(0, 10)}… (block ${head - back})` };
        break;
      }
    }
  }
  return ctx.txProbe;
}

check(
  {
    method: 'GET',
    path: '/delegation',
    auth: 'user',
    kind: 'contract',
    correct:
      '200 null (no permission on chain) or {delegatePubkey, delegateName: string|null, delegateIsCurrent = (delegatePubkey = /delegation/params delegate), ownerPubkey = the wallet, ownerName and delegateName null (X Layer has no name service this build resolves), dailyCapUsd > 0, expiresAt (ms), grantedAt: ms before expiresAt | null, venueAllowlist ⊆ /delegation/params venues, withdrawalAllowlist [], revoked, onChainRemainingUsd in [0, cap], spentTodayUsd ≥ 0; while live, onChainRemainingUsd + spentTodayUsd = dailyCapUsd within a cent}; cap, expiry and the chain\'s spend agree with GET /limits.',
  },
  async () => {
    const r = await get('/delegation');
    const limits = (await get('/limits')).json;
    expectStatus(r, 200, 'GET /delegation');
    const d = r.json;
    if (d === null) {
      must(limits.granted === false, `null delegation but /limits granted=${limits.granted}`);
      return 'no permission on chain (null), and /limits agrees';
    }
    must(ADDRESS.test(d.delegatePubkey) && d.delegateIsCurrent === sameAddr(d.delegatePubkey, ctx.params.delegate), `delegate ${d.delegatePubkey}, isCurrent ${d.delegateIsCurrent}`);
    must(d.ownerPubkey === ctx.owner, `ownerPubkey ${d.ownerPubkey}`);
    must(d.ownerName === null && d.delegateName === null, `a name on ${ctx.chain}, which has no name service: ${d.ownerName} / ${d.delegateName}`);
    must(d.dailyCapUsd > 0 && isMs(d.expiresAt) && typeof d.revoked === 'boolean', `cap ${d.dailyCapUsd}, expiresAt ${d.expiresAt}, revoked ${d.revoked}`);
    must(d.grantedAt === null || (isMs(d.grantedAt) && d.grantedAt < d.expiresAt), `grantedAt ${d.grantedAt}`);
    must(Array.isArray(d.venueAllowlist) && d.venueAllowlist.every((v) => ctx.params.venues.some((p) => sameAddr(p, v))), `venueAllowlist ${clip(d.venueAllowlist)} not ⊆ params.venues`);
    must(Array.isArray(d.withdrawalAllowlist) && d.withdrawalAllowlist.length === 0, 'withdrawalAllowlist not []');
    must(d.onChainRemainingUsd >= 0 && d.onChainRemainingUsd <= d.dailyCapUsd + 0.01 && d.spentTodayUsd >= 0, `remaining ${d.onChainRemainingUsd}, spent ${d.spentTodayUsd}`);
    if (!d.revoked && d.expiresAt > Date.now()) {
      must(near(d.onChainRemainingUsd + d.spentTodayUsd, d.dailyCapUsd, 0.01), `chain remaining ${d.onChainRemainingUsd} + spent ${d.spentTodayUsd} ≠ cap ${d.dailyCapUsd}`);
    }
    if (!d.revoked) {
      must(limits.dailyCapUsd === d.dailyCapUsd && limits.expiresAt === d.expiresAt && near(limits.spentTodayUsd, d.spentTodayUsd, 0.01), `/limits ${clip(limits)} disagrees`);
    }
    return `$${d.dailyCapUsd}/day, $${d.spentTodayUsd} spent, ${d.venueAllowlist.length} venue(s), expires ${new Date(d.expiresAt).toISOString().slice(0, 10)}`;
  },
);
unauthorized('GET', '/delegation');

check(
  {
    method: 'GET',
    path: '/delegation/params',
    auth: 'user',
    kind: 'contract',
    correct:
      '200 {contract = /health delegation, delegate (address), venues = SETTLEMENT_VENUES: on mainnet state (xlayer, xlayer-fork) exactly Uniswap v3 SwapRouter02 0x4f0C…9bcA, the OKX DEX router 0x7c5b…eaf and its approval contract 0x8b77…F000, and the Aave v3 Pool 0xE3F3…f116; on the testnet none (no DEX, no lending pool); token = this chain\'s Circle USDC (mainnet state 0xB6CE…3061, testnet 0xDec9…B9B3), tokens: [{symbol, address}] starting with USDC at token — on mainnet state including USDT0 (tier 4) — and xStocks (…x) only on mainnet state, chain = /health chain}.',
  },
  async () => {
    const r = await get('/delegation/params');
    expectStatus(r, 200, 'GET /delegation/params');
    const p = r.json;
    must(sameAddr(p.contract, ctx.health.delegation) && ADDRESS.test(p.delegate) && p.chain === ctx.chain, `contract ${p.contract}, delegate ${p.delegate}, chain ${p.chain}`);
    const expected = ctx.mainnetState ? [UNISWAP_ROUTER, OKX_DEX_ROUTER, OKX_DEX_APPROVE_SPENDER, AAVE_V3_POOL] : [];
    must(
      p.venues.length === expected.length && expected.every((v) => p.venues.some((x) => sameAddr(x, v))),
      `venues ${clip(p.venues)}, expected ${expected.length ? expected.join(', ') : 'none'} on ${ctx.chain}`,
    );
    must(sameAddr(p.token, ctx.usdc), `token ${p.token}, expected ${ctx.usdc}`);
    must(p.tokens[0]?.symbol === 'USDC' && sameAddr(p.tokens[0].address, p.token), `tokens[0] ${clip(p.tokens[0])}`);
    if (ctx.mainnetState) must(p.tokens.some((t) => t.symbol === 'USDT0' && sameAddr(t.address, USDT0)), 'no USDT0, which tier 4 supplies');
    else must(!p.tokens.some((t) => /x$/.test(t.symbol)), `an xStock is offered on ${ctx.chain}, where none has code: ${clip(p.tokens.map((t) => t.symbol))}`);
    return `${p.venues.length} venue(s); tokens ${p.tokens.map((t) => t.symbol).join(', ')}`;
  },
);
unauthorized('GET', '/delegation/params');

check(
  {
    method: 'POST',
    path: '/delegation/record',
    auth: 'user',
    kind: 'refusal',
    correct:
      'Nothing unverifiable enters the trail: {txHash:"0xabc"} → 400 invalid_request naming txHash; malformed JSON → 400 invalid_json; a hash no chain has seen → 400 tx_not_found; a real, successful transaction that grants nothing (xlayer-fork: this wallet\'s own spend from /history; xlayer-testnet: an unrelated transaction) → 400 no_grant_event. No "Trading permission granted" row is written. Happy path not executed: it needs a grant the owner signs on chain.',
  },
  async () => {
    const newest = Number((await get('/activity')).json[0]?.id ?? 0);
    const short = await post('/delegation/record', { txHash: '0xabc' });
    expectRefusal(short, 400, 'invalid_request', '{txHash:"0xabc"}');
    must(/txHash/.test(short.json.detail ?? ''), `detail does not name txHash: ${short.json.detail}`);
    expectRefusal(await http('POST', '/delegation/record', { raw: '{"txHash":' }), 400, 'invalid_json', 'malformed JSON');
    expectRefusal(await post('/delegation/record', { txHash: randomHash() }), 400, 'tx_not_found', 'unknown hash');
    const probe = await realTxNotFromOwner();
    let note = 'no real transaction available to probe';
    if (probe) {
      const r = await post('/delegation/record', { txHash: probe.hash });
      expectRefusal(r, 400, 'no_grant_event', `real non-grant tx (${probe.source})`);
      note = `${probe.source} → 400 no_grant_event`;
    }
    const added = (await get('/activity')).json.filter((a) => Number(a.id) > newest && a.action === 'Trading permission granted');
    must(added.length === 0, `${added.length} grant row(s) written`);
    return `400 invalid_request, 400 invalid_json, 400 tx_not_found; ${note}; nothing recorded`;
  },
);
unauthorized('POST', '/delegation/record', { body: { txHash: randomHash() } });

check(
  {
    method: 'POST',
    path: '/delegation/revoke',
    auth: 'user',
    kind: 'refusal',
    correct:
      '{txHash:"0xabc"} → 400 invalid_request before anything is read; {} while the permission is still live on chain → 400 {error:"still_active"} and nothing is written. Happy path not executed: it records a revoke the owner signs on chain.',
  },
  async () => {
    expectRefusal(await post('/delegation/revoke', { txHash: '0xabc' }), 400, 'invalid_request', '{txHash:"0xabc"}');
    const d = (await get('/delegation')).json;
    if (!d || d.revoked) return '400 invalid_request; still_active not probed: no live permission on this account (an empty revoke would write)';
    const newest = Number((await get('/activity')).json[0]?.id ?? 0);
    expectRefusal(await post('/delegation/revoke', {}), 400, 'still_active', '{} with a live permission');
    const added = (await get('/activity')).json.filter((a) => Number(a.id) > newest && a.action === 'All agents stopped');
    must(added.length === 0, 'a stop was written');
    return '400 invalid_request; 400 still_active; nothing written';
  },
);
unauthorized('POST', '/delegation/revoke', { body: {} });

check(
  {
    method: 'POST',
    path: '/devices/register',
    auth: 'user',
    kind: 'validation',
    correct:
      'Refused before anything is stored: a token shorter than 10 characters → 400 invalid_request; a missing platform → 400 invalid_request. Happy path not executed: it registers a push target.',
  },
  async () => {
    expectRefusal(await post('/devices/register', { token: 'short', platform: 'ios' }), 400, 'invalid_request', 'token "short"');
    expectRefusal(await post('/devices/register', { token: 'ExponentPushToken[qa-full]' }), 400, 'invalid_request', 'no platform');
    return '400 invalid_request ×2';
  },
);
unauthorized('POST', '/devices/register', { body: { token: 'ExponentPushToken[qa-full]', platform: 'ios' } });

check(
  {
    method: 'GET',
    path: '/disposals',
    auth: 'user',
    kind: 'contract',
    correct:
      '200 array (≤ 200, newest first) of {id, symbol, at: ISO, units > 0, proceeds ≥ 0, cost ≥ 0, realised, basisKnown}; basisKnown ⇒ realised = proceeds − cost (to a cent); unknown basis ⇒ cost 0 and realised 0; with fewer than 200 rows the count and the realised total match /pnl/disposals.csv.',
  },
  async () => {
    const r = await get('/disposals');
    expectStatus(r, 200, 'GET /disposals');
    must(Array.isArray(r.json) && r.json.length <= 200, `not an array of ≤200: ${clip(r.text)}`);
    let prev = Number.POSITIVE_INFINITY;
    let total = 0;
    for (const d of r.json) {
      must(typeof d.symbol === 'string' && isIso(d.at) && d.units > 0 && d.proceeds >= 0 && d.cost >= 0 && typeof d.basisKnown === 'boolean', `row ${clip(d)}`);
      must(Date.parse(d.at) <= prev, `not newest first at ${d.at}`);
      prev = Date.parse(d.at);
      if (d.basisKnown) must(near(d.realised, d.proceeds - d.cost, 0.011), `${d.id}: realised ${d.realised} ≠ ${d.proceeds} − ${d.cost}`);
      else must(d.cost === 0 && d.realised === 0, `${d.id}: unknown basis with cost ${d.cost}, realised ${d.realised}`);
      total += d.realised;
    }
    if (r.json.length < 200) {
      const csv = await get('/pnl/disposals.csv');
      const lines = csv.text.trim().split('\n');
      const data = lines.slice(1, -1);
      must(data.length === r.json.length, `CSV has ${data.length} rows, JSON ${r.json.length}`);
      must(near(Number(lines.at(-1).split(',')[5]), total, 0.011), `CSV total ${lines.at(-1)} vs JSON ${total.toFixed(2)}`);
    }
    return `${r.json.length} disposal(s), realised $${total.toFixed(2)}`;
  },
);
unauthorized('GET', '/disposals');

/* ───────────────────────────────────────────────────────────── /faucet */

check(
  {
    method: 'GET',
    path: '/faucet',
    auth: 'user',
    kind: 'contract',
    correct:
      '200 {chain = /health chain, available, reason: null iff available, detail, source ("fork-holder" — the fork-only reserve — on xlayer-fork and localnet, "faucet-key" on xlayer-testnet; null when unavailable), from, usdc, usdcRaw = usdc × 10^6, ethFloor (the wallet\'s OKB floor: 0.05 on a fork; null otherwise), windowHours 24, wallet:{address = the wallet, lastClaimAt: ms|null, nextAt, canAsk}}; nextAt = lastClaimAt + 24h inside the window, else null; canAsk = available && nextAt === null. The fork offers exactly 1,000 USDC; xlayer-testnet at most 10; xlayer (real money) is unavailable with reason "real_money".',
  },
  async () => {
    const r = await get('/faucet');
    expectStatus(r, 200, 'GET /faucet');
    const f = r.json;
    must(f.chain === ctx.chain && f.windowHours === 24 && typeof f.available === 'boolean', `chain ${f.chain}, windowHours ${f.windowHours}`);
    must((f.reason === null) === f.available && typeof f.detail === 'string', `available ${f.available} with reason ${f.reason}`);
    if (f.available) {
      must(f.source === (ctx.fork ? 'fork-holder' : 'faucet-key') && ADDRESS.test(f.from), `source ${f.source}, from ${f.from}`);
      must(String(Math.round(f.usdc * 1e6)) === f.usdcRaw, `usdc ${f.usdc} vs raw ${f.usdcRaw}`);
      if (ctx.fork) must(f.usdc === 1000 && f.ethFloor === 0.05, `fork offer ${f.usdc} USDC, OKB floor ${f.ethFloor}`);
      if (ctx.testnet) must(f.usdc > 0 && f.usdc <= 10 && f.ethFloor === null, `testnet offer ${f.usdc}`);
      must(ctx.chain !== 'xlayer', 'a faucet on X Layer mainnet, where USDC is real money');
    } else {
      if (ctx.chain === 'xlayer') must(f.reason === 'real_money', `mainnet faucet refusal ${f.reason}`);
      must(CODE.test(f.reason) && f.source === null && f.from === null && f.usdc === null && f.usdcRaw === null, `unavailable shape ${clip(f)}`);
    }
    const w = f.wallet;
    must(w && w.address === ctx.owner, `wallet ${clip(w)}`);
    must(w.lastClaimAt === null || isMs(w.lastClaimAt), `lastClaimAt ${w.lastClaimAt}`);
    const inWindow = w.lastClaimAt !== null && Date.now() - w.lastClaimAt < 86_400_000;
    must(inWindow ? w.nextAt === w.lastClaimAt + 86_400_000 : w.nextAt === null, `nextAt ${w.nextAt} for lastClaimAt ${w.lastClaimAt}`);
    must(w.canAsk === (f.available && w.nextAt === null), `canAsk ${w.canAsk}`);
    return f.available ? `${f.usdc} USDC from ${f.source}; canAsk ${w.canAsk}` : `unavailable: ${f.reason}; canAsk ${w.canAsk}`;
  },
);
unauthorized('GET', '/faucet');

check(
  {
    method: 'POST',
    path: '/faucet',
    auth: 'user',
    kind: 'refusal',
    correct:
      'Refusal only, and only when GET /faucet says this wallet cannot ask (canAsk false, with nextAt more than 5 minutes away or the faucet unavailable): a recent claim → 409 {status:"blocked", reason:"claimed_recently", lastClaimAt, nextAt} with Retry-After ≈ seconds to nextAt; an unavailable faucet → 409 blocked with the reason GET /faucet gave. Happy path not executed: it moves test funds.',
  },
  async () => {
    const f = (await get('/faucet')).json;
    const w = f.wallet;
    const safeClaim = w.nextAt !== null && w.nextAt - Date.now() > 5 * 60_000;
    const safeUnavailable = !f.available && w.nextAt === null;
    if (w.canAsk || !(safeClaim || safeUnavailable)) return `not executed: this wallet could be sent funds right now (canAsk ${w.canAsk}, nextAt ${w.nextAt})`;
    const r = await post('/faucet', {}, { retry: false });
    if (safeClaim) {
      expectRefusal(r, 409, 'claimed_recently', 'POST /faucet after a claim');
      must(r.json.lastClaimAt === w.lastClaimAt && r.json.nextAt === w.nextAt, `claim times ${r.json.lastClaimAt}/${r.json.nextAt}`);
      const ra = Number(r.headers.get('retry-after'));
      must(Math.abs(ra - (w.nextAt - Date.now()) / 1000) < 120, `Retry-After ${ra} vs ${Math.round((w.nextAt - Date.now()) / 1000)}s to nextAt`);
      return `409 claimed_recently, Retry-After ${ra}s`;
    }
    expectRefusal(r, 409, f.reason, 'POST /faucet while unavailable');
    return `409 blocked ${r.json.reason}`;
  },
);
unauthorized('POST', '/faucet', { body: {} });

/* ───────────────────────────────────────────────────────────── /health, /history */

/** The lists the app mirrors, read from its source so a drift fails here rather than on a screen. */
function appList(relative, pattern) {
  try {
    const text = readFileSync(new URL(relative, import.meta.url), 'utf8');
    return [...text.matchAll(pattern)].map((m) => m[1]);
  } catch {
    return undefined;
  }
}

const SERVER_PUBLIC_PATHS = [
  '/health', '/market/quotes', '/market/sparklines', '/market/ohlc', '/market/symbols', '/market/logos', '/market/tradable',
  '/market/watchable', '/market/stocks', '/market/xstocks', '/market/stocks/history', '/yield/supply', '/verify', '/metrics',
  '/market/crosscheck', '/market/corporate-action', '/market/futures',
];

check(
  {
    method: 'GET',
    path: '/health',
    auth: 'public',
    kind: 'contract',
    correct:
      'Public. 200 (503 only when a critical dependency is down) {ok = status ≠ "down", status ∈ up|degraded|down = the worst dependency, chain (= QA_EXPECT_CHAIN), version: a commit sha (= QA_EXPECT_VERSION when set), delegation, uptimeSec ≥ 0, dependencies: postgres, rpc, delegation (critical) and gas (the delegate\'s OKB), upstreams (not critical) — no subgraph on X Layer — each {status, ms ≥ 0, detail}, breakers: [{host, failures, openUntil, open}], db, publicSurface: {paths = the server\'s 17 public paths = src/data/publicPaths.ts, prefixes ["/perp/"]}, voice: {configured: boolean}}; headers x-request-id and access-control-allow-origin; status not "down".',
  },
  async () => {
    const r = await get('/health', { auth: false, retry: false });
    const h = r.json;
    expectStatus(r, h?.status === 'down' ? 503 : 200, 'GET /health');
    must(h.status !== 'down', `down: ${h.dependencies.filter((d) => d.status === 'down').map((d) => `${d.name} (${d.detail})`).join(', ')}`);
    must(h.ok === (h.status !== 'down'), `ok ${h.ok} with status ${h.status}`);
    if (process.env.QA_EXPECT_CHAIN) must(h.chain === process.env.QA_EXPECT_CHAIN, `chain ${h.chain}`);
    must(typeof h.version === 'string' && /^[0-9a-f]{7,40}(-dirty)?$/.test(h.version), `version ${h.version}`);
    if (process.env.QA_EXPECT_VERSION) must(h.version === process.env.QA_EXPECT_VERSION, `version ${h.version}, expected ${process.env.QA_EXPECT_VERSION}`);
    must(ADDRESS.test(h.delegation) && isNum(h.uptimeSec) && h.uptimeSec >= 0, `delegation ${h.delegation}, uptime ${h.uptimeSec}`);
    const names = h.dependencies.map((d) => `${d.name}:${d.critical}`).join(',');
    must(names === 'postgres:true,rpc:true,delegation:true,gas:false,upstreams:false', `dependencies ${names}`);
    const gas = h.dependencies.find((d) => d.name === 'gas');
    must(gas.status !== 'up' || / OKB$/.test(gas.detail), `the gas balance is not stated in OKB: ${gas.detail}`);
    for (const d of h.dependencies) {
      must(['up', 'degraded', 'down'].includes(d.status) && isNum(d.ms) && d.ms >= 0 && typeof d.detail === 'string', `dependency ${clip(d)}`);
      must(d.status !== (d.critical ? 'degraded' : 'down'), `${d.name}: status ${d.status} for critical=${d.critical}`);
    }
    const worst = h.dependencies.some((d) => d.status === 'down') ? 'down' : h.dependencies.some((d) => d.status === 'degraded') ? 'degraded' : 'up';
    must(h.status === worst, `status ${h.status}, worst dependency ${worst}`);
    must(
      Array.isArray(h.breakers) &&
        h.breakers.every((b) => typeof b.host === 'string' && Number.isInteger(b.failures) && typeof b.open === 'boolean' && (b.openUntil > 0 || b.open === false)),
      `breakers ${clip(h.breakers)}`,
    );
    const appPaths = appList('../src/data/publicPaths.ts', /^\s*'(\/[^']+)',?\s*$/gm);
    const served = [...h.publicSurface.paths].sort();
    must(JSON.stringify(served) === JSON.stringify([...SERVER_PUBLIC_PATHS].sort()), `publicSurface.paths ${clip(served)}`);
    if (appPaths) must(JSON.stringify([...appPaths].sort()) === JSON.stringify(served), `app mirror ${clip([...appPaths].sort())} ≠ server ${clip(served)}`);
    must(JSON.stringify(h.publicSurface.prefixes) === '["/perp/"]', `prefixes ${clip(h.publicSurface.prefixes)}`);
    must(typeof h.voice?.configured === 'boolean', `voice ${clip(h.voice)}`);
    must(r.headers.get('x-request-id') && r.headers.get('access-control-allow-origin'), 'missing x-request-id or access-control-allow-origin');
    ctx.version = h.version;
    return `${h.status} on ${h.chain} at ${h.version.slice(0, 12)}; ${h.dependencies.map((d) => `${d.name} ${d.status}`).join(', ')}`;
  },
);

check(
  {
    method: 'GET',
    path: '/history',
    auth: 'user',
    kind: 'contract',
    correct:
      'As the app sends it (?limit=50, src/data/history.ts:61): 200 {owner = the wallet, chain, source "chain" (read from the delegation\'s events on X Layer), window:{fromBlock < toBlock, span ≤ 9,000 blocks, since: ISO|null}, unavailable: null, items: ≤ 50 {kind ∈ spent|closed, txHash, block inside the window, at: ISO|null, venue, token: {symbol, decimals, address}|null, amount: integer string, usd = amount/10^6 exactly when the token is USDC (null otherwise), run?: {kind, symbol, venue, side, units, usd}, explorer ("fork:<hash>" / OKLink)}}, newest first; ?limit=2 returns at most 2.',
  },
  async () => {
    const r = await get('/history?limit=50');
    expectStatus(r, 200, 'GET /history?limit=50');
    const h = r.json;
    must(h.owner === ctx.owner && h.chain === ctx.chain && h.source === 'chain' && h.unavailable === null, `header ${clip({ owner: h.owner, chain: h.chain, source: h.source, unavailable: h.unavailable })}`);
    must(h.window.fromBlock < h.window.toBlock && h.window.toBlock - h.window.fromBlock <= 9_000, `window ${clip(h.window)}`);
    must(h.window.since === null || isIso(h.window.since), `since ${h.window.since}`);
    must(Array.isArray(h.items) && h.items.length <= 50, `items ${clip(h.items, 80)}`);
    let prev = Number.POSITIVE_INFINITY;
    for (const i of h.items) {
      must(['spent', 'closed'].includes(i.kind) && TX.test(i.txHash) && i.block >= h.window.fromBlock && i.block <= h.window.toBlock, `item ${clip(i)}`);
      must(i.block <= prev, `items not newest first at block ${i.block}`);
      prev = i.block;
      must(i.at === null || isIso(i.at), `item at ${i.at}`);
      must(/^\d+$/.test(i.amount), `amount ${i.amount}`);
      if (i.token?.symbol === 'USDC') must(near(i.usd, Number(BigInt(i.amount)) / 1e6, 1e-9), `usd ${i.usd} for ${i.amount} USDC units`);
      else must(i.usd === null, `usd ${i.usd} on a ${i.token?.symbol ?? 'unknown'} amount`);
      must(i.explorer === explorerFor(i.txHash), `explorer ${clip(i.explorer)}`);
      if (i.run) must(typeof i.run.kind === 'string' && typeof i.run.symbol === 'string', `run ${clip(i.run)}`);
    }
    const two = await get('/history?limit=2');
    expectStatus(two, 200, '?limit=2');
    must(two.json.items.length <= 2, `?limit=2 returned ${two.json.items.length}`);
    return `${h.items.length} settlement(s) in blocks ${h.window.fromBlock}–${h.window.toBlock}`;
  },
);

check(
  {
    method: 'GET',
    path: '/history',
    auth: 'user',
    kind: 'validation',
    correct: '?limit=abc → 400 {error:"bad_limit", detail}.',
  },
  async () => {
    const r = await get('/history?limit=abc');
    expectRefusal(r, 400, 'bad_limit', '?limit=abc');
    return '400 bad_limit';
  },
);
unauthorized('GET', '/history');

/* ───────────────────────────────────────────────────────────── /limits */

check(
  {
    method: 'GET',
    path: '/limits',
    auth: 'user',
    kind: 'contract',
    correct:
      '200. Granted and live: {dailyCapUsd = /delegation cap, spentTodayUsd = the chain\'s spend (= /delegation spentTodayUsd), remainingUsd, revoked:false, granted:true, expiresAt = /delegation expiresAt}, with remainingUsd = dailyCapUsd − spentTodayUsd within a cent — the three numbers on the Limits screen must add up — and 0 once expired. Revoked: cap 0, remaining 0, granted true. Never granted: cap 0, remaining 0, revoked false, granted false.',
  },
  async () => {
    const r = await get('/limits');
    const d = (await get('/delegation')).json;
    expectStatus(r, 200, 'GET /limits');
    const l = r.json;
    if (!d) {
      must(l.granted === false && l.revoked === false && l.dailyCapUsd === 0 && l.remainingUsd === 0, `no permission, but ${clip(l)}`);
      return 'never granted';
    }
    if (d.revoked) {
      must(l.granted === true && l.revoked === true && l.dailyCapUsd === 0 && l.remainingUsd === 0, `revoked, but ${clip(l)}`);
      return 'revoked';
    }
    must(l.granted === true && l.revoked === false && l.dailyCapUsd === d.dailyCapUsd && l.expiresAt === d.expiresAt, `header ${clip(l)} vs delegation cap ${d.dailyCapUsd}`);
    must(near(l.spentTodayUsd, d.spentTodayUsd, 0.01), `spentTodayUsd ${l.spentTodayUsd} vs chain ${d.spentTodayUsd}`);
    if (l.expiresAt <= Date.now()) {
      must(l.remainingUsd === 0, `expired permission with $${l.remainingUsd} remaining`);
      return 'expired: remaining 0';
    }
    const executorSpend = l.dailyCapUsd - l.remainingUsd;
    must(
      near(l.remainingUsd, Math.max(0, l.dailyCapUsd - l.spentTodayUsd), 0.01),
      `remainingUsd ${l.remainingUsd} ≠ dailyCapUsd ${l.dailyCapUsd} − spentTodayUsd ${l.spentTodayUsd} = ${(l.dailyCapUsd - l.spentTodayUsd).toFixed(6)}; the remainder follows the executor's own tally ($${executorSpend.toFixed(2)} spent today) while spentTodayUsd is the chain's ($${l.spentTodayUsd})`,
    );
    return `$${l.spentTodayUsd} of $${l.dailyCapUsd} spent, $${l.remainingUsd} left`;
  },
);
unauthorized('GET', '/limits');

check(
  {
    method: 'POST',
    path: '/limits/check',
    auth: 'user',
    kind: 'contract',
    correct:
      'Read-only rule check. With a live permission and the agents running: {usd:1} → 200 {allowed:true, spentTodayUsd ≥ 0, remainingUsd = dailyCapUsd − spentTodayUsd − 1}, and that remainder is never below /limits remainingUsd − 1; {usd:0} → 200 {allowed:false, reason:"invalid_amount"}; {usd:10000000} → 200 {allowed:false, reason:"daily_cap", detail}. {usd:"10"} → 400 invalid_request; malformed JSON → 400 invalid_json.',
  },
  async () => {
    expectRefusal(await post('/limits/check', { usd: '10' }), 400, 'invalid_request', '{usd:"10"}');
    expectRefusal(await http('POST', '/limits/check', { raw: '{"usd":' }), 400, 'invalid_json', 'malformed JSON');
    const d = (await get('/delegation')).json;
    const stopped = (await get('/agents/stopped')).json.stopped;
    const one = await post('/limits/check', { usd: 1 });
    expectStatus(one, 200, '{usd:1}');
    if (!d || d.revoked || d.expiresAt <= Date.now() || stopped) {
      must(one.json.allowed === false && ['no_delegation', 'delegation_revoked', 'delegation_expired', 'agents_stopped'].includes(one.json.reason), `no live permission, but ${clip(one.text)}`);
      return `permission not live: ${one.json.reason}`;
    }
    const limits = (await get('/limits')).json;
    must(one.json.allowed === true && one.json.spentTodayUsd >= 0, `{usd:1}: ${clip(one.text)}`);
    must(near(one.json.remainingUsd, d.dailyCapUsd - one.json.spentTodayUsd - 1, 0.01), `remainingUsd ${one.json.remainingUsd} ≠ ${d.dailyCapUsd} − ${one.json.spentTodayUsd} − 1`);
    must(one.json.remainingUsd >= limits.remainingUsd - 1 - 0.01, `remainder ${one.json.remainingUsd} below /limits ${limits.remainingUsd} − 1`);
    const zero = await post('/limits/check', { usd: 0 });
    must(zero.status === 200 && zero.json.allowed === false && zero.json.reason === 'invalid_amount', `{usd:0}: ${show(zero)}`);
    const huge = await post('/limits/check', { usd: 10_000_000 });
    must(huge.status === 200 && huge.json.allowed === false && huge.json.reason === 'daily_cap' && typeof huge.json.detail === 'string', `{usd:1e7}: ${show(huge)}`);
    return `$1 allowed ($${one.json.remainingUsd} after); $0 invalid_amount; $10M daily_cap`;
  },
);
unauthorized('POST', '/limits/check', { body: { usd: 1 } });

/* ───────────────────────────────────────────────────────────── /market (public except earnings) */

async function quotes(symbols) {
  const r = await get(`/market/quotes?symbols=${symbols}`, { auth: false });
  expectStatus(r, 200, `GET /market/quotes?symbols=${symbols}`);
  return r.json;
}

check(
  {
    method: 'GET',
    path: '/market/crosscheck',
    auth: 'public',
    kind: 'contract',
    correct:
      'Public; as the asset screen sends it (?symbol=BTC, priced a second way through the X Layer Uniswap v3 pools XBTC trades in): 200 {symbol echoed, coingecko > 0, pool > 0, spreadPct = |coingecko − pool| / their mean × 100, compared:true, agree = spreadPct ≤ 0.75, note}. ?symbol=ETH (WETH has no pool with real liquidity on X Layer) → 200 {pool:null, spreadPct:null, compared:false, agree:true, note "has no pool on X Layer"}. compared:false always carries agree:true and spreadPct:null.',
  },
  async () => {
    const out = [];
    for (const symbol of ['BTC']) {
      const r = await get(`/market/crosscheck?symbol=${symbol}`, { auth: false });
      expectStatus(r, 200, `?symbol=${symbol}`);
      const x = r.json;
      must(x.symbol === symbol && x.coingecko > 0 && x.pool > 0 && x.compared === true, `${symbol}: ${clip(r.text)}`);
      must(near(x.spreadPct, (Math.abs(x.coingecko - x.pool) / ((x.coingecko + x.pool) / 2)) * 100, 1e-9, 1e-6), `${symbol}: spreadPct ${x.spreadPct}`);
      must(x.agree === x.spreadPct <= 0.75 && typeof x.note === 'string', `${symbol}: agree ${x.agree} at ${x.spreadPct}%`);
      out.push(`${symbol} ${x.spreadPct.toFixed(3)}%`);
    }
    const eth = await get('/market/crosscheck?symbol=ETH', { auth: false });
    expectStatus(eth, 200, '?symbol=ETH');
    must(eth.json.pool === null && eth.json.spreadPct === null && eth.json.compared === false && eth.json.agree === true && /no pool on X Layer/i.test(eth.json.note), `ETH: ${clip(eth.text)}`);
    return `${out.join(', ')}; ETH has no pool on X Layer`;
  },
);

check(
  {
    method: 'GET',
    path: '/market/crosscheck',
    auth: 'public',
    kind: 'validation',
    correct: 'A missing ?symbol → 400 with a named error.',
  },
  async () => {
    const r = await get('/market/crosscheck', { auth: false });
    expectRefusal(r, 400, undefined, 'no ?symbol');
    return `400 ${named(r)}`;
  },
);

check(
  {
    method: 'GET',
    path: '/market/earnings',
    auth: 'user',
    kind: 'contract',
    correct:
      'As the earnings screen sends it (?symbol=NVDAx, its default): 200 {symbol "NVDAx", cik 1045810 (NVIDIA), reported: ≥ 3 ms dates newest first, gapDays[i] = round((reported[i] − reported[i+1]) / 1 day), medianGapDays in [80, 100], errorDays = the widest gap\'s distance from the median, nextAt = reported[0] + medianGapDays days}; ?symbol=nvdax resolves to the same calendar.',
  },
  async () => {
    const r = await get('/market/earnings?symbol=NVDAx');
    expectStatus(r, 200, '?symbol=NVDAx');
    const e = r.json;
    must(e.symbol === 'NVDAx' && e.cik === 1045810, `symbol ${e.symbol}, cik ${e.cik}`);
    must(Array.isArray(e.reported) && e.reported.length >= 3 && e.reported.every(isMs), `reported ${clip(e.reported)}`);
    for (let i = 1; i < e.reported.length; i += 1) must(e.reported[i] < e.reported[i - 1], 'reported not newest first');
    must(e.gapDays.length === e.reported.length - 1 && e.gapDays.every((g, i) => g === Math.round((e.reported[i] - e.reported[i + 1]) / 86_400_000)), `gapDays ${clip(e.gapDays)}`);
    must(e.medianGapDays >= 80 && e.medianGapDays <= 100, `medianGapDays ${e.medianGapDays}`);
    must(e.errorDays === Math.max(...e.gapDays.map((g) => Math.abs(g - e.medianGapDays))), `errorDays ${e.errorDays}`);
    must(e.nextAt === e.reported[0] + e.medianGapDays * 86_400_000, `nextAt ${e.nextAt}`);
    const lowerCase = await get('/market/earnings?symbol=nvdax');
    expectStatus(lowerCase, 200, '?symbol=nvdax');
    must(lowerCase.json.symbol === 'NVDAx' && lowerCase.json.nextAt === e.nextAt, `nvdax → ${clip(lowerCase.text)}`);
    return `${e.reported.length} prints, next ~${new Date(e.nextAt).toISOString().slice(0, 10)} ±${e.errorDays}d`;
  },
);

check(
  {
    method: 'GET',
    path: '/market/earnings',
    auth: 'user',
    kind: 'validation',
    correct: 'Bad parameters get a named error, never a sentence with a hole in it: no ?symbol → 400 named; ?symbol=BTC (not a tokenized equity) → 400 or 404 named.',
  },
  async () => {
    const none = await get('/market/earnings');
    const btc = await get('/market/earnings?symbol=BTC');
    const problems = [];
    if (none.status !== 400 || !named(none)) problems.push(`no ?symbol → ${show(none)}`);
    if (![400, 404].includes(btc.status) || !named(btc)) problems.push(`?symbol=BTC → ${show(btc)}`);
    must(problems.length === 0, problems.join('; '));
    return `400 ${named(none)}; ${btc.status} ${named(btc)}`;
  },
);
unauthorized('GET', '/market/earnings');

check(
  {
    method: 'GET',
    path: '/market/futures',
    auth: 'public',
    kind: 'contract',
    correct:
      'Public. 200 {venue:"Hyperliquid", markets: many {symbol, markPx > 0, oraclePx > 0, change24hPct: number|null, fundingRate finite, openInterestUsd ≥ 0, dayVolumeUsd ≥ 0, maxLeverage ≥ 1}} busiest first (dayVolumeUsd never increases); BTC and ETH are listed, and BTC\'s mark is within 3% of /market/quotes BTC.',
  },
  async () => {
    const r = await get('/market/futures', { auth: false });
    expectStatus(r, 200, 'GET /market/futures');
    const f = r.json;
    must(f.venue === 'Hyperliquid' && Array.isArray(f.markets) && f.markets.length > 10, `venue ${f.venue}, ${f.markets?.length} markets`);
    let prev = Number.POSITIVE_INFINITY;
    for (const m of f.markets) {
      must(typeof m.symbol === 'string' && m.markPx > 0 && m.oraclePx > 0 && isNum(m.fundingRate) && m.openInterestUsd >= 0 && m.dayVolumeUsd >= 0 && m.maxLeverage >= 1, `market ${clip(m)}`);
      must(m.change24hPct === null || isNum(m.change24hPct), `${m.symbol}: change24hPct ${m.change24hPct}`);
      must(m.dayVolumeUsd <= prev, `not busiest first at ${m.symbol}`);
      prev = m.dayVolumeUsd;
    }
    const btc = f.markets.find((m) => m.symbol === 'BTC');
    must(btc && f.markets.some((m) => m.symbol === 'ETH'), 'BTC or ETH missing');
    const q = await quotes('BTC');
    must(Math.abs(btc.markPx / q.BTC.price - 1) < 0.03, `BTC mark ${btc.markPx} vs spot ${q.BTC.price}`);
    return `${f.markets.length} markets; BTC mark ${btc.markPx}`;
  },
);

check(
  {
    method: 'GET',
    path: '/market/logos',
    auth: 'public',
    kind: 'contract',
    correct:
      'Public; as the app asks (?symbols=a,b,c): 200 object whose keys are among the symbols asked, each {url: https URL | null, source: "xstocks" | "coingecko" | null} with url null ⇔ source null; BTC (CoinGecko) and NVDAx (the xStocks issuer\'s registry) resolve to a URL within four asks 5 s apart — the app asks again for whatever is absent (a symbol still resolving is absent, not null); ?symbols= (empty) → {}.',
  },
  async () => {
    const asked = ['BTC', 'WETH', 'NVDAx', 'ZZZNOPE'];
    let body = {};
    for (let i = 0; i < 4 && !(body.BTC?.url && body.NVDAx?.url); i += 1) {
      if (i > 0) await sleep(5_000);
      const r = await get(`/market/logos?symbols=${asked.join(',')}`, { auth: false });
      expectStatus(r, 200, 'GET /market/logos');
      body = r.json;
      for (const [k, v] of Object.entries(body)) {
        must(asked.includes(k), `unasked key ${k}`);
        must((v.url === null) === (v.source === null) && (v.url === null || /^https:\/\//.test(v.url)) && [null, 'xstocks', 'coingecko'].includes(v.source), `${k}: ${clip(v)}`);
      }
    }
    must(body.BTC?.url && body.NVDAx?.url, `BTC/NVDAx did not resolve: ${clip(body)}`);
    const empty = await get('/market/logos?symbols=', { auth: false });
    must(empty.status === 200 && JSON.stringify(empty.json) === '{}', `empty ask: ${show(empty)}`);
    return Object.entries(body).map(([k, v]) => `${k}:${v.source ?? 'none'}`).join(', ');
  },
);

function ohlcContract(r, symbol, days) {
  expectStatus(r, 200, `?symbol=${symbol}&days=${days}`);
  const o = r.json;
  must(o.symbol === symbol && o.days === days && Array.isArray(o.rows) && o.rows.length > 0, `days=${days}: ${clip(r.text)}`);
  let prev = 0;
  for (const row of o.rows) {
    must(Array.isArray(row) && row.length === 5 && row.every(isNum), `days=${days}: row ${clip(row)}`);
    const [t, open, high, low, close] = row;
    must(t > prev, `days=${days}: times not ascending`);
    prev = t;
    must(high >= Math.max(open, close) - 1e-9 && low <= Math.min(open, close) + 1e-9 && low > 0, `days=${days}: candle ${clip(row)}`);
  }
  return o.rows;
}

check(
  {
    method: 'GET',
    path: '/market/ohlc',
    auth: 'public',
    kind: 'contract',
    correct:
      'Public; as the chart asks (?symbol=BTC&days=1|7|30|90, src/data/marketData.ts TIMEFRAME_PLAN): 200 {symbol, days (a number), rows: non-empty [time, open, high, low, close]} with times ascending, high ≥ max(open, close), 0 < low ≤ min(open, close); days=1 and days=30 are different series; the last days=1 close is within 3% of /market/quotes BTC.',
  },
  async () => {
    const series = {};
    for (const days of [1, 7, 30, 90]) series[days] = ohlcContract(await get(`/market/ohlc?symbol=BTC&days=${days}`, { auth: false }), 'BTC', days);
    must(JSON.stringify(series[1]) !== JSON.stringify(series[30]), 'days=1 and days=30 are the same series');
    const q = await quotes('BTC');
    const last = series[1].at(-1)[4];
    must(Math.abs(last / q.BTC.price - 1) < 0.03, `last close ${last} vs spot ${q.BTC.price}`);
    return Object.entries(series).map(([d, rows]) => `${d}d:${rows.length}`).join(' ');
  },
);

check(
  {
    method: 'GET',
    path: '/market/ohlc',
    auth: 'public',
    kind: 'validation',
    correct: 'Bad parameters get a named error: no ?symbol → 400 named; ?days=abc → 400 named; ?symbol=NOPE → 404 named. Never a 404 whose message is missing the symbol.',
  },
  async () => {
    const cases = [
      ['/market/ohlc', 400],
      ['/market/ohlc?symbol=BTC&days=abc', 400],
      ['/market/ohlc?symbol=NOPE&days=1', 404],
    ];
    const problems = [];
    for (const [path, status] of cases) {
      const r = await get(path, { auth: false, retry: false });
      if (r.status !== status || !named(r)) problems.push(`${path} → ${show(r)}`);
    }
    must(problems.length === 0, problems.join('; '));
    return '400, 400, 404 — all named';
  },
);

check(
  {
    method: 'GET',
    path: '/market/quotes',
    auth: 'public',
    kind: 'contract',
    correct:
      'Public; as the market list asks (?symbols=BTC,ETH,WETH,USDC,USDT0,SOL,NVDAx,NOPE): 200 {SYMBOL: {price > 0, change24h finite, source "coingecko"}} for exactly the symbols with a feed — NVDAx (priced by its X Layer pool, /market/stocks) and NOPE are omitted; USDC and USDT0 within [0.98, 1.02]; WETH within 1% of ETH; ?symbols=weth answers under WETH; no symbols → {}.',
  },
  async () => {
    const q = await quotes('BTC,ETH,WETH,USDC,USDT0,SOL,NVDAx,NOPE');
    must(JSON.stringify(Object.keys(q).sort()) === JSON.stringify(['BTC', 'ETH', 'SOL', 'USDC', 'USDT0', 'WETH']), `keys ${Object.keys(q)}`);
    for (const [k, v] of Object.entries(q)) must(v.price > 0 && isNum(v.change24h) && v.source === 'coingecko', `${k}: ${clip(v)}`);
    must(q.USDC.price >= 0.98 && q.USDC.price <= 1.02, `USDC ${q.USDC.price}`);
    must(Math.abs(q.WETH.price / q.ETH.price - 1) < 0.01, `WETH ${q.WETH.price} vs ETH ${q.ETH.price}`);
    must(q.USDT0.price >= 0.98 && q.USDT0.price <= 1.02, `USDT0 ${q.USDT0.price}`);
    const lowerCase = await quotes('weth');
    must(lowerCase.WETH?.price > 0, `?symbols=weth → ${clip(lowerCase)}`);
    const none = await quotes('');
    must(JSON.stringify(none) === '{}', `no symbols → ${clip(none)}`);
    return `BTC $${q.BTC.price}, ETH $${q.ETH.price}, USDC $${q.USDC.price}`;
  },
);

check(
  {
    method: 'GET',
    path: '/market/sparklines',
    auth: 'public',
    kind: 'contract',
    correct:
      'Public; as the market list asks (?symbols=BTC,ETH,WETH,USDT0,NVDAx): 200 {SYMBOL: 2–24 positive closes}; keys are among the symbols with a feed (NVDAx never; a symbol still warming is absent, never an empty series); BTC and ETH are present; each series ends within 5% of /market/quotes; no symbols → {}.',
  },
  async () => {
    const r = await get('/market/sparklines?symbols=BTC,ETH,WETH,USDT0,NVDAx', { auth: false });
    expectStatus(r, 200, 'GET /market/sparklines');
    const s = r.json;
    const q = await quotes('BTC,ETH,WETH,USDT0');
    for (const [k, v] of Object.entries(s)) {
      must(['BTC', 'ETH', 'WETH', 'USDT0'].includes(k), `unexpected key ${k}`);
      must(Array.isArray(v) && v.length >= 2 && v.length <= 24 && v.every((n) => isNum(n) && n > 0), `${k}: ${clip(v)}`);
      must(Math.abs(v.at(-1) / q[k].price - 1) < 0.05, `${k}: ends at ${v.at(-1)}, spot ${q[k].price}`);
    }
    must(s.BTC && s.ETH, `BTC/ETH missing: keys ${Object.keys(s)}`);
    const none = await get('/market/sparklines?symbols=', { auth: false });
    must(none.status === 200 && JSON.stringify(none.json) === '{}', `no symbols → ${show(none)}`);
    return Object.entries(s).map(([k, v]) => `${k}:${v.length}`).join(' ');
  },
);

/** The wrapped xStocks on X Layer, in the order server/src/venues/stocks.ts lists them. */
const EQUITIES = ['TSLAx', 'QQQx', 'GOOGLx', 'COINx', 'SPYx', 'NVDAx', 'AAPLx', 'MSFTx', 'METAx', 'MSTRx', 'AMZNx'];

check(
  {
    method: 'GET',
    path: '/market/stocks',
    auth: 'public',
    kind: 'contract',
    correct:
      'Public. 200: the eleven wrapped xStocks in registry order TSLAx, QQQx, GOOGLx, COINx, SPYx, NVDAx, AAPLx, MSFTx, METAx, MSTRx, AMZNx, each {symbol, name, address (an ERC-4626 wrapper on X Layer), price, venues, feed}; feed "live" ⇒ price in (1, 10000) and at least one venue (uniswap-v3 / okx-dex); "unavailable" ⇒ price null and venues []. On mainnet state all eleven are live — priced from a real $1,000 Uniswap v3 quote on X Layer.',
  },
  async () => {
    const r = await get('/market/stocks', { auth: false });
    expectStatus(r, 200, 'GET /market/stocks');
    must(Array.isArray(r.json) && JSON.stringify(r.json.map((s) => s.symbol)) === JSON.stringify(EQUITIES), `symbols ${clip(r.json?.map?.((s) => s.symbol))}`);
    const dead = [];
    for (const s of r.json) {
      must(typeof s.name === 'string' && s.name && ADDRESS.test(s.address), `${s.symbol}: name/address ${s.name} ${s.address}`);
      if (s.feed === 'live') must(s.price > 1 && s.price < 10_000 && s.venues.length > 0, `${s.symbol}: live at ${s.price} via ${clip(s.venues)}`);
      else {
        must(s.feed === 'unavailable' && s.price === null && s.venues.length === 0, `${s.symbol}: ${clip(s)}`);
        dead.push(s.symbol);
      }
    }
    if (ctx.mainnetState) must(dead.length === 0, `unavailable: ${dead.join(', ')}`);
    return r.json.map((s) => `${s.symbol} ${s.price === null ? 'unpriced' : `$${s.price.toFixed(2)}`}`).join(', ');
  },
);

check(
  {
    method: 'GET',
    path: '/market/stocks/history',
    auth: 'public',
    kind: 'contract',
    correct:
      'Public; as the app asks (?symbol=NVDAx&hours=720): 200 {symbol "NVDAx", points: [{at ascending, usd > 0}] all within the last 720 hours, observedSince = points[0].at (null when empty), note = "<n> readings since <first ISO>." or the no-readings sentence}.',
  },
  async () => {
    const r = await get('/market/stocks/history?symbol=NVDAx&hours=720', { auth: false });
    expectStatus(r, 200, '?symbol=NVDAx&hours=720');
    const h = r.json;
    must(h.symbol === 'NVDAx' && Array.isArray(h.points), `answer ${clip(r.text)}`);
    let prev = 0;
    for (const p of h.points) {
      must(isMs(p.at) && p.at > Date.now() - 720 * 3_600_000 - 120_000 && p.usd > 0, `point ${clip(p)}`);
      must(p.at >= prev, 'points not ascending');
      prev = p.at;
    }
    if (h.points.length === 0) {
      must(h.observedSince === null && /No readings yet/.test(h.note), `empty series: ${clip(h)}`);
      return 'no readings yet';
    }
    must(h.observedSince === h.points[0].at, `observedSince ${h.observedSince}`);
    must(h.note === `${h.points.length} readings since ${new Date(h.points[0].at).toISOString()}.`, `note "${h.note}"`);
    return `${h.points.length} readings since ${new Date(h.points[0].at).toISOString()}`;
  },
);

check(
  {
    method: 'GET',
    path: '/market/stocks/history',
    auth: 'public',
    kind: 'validation',
    correct: 'Bad parameters get a named 400, never an empty "No readings yet" or a sentence with a hole: no ?symbol → 400 named; ?symbol=NVDAx&hours=abc → 400 named.',
  },
  async () => {
    const none = await get('/market/stocks/history', { auth: false });
    const hours = await get('/market/stocks/history?symbol=NVDAx&hours=abc', { auth: false });
    const problems = [];
    if (none.status !== 400 || !named(none)) problems.push(`no ?symbol → ${show(none)}`);
    if (hours.status !== 400 || !named(hours)) problems.push(`hours=abc → ${show(hours)}`);
    must(problems.length === 0, problems.join('; '));
    return `400 ${named(none)}; 400 ${named(hours)}`;
  },
);

const FEEDS = ['BTC', 'ETH', 'SOL', 'XRP', 'DOGE', 'HYPE', 'AAVE', 'LINK', 'TON', 'XAUT', 'PAXG', 'WETH', 'USDC', 'USDT0', 'CBBTC'];

check(
  {
    method: 'GET',
    path: '/market/symbols',
    auth: 'public',
    kind: 'contract',
    correct: 'Public. 200: exactly the feed table (server/src/market/ids.ts) BTC, ETH, SOL, XRP, DOGE, HYPE, AAVE, LINK, TON, XAUT, PAXG, WETH, USDC, USDT0, CBBTC — no duplicates — and every one prices in /market/quotes.',
  },
  async () => {
    const r = await get('/market/symbols', { auth: false });
    expectStatus(r, 200, 'GET /market/symbols');
    must(JSON.stringify(r.json) === JSON.stringify(FEEDS), `symbols ${clip(r.json)}`);
    const q = await quotes(r.json.join(','));
    const unpriced = r.json.filter((s) => !(q[s]?.price > 0));
    must(unpriced.length === 0, `no price for ${unpriced.join(', ')}`);
    return `${r.json.length} feeds, all priced`;
  },
);

/**
 * The token registry (server/src/venues/tokens.ts) in its own order, at X Layer mainnet addresses — prices are a mainnet
 * question — with USDC at this chain's own Circle deployment. The xStocks follow wherever they function (mainnet state).
 */
const REGISTRY = [
  ['USDC', null, 6],
  ['USDG', '0x4ae46a509F6b1D9056937BA4500cb143933D2dc8', 6],
  ['USDT0', USDT0, 6],
  ['XBTC', '0xb7C00000bcDEeF966b20B3D884B98E64d2b06b4f', 8],
  ['WOKB', '0xe538905cf8410324e03A5A23C1c177a474D59b2b', 18],
  ['WETH', '0x5A77f1443D16ee5761d310e38b62f77f726bC71c', 18],
];

function watchableRows(rows, what) {
  must(Array.isArray(rows) && rows.length >= REGISTRY.length, `${what}: ${clip(rows)}`);
  REGISTRY.forEach(([symbol, address, decimals], i) => {
    const at = address ?? ctx.usdc;
    must(rows[i].symbol === symbol && sameAddr(rows[i].address, at) && rows[i].decimals === decimals, `${what}: row ${i} ${clip(rows[i])}, expected ${symbol} ${at} ${decimals}`);
  });
  const stocks = rows.slice(REGISTRY.length).map((r) => r.symbol);
  if (ctx.mainnetState) must(JSON.stringify(stocks) === JSON.stringify(EQUITIES), `${what}: xStocks ${clip(stocks)}, expected ${EQUITIES.join(', ')}`);
  else must(stocks.length === 0, `${what}: xStocks offered on ${ctx.chain}, where none has code: ${clip(stocks)}`);
}

check(
  {
    method: 'GET',
    path: '/market/tradable',
    auth: 'public',
    kind: 'contract',
    correct:
      'Public. Mainnet state (xlayer, xlayer-fork — fills settle): the token registry\'s routable symbols (watchable\'s rows less WETH, which no X Layer pool routes) at X Layer\'s addresses with their decimals — exactly the app\'s TRADABLE list (src/data/tradable.ts). xlayer-testnet: [] (no DEX routes there).',
  },
  async () => {
    const r = await get('/market/tradable', { auth: false });
    expectStatus(r, 200, 'GET /market/tradable');
    if (!ctx.mainnetState) {
      must(Array.isArray(r.json) && r.json.length === 0, `${ctx.chain} offers ${clip(r.json)}`);
      return '[]';
    }
    const watch = (await get('/market/watchable', { auth: false })).json;
    must(JSON.stringify(watch.filter((t) => t.symbol !== 'WETH')) === JSON.stringify(r.json), `tradable ${clip(r.json.map((t) => t.symbol))} is not watchable less WETH`);
    const app = appList('../src/data/tradable.ts', /^\s*'([A-Za-z0-9]+)',\s*$/gm);
    if (app) {
      // Routable symbols only: WETH is in the registry (held and shown) but no X Layer pool routes it, so the app's
      // TRADABLE leaves it out — and a tradable list that offers it promises a buy no signed transaction can fill.
      const served = r.json.map((t) => t.symbol);
      must(JSON.stringify([...app].sort()) === JSON.stringify([...served].sort()), `app TRADABLE ${clip(app)} vs served ${clip(served)}`);
    }
    return r.json.map((t) => t.symbol).join(', ');
  },
);

check(
  {
    method: 'GET',
    path: '/market/watchable',
    auth: 'public',
    kind: 'contract',
    correct:
      'Public. The token registry USDC (this chain\'s Circle USDC: 0xB6CE…3061 on mainnet state, 0xDec9…B9B3 on the testnet), USDG 0x4ae4…2dc8, USDT0 0x779D…3736, XBTC 0xb7C0…6b4f (8 decimals), WOKB 0xe538…2b2b, WETH 0x5A77…C71c — then the eleven xStocks where they function (mainnet state) and none elsewhere.',
  },
  async () => {
    const r = await get('/market/watchable', { auth: false });
    expectStatus(r, 200, 'GET /market/watchable');
    watchableRows(r.json, 'watchable');
    return r.json.map((t) => `${t.symbol} ${t.address.slice(0, 8)}…`).join(', ');
  },
);

/* ───────────────────────────────────────────────────────────── /metrics, /notifications, /notify, /ops */

check(
  {
    method: 'GET',
    path: '/metrics',
    auth: 'public',
    kind: 'contract',
    correct:
      'Public. 200 {runs: {status: count}, runFailureRate = failed / (filled + failed) (0 when neither), failuresByCause: keys among price_moved, permission_revoked, permission_expired, daily_cap, venue_not_allowed, wrong_delegate, venue_could_not_fill, upstream_unreachable, other, totalling ≤ runs.failed, fillsByVenue summing to runs.filled (±1 for a fill landing between the reads), fillQuality: {venues, measured, unmeasurable, basis} | null, strategies: {state: count}, alertsEnabled ≥ 0, alertsFiredTotal ≥ 0, spentTodayUsd ≥ 0, gas: {eth (the delegate\'s OKB, under its historical name) > 0, enough = eth ≥ floor, floor 0.01, address = /delegation/params delegate}, uptimeSec}; fillsByVenue keys are among uniswap-v3, okx-dex, aave (or "unrecorded"); at most one run pending.',
  },
  async () => {
    const r = await get('/metrics', { auth: false });
    expectStatus(r, 200, 'GET /metrics');
    const m = r.json;
    const filled = m.runs.filled ?? 0;
    const failed = m.runs.failed ?? 0;
    must(near(m.runFailureRate, filled + failed > 0 ? failed / (filled + failed) : 0, 1e-12), `runFailureRate ${m.runFailureRate} for ${failed}/${filled + failed}`);
    const causes = ['price_moved', 'permission_revoked', 'permission_expired', 'daily_cap', 'venue_not_allowed', 'wrong_delegate', 'venue_could_not_fill', 'upstream_unreachable', 'other'];
    must(Object.keys(m.failuresByCause).every((k) => causes.includes(k)), `unknown cause ${clip(Object.keys(m.failuresByCause))}`);
    must(Object.values(m.failuresByCause).reduce((a, b) => a + b, 0) <= failed, `causes ${clip(m.failuresByCause)} exceed ${failed} failed`);
    const venues = Object.values(m.fillsByVenue).reduce((a, b) => a + b, 0);
    must(Math.abs(venues - filled) <= 1, `fillsByVenue total ${venues} vs ${filled} filled`);
    must(Object.keys(m.fillsByVenue).every((k) => [...VENUES, 'unrecorded'].includes(k)), `a venue X Layer does not settle on: ${clip(Object.keys(m.fillsByVenue))}`);
    must(m.fillQuality === null || (Array.isArray(m.fillQuality.venues) && ['same-chain', 'forked'].includes(m.fillQuality.basis)), `fillQuality ${clip(m.fillQuality)}`);
    must(Number.isInteger(m.alertsEnabled) && m.alertsEnabled >= 0 && m.alertsFiredTotal >= 0 && m.spentTodayUsd >= 0, `alerts/spend ${m.alertsEnabled}/${m.alertsFiredTotal}/${m.spentTodayUsd}`);
    must(m.gas && m.gas.eth > 0 && m.gas.floor === 0.01 && m.gas.enough === m.gas.eth >= m.gas.floor && sameAddr(m.gas.address, ctx.params.delegate), `gas ${clip(m.gas)}`);
    must((m.runs.pending ?? 0) <= 1, `${m.runs.pending} runs stuck pending`);
    return `runs ${clip(m.runs, 100)}; failure rate ${(m.runFailureRate * 100).toFixed(1)}%; gas ${m.gas.eth.toFixed(4)} OKB`;
  },
);

const PUSH_KINDS = ['dca-executed', 'strategy-blocked', 'alert-fired', 'panic-flatten', 'proposal-awaiting'];

check(
  {
    method: 'GET',
    path: '/notifications/prefs',
    auth: 'user',
    kind: 'contract',
    correct: '200: exactly the five push kinds in order dca-executed, strategy-blocked, alert-fired, panic-flatten, proposal-awaiting, each {kind, label, detail, enabled: bool}.',
  },
  async () => {
    const r = await get('/notifications/prefs');
    expectStatus(r, 200, 'GET /notifications/prefs');
    must(JSON.stringify(r.json.map((p) => p.kind)) === JSON.stringify(PUSH_KINDS), `kinds ${clip(r.json.map((p) => p.kind))}`);
    for (const p of r.json) must(typeof p.label === 'string' && p.label && typeof p.detail === 'string' && typeof p.enabled === 'boolean', `pref ${clip(p)}`);
    return r.json.map((p) => `${p.kind}:${p.enabled ? 'on' : 'off'}`).join(', ');
  },
);
unauthorized('GET', '/notifications/prefs');

check(
  {
    method: 'POST',
    path: '/notifications/prefs',
    auth: 'user',
    kind: 'contract',
    correct:
      'Reversible happy path: flipping proposal-awaiting → 200 {ok:true, kind, enabled} and GET /notifications/prefs shows it; setting it back restores the original. {kind:"nope", enabled:true} → 400 invalid_request; {kind:"dca-executed"} without enabled → 400 invalid_request.',
  },
  async () => {
    expectRefusal(await post('/notifications/prefs', { kind: 'nope', enabled: true }), 400, 'invalid_request', 'kind "nope"');
    expectRefusal(await post('/notifications/prefs', { kind: 'dca-executed' }), 400, 'invalid_request', 'no enabled');
    const original = (await get('/notifications/prefs')).json.find((p) => p.kind === 'proposal-awaiting').enabled;
    try {
      const flipped = await post('/notifications/prefs', { kind: 'proposal-awaiting', enabled: !original });
      expectStatus(flipped, 200, 'flip proposal-awaiting');
      must(flipped.json.ok === true && flipped.json.kind === 'proposal-awaiting' && flipped.json.enabled === !original, `answer ${clip(flipped.text)}`);
      must((await get('/notifications/prefs')).json.find((p) => p.kind === 'proposal-awaiting').enabled === !original, 'GET does not show the flip');
    } finally {
      await post('/notifications/prefs', { kind: 'proposal-awaiting', enabled: original });
    }
    must((await get('/notifications/prefs')).json.find((p) => p.kind === 'proposal-awaiting').enabled === original, 'not restored');
    return `proposal-awaiting ${original} → ${!original} → ${original}; bad bodies 400`;
  },
);
unauthorized('POST', '/notifications/prefs', { body: { kind: 'dca-executed', enabled: true } });

unauthorized('POST', '/notify/test', { body: {}, extra: 'Happy path not executed: it sends a push to the account\'s devices.' });

operatorOnly('GET', '/ops/mirror');
operatorOnly('POST', '/ops/mirror', {});

/* ───────────────────────────────────────────────────────────── /orders, /panic, /perp, /pnl */

check(
  {
    method: 'POST',
    path: '/orders',
    auth: 'user',
    kind: 'validation',
    correct:
      'Refused before anything is placed: {symbol:"XBTC", usd:-5} → 400 invalid_request; {usd:10} without a symbol → 400 invalid_request; a 13-character symbol → 400 invalid_request; malformed JSON → 400 invalid_json. Happy path not executed: it places a market order.',
  },
  async () => {
    expectRefusal(await post('/orders', { symbol: 'XBTC', usd: -5 }, { retry: false }), 400, 'invalid_request', 'usd -5');
    expectRefusal(await post('/orders', { usd: 10 }, { retry: false }), 400, 'invalid_request', 'no symbol');
    expectRefusal(await post('/orders', { symbol: 'ABCDEFGHIJKLM', usd: 10 }, { retry: false }), 400, 'invalid_request', '13-character symbol');
    expectRefusal(await http('POST', '/orders', { raw: '{"symbol":', retry: false }), 400, 'invalid_json', 'malformed JSON');
    return '400 invalid_request ×3, 400 invalid_json';
  },
);
unauthorized('POST', '/orders', { body: { symbol: 'XBTC', usd: 1 } });

unauthorized('POST', '/panic/flatten', {
  extra: 'Happy path not executed: it sells every holding — with a live permission an authenticated call sells, so no token-bearing request is sent at all.',
});

check(
  {
    method: 'GET',
    path: '/panic/preview',
    auth: 'user',
    kind: 'contract',
    correct:
      '200 {legs: [{symbol, units > 0, usd ≥ 1}], totalUsd = Σ legs.usd, dustBelowUsd 1, slippagePct 2, skipped: symbols held below $1}; USDC and native OKB are never legs; each leg\'s units equal /wallet/balance holdings for that symbol.',
  },
  async () => {
    const r = await get('/panic/preview');
    const balance = (await get('/wallet/balance')).json;
    expectStatus(r, 200, 'GET /panic/preview');
    const p = r.json;
    must(p.dustBelowUsd === 1 && p.slippagePct === 2 && Array.isArray(p.legs) && Array.isArray(p.skipped), `shape ${clip(p)}`);
    must(near(p.totalUsd, p.legs.reduce((a, l) => a + l.usd, 0), 1e-6), `totalUsd ${p.totalUsd} ≠ Σ legs`);
    for (const l of p.legs) {
      must(l.units > 0 && l.usd >= 1 && !['USDC', 'OKB'].includes(l.symbol), `leg ${clip(l)}`);
      const held = balance.holdings.find((h) => h.symbol === l.symbol);
      must(held && near(held.units, l.units, 1e-12, 1e-9), `${l.symbol}: preview ${l.units} vs balance ${held?.units}`);
    }
    return p.legs.length ? `${p.legs.map((l) => `${l.symbol} $${l.usd.toFixed(2)}`).join(', ')}; total $${p.totalUsd.toFixed(2)}` : 'nothing to sell';
  },
);
unauthorized('GET', '/panic/preview');

check(
  {
    method: 'GET',
    path: '/perp/:symbol',
    auth: 'public',
    kind: 'contract',
    correct:
      'Public; as the futures screen asks (/perp/BTC): 200 {symbol "BTC", markPx > 0, oraclePx > 0, markVsIndex = markPx − oraclePx, change24hPct: number|null, openInterestUsd ≥ 0, dayVolumeUsd ≥ 0, fundingRate finite, fundingIntervalHours 1, maxLeverage ≥ 1, nextFundingSeconds in [0, 3600], nextFundingAt on the next whole hour, venue "Hyperliquid", feed "live"}. /perp/WETH answers for ETH, its underlying; /perp/xbtc (OKX\'s wrapped BTC on X Layer) for BTC.',
  },
  async () => {
    const r = await get('/perp/BTC', { auth: false });
    expectStatus(r, 200, '/perp/BTC');
    const m = r.json;
    must(m.symbol === 'BTC' && m.markPx > 0 && m.oraclePx > 0 && near(m.markVsIndex, m.markPx - m.oraclePx, 1e-6), `mark ${clip(m)}`);
    must((m.change24hPct === null || isNum(m.change24hPct)) && m.openInterestUsd >= 0 && m.dayVolumeUsd >= 0 && isNum(m.fundingRate), `metrics ${clip(m)}`);
    must(m.fundingIntervalHours === 1 && m.maxLeverage >= 1 && m.venue === 'Hyperliquid' && m.feed === 'live', `venue fields ${clip(m)}`);
    must(m.nextFundingSeconds >= 0 && m.nextFundingSeconds <= 3600 && m.nextFundingAt % 3_600_000 === 0 && m.nextFundingAt > Date.now() - 60_000 && m.nextFundingAt <= Date.now() + 3_660_000, `funding clock ${m.nextFundingSeconds}s / ${m.nextFundingAt}`);
    const weth = await get('/perp/WETH', { auth: false });
    must(weth.status === 200 && weth.json.symbol === 'ETH', `/perp/WETH → ${show(weth)}`);
    const xbtc = await get('/perp/xbtc', { auth: false });
    must(xbtc.status === 200 && xbtc.json.symbol === 'BTC', `/perp/xbtc → ${show(xbtc)}`);
    return `BTC mark ${m.markPx}, funding ${m.fundingRate}; WETH→ETH, xbtc→BTC`;
  },
);

check(
  {
    method: 'GET',
    path: '/perp/:symbol',
    auth: 'public',
    kind: 'validation',
    correct: 'No contract for the symbol → 404 {error:"no_feed", detail}: /perp/NOPE, and /perp/NVDAx (a tokenized equity has no perpetual).',
  },
  async () => {
    expectRefusal(await get('/perp/NOPE', { auth: false }), 404, 'no_feed', '/perp/NOPE');
    expectRefusal(await get('/perp/NVDAx', { auth: false }), 404, 'no_feed', '/perp/NVDAx');
    return '404 no_feed ×2';
  },
);

const CANDLES = { '1D': ['1h', 3_600_000, 24], '1W': ['4h', 14_400_000, 42], '1M': ['1d', 86_400_000, 30], '1Y': ['1w', 604_800_000, 52] };

check(
  {
    method: 'GET',
    path: '/perp/:symbol/candles',
    auth: 'public',
    kind: 'contract',
    correct:
      'Public; as the futures screen asks (?range=1D, ?range=1W): 200 {symbol, range echoed, interval (1D → 1h, 1W → 4h), times ascending, at most 24 / 42, consecutive times a whole number of intervals apart, bars: same length, [open, high, low, close] with high ≥ max(open, close) and 0 < low ≤ min(open, close)}.',
  },
  async () => {
    const out = [];
    for (const range of ['1D', '1W']) {
      const [interval, step, count] = CANDLES[range];
      const r = await get(`/perp/BTC/candles?range=${range}`, { auth: false });
      expectStatus(r, 200, `?range=${range}`);
      const c = r.json;
      must(c.symbol === 'BTC' && c.range === range && c.interval === interval, `${range}: header ${clip({ symbol: c.symbol, range: c.range, interval: c.interval })}`);
      must(Array.isArray(c.times) && c.times.length > 0 && c.times.length <= count && c.bars.length === c.times.length, `${range}: ${c.times?.length} times, ${c.bars?.length} bars`);
      c.times.forEach((t, i) => {
        if (i > 0) must(t > c.times[i - 1] && (t - c.times[i - 1]) % step === 0, `${range}: time gap at ${i}`);
        const [o, h, l, cl] = c.bars[i];
        must([o, h, l, cl].every(isNum) && h >= Math.max(o, cl) - 1e-9 && l <= Math.min(o, cl) + 1e-9 && l > 0, `${range}: bar ${clip(c.bars[i])}`);
      });
      out.push(`${range}: ${c.bars.length}×${interval}`);
    }
    return out.join('; ');
  },
);

check(
  {
    method: 'GET',
    path: '/perp/:symbol/candles',
    auth: 'public',
    kind: 'validation',
    correct: '?range=5Y → 400 {error:"bad_range", detail}; /perp/NOPE/candles → 404 {error:"no_feed"}.',
  },
  async () => {
    expectRefusal(await get('/perp/BTC/candles?range=5Y', { auth: false }), 400, 'bad_range', '?range=5Y');
    expectRefusal(await get('/perp/NOPE/candles?range=1D', { auth: false }), 404, 'no_feed', '/perp/NOPE/candles');
    return '400 bad_range; 404 no_feed';
  },
);

check(
  {
    method: 'GET',
    path: '/pnl/disposals.csv',
    auth: 'user',
    kind: 'contract',
    correct:
      '200 text/csv, attachment filename "xorr-disposals.csv"; header exactly date,symbol,units,proceeds_usd,cost_basis_usd,gain_loss_usd,basis_method,basis_known; each data row has 8 fields — ISO date (ascending), basis_method "average_cost", basis_known yes|no; the last line is the total row ",,,,,<total>,," with total = Σ gain_loss_usd to a cent.',
  },
  async () => {
    const r = await get('/pnl/disposals.csv');
    expectStatus(r, 200, 'GET /pnl/disposals.csv');
    must(/text\/csv/.test(r.headers.get('content-type') ?? '') && /filename="xorr-disposals\.csv"/.test(r.headers.get('content-disposition') ?? ''), `headers ${r.headers.get('content-type')} / ${r.headers.get('content-disposition')}`);
    const lines = r.text.split('\n');
    must(lines[0] === 'date,symbol,units,proceeds_usd,cost_basis_usd,gain_loss_usd,basis_method,basis_known', `header ${clip(lines[0])}`);
    const total = lines.at(-1);
    must(/^,,,,,-?\d+\.\d{2},,$/.test(total), `total row ${clip(total)}`);
    const rows = lines.slice(1, -1);
    let sum = 0;
    let prev = 0;
    for (const line of rows) {
      const f = line.split(',');
      must(f.length === 8 && isIso(f[0]) && f[6] === 'average_cost' && ['yes', 'no'].includes(f[7]), `row ${clip(line)}`);
      must(Date.parse(f[0]) >= prev, `dates not ascending at ${f[0]}`);
      prev = Date.parse(f[0]);
      sum += Number(f[5]);
    }
    must(near(Number(total.split(',')[5]), sum, 0.011), `total ${total.split(',')[5]} vs Σ ${sum.toFixed(2)}`);
    return `${rows.length} disposal row(s), total ${total.split(',')[5]}`;
  },
);
unauthorized('GET', '/pnl/disposals.csv');

check(
  {
    method: 'GET',
    path: '/pnl/realised',
    auth: 'user',
    kind: 'contract',
    correct: '200 {total = Σ bySymbol.realised, bySymbol: [{symbol (unique), realised, unitsSold > 0, proceeds ≥ 0, basisIncomplete: bool}] largest realised first}.',
  },
  async () => {
    const r = await get('/pnl/realised');
    expectStatus(r, 200, 'GET /pnl/realised');
    const p = r.json;
    must(Array.isArray(p.bySymbol) && near(p.total, p.bySymbol.reduce((a, s) => a + s.realised, 0), 1e-6), `total ${p.total} ≠ Σ ${clip(p.bySymbol)}`);
    must(new Set(p.bySymbol.map((s) => s.symbol)).size === p.bySymbol.length, 'duplicate symbols');
    p.bySymbol.forEach((s, i) => {
      must(isNum(s.realised) && s.unitsSold > 0 && s.proceeds >= 0 && typeof s.basisIncomplete === 'boolean', `row ${clip(s)}`);
      if (i > 0) must(s.realised <= p.bySymbol[i - 1].realised, 'not largest first');
    });
    return `total $${p.total.toFixed(2)} over ${p.bySymbol.length} symbol(s)`;
  },
);
unauthorized('GET', '/pnl/realised');

/* ───────────────────────────────────────────────────────────── /portfolio, /positions, /price, /privy */

const RANGE_MS = { '1D': 86_400_000, '1W': 7 * 86_400_000, '1M': 30 * 86_400_000, ALL: Number.POSITIVE_INFINITY };

check(
  {
    method: 'GET',
    path: '/portfolio/history',
    auth: 'user',
    kind: 'contract',
    correct:
      'As the app asks (?range=1D|1W|1M|ALL, src/data/system.ts:497): 200 {range echoed, chain, everyMinutes 15, points: ≤ 500 {at ascending, totalUsd ≥ 0, reason ∈ interval|fill|close|withdrawal}}, every point inside its range; a longer range never has fewer points than a shorter one (unless thinned to 500); ?range=1w answers as 1W.',
  },
  async () => {
    const counts = {};
    for (const range of ['1D', '1W', '1M', 'ALL']) {
      const r = await get(`/portfolio/history?range=${range}`);
      expectStatus(r, 200, `?range=${range}`);
      const h = r.json;
      must(h.range === range && h.chain === ctx.chain && h.everyMinutes === 15 && Array.isArray(h.points) && h.points.length <= 500, `${range}: ${clip({ ...h, points: h.points?.length })}`);
      let prev = 0;
      for (const p of h.points) {
        must(isMs(p.at) && p.at >= prev && p.totalUsd >= 0 && ['interval', 'fill', 'close', 'withdrawal'].includes(p.reason), `${range}: point ${clip(p)}`);
        must(p.at >= Date.now() - RANGE_MS[range] - 120_000, `${range}: point at ${new Date(p.at).toISOString()} outside the range`);
        prev = p.at;
      }
      counts[range] = h.points.length;
    }
    const order = ['1D', '1W', '1M', 'ALL'];
    for (let i = 1; i < order.length; i += 1) {
      if (counts[order[i]] < 500) must(counts[order[i]] >= counts[order[i - 1]], `${order[i]} has ${counts[order[i]]} points, fewer than ${order[i - 1]}'s ${counts[order[i - 1]]}`);
    }
    const lowerCase = await get('/portfolio/history?range=1w');
    must(lowerCase.status === 200 && lowerCase.json.range === '1W', `?range=1w → ${show(lowerCase)}`);
    return order.map((r) => `${r}:${counts[r]}`).join(' ');
  },
);

check(
  {
    method: 'GET',
    path: '/portfolio/history',
    auth: 'user',
    kind: 'validation',
    correct: '?range=7d → 400 {error:"invalid_range", message}.',
  },
  async () => {
    const r = await get('/portfolio/history?range=7d');
    expectRefusal(r, 400, 'invalid_range', '?range=7d');
    return '400 invalid_range';
  },
);
unauthorized('GET', '/portfolio/history');

check(
  {
    method: 'POST',
    path: '/portfolio/snapshot',
    auth: 'user',
    kind: 'validation',
    correct:
      'Refused before anything is read or stored: {txHash:"nothex"} → 400 invalid_request. Happy path not executed: it writes a portfolio snapshot row that nothing can remove.',
  },
  async () => {
    expectRefusal(await post('/portfolio/snapshot', { txHash: 'nothex' }), 400, 'invalid_request', '{txHash:"nothex"}');
    return '400 invalid_request';
  },
);
unauthorized('POST', '/portfolio/snapshot', { body: {} });

function positionShape(p, what) {
  must(typeof p.id === 'string' && typeof p.symbol === 'string' && p.side === 'long' && p.fundingPaid === 0, `${what}: ${clip(p)}`);
  must(p.leverage >= 1 && (p.leverage > 1 || p.liquidation === 0), `${what}: leverage ${p.leverage}, liquidation ${p.liquidation}`);
  must(p.ledgerUnits > 0.000001 && p.units >= 0 && p.units <= p.ledgerUnits + 1e-12, `${what}: units ${p.units} of ledger ${p.ledgerUnits}`);
  if (p.chainUnits !== null) {
    must(near(p.units, Math.min(p.ledgerUnits, p.chainUnits), 1e-12, 1e-9) && near(p.driftUnits, p.ledgerUnits - p.chainUnits, 1e-8), `${what}: units ${p.units}, drift ${p.driftUnits}, chain ${p.chainUnits}`);
  } else {
    must(p.units === p.ledgerUnits && p.driftUnits === null, `${what}: unchecked row units ${p.units}, drift ${p.driftUnits}`);
  }
  must(['live', 'unavailable'].includes(p.feed), `${what}: feed ${p.feed}`);
  if (p.feed === 'unavailable') must(p.mark === 0 && p.unrealised === 0, `${what}: unavailable with mark ${p.mark}`);
  must(near(p.notional, p.units * p.mark, 1e-6, 1e-9), `${what}: notional ${p.notional} ≠ ${p.units} × ${p.mark}`);
  if (p.feed === 'live') must(near(p.unrealised, p.notional - p.entry * p.units, 0.011), `${what}: unrealised ${p.unrealised} ≠ notional − entry × units`);
}

check(
  {
    method: 'GET',
    path: '/positions',
    auth: 'user',
    kind: 'contract',
    correct:
      '200 array of {id (unique), symbol, side "long", leverage ≥ 1 (liquidation 0 at 1), entry, mark, notional = units × mark, margin, unrealised, unrealisedPct, units, ledgerUnits > 0.000001, chainUnits: number|null, driftUnits, fundingPaid 0, feed ∈ live|unavailable, realised, unitsSold}; where the chain was read units = min(ledgerUnits, chainUnits) and driftUnits = ledgerUnits − chainUnits, otherwise units = ledgerUnits and driftUnits null; "unavailable" ⇒ mark 0 and unrealised 0; a live row\'s unrealised = notional − entry × units.',
  },
  async () => {
    const r = await get('/positions');
    expectStatus(r, 200, 'GET /positions');
    must(Array.isArray(r.json) && new Set(r.json.map((p) => p.id)).size === r.json.length, `shape ${clip(r.text)}`);
    r.json.forEach((p) => positionShape(p, `position ${p.symbol}`));
    return r.json.length ? r.json.map((p) => `${p.symbol} ${p.units}${p.driftUnits ? ` (ledger drift ${p.driftUnits})` : ''}`).join(', ') : 'no positions';
  },
);
unauthorized('GET', '/positions');

check(
  {
    method: 'GET',
    path: '/positions/:id',
    auth: 'user',
    kind: 'contract',
    correct:
      'As the app asks (/positions/<an id from /positions>): 200 with the same position as the list (id, symbol, ledgerUnits, entry, units); an id that is not in this wallet\'s book → 404 {error:"not_found", message}.',
  },
  async () => {
    expectRefusal(await get(`/positions/${randomUUID()}`), 404, 'not_found', 'unknown id');
    const list = (await get('/positions')).json;
    if (list.length === 0) return '404 not_found; no position on this account to read back';
    const first = list[0];
    const r = await get(`/positions/${first.id}`);
    expectStatus(r, 200, `/positions/${first.id}`);
    positionShape(r.json, 'single position');
    must(r.json.id === first.id && r.json.symbol === first.symbol && near(r.json.ledgerUnits, first.ledgerUnits, 1e-12) && near(r.json.entry, first.entry, 1e-9) && near(r.json.units, first.units, 1e-12, 1e-9), `differs from the list: ${clip(r.json)} vs ${clip(first)}`);
    return `404 for an unknown id; ${first.symbol} reads back identically`;
  },
);
unauthorized('GET', '/positions/:id');

check(
  {
    method: 'POST',
    path: '/positions/close',
    auth: 'user',
    kind: 'validation',
    correct:
      'Refused before anything is sold: {symbol:"XBTC", fraction:2} → 400 invalid_request; {symbol:"", fraction:1} → 400 invalid_request; {symbol:"XBTC", fraction:0} → 400 invalid_request; malformed JSON → 400 invalid_json. Happy path not executed: it sells a holding.',
  },
  async () => {
    expectRefusal(await post('/positions/close', { symbol: 'XBTC', fraction: 2 }, { retry: false }), 400, 'invalid_request', 'fraction 2');
    expectRefusal(await post('/positions/close', { symbol: '', fraction: 1 }, { retry: false }), 400, 'invalid_request', 'empty symbol');
    expectRefusal(await post('/positions/close', { symbol: 'XBTC', fraction: 0 }, { retry: false }), 400, 'invalid_request', 'fraction 0');
    expectRefusal(await http('POST', '/positions/close', { raw: '{"symbol":', retry: false }), 400, 'invalid_json', 'malformed JSON');
    return '400 invalid_request ×3, 400 invalid_json';
  },
);
unauthorized('POST', '/positions/close', { body: { symbol: 'XBTC', fraction: 1 } });

check(
  {
    method: 'GET',
    path: '/price/:symbol',
    auth: 'user',
    kind: 'contract',
    correct:
      '200 {symbol, price > 0, source}: /price/BTC → source "coingecko", within 2% of /market/quotes BTC; /price/nvdax → symbol "NVDAx" (the registry\'s spelling), source "uniswap-v3" (its X Layer pool), within 2% of /market/stocks NVDAx. Each ask answers inside a screen\'s patience: a price still on its way is 503 warming with a retry-after, which is waited out, and no attempt takes the app\'s 45s.',
  },
  async () => {
    const btc = await get('/price/BTC');
    expectStatus(btc, 200, '/price/BTC');
    must(btc.ms < 45_000, `/price/BTC took ${btc.ms}ms on its last attempt`);
    const q = await quotes('BTC');
    must(btc.json.symbol === 'BTC' && btc.json.source === 'coingecko' && Math.abs(btc.json.price / q.BTC.price - 1) < 0.02, `BTC ${clip(btc.text)} vs spot ${q.BTC.price}`);
    const nvda = await get('/price/nvdax');
    expectStatus(nvda, 200, '/price/nvdax');
    const stock = (await get('/market/stocks', { auth: false })).json.find((s) => s.symbol === 'NVDAx');
    must(nvda.json.symbol === 'NVDAx' && nvda.json.source === 'uniswap-v3' && nvda.json.price > 0, `nvdax ${clip(nvda.text)}`);
    if (stock?.price) must(Math.abs(nvda.json.price / stock.price - 1) < 0.02, `NVDAx ${nvda.json.price} vs /market/stocks ${stock.price}`);
    return `BTC $${btc.json.price}; NVDAx $${nvda.json.price.toFixed(2)}`;
  },
);

check(
  {
    method: 'GET',
    path: '/price/:symbol',
    auth: 'user',
    kind: 'validation',
    correct: 'A symbol nothing prices (/price/NOPE) is the caller\'s mistake: 404 with a named error — not a 502, which tells the app to retry an impossible request.',
  },
  async () => {
    const r = await get('/price/NOPE', { retry: false });
    expectRefusal(r, 404, undefined, '/price/NOPE');
    return `404 ${named(r)}`;
  },
);
unauthorized('GET', '/price/:symbol');

check(
  {
    method: 'GET',
    path: '/privy/policy',
    auth: 'user',
    kind: 'contract',
    correct:
      '200 {enforced: bool, walletId, allowed: [{label, address}] (non-empty when enforced), ownerId, policyId, policyName naming this chain, wouldAllow: non-empty [{label, address, call}] including grant and revoke on this deployment\'s delegation contract and a USDC approval for it, ownedByQuorum: string|null}.',
  },
  async () => {
    const r = await get('/privy/policy');
    expectStatus(r, 200, 'GET /privy/policy');
    const p = r.json;
    must(typeof p.enforced === 'boolean' && Array.isArray(p.allowed) && (!p.enforced || p.allowed.length > 0), `enforced ${p.enforced} with ${p.allowed?.length} allowed`);
    must(typeof p.policyId === 'string' && (p.policyName ?? '').includes(ctx.chain), `policy ${p.policyId} "${p.policyName}"`);
    must(Array.isArray(p.wouldAllow) && p.wouldAllow.length > 0 && p.wouldAllow.every((w) => typeof w.label === 'string' && ADDRESS.test(w.address) && typeof w.call === 'string'), `wouldAllow ${clip(p.wouldAllow)}`);
    const onDelegation = p.wouldAllow.filter((w) => sameAddr(w.address, ctx.health.delegation));
    must(onDelegation.some((w) => /^grant/.test(w.call)) && onDelegation.some((w) => /^revoke/.test(w.call)), `no grant/revoke on ${ctx.health.delegation}`);
    must(p.wouldAllow.some((w) => sameAddr(w.address, ctx.usdc) && /approve/.test(w.call)), `no USDC approval rule for ${ctx.usdc}`);
    must(p.ownedByQuorum === null || typeof p.ownedByQuorum === 'string', `ownedByQuorum ${p.ownedByQuorum}`);
    return `enforced ${p.enforced}; ${p.wouldAllow.length} rules would apply; owned by quorum ${p.ownedByQuorum ? 'yes' : 'no'}`;
  },
);
unauthorized('GET', '/privy/policy');
operatorOnly('POST', '/privy/policy/prove', {});

/* ───────────────────────────────────────────────────────────── /proposals */

/** A proposal that could never place an order: no symbol and no size, so approving it places nothing. */
async function createInertProposal() {
  const r = await post('/proposals', {
    agent: 'qa-full',
    payload: {
      action: 'Nothing to buy',
      status: 'qa-full probe',
      rationale: 'A proposal with no symbol and no size, skipped by the check that made it.',
      onSkip: 'Skipped (qa-full probe).',
    },
    ttlSeconds: 60,
  });
  expectStatus(r, 200, 'POST /proposals');
  must(typeof r.json?.id === 'string' && isMs(r.json.expiresAt), `answer ${clip(r.text)}`);
  return r.json;
}

check(
  {
    method: 'GET',
    path: '/proposals',
    auth: 'user',
    kind: 'contract',
    correct:
      '200 array (≤ 100, newest first) of {id, agent, payload: object, decision ∈ approve|skip|expired|null, decidedAt: ISO|null, expiresAt: ISO, at: ISO}; decision null only while expiresAt is in the future; approve and skip carry decidedAt.',
  },
  async () => {
    const r = await get('/proposals');
    expectStatus(r, 200, 'GET /proposals');
    must(Array.isArray(r.json) && r.json.length <= 100, `shape ${clip(r.text)}`);
    let prev = Number.POSITIVE_INFINITY;
    for (const p of r.json) {
      must(typeof p.id === 'string' && typeof p.agent === 'string' && p.payload && typeof p.payload === 'object' && isIso(p.expiresAt) && isIso(p.at), `row ${clip(p)}`);
      must([null, 'approve', 'skip', 'expired'].includes(p.decision), `decision ${p.decision}`);
      if (p.decision === null) must(Date.parse(p.expiresAt) > Date.now() - 5_000, `undecided but expired: ${p.id}`);
      if (['approve', 'skip'].includes(p.decision)) must(isIso(p.decidedAt), `${p.decision} without decidedAt: ${p.id}`);
      must(Date.parse(p.at) <= prev, 'not newest first');
      prev = Date.parse(p.at);
    }
    return `${r.json.length} proposal(s): ${[...new Set(r.json.map((p) => p.decision))].join(', ')}`;
  },
);
unauthorized('GET', '/proposals');

check(
  {
    method: 'POST',
    path: '/proposals',
    auth: 'user',
    kind: 'contract',
    correct:
      'Reversible happy path: a proposal with no symbol and no size (approving it could place nothing), ttlSeconds 60 → 200 {id, expiresAt ≈ now + 60s}; GET /proposals lists it undecided; it is then skipped. Validation: no payload → 400 invalid_request; ttlSeconds 99999 → 400 invalid_request; a non-string payload value → 400 invalid_request.',
  },
  async () => {
    expectRefusal(await post('/proposals', { agent: 'qa-full' }), 400, 'invalid_request', 'no payload');
    expectRefusal(await post('/proposals', { agent: 'qa-full', payload: { action: 'x' }, ttlSeconds: 99_999 }), 400, 'invalid_request', 'ttlSeconds 99999');
    expectRefusal(await post('/proposals', { agent: 'qa-full', payload: { usd: 5 } }), 400, 'invalid_request', 'numeric payload value');
    const t0 = Date.now();
    const created = await createInertProposal();
    try {
      must(Math.abs(created.expiresAt - (t0 + 60_000)) < 30_000, `expiresAt ${created.expiresAt}, expected ≈ ${t0 + 60_000}`);
      const listed = (await get('/proposals')).json.find((p) => p.id === created.id);
      must(listed && listed.decision === null && listed.agent === 'qa-full', `listed as ${clip(listed)}`);
    } finally {
      await post(`/proposals/${created.id}/decide`, { decision: 'skip' });
    }
    return `created ${created.id}, listed undecided, skipped; bad bodies 400`;
  },
);
unauthorized('POST', '/proposals', { body: { agent: 'qa-full', payload: {} } });

check(
  {
    method: 'POST',
    path: '/proposals/:id/decide',
    auth: 'user',
    kind: 'contract',
    correct:
      'On this wallet\'s undecided proposal {decision:"skip"} → 200 {status:"skip", message: the proposal\'s onSkip}; deciding again → 200 {status:"skip", message:"That was already decided."}; {decision:"maybe"} → 400 invalid_request. Happy path for approve not executed: it places the order a proposal describes.',
  },
  async () => {
    const created = await createInertProposal();
    const skipped = await post(`/proposals/${created.id}/decide`, { decision: 'skip' });
    expectStatus(skipped, 200, 'skip');
    must(skipped.json.status === 'skip' && skipped.json.message === 'Skipped (qa-full probe).', `answer ${clip(skipped.text)}`);
    const again = await post(`/proposals/${created.id}/decide`, { decision: 'skip' });
    must(again.status === 200 && again.json.status === 'skip' && again.json.message === 'That was already decided.', `second decision: ${show(again)}`);
    expectRefusal(await post(`/proposals/${created.id}/decide`, { decision: 'maybe' }), 400, 'invalid_request', '{decision:"maybe"}');
    const row = (await get('/proposals')).json.find((p) => p.id === created.id);
    must(row?.decision === 'skip' && isIso(row.decidedAt), `recorded as ${clip(row)}`);
    return 'skip → onSkip message; repeat → already decided; bad body 400';
  },
);

check(
  {
    method: 'POST',
    path: '/proposals/:id/decide',
    auth: 'user',
    kind: 'refusal',
    correct:
      'An id that is not this wallet\'s proposal (unknown, or another account\'s — the query is scoped to the wallet, so both look the same) → 404 with a named error, for skip and for approve alike, as every other owned resource answers; nothing is decided or placed.',
  },
  async () => {
    const problems = [];
    for (const decision of ['skip', 'approve']) {
      const r = await post(`/proposals/${randomUUID()}/decide`, { decision }, { retry: false });
      if (r.status !== 404 || !named(r)) problems.push(`${decision} on an unknown id → ${show(r)}`);
    }
    must(problems.length === 0, problems.join('; '));
    return '404 for skip and approve';
  },
);
unauthorized('POST', '/proposals/:id/decide', { body: { decision: 'skip' } });

check(
  {
    method: 'GET',
    path: '/proposals/current',
    auth: 'user',
    kind: 'contract',
    correct:
      '200 null, or the newest undecided, unexpired proposal {id, agent, expiresAt > now, …its payload fields}; a proposal created just now is the one returned, and once skipped it no longer is.',
  },
  async () => {
    const before = await get('/proposals/current');
    expectStatus(before, 200, 'GET /proposals/current');
    must(before.json === null || (typeof before.json.id === 'string' && before.json.expiresAt > Date.now() - 5_000), `answer ${clip(before.text)}`);
    const created = await createInertProposal();
    try {
      const now = (await get('/proposals/current')).json;
      must(now?.id === created.id && now.agent === 'qa-full' && now.status === 'qa-full probe' && now.expiresAt === created.expiresAt, `current is ${clip(now)}`);
    } finally {
      await post(`/proposals/${created.id}/decide`, { decision: 'skip' });
    }
    const after = (await get('/proposals/current')).json;
    must(after?.id !== created.id, 'a skipped proposal is still current');
    return `before: ${before.json === null ? 'null' : before.json.id}; a new proposal became current and left once skipped`;
  },
);
unauthorized('GET', '/proposals/current');
unauthorized('POST', '/proposals/generate', {
  body: {},
  extra: 'Happy path not executed: the agent prices the market, may ask the language model, and writes proposals and trail rows.',
});

/* ───────────────────────────────────────────────────────────── /route, /runs, /strategies */

check(
  {
    method: 'GET',
    path: '/route/compare',
    auth: 'user',
    kind: 'contract',
    correct:
      'As the route screen asks (?in=USDC&out=XBTC&amount=500, app/route/[symbol].tsx SIZES[1]): 200 {inSymbol "USDC", outSymbol "XBTC", amount 500, venues: "Uniswap v3" then "OKX DEX" in that order, each {venue, outAmount: number > 0 | null, unavailable: null | a reason} with outAmount null ⇔ unavailable set; best = the venue with the most out (null when none priced); edgeBps = round((best − runner-up) / runner-up × 10^4) when two price, null otherwise}; Uniswap v3 prices on mainnet state, at a rate within 3% of /market/quotes BTC; OKX DEX says why when this deployment has no key.',
  },
  async () => {
    const r = await get('/route/compare?in=USDC&out=XBTC&amount=500');
    expectStatus(r, 200, 'GET /route/compare');
    const c = r.json;
    must(c.inSymbol === 'USDC' && c.outSymbol === 'XBTC' && c.amount === 500, `header ${clip(c)}`);
    must(JSON.stringify(c.venues.map((q) => q.venue)) === '["Uniswap v3","OKX DEX"]', `venues ${clip(c.venues.map((q) => q.venue))}`);
    for (const q of c.venues) {
      if (q.outAmount !== null) must(q.outAmount > 0 && q.unavailable === null, `${q.venue}: ${clip(q)}`);
      else must(typeof q.unavailable === 'string' && q.unavailable.length > 0, `${q.venue}: ${clip(q)}`);
    }
    const priced = c.venues.filter((q) => q.outAmount !== null && q.outAmount > 0).sort((a, b) => b.outAmount - a.outAmount);
    must(c.best === (priced[0]?.venue ?? null), `best ${c.best}, largest out ${priced[0]?.venue}`);
    must(priced.length > 1 ? c.edgeBps === Math.round(((priced[0].outAmount - priced[1].outAmount) / priced[1].outAmount) * 10_000) : c.edgeBps === null, `edgeBps ${c.edgeBps}`);
    const uni = c.venues.find((q) => q.venue === 'Uniswap v3');
    if (ctx.mainnetState) {
      must(uni.outAmount > 0, `Uniswap v3 did not price: ${uni.unavailable}`);
      const q = await quotes('BTC');
      must(Math.abs(500 / uni.outAmount / q.BTC.price - 1) < 0.03, `Uniswap v3 rate ${(500 / uni.outAmount).toFixed(2)} vs BTC spot ${q.BTC.price}`);
    }
    return c.venues.map((x) => `${x.venue}:${x.outAmount === null ? 'no' : x.outAmount.toFixed(6)}`).join(', ') + `; best ${c.best}`;
  },
);

check(
  {
    method: 'GET',
    path: '/route/compare',
    auth: 'user',
    kind: 'validation',
    correct: 'Bad parameters get a named 400, never a 5xx: ?in=NOPE → 400 named; ?amount=abc → 400 named.',
  },
  async () => {
    const problems = [];
    for (const q of ['in=NOPE&out=XBTC&amount=500', 'in=USDC&out=XBTC&amount=abc']) {
      const r = await get(`/route/compare?${q}`, { retry: false });
      if (r.status !== 400 || !named(r)) problems.push(`?${q} → ${show(r)}`);
    }
    must(problems.length === 0, problems.join('; '));
    return '400 named ×2';
  },
);
unauthorized('GET', '/route/compare');

check(
  {
    method: 'GET',
    path: '/runs',
    auth: 'user',
    kind: 'contract',
    correct:
      'As the app asks (?limit=200, and the default of 100): 200 array (≤ limit, newest first) of {id, strategyId, kind, label, symbol, status ∈ pending|filled|failed|blocked|skipped, usd/units/price: number|null, signature: string|null, error: string|null, at: ISO, finishedAt: ISO|null, venue: string|null, side ∈ buy|sell|supply|null (supply is an Aave deposit)}; a filled run carries its transaction; every strategyId is one of this wallet\'s strategies.',
  },
  async () => {
    const r = await get('/runs?limit=200');
    expectStatus(r, 200, '?limit=200');
    const strategies = new Set((await get('/strategies')).json.map((s) => s.id));
    must(Array.isArray(r.json) && r.json.length <= 200, `shape ${clip(r.text)}`);
    let prev = Number.POSITIVE_INFINITY;
    for (const run of r.json) {
      must(['pending', 'filled', 'failed', 'blocked', 'skipped'].includes(run.status) && isIso(run.at), `run ${clip(run)}`);
      must([run.usd, run.units, run.price].every((v) => v === null || isNum(v)) && [null, 'buy', 'sell', 'supply'].includes(run.side), `run numbers ${clip(run)}`);
      must(run.finishedAt === null || isIso(run.finishedAt), `finishedAt ${run.finishedAt}`);
      if (run.status === 'filled') must(TX.test(run.signature ?? ''), `filled run ${run.id} has no transaction`);
      must(strategies.has(run.strategyId), `run ${run.id} belongs to strategy ${run.strategyId}, not one of this wallet's`);
      must(Date.parse(run.at) <= prev, 'not newest first');
      prev = Date.parse(run.at);
    }
    const dflt = await get('/runs');
    must(dflt.status === 200 && dflt.json.length <= 100, `default limit gave ${dflt.json?.length}`);
    return `${r.json.length} run(s): ${Object.entries(r.json.reduce((a, x) => ({ ...a, [x.status]: (a[x.status] ?? 0) + 1 }), {})).map(([k, v]) => `${v} ${k}`).join(', ')}`;
  },
);

check(
  {
    method: 'GET',
    path: '/runs',
    auth: 'user',
    kind: 'validation',
    correct: '?limit=abc → 400 with a named error (as /history answers bad_limit), never a 500.',
  },
  async () => {
    const r = await get('/runs?limit=abc', { retry: false });
    expectRefusal(r, 400, undefined, '?limit=abc');
    return `400 ${named(r)}`;
  },
);
unauthorized('GET', '/runs');

check(
  {
    method: 'GET',
    path: '/strategies',
    auth: 'user',
    kind: 'contract',
    correct:
      '200 array of {id (unique), kind, state ∈ draft|watch|live|paused|ended, label, symbol, params: object, cadence?: daily|weekly|biweekly|monthly, nextRunAt?: ms, dailyAllocationUsd ≥ 0, createdAt}; an ended strategy has no nextRunAt; createdAt is when the strategy was created — no strategy is created after its own runs (checked against /runs).',
  },
  async () => {
    const r = await get('/strategies');
    expectStatus(r, 200, 'GET /strategies');
    must(Array.isArray(r.json) && new Set(r.json.map((s) => s.id)).size === r.json.length, `shape ${clip(r.text, 120)}`);
    const endedWithNext = [];
    for (const s of r.json) {
      must(['draft', 'watch', 'live', 'paused', 'ended'].includes(s.state) && typeof s.kind === 'string' && typeof s.label === 'string' && typeof s.symbol === 'string', `strategy ${clip(s)}`);
      must(s.params && typeof s.params === 'object' && s.dailyAllocationUsd >= 0 && isMs(s.createdAt), `strategy ${s.id}: ${clip(s)}`);
      must(s.cadence === undefined || ['daily', 'weekly', 'biweekly', 'monthly'].includes(s.cadence), `cadence ${s.cadence}`);
      if (s.state === 'ended' && s.nextRunAt !== undefined) endedWithNext.push(s);
    }
    const runs = (await get('/runs?limit=200')).json;
    const created = new Map(r.json.map((s) => [s.id, s.createdAt]));
    const later = runs.filter((run) => created.has(run.strategyId) && created.get(run.strategyId) > Date.parse(run.at) + 1_000);
    const problems = [];
    if (endedWithNext.length > 0) {
      const e = endedWithNext[0];
      problems.push(`${endedWithNext.length} ended strateg${endedWithNext.length === 1 ? 'y still carries' : 'ies still carry'} a nextRunAt — e.g. ${e.kind} "${e.label}" ${e.id}, nextRunAt ${new Date(e.nextRunAt).toISOString()}`);
    }
    if (later.length > 0) {
      problems.push(`${later.length} of ${runs.length} runs predate their strategy's createdAt — e.g. run at ${later[0].at} vs createdAt ${new Date(created.get(later[0].strategyId)).toISOString()}`);
    }
    must(problems.length === 0, problems.join('; '));
    return `${r.json.length} strateg${r.json.length === 1 ? 'y' : 'ies'}: ${Object.entries(r.json.reduce((a, s) => ({ ...a, [s.state]: (a[s.state] ?? 0) + 1 }), {})).map(([k, v]) => `${v} ${k}`).join(', ')}`;
  },
);
unauthorized('GET', '/strategies');

/** A draft recurring buy: never picked up by the scheduler, well inside the cap, ended by the check that made it. */
const draftStrategy = (symbol = 'XBTC') => ({
  kind: 'dca',
  state: 'draft',
  label: `qa-full draft ${Date.now()}`,
  symbol,
  params: { usd: 1 },
  cadence: 'weekly',
  dailyAllocationUsd: 1,
});

async function createDraft(symbol) {
  const body = draftStrategy(symbol);
  const r = await post('/strategies', body);
  expectStatus(r, 200, 'create a draft strategy');
  must(typeof r.json?.id === 'string', `no id: ${clip(r.text)}`);
  return { r, body, id: r.json.id };
}

check(
  {
    method: 'POST',
    path: '/strategies',
    auth: 'user',
    kind: 'contract',
    correct:
      'Reversible happy path: {kind "dca", state "draft", label, symbol "xbtc", params {usd:1}, cadence "weekly", dailyAllocationUsd 1} → 200 {id, kind "dca", state "draft", label, symbol stored under the registry\'s spelling "XBTC" (the handler\'s own rule: a client\'s spelling is resolved through canonicalSymbol), params, cadence "weekly", nextRunAt within the next 8 days, dailyAllocationUsd 1}; GET /strategies lists it; it is then ended with DELETE.',
  },
  async () => {
    const { r, body, id } = await createDraft('xbtc');
    try {
      const s = r.json;
      must(s.kind === 'dca' && s.state === 'draft' && s.label === body.label && s.cadence === 'weekly' && s.dailyAllocationUsd === 1 && s.params.usd === 1, `answer ${clip(r.text)}`);
      must(isMs(s.nextRunAt) && s.nextRunAt > Date.now() - 60_000 && s.nextRunAt < Date.now() + 8 * 86_400_000, `nextRunAt ${s.nextRunAt}`);
      must((await get('/strategies')).json.some((x) => x.id === id), 'not listed');
      must(s.symbol === 'XBTC', `stored the symbol as sent, "${s.symbol}", not the registry's "XBTC"`);
    } finally {
      await del(`/strategies/${id}`);
    }
    return 'created draft (symbol XBTC), listed, ended';
  },
);

check(
  {
    method: 'POST',
    path: '/strategies',
    auth: 'user',
    kind: 'validation',
    correct:
      'Refusals, none of which creates a strategy: {kind, symbol} only → 400 invalid_request naming label and state; kind "nonsense" → 400 invalid_request listing the runnable kinds; symbol "SOL" → 400 invalid_request naming what is tradable; a dca on USDC → 400 not_settleable_here; on the testnet (no xStock has code there) a dca on NVDAx → 400 not_settleable_here; dailyAllocationUsd 0 on a dca → 400 invalid_request; 9,999,999 a day → 400 over_cap with the arithmetic; an agentId that is not a hired agent of this wallet → 400 unknown_agent; a PORTFOLIO rebalance with targets adding to 150% → 400 invalid_request; malformed JSON → 400 invalid_json.',
  },
  async () => {
    const before = (await get('/strategies')).json.length;
    const missing = await post('/strategies', { kind: 'dca', symbol: 'XBTC' });
    expectRefusal(missing, 400, 'invalid_request', 'missing fields');
    must(/label/.test(missing.json.detail ?? '') && /state/.test(missing.json.detail ?? ''), `detail ${missing.json.detail}`);
    const kind = await post('/strategies', { ...draftStrategy(), kind: 'nonsense' });
    expectRefusal(kind, 400, 'invalid_request', 'kind "nonsense"');
    must(/dca/.test(kind.json.detail ?? ''), `does not list the runnable kinds: ${kind.json.detail}`);
    const sol = await post('/strategies', draftStrategy('SOL'));
    expectRefusal(sol, 400, 'invalid_request', 'symbol SOL');
    must(/XBTC/.test(sol.json.detail ?? ''), `does not name what is tradable: ${sol.json.detail}`);
    expectRefusal(await post('/strategies', draftStrategy('USDC')), 400, 'not_settleable_here', 'dca on USDC');
    if (!ctx.mainnetState) expectRefusal(await post('/strategies', draftStrategy('NVDAx')), 400, 'not_settleable_here', 'dca on NVDAx');
    expectRefusal(await post('/strategies', { ...draftStrategy(), dailyAllocationUsd: 0 }), 400, 'invalid_request', 'dailyAllocationUsd 0');
    const over = await post('/strategies', { ...draftStrategy(), dailyAllocationUsd: 9_999_999 });
    expectRefusal(over, 400, 'over_cap', '9,999,999 a day');
    must(/\$[\d,.]+ a day against a \$[\d,.]+ cap/.test(over.json.message ?? ''), `no arithmetic: ${over.json.message}`);
    expectRefusal(await post('/strategies', { ...draftStrategy(), agentId: randomUUID() }), 400, 'unknown_agent', 'foreign agentId');
    expectRefusal(await post('/strategies', { kind: 'rebalance', state: 'draft', label: 'qa-full', symbol: 'PORTFOLIO', params: { targets: { XBTC: 100, WOKB: 50 } }, dailyAllocationUsd: 0 }), 400, 'invalid_request', 'targets over 100%');
    expectRefusal(await http('POST', '/strategies', { raw: '{not json' }), 400, 'invalid_json', 'malformed JSON');
    const after = (await get('/strategies')).json.length;
    must(after === before, `strategy count changed ${before} → ${after}`);
    return `${ctx.mainnetState ? 9 : 10} refusals, all named; nothing created`;
  },
);
unauthorized('POST', '/strategies', { body: draftStrategy() });

check(
  {
    method: 'DELETE',
    path: '/strategies/:id',
    auth: 'user',
    kind: 'contract',
    correct:
      'Retiring this wallet\'s strategy → 200 {ok:true}; GET /strategies shows it ended with no nextRunAt (retired, not deleted); retiring it again → 200 {ok:true} (no change); an id that is not this wallet\'s → 404 {error:"not_found"}.',
  },
  async () => {
    const { id } = await createDraft();
    const r = await del(`/strategies/${id}`);
    expectStatus(r, 200, 'DELETE own strategy');
    must(r.json?.ok === true, `answer ${clip(r.text)}`);
    const row = (await get('/strategies')).json.find((s) => s.id === id);
    must(row?.state === 'ended' && row.nextRunAt === undefined, `after DELETE: ${clip(row)}`);
    const again = await del(`/strategies/${id}`);
    must(again.status === 200 && again.json?.ok === true, `second DELETE: ${show(again)}`);
    expectRefusal(await del(`/strategies/${randomUUID()}`), 404, 'not_found', 'unknown id');
    return 'ended (kept as history), idempotent, unknown 404';
  },
);
unauthorized('DELETE', '/strategies/:id');

check(
  {
    method: 'PATCH',
    path: '/strategies/:id',
    auth: 'user',
    kind: 'contract',
    correct:
      'Reversible: this wallet\'s draft → {state:"paused"} → 200 with state paused (same id and label), and GET /strategies agrees; once ended it stays ended: {state:"paused"} → 409 {error:"strategy_ended", message}. {state:"sideways"} → 400 invalid_request; an id that is not this wallet\'s → 404 not_found.',
  },
  async () => {
    const { id, body } = await createDraft();
    try {
      const paused = await patch(`/strategies/${id}`, { state: 'paused' });
      expectStatus(paused, 200, 'PATCH paused');
      must(paused.json.id === id && paused.json.state === 'paused' && paused.json.label === body.label, `answer ${clip(paused.text)}`);
      must((await get('/strategies')).json.find((s) => s.id === id)?.state === 'paused', 'GET /strategies does not show paused');
      expectRefusal(await patch(`/strategies/${id}`, { state: 'sideways' }), 400, 'invalid_request', '{state:"sideways"}');
      expectRefusal(await patch(`/strategies/${randomUUID()}`, { state: 'paused' }), 404, 'not_found', 'unknown id');
    } finally {
      await del(`/strategies/${id}`);
    }
    const ended = await patch(`/strategies/${id}`, { state: 'paused' });
    expectRefusal(ended, 409, 'strategy_ended', 'PATCH an ended strategy');
    return 'draft → paused; ended stays ended (409); bad state 400; unknown 404';
  },
);
unauthorized('PATCH', '/strategies/:id', { body: { state: 'paused' } });

check(
  {
    method: 'POST',
    path: '/strategies/:id/run',
    auth: 'user',
    kind: 'refusal',
    correct:
      'An id that is not one of this wallet\'s strategies (unknown, or another account\'s) → 404 {error:"not_found"} — not 403, which would confirm it exists — and nothing runs. Happy path not executed: a run trades.',
  },
  async () => {
    expectRefusal(await post(`/strategies/${randomUUID()}/run`, {}, { retry: false }), 404, 'not_found', 'unknown strategy');
    return '404 not_found';
  },
);
unauthorized('POST', '/strategies/:id/run', { body: {} });

check(
  {
    method: 'POST',
    path: '/strategies/backtest',
    auth: 'user',
    kind: 'contract',
    correct:
      'Read-only. As the backtest screen sends it ({kind:"dca", symbol:"XBTC", lookback:"90d", params:{usd:50, everyNDays:7}}) → 200 {lookback "90d", ret, maxDd ≤ 0, sharpe, trades 12–14 (one per 7 of ~91 daily closes), equity: ≥ 2 numbers, feed "live", source, disclaimer}. A grid around the current price ({kind:"grid", …, params:{lower, upper, steps:4, usdPerStep:25}}) → 200 with inRangePct in [0, 100], trades = buys + sells, unitsLeft ≥ 0, leftValue ≥ 0, leftCost ≥ 0 (> 0 exactly when units are left).',
  },
  async () => {
    const dca = await post('/strategies/backtest', { kind: 'dca', symbol: 'XBTC', lookback: '90d', params: { usd: 50, everyNDays: 7 } });
    expectStatus(dca, 200, 'dca backtest');
    const d = dca.json;
    must(d.lookback === '90d' && isNum(d.ret) && d.maxDd <= 0 && isNum(d.sharpe) && d.trades >= 12 && d.trades <= 14, `dca ${clip(d)}`);
    must(Array.isArray(d.equity) && d.equity.length >= 2 && d.equity.every(isNum) && d.feed === 'live' && d.source && d.disclaimer, `dca fields ${clip(d)}`);
    const spot = (await quotes('BTC')).BTC.price;
    const grid = await post('/strategies/backtest', {
      kind: 'grid', symbol: 'XBTC', lookback: '90d',
      params: { lower: Math.round(spot * 0.85), upper: Math.round(spot * 1.15), steps: 4, usdPerStep: 25 },
    });
    expectStatus(grid, 200, 'grid backtest');
    const g = grid.json;
    must(g.inRangePct >= 0 && g.inRangePct <= 100 && g.trades === g.buys + g.sells && g.unitsLeft >= 0 && g.leftValue >= 0 && g.leftCost >= 0, `grid ${clip(g)}`);
    must((g.unitsLeft > 0) === (g.leftCost > 0), `unitsLeft ${g.unitsLeft} with leftCost ${g.leftCost}`);
    return `dca ${d.trades} buys, ret ${d.ret}%; grid in range ${g.inRangePct}%, ${g.buys}/${g.sells}`;
  },
);

check(
  {
    method: 'POST',
    path: '/strategies/backtest',
    auth: 'user',
    kind: 'validation',
    correct:
      'Bad bodies get a named 400: kind "momentum" → 400 invalid_request; lookback "2y" → 400 invalid_request; a grid whose lower is above its upper → 400 {error:"invalid_range"}; a symbol with no price history ("NOPE") → 400 or 404 named — an impossible request, not an upstream failure (no 5xx).',
  },
  async () => {
    expectRefusal(await post('/strategies/backtest', { kind: 'momentum', symbol: 'XBTC' }), 400, 'invalid_request', 'kind momentum');
    expectRefusal(await post('/strategies/backtest', { kind: 'dca', symbol: 'XBTC', lookback: '2y' }), 400, 'invalid_request', 'lookback 2y');
    expectRefusal(await post('/strategies/backtest', { kind: 'grid', symbol: 'XBTC', params: { lower: 5000, upper: 1000, steps: 4, usdPerStep: 25 } }), 400, 'invalid_range', 'lower above upper');
    const nope = await post('/strategies/backtest', { kind: 'dca', symbol: 'NOPE', lookback: '90d', params: { usd: 50 } }, { retry: false });
    must([400, 404].includes(nope.status) && named(nope), `symbol NOPE → ${show(nope)}`);
    return `400 ×3; NOPE ${nope.status} ${named(nope)}`;
  },
);
unauthorized('POST', '/strategies/backtest', { body: { kind: 'dca', symbol: 'XBTC' } });

check(
  {
    method: 'POST',
    path: '/swap',
    auth: 'user',
    kind: 'validation',
    correct:
      'Refused before anything is placed: amount "abc", amount "0", slippagePct 10 and a missing "to" → 400 invalid_request each; malformed JSON → 400 invalid_json. Happy path not executed: it swaps the wallet\'s tokens.',
  },
  async () => {
    const good = { from: 'USDC', to: 'XBTC', amount: '1' };
    expectRefusal(await post('/swap', { ...good, amount: 'abc' }, { retry: false }), 400, 'invalid_request', 'amount abc');
    expectRefusal(await post('/swap', { ...good, amount: '0' }, { retry: false }), 400, 'invalid_request', 'amount 0');
    expectRefusal(await post('/swap', { ...good, slippagePct: 10 }, { retry: false }), 400, 'invalid_request', 'slippagePct 10');
    expectRefusal(await post('/swap', { from: 'USDC', amount: '1' }, { retry: false }), 400, 'invalid_request', 'no to');
    expectRefusal(await http('POST', '/swap', { raw: '{"from":', retry: false }), 400, 'invalid_json', 'malformed JSON');
    return '400 invalid_request ×4, 400 invalid_json';
  },
);
unauthorized('POST', '/swap', { body: { from: 'USDC', to: 'XBTC', amount: '1' } });

check(
  {
    method: 'GET',
    path: '/swap/quote',
    auth: 'user',
    kind: 'contract',
    correct:
      'As the swap screen asks (?in=USDC&out=XBTC&amount=20&slippage=0.5, src/data/useSwapQuote.ts): 200 {inSymbol "USDC", outSymbol "XBTC", inAmount 20, outAmount > 0, minimumOut = outAmount × (1 − slippagePct/100), slippagePct 0.5, venues: string[], route = "Direct" | the one venue | "Best of n venues", priceImpactPct: null or in [0, 5), gas: null or {paidBy "executor", …}}; the implied XBTC price is within 3% of /market/quotes BTC; without ?slippage the default 0.3 applies; ?out=nvdax quotes under "NVDAx". Each ask answers inside a screen\'s patience: a quote still on its way is 503 warming with a retry-after, which is waited out, and no attempt takes the app\'s 45s.',
  },
  async () => {
    const r = await get('/swap/quote?in=USDC&out=XBTC&amount=20&slippage=0.5');
    expectStatus(r, 200, 'USDC → XBTC');
    must(r.ms < 45_000, `/swap/quote took ${r.ms}ms on its last attempt`);
    const q = r.json;
    must(q.inSymbol === 'USDC' && q.outSymbol === 'XBTC' && q.inAmount === 20 && q.outAmount > 0 && q.slippagePct === 0.5, `header ${clip(q)}`);
    must(near(q.minimumOut, q.outAmount * (1 - 0.005), 1e-12, 1e-9), `minimumOut ${q.minimumOut}`);
    const label = q.venues.length === 0 ? 'Direct' : q.venues.length === 1 ? q.venues[0] : `Best of ${q.venues.length} venues`;
    must(Array.isArray(q.venues) && q.route === label, `route "${q.route}" for venues ${clip(q.venues)}`);
    must(q.priceImpactPct === null || (q.priceImpactPct >= 0 && q.priceImpactPct < 5), `priceImpactPct ${q.priceImpactPct}`);
    must(q.gas === null || q.gas?.paidBy === 'executor', `gas ${clip(q.gas)}`);
    const spot = (await quotes('BTC')).BTC.price;
    must(Math.abs(20 / q.outAmount / spot - 1) < 0.03, `implied ${(20 / q.outAmount).toFixed(2)} vs BTC spot ${spot}`);
    const dflt = await get('/swap/quote?in=USDC&out=XBTC&amount=20');
    must(dflt.status === 200 && dflt.json.slippagePct === 0.3, `default slippage ${dflt.json?.slippagePct}`);
    const equity = await get('/swap/quote?in=USDC&out=nvdax&amount=100');
    must(equity.status === 200 && equity.json.outSymbol === 'NVDAx' && equity.json.outAmount > 0, `?out=nvdax → ${show(equity)}`);
    return `20 USDC → ${q.outAmount.toFixed(8)} XBTC via ${q.route}; NVDAx quotes`;
  },
);

check(
  {
    method: 'GET',
    path: '/swap/quote',
    auth: 'user',
    kind: 'validation',
    correct: 'Bad parameters get a named 400, never a 502: ?slippage=10 (outside 0.05–3) → 400 named; ?amount=abc → 400 named; ?in=NOPE → 400 named.',
  },
  async () => {
    const problems = [];
    for (const q of ['in=USDC&out=XBTC&amount=20&slippage=10', 'in=USDC&out=XBTC&amount=abc', 'in=NOPE&out=XBTC&amount=20']) {
      const r = await get(`/swap/quote?${q}`, { retry: false });
      if (r.status !== 400 || !named(r)) problems.push(`?${q} → ${show(r)}`);
    }
    must(problems.length === 0, problems.join('; '));
    return '400 named ×3';
  },
);
unauthorized('GET', '/swap/quote');

/* ───────────────────────────────────────────────────────────── /verify */

const WALLET_CHECKS = ['policy', 'venues', 'cap-agrees', 'audit', 'audit-anchor', 'audit-chain'];

check(
  {
    method: 'GET',
    path: '/verify',
    auth: 'public',
    kind: 'contract',
    correct:
      'Public; as the verification screen sends it (?owner=<the wallet>): 200 {checks: [{id (unique), claim, status ∈ pass|fail|skip, observed, how, ms ≥ 0}], passed/failed/skipped counting those statuses, chain = /health chain, at: ISO within a minute}. xlayer-fork and xlayer-testnet: no failing check (the X Layer trails began after the per-wallet append lock, so the Base build\'s fork at entry 2 is not theirs). No how/observed carries a credential-shaped URL. Without ?owner the wallet checks (policy, venues, cap-agrees, audit, audit-anchor, audit-chain) skip.',
  },
  async () => {
    const r = await get(`/verify?owner=${encodeURIComponent(ctx.owner)}`, { auth: false });
    expectStatus(r, 200, 'GET /verify?owner');
    const v = r.json;
    must(Array.isArray(v.checks) && v.checks.length >= 15 && new Set(v.checks.map((c) => c.id)).size === v.checks.length, `checks ${clip(v.checks?.map?.((c) => c.id))}`);
    for (const c of v.checks) must(['pass', 'fail', 'skip'].includes(c.status) && typeof c.claim === 'string' && typeof c.how === 'string' && typeof c.observed === 'string' && c.ms >= 0, `check ${clip(c)}`);
    const count = (s) => v.checks.filter((c) => c.status === s).length;
    must(v.passed === count('pass') && v.failed === count('fail') && v.skipped === count('skip'), `totals ${v.passed}/${v.failed}/${v.skipped}`);
    must(v.chain === ctx.chain && isIso(v.at) && Math.abs(Date.parse(v.at) - Date.now()) < 120_000, `chain ${v.chain}, at ${v.at}`);
    const leaks = v.checks.filter((c) =>
      [...`${c.how} ${c.observed}`.matchAll(/https?:\/\/[^\s"'<>]+/g)].some((m) => {
        try {
          const u = new URL(m[0]);
          return /[A-Za-z0-9_-]{24,}/.test(u.pathname + u.search) || /api[-_]?key|token=|secret/i.test(u.search);
        } catch {
          return false;
        }
      }),
    );
    must(leaks.length === 0, `credential-shaped URL in ${leaks.map((c) => c.id).join(', ')}`);
    const failing = v.checks.filter((c) => c.status === 'fail');
    if (ctx.fork || ctx.testnet) must(failing.length === 0, `failing on ${ctx.chain}: ${failing.map((c) => `${c.id} (${clip(c.observed, 160)})`).join('; ')}`);
    const anonymous = (await get('/verify', { auth: false })).json;
    const notSkipped = anonymous.checks.filter((c) => WALLET_CHECKS.includes(c.id) && c.status !== 'skip');
    must(notSkipped.length === 0, `without ?owner these did not skip: ${notSkipped.map((c) => c.id).join(', ')}`);
    return `${v.passed} pass, ${v.failed} fail${failing.length ? ` (${failing.map((c) => c.id).join(', ')})` : ''}, ${v.skipped} skip`;
  },
);

check(
  {
    method: 'GET',
    path: '/verify',
    auth: 'public',
    kind: 'validation',
    correct: '?owner=garbage → 400 {error:"invalid_owner", message} — a typo is not a wall of failed claims.',
  },
  async () => {
    expectRefusal(await get('/verify?owner=garbage', { auth: false }), 400, 'invalid_owner', '?owner=garbage');
    return '400 invalid_owner';
  },
);

/* ───────────────────────────────────────────────────────────── /wallet */

check(
  {
    method: 'GET',
    path: '/wallet',
    auth: 'user',
    kind: 'contract',
    correct:
      '200 {id, user_id (a Privy DID), address (0x + 40 hex), kind ∈ embedded|connected, cluster (where it was created), created_at, last_seen_at, active_at, agents_stopped, chain = /health chain (where it settles now)}. Every response carries x-request-id; a caller-supplied id ([A-Za-z0-9_-], ≤ 64) is echoed, and a malformed one is replaced.',
  },
  async () => {
    const r = await get('/wallet');
    expectStatus(r, 200, 'GET /wallet');
    const w = r.json;
    must(typeof w.id === 'string' && /^did:privy:/.test(w.user_id ?? '') && ADDRESS.test(w.address) && ['embedded', 'connected'].includes(w.kind), `wallet ${clip({ id: w.id, kind: w.kind, address: w.address })}`);
    must(typeof w.cluster === 'string' && isIso(w.created_at) && w.chain === ctx.chain && typeof w.agents_stopped === 'boolean', `cluster ${w.cluster}, chain ${w.chain}`);
    const generated = r.headers.get('x-request-id');
    must(generated && generated.length >= 8, 'no x-request-id');
    const mine = await get('/wallet', { headers: { 'x-request-id': 'qa-full-trace-1' } });
    must(mine.headers.get('x-request-id') === 'qa-full-trace-1', `not echoed: ${mine.headers.get('x-request-id')}`);
    const bad = await get('/wallet', { headers: { 'x-request-id': 'bad id!' } });
    must(bad.headers.get('x-request-id') && bad.headers.get('x-request-id') !== 'bad id!', `malformed id echoed: ${bad.headers.get('x-request-id')}`);
    return `${w.kind} ${w.address} (created on ${w.cluster}, settling on ${w.chain}); request ids honoured`;
  },
);
unauthorized('GET', '/wallet');

check(
  {
    method: 'GET',
    path: '/wallet/balance',
    auth: 'user',
    kind: 'contract',
    correct:
      '200 {usd = cashUsd + suppliedUsd + Σ holdings.usd (to a cent), cashUsd ≥ 0, holdings: [{symbol, units > 0, usd ≥ 0}] with no raw wei field, suppliedUsd ≥ 0, dailyCapUsd = /limits dailyCapUsd, remainingTodayUsd = /delegation onChainRemainingUsd (while live)}; cashUsd = /wallet/funds USDC; suppliedUsd = /yield/position suppliedUsd.',
  },
  async () => {
    const r = await get('/wallet/balance');
    expectStatus(r, 200, 'GET /wallet/balance');
    const b = r.json;
    must(isNum(b.cashUsd) && b.cashUsd >= 0 && isNum(b.suppliedUsd) && b.suppliedUsd >= 0 && Array.isArray(b.holdings), `shape ${clip(b)}`);
    for (const h of b.holdings) must(typeof h.symbol === 'string' && h.units > 0 && h.usd >= 0 && !('raw' in h), `holding ${clip(h)}`);
    const sum = b.cashUsd + b.suppliedUsd + b.holdings.reduce((a, h) => a + h.usd, 0);
    must(near(b.usd, sum, 0.01), `usd ${b.usd} ≠ cash ${b.cashUsd} + supplied ${b.suppliedUsd} + holdings = ${sum}`);
    const [funds, position, delegation, limits] = await Promise.all([get('/wallet/funds'), get('/yield/position'), get('/delegation'), get('/limits')]);
    must(near(b.cashUsd, funds.json.usdc.amount, 0.01), `cashUsd ${b.cashUsd} vs /wallet/funds ${funds.json.usdc.amount}`);
    must(near(b.suppliedUsd, position.json.suppliedUsd ?? 0, 0.01), `suppliedUsd ${b.suppliedUsd} vs /yield/position ${position.json.suppliedUsd}`);
    const d = delegation.json;
    if (d && !d.revoked) {
      must(b.dailyCapUsd === limits.json.dailyCapUsd && near(b.remainingTodayUsd, d.onChainRemainingUsd, 0.01), `cap ${b.dailyCapUsd}/${limits.json.dailyCapUsd}, remaining ${b.remainingTodayUsd}/${d.onChainRemainingUsd}`);
    }
    return `$${b.usd.toFixed(2)} = cash $${b.cashUsd.toFixed(2)} + supplied $${b.suppliedUsd.toFixed(2)} + ${b.holdings.length} holding(s)`;
  },
);
unauthorized('GET', '/wallet/balance');

check(
  {
    method: 'POST',
    path: '/wallet/connect',
    auth: 'user',
    kind: 'refusal',
    correct:
      'Refusals only: {address:"0x123"} → 400 invalid_request; malformed JSON → 400 invalid_json; an address that is not a wallet on this Privy account (a fresh random one, standing in for another user\'s wallet) → 403 {error:"wallet_not_linked", message}, and GET /wallet is unchanged. Happy path not executed: connecting stamps the active wallet and can send a first-time gas drip.',
  },
  async () => {
    expectRefusal(await post('/wallet/connect', { address: '0x123' }), 400, 'invalid_request', '{address:"0x123"}');
    expectRefusal(await http('POST', '/wallet/connect', { raw: '{"address":' }), 400, 'invalid_json', 'malformed JSON');
    const foreign = await post('/wallet/connect', { address: randomAddress() }, { retry: false });
    expectRefusal(foreign, 403, 'wallet_not_linked', 'someone else\'s address');
    const after = (await get('/wallet')).json;
    must(after.id === ctx.wallet.id && after.address === ctx.owner, `the active wallet changed to ${after.address}`);
    return '400 invalid_request, 400 invalid_json, 403 wallet_not_linked; wallet unchanged';
  },
);
unauthorized('POST', '/wallet/connect', { body: { address: randomAddress() } });

unauthorized('POST', '/wallet/create', {
  body: {},
  extra: 'Happy path not executed: it binds a new wallet and can send a first-time gas drip.',
});

check(
  {
    method: 'GET',
    path: '/wallet/funds',
    auth: 'user',
    kind: 'contract',
    correct:
      '200 {owner = the wallet, chain = /health chain, usdc: {address = this chain\'s USDC, raw: integer string, amount = raw / 10^6}, eth: {the native balance — OKB on X Layer — raw: integer string, amount = raw / 10^18}, readAt within a minute}; usdc.amount = /wallet/balance cashUsd.',
  },
  async () => {
    const r = await get('/wallet/funds');
    expectStatus(r, 200, 'GET /wallet/funds');
    const f = r.json;
    must(f.owner === ctx.owner && f.chain === ctx.chain && sameAddr(f.usdc.address, ctx.usdc), `header ${clip({ owner: f.owner, chain: f.chain, usdc: f.usdc?.address })}`);
    must(/^\d+$/.test(f.usdc.raw) && near(f.usdc.amount, Number(BigInt(f.usdc.raw)) / 1e6, 1e-9), `usdc ${clip(f.usdc)}`);
    must(/^\d+$/.test(f.eth.raw) && near(f.eth.amount, Number(BigInt(f.eth.raw)) / 1e18, 1e-12, 1e-9), `eth ${clip(f.eth)}`);
    must(isMs(f.readAt) && Math.abs(f.readAt - Date.now()) < 120_000, `readAt ${f.readAt}`);
    const cash = (await get('/wallet/balance')).json.cashUsd;
    must(near(f.usdc.amount, cash, 0.01), `usdc ${f.usdc.amount} vs /wallet/balance cash ${cash}`);
    return `${f.usdc.amount} USDC, ${f.eth.amount.toFixed(6)} OKB`;
  },
);
unauthorized('GET', '/wallet/funds');

check(
  {
    method: 'GET',
    path: '/wallet/tokens',
    auth: 'user',
    kind: 'contract',
    correct:
      '200 {owner = the wallet, chain, source "chain", tokens: [{symbol, address, decimals, units > 0, logo: https URL | null, usd: number|null, native only on OKB, X Layer\'s gas token}] priced ones by usd descending then unpriced by symbol, undescribed: []}; the OKB row equals /wallet/funds eth (the native balance) and the USDC row equals /wallet/funds USDC.',
  },
  async () => {
    const r = await get('/wallet/tokens');
    const funds = (await get('/wallet/funds')).json;
    expectStatus(r, 200, 'GET /wallet/tokens');
    const t = r.json;
    must(t.owner === ctx.owner && t.chain === ctx.chain && t.source === 'chain' && Array.isArray(t.undescribed) && t.undescribed.length === 0, `header ${clip({ ...t, tokens: t.tokens?.length })}`);
    t.tokens.forEach((x, i) => {
      must(typeof x.symbol === 'string' && ADDRESS.test(x.address) && Number.isInteger(x.decimals) && x.units > 0, `token ${clip(x)}`);
      must((x.logo === null || /^https:\/\//.test(x.logo)) && (x.usd === null || (isNum(x.usd) && x.usd >= 0)), `token ${x.symbol}: logo/usd ${clip(x)}`);
      must((x.native === true) === (x.symbol === 'OKB'), `token ${x.symbol}: native ${x.native}`);
      if (i > 0) {
        const p = t.tokens[i - 1];
        const ordered = p.usd !== null && x.usd !== null ? p.usd >= x.usd : p.usd !== null || (x.usd === null && p.symbol.localeCompare(x.symbol) <= 0);
        must(ordered, `not sorted at ${p.symbol} → ${x.symbol}`);
      }
    });
    const okb = t.tokens.find((x) => x.symbol === 'OKB');
    const usdc = t.tokens.find((x) => x.symbol === 'USDC');
    must(funds.eth.amount > 0 ? okb && near(okb.units, funds.eth.amount, 1e-12, 1e-9) : !okb, `OKB ${okb?.units} vs funds ${funds.eth.amount}`);
    must(funds.usdc.amount > 0 ? usdc && near(usdc.units, funds.usdc.amount, 1e-9) : !usdc, `USDC ${usdc?.units} vs funds ${funds.usdc.amount}`);
    return t.tokens.map((x) => `${x.symbol} ${x.units}`).join(', ') || 'no tokens';
  },
);
unauthorized('GET', '/wallet/tokens');

/* ───────────────────────────────────────────────────────────── /withdrawal-addresses, /withdrawals */

const DAY_MS = 86_400_000;

async function addFreshAddress(label = 'qa-full') {
  const address = randomAddress();
  const r = await post('/withdrawal-addresses', { label, address });
  expectStatus(r, 201, 'add a withdrawal address');
  return { address, r };
}

check(
  {
    method: 'GET',
    path: '/withdrawal-addresses',
    auth: 'user',
    kind: 'contract',
    correct:
      '200 {coolingOffHours 24, serverTime (within 5 minutes of this machine), addresses: [{address, label (1–40 chars), addedAt, usableAt = addedAt + 24h, usable = usableAt ≤ serverTime}] oldest first}.',
  },
  async () => {
    const r = await get('/withdrawal-addresses');
    expectStatus(r, 200, 'GET /withdrawal-addresses');
    const b = r.json;
    must(b.coolingOffHours === 24 && isMs(b.serverTime) && Math.abs(b.serverTime - Date.now()) < 300_000 && Array.isArray(b.addresses), `header ${clip(b)}`);
    b.addresses.forEach((a, i) => {
      must(ADDRESS.test(a.address) && a.label.length >= 1 && a.label.length <= 40 && isMs(a.addedAt), `entry ${clip(a)}`);
      must(a.usableAt - a.addedAt === DAY_MS && a.usable === (a.usableAt <= b.serverTime), `entry ${a.address}: usableAt ${a.usableAt}, usable ${a.usable}`);
      if (i > 0) must(a.addedAt >= b.addresses[i - 1].addedAt, 'not oldest first');
    });
    return `${b.addresses.length} address(es), ${b.addresses.filter((a) => a.usable).length} usable`;
  },
);
unauthorized('GET', '/withdrawal-addresses');

check(
  {
    method: 'POST',
    path: '/withdrawal-addresses',
    auth: 'user',
    kind: 'contract',
    correct:
      'Reversible happy path: {label, address: a fresh random address} → 201 {status:"added", coolingOffHours 24, entry:{address, label, addedAt, usableAt = addedAt + 24h exactly, usable:false}}; GET lists it, unusable; adding it again → 409 {status:"blocked", reason:"already_listed", entry} with its usableAt untouched; removed afterwards. (Adding and removing push a notice to the account\'s own devices.)',
  },
  async () => {
    const { address, r } = await addFreshAddress('qa-full add');
    try {
      const e = r.json.entry;
      must(r.json.status === 'added' && r.json.coolingOffHours === 24 && sameAddr(e.address, address) && e.label === 'qa-full add', `answer ${clip(r.text)}`);
      must(e.usableAt - e.addedAt === DAY_MS && e.usable === false, `cooling-off ${e.usableAt - e.addedAt}ms, usable ${e.usable}`);
      const listed = (await get('/withdrawal-addresses')).json.addresses.find((a) => sameAddr(a.address, address));
      must(listed && listed.usable === false && listed.usableAt === e.usableAt, `listed as ${clip(listed)}`);
      const again = await post('/withdrawal-addresses', { label: 'qa-full again', address });
      expectRefusal(again, 409, 'already_listed', 'the same address again');
      must(again.json.entry?.usableAt === e.usableAt, `re-adding moved the clock: ${again.json.entry?.usableAt} vs ${e.usableAt}`);
    } finally {
      await post('/withdrawal-addresses/remove', { address });
    }
    return 'added (24h cooling-off, unusable), duplicate 409 already_listed, removed';
  },
);

check(
  {
    method: 'POST',
    path: '/withdrawal-addresses',
    auth: 'user',
    kind: 'validation',
    correct:
      'Bad bodies get a named 400 and add nothing: an address that is not 0x + 40 hex → 400 invalid_request; a 41-character label → 400 invalid_request; the zero address → 400 named (an address nothing may ever be sent to is a bad request, not a conflict with state).',
  },
  async () => {
    const before = (await get('/withdrawal-addresses')).json.addresses.length;
    expectRefusal(await post('/withdrawal-addresses', { label: 'qa-full', address: '0x123' }), 400, 'invalid_request', 'address 0x123');
    expectRefusal(await post('/withdrawal-addresses', { label: 'x'.repeat(41), address: randomAddress() }), 400, 'invalid_request', '41-character label');
    const zero = await post('/withdrawal-addresses', { label: 'qa-full zero', address: ZERO_ADDRESS });
    const after = (await get('/withdrawal-addresses')).json.addresses.length;
    must(after === before, `address count changed ${before} → ${after}`);
    must(zero.status === 400 && named(zero), `zero address → ${show(zero)}`);
    return `400 ×2; zero address 400 ${named(zero)}`;
  },
);
unauthorized('POST', '/withdrawal-addresses', { body: { label: 'qa-full', address: randomAddress() } });

check(
  {
    method: 'POST',
    path: '/withdrawal-addresses/check',
    auth: 'user',
    kind: 'refusal',
    correct:
      'May anything be sent there now? An address not on the list → 409 {status:"blocked", reason:"not_allowlisted", detail}; one added moments ago → 409 {status:"blocked", reason:"cooling_off", label, usableAt = its entry\'s usableAt}; a usable one (if the account has any) → 200 {status:"usable", address, label, usableAt ≤ now}; {address:"nope"} → 400 invalid_request. Refusals are written to the trail, as the handler intends.',
  },
  async () => {
    expectRefusal(await post('/withdrawal-addresses/check', { address: 'nope' }), 400, 'invalid_request', '{address:"nope"}');
    const stranger = await post('/withdrawal-addresses/check', { address: randomAddress() });
    expectRefusal(stranger, 409, 'not_allowlisted', 'unlisted address');
    must(prose(stranger), 'not_allowlisted without a detail');
    const { address, r } = await addFreshAddress('qa-full check');
    try {
      const cooling = await post('/withdrawal-addresses/check', { address });
      expectRefusal(cooling, 409, 'cooling_off', 'freshly added address');
      must(cooling.json.label === 'qa-full check' && cooling.json.usableAt === r.json.entry.usableAt, `cooling_off carries ${clip(cooling.json)}`);
    } finally {
      await post('/withdrawal-addresses/remove', { address });
    }
    const usable = (await get('/withdrawal-addresses')).json.addresses.find((a) => a.usable);
    if (usable) {
      const ok = await post('/withdrawal-addresses/check', { address: usable.address });
      must(ok.status === 200 && ok.json.status === 'usable' && ok.json.usableAt <= Date.now() + 60_000, `usable address → ${show(ok)}`);
    }
    return `400; 409 not_allowlisted; 409 cooling_off${usable ? '; 200 usable' : ''}`;
  },
);
unauthorized('POST', '/withdrawal-addresses/check', { body: { address: randomAddress() } });

check(
  {
    method: 'POST',
    path: '/withdrawal-addresses/remove',
    auth: 'user',
    kind: 'contract',
    correct:
      'Removing a listed address → 200 {status:"removed", address, label}; GET no longer lists it; removing it again, or an address never listed → 404 {status:"blocked", reason:"not_listed"}; {address:"nope"} → 400 invalid_request.',
  },
  async () => {
    const { address } = await addFreshAddress('qa-full remove');
    const r = await post('/withdrawal-addresses/remove', { address });
    expectStatus(r, 200, 'remove');
    must(r.json.status === 'removed' && sameAddr(r.json.address, address) && r.json.label === 'qa-full remove', `answer ${clip(r.text)}`);
    must(!(await get('/withdrawal-addresses')).json.addresses.some((a) => sameAddr(a.address, address)), 'still listed');
    expectRefusal(await post('/withdrawal-addresses/remove', { address }), 404, 'not_listed', 'remove again');
    expectRefusal(await post('/withdrawal-addresses/remove', { address: randomAddress() }), 404, 'not_listed', 'never listed');
    expectRefusal(await post('/withdrawal-addresses/remove', { address: 'nope' }), 400, 'invalid_request', '{address:"nope"}');
    return 'removed; again 404; never listed 404; bad body 400';
  },
);
unauthorized('POST', '/withdrawal-addresses/remove', { body: { address: randomAddress() } });

check(
  {
    method: 'POST',
    path: '/withdrawals/prepare-all',
    auth: 'user',
    kind: 'refusal',
    correct:
      'Refusals only; no transfer is built. A destination not on the allowlist → 409 {status:"blocked", reason:"not_allowlisted"}; one still cooling off → 409 {status:"blocked", reason:"cooling_off", label, usableAt}; {to:"nope", token:"USDC"} → 400 invalid_request; with a usable destination, token "NOPE" → 400 unknown_token and "OKB" (the native gas token) → 400 native_token. Happy path not executed: it builds the transfer of a whole balance.',
  },
  async () => {
    expectRefusal(await post('/withdrawals/prepare-all', { to: 'nope', token: 'USDC' }, { retry: false }), 400, 'invalid_request', '{to:"nope"}');
    expectRefusal(await post('/withdrawals/prepare-all', { to: randomAddress(), token: 'USDC' }, { retry: false }), 409, 'not_allowlisted', 'unlisted destination');
    const { address } = await addFreshAddress('qa-full prepare');
    try {
      const cooling = await post('/withdrawals/prepare-all', { to: address, token: 'USDC' }, { retry: false });
      expectRefusal(cooling, 409, 'cooling_off', 'cooling-off destination');
      must(cooling.json.label === 'qa-full prepare' && isMs(cooling.json.usableAt), `cooling_off carries ${clip(cooling.json)}`);
    } finally {
      await post('/withdrawal-addresses/remove', { address });
    }
    const usable = (await get('/withdrawal-addresses')).json.addresses.find((a) => a.usable);
    if (usable) {
      expectRefusal(await post('/withdrawals/prepare-all', { to: usable.address, token: 'NOPE' }, { retry: false }), 400, 'unknown_token', 'token NOPE');
      expectRefusal(await post('/withdrawals/prepare-all', { to: usable.address, token: 'OKB' }, { retry: false }), 400, 'native_token', 'token OKB');
    }
    return `400; 409 not_allowlisted; 409 cooling_off${usable ? '; 400 unknown_token; 400 native_token' : ''}`;
  },
);
unauthorized('POST', '/withdrawals/prepare-all', { body: { to: randomAddress(), token: 'USDC' } });

check(
  {
    method: 'POST',
    path: '/withdrawals/record',
    auth: 'user',
    kind: 'refusal',
    correct:
      'Refusals only; nothing is recorded. {txHash:"0xabc"} → 400 invalid_request; a hash no chain has seen → 404 {status:"unknown", detail}; a real transaction this wallet did not send (xlayer-fork: the delegate\'s settlement from /history; xlayer-testnet: an unrelated transaction) → 403 {status:"blocked", reason:"not_your_transaction"}. Happy path not executed: it records a withdrawal the owner signed.',
  },
  async () => {
    expectRefusal(await post('/withdrawals/record', { txHash: '0xabc' }, { retry: false }), 400, 'invalid_request', '{txHash:"0xabc"}');
    const unknown = await post('/withdrawals/record', { txHash: randomHash() }, { retry: false });
    must(unknown.status === 404 && unknown.json?.status === 'unknown' && prose(unknown), `unknown hash → ${show(unknown)}`);
    const probe = await realTxNotFromOwner();
    if (!probe) return '400; 404 unknown; no real transaction available to probe';
    const theirs = await post('/withdrawals/record', { txHash: probe.hash }, { retry: false });
    expectRefusal(theirs, 403, 'not_your_transaction', probe.source);
    return `400; 404 unknown; ${probe.source} → 403 not_your_transaction`;
  },
);
unauthorized('POST', '/withdrawals/record', { body: { txHash: randomHash() } });

/* ───────────────────────────────────────────────────────────── /yield */

check(
  {
    method: 'GET',
    path: '/yield/position',
    auth: 'user',
    kind: 'contract',
    correct:
      'Mainnet state (Aave v3 deployed on X Layer): 200 {suppliedUsd ≥ 0, apy in (0, 0.5) = /yield/supply estimatedApy, symbol "USDT0" (tier 4 earns on USD₮0), pool = Aave v3 Pool 0xE3F3…f116, aToken (address), asset = X Layer USDT0 0x779D…3736, available:true}. xlayer-testnet: 200 {suppliedUsd 0, available:false, reason "There is no lending pool on …", apy, pool, aToken, asset} — mainnet\'s published rate shown for reference.',
  },
  async () => {
    const r = await get('/yield/position');
    const supply = (await get('/yield/supply', { auth: false })).json;
    expectStatus(r, 200, 'GET /yield/position');
    const p = r.json;
    must(p.symbol === 'USDT0' && sameAddr(p.pool, AAVE_V3_POOL) && ADDRESS.test(p.aToken) && sameAddr(p.asset, USDT0), `addresses ${clip(p)}`);
    must(p.apy > 0 && p.apy < 0.5 && Math.abs(p.apy - supply.estimatedApy) < 0.005, `apy ${p.apy} vs supply ${supply.estimatedApy}`);
    must(p.available === ctx.mainnetState, `available ${p.available} on ${ctx.chain}`);
    if (p.available) must(isNum(p.suppliedUsd) && p.suppliedUsd >= 0 && p.reason === undefined, `available shape ${clip(p)}`);
    else must(p.suppliedUsd === 0 && /no lending pool/i.test(p.reason ?? ''), `unavailable shape ${clip(p)}`);
    return `${p.available ? `$${p.suppliedUsd} supplied` : p.reason} at ${(p.apy * 100).toFixed(2)}%`;
  },
);
unauthorized('GET', '/yield/position');

check(
  {
    method: 'GET',
    path: '/yield/supply',
    auth: 'public',
    kind: 'contract',
    correct:
      'Public. 200 {symbol "USDT0" (what tier 4 earns on), estimatedApy in (0.001, 0.5), feed "live", source naming the Aave v3 Pool 0xE3F3…f116 on X Layer, reserves including USDT0, note, availableHere = Aave exists on this chain (mainnet state true, xlayer-testnet false), the note saying which}; a 503 rate_unavailable carries Retry-After and is waited out.',
  },
  async () => {
    const r = await get('/yield/supply', { auth: false });
    expectStatus(r, 200, 'GET /yield/supply');
    const y = r.json;
    must(y.symbol === 'USDT0' && y.estimatedApy > 0.001 && y.estimatedApy < 0.5 && y.feed === 'live' && y.source.includes(AAVE_V3_POOL) && /X Layer/.test(y.source), `rate ${clip(y)}`);
    must(Array.isArray(y.reserves) && y.reserves.some((x) => x.symbol === 'USDT0' && sameAddr(x.asset, USDT0)), `reserves ${clip(y.reserves)}`);
    must(y.availableHere === ctx.mainnetState, `availableHere ${y.availableHere} on ${ctx.chain}`);
    must(y.availableHere ? /supplied to Aave v3 on X Layer as USDT0/.test(y.note) : /no lending pool/.test(y.note), `note "${y.note}"`);
    return `${(y.estimatedApy * 100).toFixed(2)}% a year; availableHere ${y.availableHere}`;
  },
);

function decodeWithdraw(data) {
  must(typeof data === 'string' && data.length === 10 + 64 * 3 && data.startsWith('0x69328dec'), `calldata is not withdraw(address,uint256,address): ${clip(data, 80)}`);
  return {
    asset: `0x${data.slice(34, 74)}`,
    amount: BigInt(`0x${data.slice(74, 138)}`),
    to: `0x${data.slice(162, 202)}`,
  };
}

check(
  {
    method: 'POST',
    path: '/yield/withdraw-calldata',
    auth: 'user',
    kind: 'contract',
    correct:
      'Read-only calldata, as the app sends it ({usd:null}). Mainnet state: 200 {to = Aave v3 Pool 0xE3F3…f116, data = withdraw(asset = X Layer USDT0, amount = 2^256 − 1, to = the wallet) with selector 0x69328dec, isMax:true, asset "USDT0"}; {usd:5} → amount 5,000,000 (6 decimals) and isMax:false. Where Aave is not deployed (xlayer-testnet, where /yield/position says available:false) it refuses with a named 4xx (aave_not_deployed) rather than hand the wallet calldata for a pool with no code there.',
  },
  async () => {
    const max = await post('/yield/withdraw-calldata', { usd: null });
    if (!ctx.mainnetState) {
      must(max.status >= 400 && max.status < 500 && named(max), `${ctx.chain}, where Aave is not deployed → ${show(max)}`);
      return `${max.status} ${named(max)}`;
    }
    expectStatus(max, 200, '{usd:null}');
    must(sameAddr(max.json.to, AAVE_V3_POOL) && max.json.isMax === true, `answer ${clip(max.text)}`);
    const all = decodeWithdraw(max.json.data);
    must(sameAddr(all.asset, USDT0) && all.amount === MAX_UINT256 && sameAddr(all.to, ctx.owner), `decoded ${clip({ ...all, amount: String(all.amount) })}`);
    const five = await post('/yield/withdraw-calldata', { usd: 5 });
    expectStatus(five, 200, '{usd:5}');
    const part = decodeWithdraw(five.json.data);
    must(five.json.isMax === false && part.amount === 5_000_000n && sameAddr(part.to, ctx.owner), `decoded ${clip({ ...part, amount: String(part.amount) })}`);
    return 'max → withdraw(USDT0, 2^256−1, owner); $5 → 5,000,000 units';
  },
);

check(
  {
    method: 'POST',
    path: '/yield/withdraw-calldata',
    auth: 'user',
    kind: 'validation',
    correct: '{usd:0} → 400 {error:"invalid_amount"}; {usd:"abc"} → 400 with a named error, never a 500.',
  },
  async () => {
    const zero = await post('/yield/withdraw-calldata', { usd: 0 }, { retry: false });
    const abc = await post('/yield/withdraw-calldata', { usd: 'abc' }, { retry: false });
    const problems = [];
    if (zero.status !== 400 || named(zero) !== 'invalid_amount') problems.push(`{usd:0} → ${show(zero)}`);
    if (abc.status !== 400 || !named(abc)) problems.push(`{usd:"abc"} → ${show(abc)}`);
    must(problems.length === 0, problems.join('; '));
    return '400 invalid_amount; 400 named';
  },
);
unauthorized('POST', '/yield/withdraw-calldata', { body: { usd: null } });

/* ───────────────────────────────────────────────────────────── not executed here */

/**
 * Happy paths this suite deliberately does not run, and why. Each endpoint above is still exercised
 * through its refusals; the live suites under server/src (*.live.test.ts, fork proofs) cover these.
 */
const NOT_EXECUTED = [
  ['POST', '/orders', 'places a market order'],
  ['POST', '/swap', 'swaps the wallet\'s tokens'],
  ['POST', '/panic/flatten', 'sells every holding'],
  ['POST', '/positions/close', 'sells a holding'],
  ['POST', '/strategies/:id/run', 'runs a strategy, which trades'],
  ['POST', '/proposals/:id/decide', 'approve places the order a proposal describes (skip is exercised)'],
  ['POST', '/withdrawals/prepare-all', 'builds the transfer of a whole balance'],
  ['POST', '/withdrawals/record', 'records a withdrawal the owner signed'],
  ['POST', '/faucet', 'moves test funds'],
  ['POST', '/audit/anchor', 'publishes the trail head to X Layer and spends gas (OKB)'],
  ['POST', '/wallet/create', 'binds a wallet and can send a first-time gas drip'],
  ['POST', '/wallet/connect', 'stamps the active wallet and can send a first-time gas drip'],
  ['POST', '/devices/register', 'registers a push target'],
  ['POST', '/notify/test', 'sends a push'],
  ['POST', '/bot/say', 'calls the language model'],
  ['GET', '/briefing', 'asks the language model for a take on every card'],
  ['POST', '/proposals/generate', 'the agent prices the market, may ask the model, and writes proposals'],
  ['POST', '/alerts/evaluate', 'global sweep: fires any account\'s alerts and pushes to their owners'],
  ['POST', '/delegation/record', 'needs a grant the owner signs on chain'],
  ['POST', '/delegation/revoke', 'needs a revoke the owner signs on chain'],
  ['POST', '/portfolio/snapshot', 'writes a snapshot row that nothing can remove'],
  ['POST', '/catchup/seen', 'moves the last-seen marker, which cannot be put back'],
  ['DELETE', '/agents/:id', 'firing pauses the agent\'s live strategies, and re-hiring does not resume them'],
  ['POST', '/privy/policy/prove', 'drives the demo wallet through Privy signing (operator key)'],
  ['POST', '/ops/mirror', 'starts a database copy (operator key)'],
  ['GET', '/ops/mirror', 'needs the operator key; the suite holds only a user session'],
  ['POST', '/agent/positions/close', 'sells for an owner (agent key)'],
  ['POST', '/agent/strategies/:id/run', 'runs a strategy (agent key)'],
  ['POST', '/agent/tick', 'runs every due strategy (agent key)'],
  ['GET', '/agent/due', 'needs an agent key'],
  ['GET', '/agent/keys', 'needs the operator key'],
  ['POST', '/agent/keys', 'mints an agent key (operator key)'],
  ['DELETE', '/agent/keys/:id', 'revokes an agent key (operator key)'],
  ['GET', '/agent/whoami', 'needs an agent key'],
].map(([method, path, reason]) => ({ method, path, reason }));

/* ───────────────────────────────────────────────────────────── run */

async function main() {
  const startedAt = new Date().toISOString();
  console.log(`qa-full against ${BASE}`);
  await bootstrap();
  const selected = checks.filter((c) => ONLY.length === 0 || ONLY.some((o) => c.id === o || c.path.includes(o)));
  const ordered = [...selected.filter((c) => !c.runLast), ...selected.filter((c) => c.runLast)];
  console.log(`chain ${ctx.chain} · wallet ${ctx.owner} · ${ordered.length} of ${checks.length} checks\n`);

  const results = [];
  for (const c of ordered) {
    const calls = [];
    currentCalls = calls;
    const t0 = Date.now();
    let status = 'PASS';
    let observed;
    try {
      observed = await c.fn();
      const slow = calls.filter((x) => x.ms > (x.method === 'GET' ? READ_BUDGET_MS : WRITE_BUDGET_MS));
      if (slow.length > 0) {
        status = 'FAIL';
        observed = `${slow.map((x) => `${x.method} ${x.path} took ${x.ms}ms`).join('; ')} — past what the app waits (src/data/api.ts: 45s read, 180s write). Otherwise: ${observed}`;
      }
    } catch (e) {
      status = 'FAIL';
      observed = e instanceof Fail ? e.message : `${e?.name ?? 'Error'}: ${e?.message ?? e}`;
    } finally {
      currentCalls = null;
    }
    const result = {
      id: c.id,
      method: c.method,
      path: c.path,
      auth: c.auth,
      kind: c.kind,
      correct: c.correct,
      status,
      observed: clip(observed ?? '', 2000),
      ms: Date.now() - t0,
      calls,
    };
    results.push(result);
    const head = `${status}  ${c.id}  ${c.method.padEnd(6)} ${c.path}`;
    console.log(status === 'PASS' ? `${head}  — ${clip(result.observed, 160)}` : `${head}\n        ${result.observed}`);
  }

  results.sort((a, b) => a.id.localeCompare(b.id));
  const pass = results.filter((r) => r.status === 'PASS').length;
  const fail = results.length - pass;

  /*
   * Did a deploy land while the checks ran? A run that straddles a restart measures two processes —
   * one of them with cold caches — so the results say so rather than passing as one clean measurement.
   */
  const endHealth = await fetch(`${BASE}/health`).then((r) => r.json()).catch(() => undefined);
  const elapsedSec = (Date.now() - Date.parse(startedAt)) / 1000;
  const deployment = {
    versionAtStart: ctx.health.version,
    versionAtEnd: endHealth?.version ?? null,
    uptimeSecAtStart: ctx.health.uptimeSec,
    uptimeSecAtEnd: endHealth?.uptimeSec ?? null,
    restartedDuringRun: endHealth
      ? endHealth.version !== ctx.health.version || endHealth.uptimeSec + 60 < ctx.health.uptimeSec + elapsedSec
      : null,
  };
  if (deployment.restartedDuringRun) {
    console.log(
      `\nWARNING: ${BASE} restarted or changed version during the run (${deployment.versionAtStart} → ${deployment.versionAtEnd}, uptime ${deployment.uptimeSecAtStart}s → ${deployment.uptimeSecAtEnd}s over ${Math.round(elapsedSec)}s). Results that straddle a deploy are not one clean measurement.`,
    );
  }

  const payload = existsSync(OUT) ? JSON.parse(readFileSync(OUT, 'utf8')) : {};
  payload.suite = 'tools/qa-full.mjs';
  payload.updatedAt = new Date().toISOString();
  payload.executors = {
    ...(payload.executors ?? {}),
    [BASE]: {
      base: BASE,
      chain: ctx.chain,
      version: ctx.health.version,
      deployment,
      wallet: ctx.owner,
      startedAt,
      finishedAt: new Date().toISOString(),
      totals: { checks: results.length, pass, fail },
      notExecuted: NOT_EXECUTED,
      results,
    },
  };
  mkdirSync(dirname(OUT), { recursive: true });
  writeFileSync(OUT, `${JSON.stringify(payload, null, 2)}\n`);
  console.log(`\n${pass} passed, ${fail} failed of ${results.length} on ${ctx.chain} — results in ${OUT}`);
  if (fail > 0) process.exitCode = 1;
}

main().catch((e) => {
  console.error(`qa-full could not run: ${clip(e instanceof Error ? e.message : String(e), 400)}`);
  process.exitCode = 2;
});
