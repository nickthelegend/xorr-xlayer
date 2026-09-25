#!/usr/bin/env bash
# Deploy XorrDelegation + XorrAuditAnchor to X Layer MAINNET (chain 196) from the generated deployer.
#
#   CONFIRM_MAINNET=yes ./deploy-xlayer-mainnet.sh
#
# The testnet script, pointed at mainnet, and made to say so twice. Reads DEPLOYER_PRIVATE_KEY from
# ../server/.env.deployer (gitignored, never printed). Refuses to run without CONFIRM_MAINNET=yes, refuses while the
# deployer holds under 0.005 OKB, and writes the addresses to deployments/xlayer-mainnet.json. The settlement token is
# Circle's native USDC on X Layer (checked to have code by Deploy.s.sol itself). Both deploys together use ~1.65M gas:
# at X Layer's usual 0.02 gwei, about 0.00003 OKB.
#
# Rehearse first against a local fork of mainnet (nothing real is spent; the fork's deployer is funded by anvil):
#   anvil --fork-url https://rpc.xlayer.tech --chain-id 196 --port 8546 &
#   CONFIRM_MAINNET=yes XLAYER_MAINNET_RPC=http://127.0.0.1:8546 REHEARSAL=1 ./deploy-xlayer-mainnet.sh
set -euo pipefail
cd "$(dirname "$0")"

RPC="${XLAYER_MAINNET_RPC:-https://rpc.xlayer.tech}"
USDC_MAINNET="0xB6CEceAB302E2E4948951eE7843FC24E92933061"
OUT="deployments/xlayer-mainnet.json"
[ "${REHEARSAL:-}" = "1" ] && OUT="deployments/xlayer-mainnet.rehearsal.json"

[ "${CONFIRM_MAINNET:-}" = "yes" ] || { echo "This deploys to X Layer MAINNET. Re-run with CONFIRM_MAINNET=yes if that is the decision."; exit 3; }

set -a; . ../server/.env.deployer; set +a
: "${DEPLOYER_PRIVATE_KEY:?server/.env.deployer has no DEPLOYER_PRIVATE_KEY}"
: "${DEPLOYER_ADDRESS:?server/.env.deployer has no DEPLOYER_ADDRESS}"

[ "$(cast chain-id --rpc-url "$RPC")" = "196" ] || { echo "$RPC is not X Layer mainnet (196)"; exit 1; }
if [ "${REHEARSAL:-}" = "1" ]; then
  [[ "$(cast client --rpc-url "$RPC")" == anvil* ]] || { echo "REHEARSAL=1 runs only against an anvil fork"; exit 1; }
  cast rpc anvil_setBalance "$DEPLOYER_ADDRESS" 0x16345785D8A0000 --rpc-url "$RPC" >/dev/null   # 0.1 OKB, on the fork only
fi
BAL=$(cast balance "$DEPLOYER_ADDRESS" --rpc-url "$RPC")
if [ "$(python3 -c "print(int('$BAL') < 5*10**15)")" = "True" ]; then
  echo "Deployer $DEPLOYER_ADDRESS holds $(cast from-wei "$BAL") OKB on X Layer mainnet; it needs at least 0.005. Send OKB on the X Layer network, then re-run."
  exit 2
fi
echo "deployer $DEPLOYER_ADDRESS  balance $(cast from-wei "$BAL") OKB"

# Addresses and hashes come from Foundry's broadcast receipts, never from the script's stdout: forge prints
# "deployed to" during simulation too, so a broadcast that failed afterwards would otherwise record an address with no code.
receipt() { # broadcast-dir field
  python3 -c "import json,sys;r=json.load(open('broadcast/$1/196/run-latest.json'))['receipts'][0];assert int(r['status'],16)==1,'reverted';print(r['$2'] if '$2'!='blockNumber' else int(r['blockNumber'],16))"
}
# X Layer's RPC can report the pre-deploy nonce for a moment after a receipt; the next script would then reuse it.
wait_nonce() { # expected
  for _ in $(seq 1 30); do [ "$(cast nonce "$DEPLOYER_ADDRESS" --rpc-url "$RPC")" -ge "$1" ] && return 0; sleep 2; done
  echo "the deployer's nonce never reached $1"; exit 1
}
START=$(cast nonce "$DEPLOYER_ADDRESS" --rpc-url "$RPC")
SETTLEMENT_TOKEN="$USDC_MAINNET" forge script script/Deploy.s.sol:Deploy --rpc-url "$RPC" --broadcast --slow
wait_nonce $((START + 1))
forge script script/DeployAnchor.s.sol:DeployAnchor --rpc-url "$RPC" --broadcast --slow
DELEGATION=$(receipt Deploy.s.sol contractAddress); DELEGATION_TX=$(receipt Deploy.s.sol transactionHash); DELEGATION_BLOCK=$(receipt Deploy.s.sol blockNumber)
ANCHOR=$(receipt DeployAnchor.s.sol contractAddress); ANCHOR_TX=$(receipt DeployAnchor.s.sol transactionHash); ANCHOR_BLOCK=$(receipt DeployAnchor.s.sol blockNumber)
for a in "$DELEGATION" "$ANCHOR"; do [ "$(cast code "$a" --rpc-url "$RPC")" != "0x" ] || { echo "no code at $a"; exit 1; }; done

cat > "$OUT" <<JSON
{
  "network": "xlayer",
  "chainId": 196,
  "deployer": "$DEPLOYER_ADDRESS",
  "sourceCommit": "$(git rev-parse HEAD)",
  "deployedAt": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  "contracts": {
    "XorrDelegation": { "address": "$DELEGATION", "deployTx": "$DELEGATION_TX", "blockNumber": $DELEGATION_BLOCK, "constructorArgs": { "settlementToken": "$USDC_MAINNET" } },
    "XorrAuditAnchor": { "address": "$ANCHOR", "deployTx": "$ANCHOR_TX", "blockNumber": $ANCHOR_BLOCK }
  },
  "explorer": "https://www.oklink.com/xlayer/address/$DELEGATION"
}
JSON
echo
echo "DELEGATION_ADDRESS=$DELEGATION"
echo "EXPO_PUBLIC_DELEGATION_ADDRESS=$DELEGATION"
echo "ANCHOR_ADDRESS=$ANCHOR"
echo "wrote $OUT"
