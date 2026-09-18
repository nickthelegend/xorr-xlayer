import 'dotenv/config';
import { execFileSync } from 'node:child_process';
import { createPublicClient, http, type Address } from 'viem';
import { baseSepolia } from 'viem/chains';
import { DELEGATION_ABI, DELEGATION_ADDRESS } from './src/evm/delegation.js';

const P = 'https://executor-production-1659.up.railway.app';
const OWNER = '0x95A0b368588713011a15f4b1041423f31B08e615' as Address;
const token = execFileSync('npx', ['tsx', 'src/e2e-token.ts', 'test-8958@privy.io'], { encoding: 'utf8' }).trim();
const H = { 'content-type': 'application/json', authorization: `Bearer ${token}` };
const pub = createPublicClient({ chain: baseSepolia, transport: http('https://sepolia.base.org') });

let pass = 0, fail = 0;
const check = (id: string, ok: boolean, detail: string) => {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${id.padEnd(4)} ${detail}`);
  ok ? pass++ : fail++;
};
const get = async (p: string) => { const r = await fetch(P + p, { headers: H }); return { s: r.status, j: await r.json().catch(() => null) as any, t: r.headers }; };
const post = async (p: string, b: unknown) => { const r = await fetch(P + p, { method: 'POST', headers: H, body: JSON.stringify(b) }); return { s: r.status, j: await r.json().catch(() => null) as any }; };

// B1 — /limits must equal the chain, not a database copy.
const chainPolicy = await pub.readContract({ address: DELEGATION_ADDRESS, abi: DELEGATION_ABI, functionName: 'policyOf', args: [OWNER] }) as any;
const chainCap = Number(chainPolicy.dailyCap ?? chainPolicy[1]) / 1e6;
const limits = await get('/limits');
check('B1', limits.j?.dailyCapUsd === chainCap, `/limits ${limits.j?.dailyCapUsd} vs chain ${chainCap}`);

// B2 — a size above the on-chain remaining is refused, naming the number.
const over = await post('/limits/check', { usd: 999999 });
check('B2', over.j?.allowed === false && /\$[\d,]+/.test(over.j?.detail ?? ''), `refused: ${over.j?.detail}`);

// B3 — every check has an observation.
const v = await get('/verify?owner=' + OWNER);
const total = (v.j?.passed ?? 0) + (v.j?.failed ?? 0) + (v.j?.skipped ?? 0);
const allObserved = (v.j?.checks ?? []).every((c: any) => typeof c.observed === 'string' && c.observed.length > 0);
check('B3', total === v.j?.checks?.length && allObserved, `${total} checks, every observed non-empty=${allObserved}`);

// B4 — anchor state is one of four, and the block is real.
const a = await get('/audit/anchor');
let blockReal = true;
if (a.j?.latest) { const b = await pub.getBlock({ blockNumber: BigInt(a.j.latest.blockNo) }).catch(() => null); blockReal = !!b; }
check('B4', ['match','ahead','diverged','none'].includes(a.j?.state) && blockReal, `state=${a.j?.state} block ${a.j?.latest?.blockNo} exists=${blockReal}`);

// B6 — the trail walk distinguishes content from link breaks.
const av = await get('/activity/verify');
check('B6', typeof av.j?.checked === 'number' && ('kind' in (av.j ?? {}) || av.j?.ok === true), `checked=${av.j?.checked} kind=${av.j?.kind ?? 'none'} intact=${av.j?.intact}`);

// B7 — all three venues named, each an amount or a reason.
const rc = await get('/route/compare?in=USDC&out=WETH&amount=100');
const named = (rc.j?.quotes ?? []).map((q: any) => q.venue).sort().join(',');
const everyAnswered = (rc.j?.quotes ?? []).every((q: any) => q.served ? q.outAmount > 0 : (q.reason ?? '').length > 10);
check('B7', named === '1inch,aqua,swapvm' && everyAnswered, `${named}; every answered=${everyAnswered}`);

// B8 — a live quote.
const q = await get('/swap/quote?in=USDC&out=WETH&amount=100');
check('B8', q.s === 200 && q.j?.outAmount > 0 && typeof q.j?.route === 'string', `${q.s} out=${q.j?.outAmount} route=${q.j?.route}`);

// B9 — real price or 503 warming, never 5xx-other, never a hang.
const t0 = Date.now(); const perp = await get('/perp/BTC'); const ms = Date.now() - t0;
check('B9', (perp.s === 200 && perp.j?.markPx > 0 && perp.j?.feed === 'live') || (perp.s === 503 && /warming/.test(JSON.stringify(perp.j))), `${perp.s} in ${ms}ms markPx=${perp.j?.markPx} feed=${perp.j?.feed} unavailable=${(perp.j?.unavailable ?? []).length}`);

// B10 — Aave rate, never a zeroed struct.
const y = await get('/yield/supply');
check('B10', y.s === 200 && y.j?.estimatedApy > 0.001 && y.j?.estimatedApy < 0.5, `${y.s} apy=${y.j?.estimatedApy}`);

// B12 — an agent that is not yours is refused by name.
const foreign = await post('/strategies', { kind: 'dca', state: 'paused', label: 'foreign', symbol: 'WETH', cadence: 'weekly', dailyAllocationUsd: 1, agentId: '123e4567-e89b-42d3-a456-426614174000' });
check('B12', foreign.s === 400 && foreign.j?.error === 'unknown_agent', `${foreign.s} ${foreign.j?.error}`);

// B13 — a decision that names its source.
const gd = await get('/graph/decision?usd=100');
check('B13', gd.s === 200 && typeof gd.j?.rationale === 'string' && gd.j.rationale.length > 10, `${gd.s} ${String(gd.j?.rationale).slice(0, 70)}`);

// B14 — indexed block and error state.
const gh = await get('/graph/health');
check('B14', gh.s === 200 && gh.j?.block > 46_000_000 && gh.j?.healthy === true, `${gh.s} block=${gh.j?.block} healthy=${gh.j?.healthy}`);

// B15 — fills by venue from the database.
const m = await get('/metrics');
check('B15', m.s === 200 && typeof m.j === 'object', `${m.s} ${JSON.stringify(m.j).slice(0, 80)}`);

// B17 — positions read from chain.
const pos = await get('/positions');
check('B17', pos.s === 200 && Array.isArray(pos.j), `${pos.s} ${Array.isArray(pos.j) ? pos.j.length + ' position(s)' : 'not an array'}`);

// B18 — Privy's own policy state.
const pp = await get('/privy/policy');
check('B18', pp.s === 200 && JSON.stringify(pp.j).length > 20, `${pp.s} ${JSON.stringify(pp.j).slice(0, 80)}`);

// B19 — panic preview answers for a wallet with a delegation.
const pv = await get('/panic/preview');
check('B19', pv.s === 200 && 'legs' in (pv.j ?? {}), `${pv.s} legs=${(pv.j?.legs ?? []).length}`);

// B20 — the auth boundary, in both directions.
const noTok = await fetch(P + '/limits');
const agentWithUserTok = await fetch(P + '/agent/whoami', { headers: H });
check('B20', noTok.status === 401 && agentWithUserTok.status === 401, `no-token /limits=${noTok.status}; user-token /agent/whoami=${agentWithUserTok.status}`);

console.log(`\nSection B: ${pass} pass, ${fail} fail`);
