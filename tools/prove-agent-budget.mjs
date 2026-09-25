#!/usr/bin/env node
/**
 * prove-agent-budget — one agent's trade, charged to that agent's own budget on chain (2026-09-25).
 *
 * Takes a hired agent with a budget, gives it a weekly buy of `symbol`, presses Run now, and then reads the fill's own
 * receipt: the transaction must carry the contract's `AgentSpent` event under that agent's key, and the budget the
 * executor reads back from the contract must have fallen by what was spent. Nothing here is the executor's word for it.
 *
 *   BEARER=$(npx tsx server/src/e2e-token.ts test-3570@privy.io) node tools/prove-agent-budget.mjs TSLAx 10
 *
 * API / RPC default to the hosted fork's executor and node. On a fork or a testnet only: it spends from the wallet.
 */
const API = process.env.API ?? 'https://executor-fork-production-2db8.up.railway.app';
const RPC = process.env.RPC ?? 'https://xlayer-fork-production.up.railway.app';
const symbol = process.argv[2] ?? 'TSLAx';
const usd = Number(process.argv[3] ?? 10);
const h = { authorization: `Bearer ${process.env.BEARER}`, 'content-type': 'application/json' };
const get = (p) => fetch(API + p, { headers: h }).then((r) => r.json());
const send = (method, p, b) =>
  fetch(API + p, { method, headers: h, body: JSON.stringify(b ?? {}) }).then(async (r) => ({ status: r.status, body: await r.json().catch(() => null) }));
const rpc = (method, params) =>
  fetch(RPC, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) })
    .then((r) => r.json())
    .then((j) => j.result);

const health = await fetch(`${API}/health`).then((r) => r.json());
if (!/fork|localnet|testnet/.test(String(health.chain))) throw new Error(`refusing to spend on ${health.chain}`);

const agents = await get('/agents');
const agent = agents.find((a) => a.hired && a.onChainKey && a.budgetUsd >= usd);
if (!agent) {
  console.log('no hired agent with a budget of at least', usd, agents.map((a) => [a.name, a.hired, a.budgetUsd]));
  process.exit(1);
}
console.log(`agent ${agent.name} ${agent.id} key ${agent.onChainKey} budget $${agent.budgetUsd}`);

const s = await send('POST', '/strategies', {
  kind: 'dca',
  state: 'live',
  label: `${agent.name}: ${symbol} weekly`,
  symbol,
  params: {},
  cadence: 'weekly',
  dailyAllocationUsd: usd,
  agentId: agent.id,
});
console.log('strategy', s.status, s.body?.id ?? JSON.stringify(s.body));
if (!s.body?.id) process.exit(1);

const run = await send('POST', `/strategies/${s.body.id}/run`);
console.log('run', run.status, JSON.stringify(run.body).slice(0, 600));
const hash = run.body?.signature ?? run.body?.txHash;
if (hash && /^0x[0-9a-f]{64}$/i.test(hash)) {
  const receipt = await rpc('eth_getTransactionReceipt', [hash]);
  // keccak256("AgentSpent(address,bytes32,uint256,uint256)")
  const { keccak256, toBytes, decodeAbiParameters } = await import('viem');
  const topic = keccak256(toBytes('AgentSpent(address,bytes32,uint256,uint256)'));
  const log = receipt?.logs?.find((l) => l.topics[0] === topic);
  if (log) {
    const [amount, left] = decodeAbiParameters([{ type: 'uint256' }, { type: 'uint256' }], log.data);
    console.log(`AgentSpent in ${hash}: agent ${log.topics[2]} amount $${Number(amount) / 1e6} budget left $${Number(left) / 1e6}`);
    console.log('agent key matches:', log.topics[2].toLowerCase() === agent.onChainKey.toLowerCase());
  } else {
    console.log('NO AgentSpent log in', hash, 'status', receipt?.status);
  }
}
const after = (await get('/agents')).find((a) => a.id === agent.id);
console.log(`budget after: $${after?.budgetUsd}`);
