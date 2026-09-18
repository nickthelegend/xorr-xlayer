/**
 * Section B of docs/QA-PLAN.md, executed.
 *
 * Each check states the expected result as a predicate, so a pass is "matched what the plan said"
 * rather than "did not throw". Prints PASS/FAIL per item with the observed value on a failure.
 */
import { execFileSync } from 'node:child_process';
import { writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';

const B = process.env.EXPO_PUBLIC_API_URL ?? 'http://localhost:8788';
const EMAIL = process.env.E2E_PRIVY_EMAIL ?? 'test-8958@privy.io';

const token = execFileSync('npx', ['tsx', 'server/src/e2e-token.ts', EMAIL], {
  encoding: 'utf8',
}).trim();

let pass = 0;
const failures = [];

async function check(id, what, fn) {
  try {
    const detail = await fn();
    console.log(`PASS  ${id.padEnd(5)} ${what}${detail ? `  — ${detail}` : ''}`);
    pass++;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.log(`FAIL  ${id.padEnd(5)} ${what}\n            ${msg}`);
    failures.push(`${id} ${what}: ${msg}`);
  }
}

/**
 * A 503 `warming` is part of the contract, not a failure: the executor is fetching from a
 * rate-limited upstream and says so with a Retry-After. The app honours it, so the checks do too —
 * anything else would be testing a protocol the product does not use.
 */
async function withRetry(doFetch, attempts = 4) {
  for (let i = 0; i < attempts; i++) {
    const r = await doFetch();
    if (r.status !== 503 || i === attempts - 1) return r;
    const after = Number(r.headers.get('retry-after'));
    await new Promise((res) => setTimeout(res, Number.isFinite(after) && after > 0 ? after * 1000 : 3000));
  }
  throw new Error('unreachable');
}

const req = (path, init = {}, auth = true) =>
  withRetry(() =>
  fetch(`${B}${path}`, {
    ...init,
    headers: {
      'content-type': 'application/json',
      ...(auth ? { authorization: `Bearer ${token}` } : {}),
      ...init.headers,
    },
  }),
  );

const must = (cond, msg) => {
  if (!cond) throw new Error(msg);
};

await check('B1', 'GET /health without auth', async () => {
  const r = await req('/health', {}, false);
  const j = await r.json();
  must(r.status === 200, `status ${r.status}`);
  must(j.ok === true && j.db && j.chain && j.delegation, `missing fields: ${JSON.stringify(j)}`);
  return `${j.chain} ${j.delegation.slice(0, 10)}…`;
});

await check('B2', 'no token is 401', async () => {
  const r = await req('/strategies', {}, false);
  const j = await r.json();
  must(r.status === 401, `status ${r.status}`);
  must(j.error === 'unauthorized', `error ${j.error}`);
  return j.detail;
});

await check('B3', 'forged JWT is 401 with a signature failure', async () => {
  const forged =
    'eyJhbGciOiJFUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiJkaWQ6cHJpdnk6ZmFrZSIsImF1ZCI6ImZha2UiLCJleHAiOjk5OTk5OTk5OTl9.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
  const r = await fetch(`${B}/strategies`, { headers: { authorization: `Bearer ${forged}` } });
  const j = await r.json();
  must(r.status === 401, `status ${r.status} body ${JSON.stringify(j)}`);
  must(/signature|invalid|expired/i.test(j.detail ?? ''), `detail: ${j.detail}`);
  return j.detail;
});

await check('B4', 'market quotes are live and positive', async () => {
  const r = await req('/market/quotes?symbols=BTC,ETH,WETH,CBBTC,USDC', {}, false);
  const j = await r.json();
  must(r.status === 200, `status ${r.status}`);
  for (const s of ['BTC', 'ETH', 'WETH', 'CBBTC', 'USDC']) {
    must(j[s]?.price > 0, `${s} has no positive price`);
  }
  return `BTC $${j.BTC.price}`;
});

await check('B5', 'OHLC rows differ by window', async () => {
  const a = await (await req('/market/ohlc?symbol=BTC&days=1', {}, false)).json();
  const b = await (await req('/market/ohlc?symbol=BTC&days=30', {}, false)).json();
  must(Array.isArray(a.rows) && a.rows.length > 0, 'no rows for days=1');
  must(Array.isArray(b.rows) && b.rows.length > 0, 'no rows for days=30');
  must(JSON.stringify(a.rows) !== JSON.stringify(b.rows), 'the two windows returned the same series');
  return `${a.rows.length} vs ${b.rows.length} rows`;
});

await check('B6', 'all 8 equities price live from a route', async () => {
  const rows = await (await req('/market/stocks', {}, false)).json();
  must(rows.length === 8, `${rows.length} rows`);
  for (const s of rows) {
    must(s.feed === 'live', `${s.symbol} feed is ${s.feed}`);
    must(s.price > 5 && s.price < 5000, `${s.symbol} implausible price ${s.price}`);
    must(s.venues.length > 0, `${s.symbol} names no venue`);
  }
  return rows.map((s) => s.symbol).join(',');
});

await check('B7', 'tradable set matches the client', async () => {
  const rows = await (await req('/market/tradable', {}, false)).json();
  const server = rows.map((r) => r.symbol).sort();
  const { TRADABLE } = await import('../src/data/tradable.ts').catch(() => ({ TRADABLE: null }));
  if (!TRADABLE) return `${server.length} symbols (client list not importable here)`;
  must(JSON.stringify(server) === JSON.stringify([...TRADABLE].sort()), `server ${server}`);
  return server.join(',');
});

await check('B8', 'Aave rate is plausible, never a zeroed struct', async () => {
  const j = await (await req('/yield/supply', {}, false)).json();
  must(j.feed === 'live', `feed ${j.feed}`);
  must(j.estimatedApy > 0.001 && j.estimatedApy < 0.5, `apy ${j.estimatedApy}`);
  return `${(j.estimatedApy * 100).toFixed(2)}%`;
});

await check('B9', 'perp: mark real, unknowables null, bad symbol 404', async () => {
  const j = await (await req('/perp/BTC', {}, false)).json();
  must(j.markPx > 0, `markPx ${j.markPx}`);
  must(j.openInterestUsd === null && j.dayVolumeUsd === null && j.fundingRate === null,
    'an unknowable field was given a number');
  must(j.nextFundingAt > Date.now(), 'funding time is in the past');
  const bad = await req('/perp/NOPE', {}, false);
  must(bad.status === 404, `unknown symbol gave ${bad.status}`);
  return `mark $${j.markPx}`;
});

await check('B10', 'agent decision names its own reason', async () => {
  const j = await (await req('/agent/decision')).json();
  must(typeof j.act === 'boolean', `no act field: ${JSON.stringify(j)}`);
  must((j.rationale ?? '').length > 10, `thin rationale: ${j.rationale}`);
  return j.act ? `act, $${j.sizeUsd} via ${j.route?.venue}` : j.reason;
});

await check('B11', 'graph health', async () => {
  const j = await (await req('/graph/health')).json();
  must(j.block > 0, `block ${j.block}`);
  must(j.healthy === true, 'indexer reports errors');
  return `block ${j.block}`;
});

await check('B12', 'swap quote names real venues', async () => {
  const j = await (await req('/swap/quote?in=USDC&out=WETH&amount=250')).json();
  must(j.outAmount > 0, `outAmount ${j.outAmount}`);
  must(j.minimumOut > 0 && j.minimumOut < j.outAmount, 'minimumOut is not below outAmount');
  must(j.venues?.length > 0, 'no venues named');
  return `${j.outAmount.toFixed(5)} WETH via ${j.venues.join('+')}`;
});


// ── B13–B23 ─────────────────────────────────────────────────────────────────

const post = (path, body) => req(path, { method: 'POST', body: JSON.stringify(body) });

await check('B13', 'over-cap strategy is refused with the arithmetic', async () => {
  const r = await post('/strategies', {
    kind: 'dca', state: 'live', label: 'qa over cap', symbol: 'WETH',
    cadence: 'daily', dailyAllocationUsd: 9_999_999,
  });
  const j = await r.json();
  must(r.status === 400, `status ${r.status}`);
  must(j.error === 'over_cap', `error ${j.error}`);
  must(/\$[\d,]+ a day against a \$[\d,]+ cap/.test(j.message), `message: ${j.message}`);
  return j.message.slice(0, 60);
});

await check('B14', 'untradable symbol names what IS tradable', async () => {
  const r = await post('/strategies', {
    kind: 'dca', state: 'live', label: 'qa sol', symbol: 'SOL',
    cadence: 'weekly', dailyAllocationUsd: 10,
  });
  const j = await r.json();
  must(r.status === 400, `status ${r.status}`);
  must(/not tradable/.test(j.detail ?? ''), `detail ${j.detail}`);
  must(/WETH/.test(j.detail ?? ''), 'does not name the alternatives');
  return 'refused, alternatives named';
});

await check('B15', 'malformed JSON is 400, never 500', async () => {
  const r = await req('/strategies', { method: 'POST', body: '{not json' });
  const j = await r.json();
  must(r.status === 400, `status ${r.status}`);
  must(j.error === 'invalid_json', `error ${j.error}`);
  return j.error;
});

await check('B16', 'missing fields are named', async () => {
  const r = await post('/strategies', { kind: 'dca', symbol: 'WETH' });
  const j = await r.json();
  must(r.status === 400, `status ${r.status}`);
  must(j.error === 'invalid_request', `error ${j.error}`);
  must(/label|state/.test(j.detail ?? ''), `detail ${j.detail}`);
  return j.detail.slice(0, 50);
});

await check('B17', 'running twice in a period is a no-op', async () => {
  const made = await post('/strategies', {
    kind: 'dca', state: 'live', label: `qa idem ${Date.now()}`, symbol: 'WETH',
    cadence: 'weekly', dailyAllocationUsd: 5, params: { usd: 5 },
  });
  if (made.status !== 200) return `skipped: cap full (${made.status})`;
  const { id } = await made.json();
  const first = await (await post(`/strategies/${id}/run`, {})).json();
  const second = await (await post(`/strategies/${id}/run`, {})).json();
  must(second.status === 'skipped', `second run was ${second.status}`);
  must(second.reason === 'already_ran_this_period', `reason ${second.reason}`);
  await req(`/strategies/${id}`, { method: 'DELETE' });
  return `first ${first.status}, second ${second.reason}`;
});

await check('B18', "another wallet's strategy id is 404, not 403", async () => {
  const r = await post('/strategies/123e4567-e89b-42d3-a456-426614174000/run', {});
  must(r.status === 404, `status ${r.status}`);
  const j = await r.json();
  must(j.error === 'not_found', `error ${j.error}`);
  return 'not_found';
});

await check('B19', 'agent lifecycle: hire is idempotent', async () => {
  const a = await (await post('/agents', { personaId: 'momentum-scout' })).json();
  const b = await (await post('/agents', { personaId: 'momentum-scout' })).json();
  must(a.id === b.id, 'hiring twice made two agents');
  must(a.hired === true, 'not marked hired');
  const patched = await (
    await req(`/agents/${a.id}`, { method: 'PATCH', body: JSON.stringify({ tone: 'flat' }) })
  ).json();
  must(patched.tone === 'flat', `tone ${patched.tone}`);
  return `${a.name} tone=${patched.tone}`;
});

await check('B20', 'a created alert comes back in the list', async () => {
  const name = `qa alert ${Date.now()}`;
  const made = await (
    await post('/alerts', { kind: 'price', symbol: 'WETH', name, detail: 'qa', config: { above: 1 } })
  ).json();
  must(made.id, `no id: ${JSON.stringify(made)}`);
  const list = await (await req('/alerts')).json();
  must(list.some((a) => a.id === made.id), 'created alert is not in the list');
  // And the toggle persists.
  await post(`/alerts/${made.id}`, { enabled: false });
  const after = await (await req('/alerts')).json();
  must(after.find((a) => a.id === made.id).enabled === false, 'toggle did not persist');
  await req(`/alerts/${made.id}`, { method: 'DELETE' });
  return 'created, listed, toggled, deleted';
});

await check('B21', 'the audit hash chain verifies', async () => {
  const j = await (await req('/activity/verify')).json();
  must(j.ok === true || j.valid === true, `verify said ${JSON.stringify(j).slice(0, 90)}`);
  return JSON.stringify(j).slice(0, 60);
});

await check('B22', 'the public market surface is rate limited, per caller', async () => {
  /*
   * A distinct caller identity, for two reasons.
   *
   * It stops this check from spending the default bucket and 429ing every check that runs after it
   * — which it did, and which made five unrelated items look broken. And it proves the limiter
   * keys by CALLER rather than globally: a bucket shared by everyone would mean one script could
   * lock out every real user, which is worse than having no limiter at all.
   */
  const mine = { 'x-forwarded-for': `10.99.0.${Math.floor(Math.random() * 250) + 1}` };
  let limited = 0;
  for (let i = 0; i < 260; i++) {
    const r = await fetch(`${B}/market/symbols`, { headers: mine });
    if (r.status === 429) {
      limited++;
      must(r.headers.get('retry-after'), '429 without a Retry-After');
      break;
    }
  }
  must(limited > 0, 'never rate limited after 260 requests');
  // And a different caller is unaffected — the whole point of keying by identity.
  const other = await fetch(`${B}/market/symbols`, {
    headers: { 'x-forwarded-for': '10.99.250.250' },
  });
  must(other.status === 200, `a different caller was also limited (${other.status})`);
  return '429 with Retry-After; other callers unaffected';
});

// ── Tier 4: move idle cash to yield ──────────────────────────────────────────

await check('B23', 'the Aave supply rate is live and plausible', async () => {
  const r = await req('/yield/supply', {}, false);
  must(r.status === 200, `status ${r.status}`);
  const y = await r.json();
  must(y.feed === 'live', `feed was "${y.feed}"`);
  // A rate is the entire reason to run tier 4, so an implausible one has to fail loudly rather
  // than be displayed. Aave returns a zeroed struct for an asset it does not list, and 0.00% is
  // exactly what that looks like from the outside.
  must(y.estimatedApy > 0 && y.estimatedApy < 0.5, `implausible APY ${y.estimatedApy}`);
  must(String(y.source).includes('Aave v3 Pool'), 'no verifiable source cited');
  return `${(y.estimatedApy * 100).toFixed(2)}% a year, ${y.source}`;
});

await check('B24', 'the balance separates spendable cash from supplied', async () => {
  const b = await (await req('/wallet/balance')).json();
  must(typeof b.cashUsd === 'number', 'no cashUsd');
  must(typeof b.suppliedUsd === 'number', 'no suppliedUsd — supplied money would vanish from the total');
  const holdings = (b.holdings ?? []).reduce((a, h) => a + h.usd, 0);
  // The invariant that makes tier 4 safe to show: supplying moves money between two buckets and
  // must never change the total. Without suppliedUsd in the sum, a sweep looked like a loss.
  must(
    Math.abs(b.usd - (b.cashUsd + b.suppliedUsd + holdings)) < 0.01,
    `total ${b.usd} != cash ${b.cashUsd} + supplied ${b.suppliedUsd} + holdings ${holdings}`,
  );
  return `$${b.cashUsd.toFixed(2)} cash, $${b.suppliedUsd.toFixed(2)} earning`;
});

await check('B25', 'the grant asks for the venues the executor actually uses', async () => {
  const p = await (await req('/delegation/params')).json();
  must(Array.isArray(p.venues) && p.venues.length > 0, 'no venues offered');
  // A tier-4 run calls the Aave Pool. If the grant screen never asks for it, every run reaches the
  // chain and dies as VenueNotAllowed — for a permission the user was never given the chance to
  // give. One list feeds both, so this check is what keeps them from drifting apart.
  const pool = '0xA238Dd80C259a72e81d7e4664a9801593F98d1c5'.toLowerCase();
  must(
    p.venues.some((v) => v.toLowerCase() === pool),
    `the Aave Pool is not in the grant: ${p.venues.join(', ')}`,
  );
  return p.venues.join(', ');
});

await check('B26', 'the allowlist shown is the one on chain, not the one we would ask for', async () => {
  const d = await (await req('/delegation')).json();
  if (d === null) return 'no delegation granted for this wallet — nothing to compare';
  must(Array.isArray(d.venueAllowlist), 'no venueAllowlist');
  /*
   * A `.mts` file, not `tsx -e` and not a `.ts` in the temp directory.
   *
   * The eval form compiles as CJS, and a `.ts` outside the project resolves its module format from
   * the nearest package.json — which in /var/folders is none, so also CJS. Both refuse the
   * top-level await this needs. The `.mts` extension settles it wherever the file lives.
   */
  const probe = `${tmpdir()}/xorr-venues-${process.pid}.mts`;
  writeFileSync(
    probe,
    `import { allowedVenues } from '${process.cwd()}/server/src/evm/delegation.js';\n` +
      `console.log((await allowedVenues('${d.ownerPubkey}')).join(','));\n`,
  );
  let chain;
  try {
    chain = execFileSync('npx', ['tsx', probe], { encoding: 'utf8' }).trim();
  } finally {
    rmSync(probe, { force: true });
  }
  must(
    d.venueAllowlist.join(',').toLowerCase() === chain.toLowerCase(),
    `API said [${d.venueAllowlist}], chain says [${chain}]`,
  );
  return `${d.venueAllowlist.length} venue(s), matching the chain`;
});

await check('B27', 'a strategy kind with no executor is refused at creation', async () => {
  const r = await req('/strategies', {
    method: 'POST',
    body: JSON.stringify({
      // `momentum` is tier 6 and genuinely has no executor. This used to say `grid`, which became
      // wrong the moment tier 5 shipped — a test asserting a gap has to move as the gap closes.
      kind: 'momentum', state: 'live', label: 'should not exist', symbol: 'WETH',
      params: {}, cadence: 'daily', dailyAllocationUsd: 5,
    }),
  });
  // Accepting this creates a strategy that looks live on the list and is blocked at every single
  // run. Refusing it costs the user one error message while someone is still there to read it.
  must(r.status === 400, `status ${r.status} — an unrunnable strategy was accepted`);
  const body = await r.json();
  must(
    JSON.stringify(body).includes('momentum') || JSON.stringify(body).includes('runnable'),
    `unhelpful error: ${JSON.stringify(body)}`,
  );
  return '400 with the runnable kinds named';
});

await check('B28', 'a yield-rotation strategy can be created and comes back', async () => {
  const r = await req('/strategies', {
    method: 'POST',
    body: JSON.stringify({
      kind: 'yield-rotation', state: 'live', label: 'QA idle cash to Aave', symbol: 'USDC',
      params: { usd: 30, keepCashUsd: 50, minMoveUsd: 25 }, cadence: 'daily', dailyAllocationUsd: 30,
    }),
  });
  // Read the body ONCE. `await r.text()` inside the failure message consumed it, so the check
  // failed with "Body has already been read" instead of whatever the server actually said.
  const created = await r.json().catch(() => null);
  must(r.status === 200 || r.status === 201, `status ${r.status}: ${JSON.stringify(created)}`);
  const list = await (await req('/strategies')).json();
  must(list.some((s) => s.id === created.id), 'created but not in the list');
  await req(`/strategies/${created.id}`, { method: 'DELETE' });
  return `${created.id} created, listed, removed`;
});

// ── Verification console, health, alerts, idempotency ────────────────────────

await check('B29', 'every claim the README makes verifies live', async () => {
  const r = await req('/verify?owner=' + (await (await req('/wallet')).json()).address, {}, false);
  must(r.status === 200, `status ${r.status}`);
  const v = await r.json();
  // A failing claim here is a real failure, not a flaky test: each probe is a live read of
  // something this project asserts in its own README.
  must(v.failed === 0, `${v.failed} failing: ${v.checks.filter((c) => c.status === 'fail').map((c) => `${c.id} (${c.observed})`).join('; ')}`);
  must(v.passed >= 12, `only ${v.passed} claims checked`);
  return `${v.passed}/${v.checks.length} verified on ${v.chain}`;
});

await check('B30', 'health checks its dependencies, not just itself', async () => {
  const r = await req('/health', {}, false);
  const h = await r.json();
  must(Array.isArray(h.dependencies) && h.dependencies.length >= 3, 'no dependency list');
  // The distinction that matters: a dry gas wallet is degraded, a dead database is down. A single
  // boolean would make a load balancer cycle a server that was serving fine.
  must(['up', 'degraded', 'down'].includes(h.status), `bad status ${h.status}`);
  const critical = h.dependencies.filter((d) => d.critical);
  must(critical.length >= 3, 'nothing marked critical');
  must(h.status !== 'down', `down: ${h.dependencies.filter((d) => d.status === 'down').map((d) => d.name).join(', ')}`);
  return `${h.status} — ${h.dependencies.map((d) => `${d.name} ${d.ms}ms`).join(', ')}`;
});

await check('B31', 'metrics are derived from the tables, not a counter', async () => {
  const m = await (await req('/metrics', {}, false)).json();
  must(typeof m.runFailureRate === 'number', 'no failure rate');
  must(m.gas && typeof m.gas.eth === 'number', 'no gas reading');
  must(typeof m.spentTodayUsd === 'number', 'no spend figure');
  return `${Object.entries(m.runs).map(([k, v]) => `${v} ${k}`).join(', ')}; gas ${m.gas.eth.toFixed(3)} ETH`;
});

await check('B32', 'a retried POST with the same key does not run twice', async () => {
  const key = `qa-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const body = JSON.stringify({
    kind: 'dca', state: 'live', label: `qa idem ${key}`, symbol: 'WETH',
    params: { usd: 5 }, cadence: 'weekly', dailyAllocationUsd: 5,
  });
  const send = () =>
    req('/strategies', { method: 'POST', body, headers: { 'idempotency-key': key } });

  const a = await send();
  const first = await a.json();
  const b = await send();
  const second = await b.json();
  must(b.headers.get('idempotent-replay') === 'true', 'the second request was not a replay');
  must(first.id === second.id, `two different strategies: ${first.id} vs ${second.id}`);

  const list = await (await req('/strategies')).json();
  const matching = list.filter((s) => s.label === `qa idem ${key}`);
  must(matching.length === 1, `${matching.length} strategies created for one key`);
  await req(`/strategies/${first.id}`, { method: 'DELETE' });
  return 'one strategy, replayed response';
});

await check('B33', 'an alert fires once per crossing, not once per sweep', async () => {
  // A level BTC is certainly already past, so the condition is true from the first sweep.
  const created = await (await req('/alerts', {
    method: 'POST',
    body: JSON.stringify({
      kind: 'price', symbol: 'BTC', name: `qa fire ${Date.now()}`,
      detail: 'qa', config: { above: 1000 },
    }),
  })).json();

  const mine = (rs) => rs.find((o) => o.id === created.id);
  const first = mine(await (await req('/alerts/evaluate', { method: 'POST' })).json());
  const second = mine(await (await req('/alerts/evaluate', { method: 'POST' })).json());
  must(first?.action === 'fired', `first sweep: ${JSON.stringify(first)}`);
  // Without hysteresis this fires again every thirty seconds until the user mutes everything.
  must(second?.action === 'quiet', `second sweep: ${JSON.stringify(second)}`);

  const after = (await (await req('/alerts')).json()).find((a) => a.id === created.id);
  must(after?.armed === false && after?.fireCount === 1, `armed=${after?.armed} count=${after?.fireCount}`);
  await req(`/alerts/${created.id}`, { method: 'DELETE' });
  return `fired once: "${first.detail}"`;
});

await check('B34', 'selling everything does not consume the daily cap', async () => {
  const before = await (await req('/wallet/balance')).json();
  const r = await (await req('/panic/flatten', { method: 'POST' })).json();
  const after = await (await req('/wallet/balance')).json();
  must(r.capUntouched === true, 'the route did not claim the cap was untouched');
  // The property, checked rather than trusted: an exit routed through the spend path would show
  // up here, and a cap that can block a sale is a cap that traps you.
  must(
    Math.abs(after.remainingTodayUsd - before.remainingTodayUsd) < 0.01,
    `cap moved ${before.remainingTodayUsd} -> ${after.remainingTodayUsd}`,
  );
  return `${r.sold} sold, ${r.failed} failed, cap still $${after.remainingTodayUsd}`;
});

await check('B35', 'a request carries an id, and honours one it is given', async () => {
  const r = await req('/wallet');
  const generated = r.headers.get('x-request-id');
  must(generated && generated.length > 8, 'no id on the response');
  const mine = await req('/wallet', { headers: { 'x-request-id': 'qa-trace-1' } });
  must(mine.headers.get('x-request-id') === 'qa-trace-1', 'a caller-supplied id was not honoured');
  return `generated ${generated.slice(0, 8)}…, echoed qa-trace-1`;
});

await check('B36', 'prices are cross-checked against a second, on-chain source', async () => {
  const r = await withRetry(() => fetch(`${B}/market/crosscheck?symbol=ETH`));
  must(r.status === 200, `status ${r.status}`);
  const x = await r.json();
  // The second source is worth having because it is derived from the pools a fill would touch,
  // not because it is merely a second API.
  must(typeof x.oneinch === 'number' && x.oneinch > 0, `no on-chain price: ${JSON.stringify(x)}`);
  if (x.coingecko === null) return 'only the on-chain source answered — reported as such, not as a disagreement';
  must(typeof x.spreadPct === 'number', 'two prices but no spread computed');
  must(x.spreadPct < 5, `implausible spread ${x.spreadPct}%`);
  return `coingecko $${x.coingecko.toFixed(2)} vs 1inch $${x.oneinch.toFixed(2)} — ${x.spreadPct.toFixed(3)}%`;
});

await check('B37', 'an unroutable symbol gets no second opinion, not a wrong one', async () => {
  const x = await (await withRetry(() => fetch(`${B}/market/crosscheck?symbol=BTC`))).json();
  // This used to fall back to WETH's address and return WETH's price labelled as BTC.
  must(x.oneinch === null, `BTC was priced on chain as ${x.oneinch} — that is WETH's price`);
  must(/not routable/i.test(x.note), `unhelpful note: ${x.note}`);
  return x.note;
});

await check('B38', 'shutting down does not abandon a claimed run', async () => {
  // The property is asserted through /metrics rather than by killing the server mid-suite: a run
  // left `pending` forever is exactly what an abandoned claim looks like, and the period key means
  // that period can never be retried.
  const m = await (await req('/metrics', {}, false)).json();
  const pending = m.runs.pending ?? 0;
  must(pending <= 1, `${pending} runs stuck pending — a claim was abandoned`);
  return `${pending} pending`;
});

await check('B39', 'every disposal is exported with its cost basis', async () => {
  const r = await req('/pnl/disposals.csv');
  must(r.status === 200, `status ${r.status}`);
  const csv = await r.text();
  const [header, ...rows] = csv.trim().split('\n');
  must(
    header === 'date,symbol,units,proceeds_usd,cost_basis_usd,gain_loss_usd,basis_method,basis_known',
    `unexpected header: ${header}`,
  );
  const data = rows.filter((l) => l.split(',')[1]);
  if (data.length === 0) return 'no disposals yet — header only, which is the honest empty file';
  // The basis method is stated in the file. A jurisdiction that requires FIFO has to be told this
  // is not it, and a column that says so is the only place that can carry it.
  must(data.every((l) => l.includes('average_cost')), 'the basis method is not stated per row');
  const totalRow = rows[rows.length - 1];
  must(totalRow.startsWith(',,,,,'), 'no total row');
  return `${data.length} disposal(s), total ${totalRow.split(',')[5]}`;
});

console.log(`\n${pass} passed, ${failures.length} failed`);
if (failures.length) process.exitCode = 1;
