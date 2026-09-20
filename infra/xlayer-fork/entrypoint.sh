#!/bin/sh
#
# The X Layer mainnet fork behind the fork executor, kept across restarts (PLAN.md 3.3).
#
# A restart used to take the fork again at X Layer's head with none of what had been built on it: the
# delegation, both books, the audit anchor and every grant were gone, and the fork executor pointed at
# addresses with no code until someone rebuilt it by hand. Now anvil saves the chain to the volume
# (`--state`: every STATE_INTERVAL_SEC seconds, and on shutdown) and a restart resumes it — forked from
# the same X Layer block as before, which is what keeps the saved state consistent with the upstream it
# reads everything else from. Chain id 196: the executor and the app refuse a fork that answers anything else.
#
# A new REFORKED_AT is the one way to start over: the saved chain is dropped and the fork taken again at
# X Layer's head. Then rebuild it — `cd server && npm run rebuild:fork` (docs/RUNBOOK.md).
set -eu

DATA="${FORK_DATA_DIR:-/data}"
STATE="$DATA/fork-state.json"
BLOCK_FILE="$DATA/fork-block"
MARK="$DATA/reforked-at"
: "${XLAYER_RPC:=https://rpc.xlayer.tech}"
mkdir -p "$DATA"

if [ "$(cat "$MARK" 2>/dev/null || true)" != "${REFORKED_AT:-}" ]; then
  if [ -e "$STATE" ]; then
    echo "fork: REFORKED_AT changed, dropping the saved chain"
  fi
  rm -f "$STATE" "$BLOCK_FILE"
fi

if [ ! -s "$BLOCK_FILE" ]; then
  cast block-number --rpc-url "$XLAYER_RPC" > "$BLOCK_FILE.tmp"
  mv "$BLOCK_FILE.tmp" "$BLOCK_FILE"
fi
printf '%s' "${REFORKED_AT:-}" > "$MARK"
BLOCK="$(cat "$BLOCK_FILE")"

if [ -s "$STATE" ]; then
  echo "fork: resuming the saved chain, forked from X Layer block $BLOCK"
else
  echo "fork: forking X Layer at block $BLOCK"
fi

# A block every few seconds, so the chain's clock moves like a real one.
#
# anvil mines only when something is sent, so an idle fork's `block.timestamp` stands still — and every time-based
# rule in the contract reads that clock. Measured at 00:00 UTC on 2026-09-20: the day rolled over, the executor's own
# tally reset, and `remainingToday(owner)` still answered $4 because the last block was from the previous day. A
# judge opening the live link after midnight would have seen yesterday's spend until somebody traded.
exec anvil \
  --host 0.0.0.0 --port "${PORT:-8545}" \
  --fork-url "$XLAYER_RPC" --fork-block-number "$BLOCK" \
  --chain-id 196 --accounts 10 --balance 10000 --no-rate-limit --silent \
  --block-time "${BLOCK_TIME_SEC:-12}" \
  --state "$STATE" --state-interval "${STATE_INTERVAL_SEC:-30}"
