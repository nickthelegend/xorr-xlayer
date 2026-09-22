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
anvil \
  --host 0.0.0.0 --port "${PORT:-8545}" \
  --fork-url "$XLAYER_RPC" --fork-block-number "$BLOCK" \
  --chain-id 196 --accounts 10 --balance 10000 --no-rate-limit --silent \
  --block-time "${BLOCK_TIME_SEC:-12}" \
  --state "$STATE" --state-interval "${STATE_INTERVAL_SEC:-30}" &
ANVIL=$!

# anvil saves the chain on shutdown, so the signal Railway sends has to reach it rather than stop at this shell.
trap 'kill -TERM "$ANVIL" 2>/dev/null; wait "$ANVIL"; exit 0' TERM INT

# And the clock has to be the real one — mined blocks are not enough on their own.
#
# A forked anvil stamps each interval block exactly BLOCK_TIME_SEC after the last, not with the time it is mined, so
# every minute the node spends restarting (and any interval it mines late) is lost for good. On 2026-09-22 the hosted
# fork read 20:40 UTC at 23:28 UTC — 2h48m behind, after two and a half days of redeploys — so the contract's day rolled
# over three hours late: `remainingToday` answered yesterday's spend after midnight, and a fill at 01:08 UTC counted
# toward the previous day. Reproduced locally: a fork resumed after 30s down reads 42s behind, and one
# `evm_setNextBlockTimestamp` puts it back. So: align once the RPC answers, then keep checking. Only ever forwards:
# a block's time cannot go backwards, so a chain that runs ahead is left where it is.
RPC="http://127.0.0.1:${PORT:-8545}"
align() {
  CHAIN_NOW="$(cast block latest -f timestamp --rpc-url "$RPC" 2>/dev/null)" || return 0
  WALL_NOW="$(date +%s)"
  if [ "$((WALL_NOW - CHAIN_NOW))" -gt "${CLOCK_SLACK_SEC:-15}" ]; then
    cast rpc evm_setNextBlockTimestamp "$WALL_NOW" --rpc-url "$RPC" >/dev/null 2>&1 &&
      echo "fork: clock was $((WALL_NOW - CHAIN_NOW))s behind, set the next block to $WALL_NOW"
  fi
}
until cast chain-id --rpc-url "$RPC" >/dev/null 2>&1; do
  kill -0 "$ANVIL" 2>/dev/null || { wait "$ANVIL"; exit $?; }
  sleep 1
done
align
while kill -0 "$ANVIL" 2>/dev/null; do
  sleep "${CLOCK_CHECK_SEC:-60}" & wait $!
  align
done
wait "$ANVIL"
