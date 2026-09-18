#!/bin/sh
#
# The Base mainnet fork behind the fork executor, kept across restarts (PLAN.md 3.3).
#
# A restart used to take the fork again at Base's head with none of what had been built on it: the
# delegation, both books, the audit anchor and every grant were gone, and the fork executor pointed at
# addresses with no code until someone rebuilt it by hand. Now anvil saves the chain to the volume
# (`--state`: every STATE_INTERVAL_SEC seconds, and on shutdown) and a restart resumes it — forked from
# the same Base block as before, which is what keeps the saved state consistent with the upstream it
# reads everything else from.
#
# A new REFORKED_AT is the one way to start over: the saved chain is dropped and the fork taken again at
# Base's head. Then rebuild it — `cd server && npm run rebuild:fork` (docs/RUNBOOK.md).
set -eu

DATA="${FORK_DATA_DIR:-/data}"
STATE="$DATA/fork-state.json"
BLOCK_FILE="$DATA/fork-block"
MARK="$DATA/reforked-at"
: "${BASE_RPC:?BASE_RPC is required: the Base mainnet RPC this forks}"
mkdir -p "$DATA"

if [ "$(cat "$MARK" 2>/dev/null || true)" != "${REFORKED_AT:-}" ]; then
  if [ -e "$STATE" ]; then
    echo "fork: REFORKED_AT changed, dropping the saved chain"
  fi
  rm -f "$STATE" "$BLOCK_FILE"
fi

if [ ! -s "$BLOCK_FILE" ]; then
  cast block-number --rpc-url "$BASE_RPC" > "$BLOCK_FILE.tmp"
  mv "$BLOCK_FILE.tmp" "$BLOCK_FILE"
fi
printf '%s' "${REFORKED_AT:-}" > "$MARK"
BLOCK="$(cat "$BLOCK_FILE")"

if [ -s "$STATE" ]; then
  echo "fork: resuming the saved chain, forked from Base block $BLOCK"
else
  echo "fork: forking Base at block $BLOCK"
fi

exec anvil \
  --host 0.0.0.0 --port "${PORT:-8545}" \
  --fork-url "$BASE_RPC" --fork-block-number "$BLOCK" \
  --chain-id 8453 --accounts 10 --balance 10000 --no-rate-limit --silent \
  --state "$STATE" --state-interval "${STATE_INTERVAL_SEC:-30}"
