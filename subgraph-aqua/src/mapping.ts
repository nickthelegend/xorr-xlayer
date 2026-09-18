/**
 * Aqua liquidity mappings.
 *
 * Aqua never holds tokens: a "balance" here is a maker's standing commitment to pay out of their
 * own wallet, moved by Pulled and Pushed. So depth is derived from the flow, not read from a
 * contract balance — a book that looks funded on chain would be a book that had escrowed, which
 * is the thing Aqua exists not to do.
 */
import { BigInt, Bytes, ethereum } from '@graphprotocol/graph-ts';
import { Shipped, Docked, Pulled, Pushed } from '../generated/Aqua/Aqua';
import { Strategy, StrategyBalance, Flow, AquaStats } from '../generated/schema';

const STATS_ID = 'aqua';

function stats(): AquaStats {
  let s = AquaStats.load(STATS_ID);
  if (s == null) {
    s = new AquaStats(STATS_ID);
    s.strategiesShipped = 0;
    s.strategiesOpen = 0;
    s.flowCount = 0;
    s.lastActivityAt = BigInt.zero();
  }
  return s as AquaStats;
}

function balanceOf(strategyHash: Bytes, token: Bytes): StrategyBalance {
  const id = strategyHash.toHexString() + '-' + token.toHexString();
  let b = StrategyBalance.load(id);
  if (b == null) {
    b = new StrategyBalance(id);
    b.strategy = strategyHash.toHexString();
    b.token = token;
    b.amount = BigInt.zero();
  }
  return b as StrategyBalance;
}

function recordFlow(
  event: ethereum.Event,
  strategyHash: Bytes,
  token: Bytes,
  amount: BigInt,
  kind: string,
): void {
  const id = event.transaction.hash.toHexString() + '-' + event.logIndex.toString();
  const f = new Flow(id);
  f.strategy = strategyHash.toHexString();
  f.kind = kind;
  f.token = token;
  f.amount = amount;
  f.blockNumber = event.block.number;
  f.timestamp = event.block.timestamp;
  f.txHash = event.transaction.hash;
  f.save();

  const s = stats();
  s.flowCount = s.flowCount + 1;
  s.lastActivityAt = event.block.timestamp;
  s.save();

  const st = Strategy.load(strategyHash.toHexString());
  if (st != null && kind == 'PULL') {
    // One fill is one pull out plus one push in. Counting pulls counts fills.
    st.fillCount = st.fillCount + 1;
    st.save();
  }
}

export function handleShipped(event: Shipped): void {
  const id = event.params.strategyHash.toHexString();
  let st = Strategy.load(id);
  const isNew = st == null;
  if (st == null) st = new Strategy(id);

  st.maker = event.params.maker;
  st.app = event.params.app;
  st.strategyHash = event.params.strategyHash;
  st.encoded = event.params.strategy;
  st.open = true;
  st.shippedAt = event.block.timestamp;
  st.shippedTx = event.transaction.hash;
  st.dockedAt = null;
  if (isNew) st.fillCount = 0;
  st.save();

  const s = stats();
  if (isNew) s.strategiesShipped = s.strategiesShipped + 1;
  s.strategiesOpen = s.strategiesOpen + 1;
  s.lastActivityAt = event.block.timestamp;
  s.save();
}

export function handleDocked(event: Docked): void {
  const st = Strategy.load(event.params.strategyHash.toHexString());
  if (st == null) return;
  st.open = false;
  st.dockedAt = event.block.timestamp;
  st.save();

  const s = stats();
  if (s.strategiesOpen > 0) s.strategiesOpen = s.strategiesOpen - 1;
  s.lastActivityAt = event.block.timestamp;
  s.save();
}

export function handlePulled(event: Pulled): void {
  const b = balanceOf(event.params.strategyHash, event.params.token);
  b.amount = b.amount.minus(event.params.amount);
  b.updatedAt = event.block.timestamp;
  b.save();
  recordFlow(event, event.params.strategyHash, event.params.token, event.params.amount, 'PULL');
}

export function handlePushed(event: Pushed): void {
  const b = balanceOf(event.params.strategyHash, event.params.token);
  b.amount = b.amount.plus(event.params.amount);
  b.updatedAt = event.block.timestamp;
  b.save();
  recordFlow(event, event.params.strategyHash, event.params.token, event.params.amount, 'PUSH');
}
