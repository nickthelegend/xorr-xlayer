/**
 * How much gas the bot has left, and whether that is enough to keep working.
 *
 * The delegate pays for every fill out of its own wallet. When it runs dry every strategy
 * fails inside the venue call, which surfaces to the user as "the venue rejected the order"
 * — a sentence that sends them looking at the market instead of at us. It is the most
 * predictable outage this system has and nothing was watching for it.
 *
 * ## Why this is not in `routes/ops.ts`
 *
 * It used to be, and `executor/run.ts` imported it from there — so the EXECUTOR depended on
 * an HTTP route module, which depends on the auth middleware, which refuses to load without
 * Privy credentials. The visible symptom was a unit test for a pure string function failing
 * with "PRIVY_APP_ID and PRIVY_APP_SECRET are required". A chain read belongs next to the
 * chain, and the route reads it from here.
 */
import { formatEther } from 'viem';
import { publicClient } from './client.js';
import { delegatePublicKey } from './delegation.js';

/** Below this the delegate cannot reliably land a transaction. */
export const GAS_FLOOR_ETH = 0.01;

export async function gasStatus(): Promise<{
  eth: number;
  enough: boolean;
  floor: number;
  address: `0x${string}`;
}> {
  const eth = Number(formatEther(await publicClient.getBalance({ address: delegatePublicKey })));
  return { eth, enough: eth >= GAS_FLOOR_ETH, floor: GAS_FLOOR_ETH, address: delegatePublicKey };
}
