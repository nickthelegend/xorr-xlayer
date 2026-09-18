/**
 * Subgraph mappings for XorrDelegation.
 *
 * Indexes every grant, revoke, venue change and spend so the app can answer "what has this bot
 * been allowed to do, and what did it actually do" from chain data alone.
 */
import { BigInt, Bytes, Address } from '@graphprotocol/graph-ts';
import {
  Granted,
  Revoked,
  VenueAllowed,
  Spent,
  Closed,
} from '../generated/XorrDelegation/XorrDelegation';
import { Policy, Venue, Spend, DailySpend, Close } from '../generated/schema';

const SECONDS_PER_DAY = BigInt.fromI32(86400);

function policyId(owner: Address): string {
  return owner.toHexString();
}

function loadOrCreatePolicy(owner: Address, timestamp: BigInt, txHash: Bytes): Policy {
  let id = policyId(owner);
  let policy = Policy.load(id);
  if (policy == null) {
    policy = new Policy(id);
    policy.owner = owner;
    policy.delegate = Address.zero();
    policy.dailyCap = BigInt.zero();
    policy.expiresAt = BigInt.zero();
    policy.revoked = false;
    policy.totalSpent = BigInt.zero();
    policy.grantedAt = timestamp;
    policy.grantedTx = txHash;
  }
  return policy as Policy;
}

export function handleGranted(event: Granted): void {
  let policy = loadOrCreatePolicy(event.params.owner, event.block.timestamp, event.transaction.hash);
  policy.delegate = event.params.delegate;
  policy.dailyCap = event.params.dailyCap;
  // graph-ts already decodes uint64 as BigInt — no conversion needed.
  policy.expiresAt = event.params.expiresAt;
  // A re-grant reactivates a previously revoked policy — the app's "Resume agents".
  policy.revoked = false;
  policy.grantedAt = event.block.timestamp;
  policy.grantedTx = event.transaction.hash;
  policy.revokedAt = null;
  policy.revokedTx = null;
  policy.save();
}

export function handleRevoked(event: Revoked): void {
  let policy = loadOrCreatePolicy(event.params.owner, event.block.timestamp, event.transaction.hash);
  policy.revoked = true;
  policy.revokedAt = event.block.timestamp;
  policy.revokedTx = event.transaction.hash;
  policy.save();
}

export function handleVenueAllowed(event: VenueAllowed): void {
  let policy = loadOrCreatePolicy(event.params.owner, event.block.timestamp, event.transaction.hash);
  policy.save();

  let id = event.params.owner.toHexString() + '-' + event.params.venue.toHexString();
  let venue = Venue.load(id);
  if (venue == null) {
    venue = new Venue(id);
    venue.policy = policy.id;
    venue.venue = event.params.venue;
  }
  venue.allowed = event.params.allowed;
  venue.updatedAt = event.block.timestamp;
  venue.save();
}

export function handleSpent(event: Spent): void {
  let policy = loadOrCreatePolicy(event.params.owner, event.block.timestamp, event.transaction.hash);
  policy.totalSpent = policy.totalSpent.plus(event.params.amount);
  policy.save();

  let spend = new Spend(
    event.transaction.hash.toHexString() + '-' + event.logIndex.toString(),
  );
  spend.policy = policy.id;
  spend.owner = event.params.owner;
  spend.delegate = event.params.delegate;
  spend.venue = event.params.venue;
  spend.token = event.params.token;
  spend.amount = event.params.amount;
  spend.spentToday = event.params.spentToday;
  spend.blockNumber = event.block.number;
  spend.timestamp = event.block.timestamp;
  spend.txHash = event.transaction.hash;
  spend.save();

  // Roll up per UTC day, matching the contract's own cap window exactly.
  let day = event.block.timestamp.div(SECONDS_PER_DAY);
  let dailyId = event.params.owner.toHexString() + '-' + day.toString();
  let daily = DailySpend.load(dailyId);
  if (daily == null) {
    daily = new DailySpend(dailyId);
    daily.owner = event.params.owner;
    daily.day = day;
    daily.total = BigInt.zero();
    daily.tradeCount = 0;
  }
  daily.total = daily.total.plus(event.params.amount);
  daily.tradeCount = daily.tradeCount + 1;
  daily.save();
}

/**
 * A position closed. Kept out of `totalSpent` and the daily rollup, exactly as the contract keeps it
 * out of the cap: taking risk off is not spending, and a stop the cap could silence is not a stop.
 *
 * The contract has always emitted `Closed`; this index never listened for it, so a stop-loss that
 * fired left no trace in the history the app tells users they can check without trusting us.
 */
export function handleClosed(event: Closed): void {
  let policy = loadOrCreatePolicy(event.params.owner, event.block.timestamp, event.transaction.hash);
  policy.save();

  let close = new Close(event.transaction.hash.toHexString() + '-' + event.logIndex.toString());
  close.policy = policy.id;
  close.owner = event.params.owner;
  close.delegate = event.params.delegate;
  close.venue = event.params.venue;
  close.token = event.params.token;
  close.amount = event.params.amount;
  close.blockNumber = event.block.number;
  close.timestamp = event.block.timestamp;
  close.txHash = event.transaction.hash;
  close.save();
}
