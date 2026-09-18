/**
 * The Graph — the app's on-chain history.
 *
 * The product claim is that you can see exactly what the bot did and take its permission away. A
 * history only our own server holds is a history the user has to take on trust, so the app reads
 * the permission trail from the chain via the subgraph instead.
 *
 * Our Postgres audit log still exists and still matters — it records DECISIONS, including the ones
 * that never produced a transaction ("skipped, spread too wide"). The subgraph records what
 * actually settled. The two answer different questions and the app shows both.
 */
const ENDPOINT =
  process.env.EXPO_PUBLIC_SUBGRAPH_URL ??
  'https://api.studio.thegraph.com/query/1758741/xorr/v0.0.2';

export type OnChainPolicy = {
  owner: string;
  delegate: string;
  dailyCap: string;
  expiresAt: string;
  revoked: boolean;
  totalSpent: string;
};

export type OnChainSpend = {
  id: string;
  amount: string;
  spentToday: string;
  venue: string;
  token: string;
  txHash: string;
  timestamp: string;
  blockNumber: string;
};

export type OnChainDay = { day: string; total: string; tradeCount: number };

async function gql<T>(query: string, variables: Record<string, unknown> = {}): Promise<T> {
  const res = await fetch(ENDPOINT, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ query, variables }),
  });
  if (!res.ok) throw new Error(`subgraph ${res.status}`);
  const json = (await res.json()) as { data?: T; errors?: { message: string }[] };
  if (json.errors?.length) throw new Error(json.errors[0]!.message);
  if (!json.data) throw new Error('subgraph returned no data');
  return json.data;
}

/** USDC base units -> dollars. */
export function unitsToUsd(units: string, decimals = 6): number {
  return Number(units) / 10 ** decimals;
}

/** The permission as the CHAIN records it — not as our database remembers it. */
export async function policyFor(owner: string): Promise<OnChainPolicy | null> {
  const data = await gql<{ policy: OnChainPolicy | null }>(
    `query Policy($id: ID!) { policy(id: $id) {
      owner delegate dailyCap expiresAt revoked totalSpent
    } }`,
    { id: owner.toLowerCase() },
  );
  return data.policy;
}

/** Every trade the bot actually settled, newest first. */
export async function spendsFor(owner: string, first = 50): Promise<OnChainSpend[]> {
  const data = await gql<{ spends: OnChainSpend[] }>(
    `query Spends($owner: Bytes!, $first: Int!) {
      spends(where: { owner: $owner }, orderBy: timestamp, orderDirection: desc, first: $first) {
        id amount spentToday venue token txHash timestamp blockNumber
      }
    }`,
    { owner: owner.toLowerCase(), first },
  );
  return data.spends;
}

/** Spend per UTC day — the same window the contract resets its cap on. */
export async function dailySpendFor(owner: string, first = 30): Promise<OnChainDay[]> {
  const data = await gql<{ dailySpends: OnChainDay[] }>(
    `query Daily($owner: Bytes!, $first: Int!) {
      dailySpends(where: { owner: $owner }, orderBy: day, orderDirection: desc, first: $first) {
        day total tradeCount
      }
    }`,
    { owner: owner.toLowerCase(), first },
  );
  return data.dailySpends;
}

export async function indexerHealth(): Promise<{ block: number; healthy: boolean }> {
  const data = await gql<{ _meta: { block: { number: number }; hasIndexingErrors: boolean } }>(
    `{ _meta { block { number } hasIndexingErrors } }`,
  );
  return { block: data._meta.block.number, healthy: !data._meta.hasIndexingErrors };
}

export const SUBGRAPH_ENDPOINT = ENDPOINT;
