/**
 * LIVE — the agent decides from the deployed subgraph. No mocked or local data.
 * Run: LIVE=1 npx vitest run src/graph/decide.live.test.ts
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { indexesThisDeployment } from './client.js';

/**
 * These assertions are about the INDEXED deployment.
 *
 * The subgraph describes one contract on one network. Run the executor against a Base mainnet fork
 * and `decide()` correctly declines to read permission from an index about a different contract —
 * so the substantive tests below have nothing to measure. Skipping with the reason stated beats
 * either failing (which would be wrong) or asserting nothing (which would be worse).
 */
const onIndexedDeployment = indexesThisDeployment();
const whenIndexed = onIndexedDeployment ? it : it.skip;
import { decide } from './decide.js';
import { anyLivePolicy, dailySpendFor, health, policyFor, spendsFor, unitsToUsd } from './client.js';

// A known indexed policy on Base Sepolia — present and unrevoked, whatever its expiry.
const OWNER = '0x364d7Bbc139541e0e37450D527ae154B5C292581';
const USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';

/**
 * An owner the chain currently PERMITS, resolved at run time.
 *
 * The acting tests used `OWNER`, whose grant has since expired — so `decide()` began answering
 * "The permission has expired", which is correct, and the suite reported the correct answer as a
 * failure. An expiring fixture cannot be a constant.
 *
 * Still entirely live: the index picks the owner, and every assertion below runs against that
 * owner's real indexed policy and real spends.
 */
let actor: string;

beforeAll(async () => {
  if (!onIndexedDeployment) return;
  const live = await anyLivePolicy();
  expect(
    live,
    'no unexpired policy is indexed on this deployment, so nothing can test the act path — ' +
      'grant one and re-run',
  ).not.toBeNull();
  actor = live!.owner;
}, 60_000);

describe('The Graph is load-bearing for the agent', () => {
  it('the indexer is healthy', async () => {
    const h = await health();
    expect(h.healthy).toBe(true);
    expect(h.block).toBeGreaterThan(46_000_000);
  }, 60_000);

  whenIndexed('the agent reads the policy from indexed data', async () => {
    const p = await policyFor(OWNER);
    expect(p).not.toBeNull();
    expect(unitsToUsd(p!.dailyCap)).toBe(400);
    expect(p!.revoked).toBe(false);
  }, 60_000);

  whenIndexed('DECIDES to act, sized from what the chain says is left today', async () => {
    const d = await decide({ owner: actor, wantUsd: 100, token: USDC });
    expect(d.act, d.act ? '' : d.rationale).toBe(true);
    if (!d.act) return;
    // Never more than a quarter of the remaining cap in one trade.
    expect(d.sizeUsd).toBeLessThanOrEqual(d.observedRemainingUsd * 0.25 + 1e-9);
    expect(d.sizeUsd).toBeGreaterThan(0);
    expect(d.rationale).toContain('on-chain');
  }, 60_000);

  whenIndexed('sizes DOWN when asked for more than the remaining cap allows', async () => {
    /*
     * Against a PERMITTED owner, so the sizing is what gets measured.
     *
     * `if (!d.act) return` used to excuse any refusal as "also a correct outcome" — true in
     * general, and the reason this went on passing after the fixture's grant expired: the one
     * behaviour it names, sizing down, stopped being exercised at all.
     */
    const d = await decide({ owner: actor, wantUsd: 1_000_000, token: USDC });
    expect(d.act, d.act ? '' : d.rationale).toBe(true);
    if (!d.act) return;
    expect(d.sizeUsd).toBeLessThan(1_000_000);
    expect(d.sizeUsd).toBeLessThanOrEqual(d.observedRemainingUsd);
  }, 60_000);

  whenIndexed('refuses for an address with no policy — it does not invent permission', async () => {
    const d = await decide({
      owner: '0x000000000000000000000000000000000000dEaD',
      wantUsd: 100,
      token: USDC,
    });
    expect(d.act).toBe(false);
    if (d.act) return;
    expect(d.reason).toBe('no_policy_onchain');
  }, 60_000);

  whenIndexed('the settled spends it reasons over are real, with verifiable hashes', async () => {
    const spends = await spendsFor(OWNER);
    expect(spends.length).toBeGreaterThan(0);
    for (const s of spends) expect(s.txHash).toMatch(/^0x[0-9a-f]{64}$/);
    const daily = await dailySpendFor(OWNER);
    expect(daily.length).toBeGreaterThan(0);
  }, 60_000);
});

describe('the route is chosen by joining the two indexes', () => {
  it('declines to read permission from an index about a different contract', async () => {
    // The guard itself, always checked: on a fork this is the whole answer, and on the indexed
    // deployment it must NOT fire.
    const d = await decide({ owner: OWNER, wantUsd: 25, token: USDC });
    if (!onIndexedDeployment) {
      expect(d.act).toBe(false);
      if (!d.act) expect(d.reason).toBe('index_is_for_another_deployment');
      return;
    }
    if (!d.act) expect(d.reason).not.toBe('index_is_for_another_deployment');
  }, 30_000);

  whenIndexed('falls to the aggregator, and says why, when no venue index is configured', async () => {
    // Composition has to degrade legibly. Aqua is Base-mainnet-only, so a Sepolia deployment has
    // no venue index — the decision still happens, and the rationale says a book was never
    // considered rather than implying one was looked at and rejected.
    const d = await decide({ owner: actor, wantUsd: 25, token: USDC });
    expect(d.act, `the live policy should still permit a small trade: ${d.act ? '' : d.rationale}`).toBe(true);
    if (!d.act) return;
    expect(d.route.venue).toBe('1inch');
    expect(d.route.why).toMatch(/index|book/i);
    // The reason must reach the user-facing rationale, not be swallowed.
    expect(d.rationale).toContain(d.route.why);
  }, 30_000);
});
