#!/usr/bin/env bash
# Deploy XorrDelegation + XorrAuditAnchor to X Layer testnet (chain 1952) from the generated deployer (PLAN.md P3.5).
#
#   ./deploy-xlayer-testnet.sh
#
# Reads DEPLOYER_PRIVATE_KEY from ../server/.env.deployer (gitignored, never printed). Refuses to run while the deployer
# holds no OKB, and writes the addresses to deployments/xlayer-testnet.json. The settlement token is the testnet USDC
# (checked to have code by Deploy.s.sol itself).
set -euo pipefail
cd "$(dirname "$0")"

RPC="${XLAYER_TESTNET_RPC:-https://testrpc.xlayer.tech}"
USDC_TESTNET="0xDec90b78111Ba2fc6FC6d84d8B9ec159A2d4b9B3"

set -a; . ../server/.env.deployer; set +a
: "${DEPLOYER_PRIVATE_KEY:?server/.env.deployer has no DEPLOYER_PRIVATE_KEY}"
: "${DEPLOYER_ADDRESS:?server/.env.deployer has no DEPLOYER_ADDRESS}"

[ "$(cast chain-id --rpc-url "$RPC")" = "1952" ] || { echo "$RPC is not X Layer testnet (1952)"; exit 1; }
BAL=$(cast balance "$DEPLOYER_ADDRESS" --rpc-url "$RPC")
if [ "$BAL" = "0" ]; then
  echo "Deployer $DEPLOYER_ADDRESS holds no OKB on X Layer testnet. Fund it (a faucet or a transfer), then re-run."
  exit 2
fi
echo "deployer $DEPLOYER_ADDRESS  balance $(cast from-wei "$BAL") OKB"

# Addresses and hashes come from Foundry's broadcast receipts, never from the script's stdout: forge prints
# "deployed to" during simulation too, so a broadcast that failed afterwards would otherwise record an address with no code.
receipt() { # broadcast-dir field
  python3 -c "import json,sys;r=json.load(open('broadcast/$1/1952/run-latest.json'))['receipts'][0];assert int(r['status'],16)==1,'reverted';print(r['$2'] if '$2'!='blockNumber' else int(r['blockNumber'],16))"
}
# X Layer's RPC can report the pre-deploy nonce for a moment after a receipt; the next script would then reuse it.
wait_nonce() { # expected
  for _ in $(seq 1 30); do [ "$(cast nonce "$DEPLOYER_ADDRESS" --rpc-url "$RPC")" -ge "$1" ] && return 0; sleep 2; done
  echo "the deployer's nonce never reached $1"; exit 1
}
START=$(cast nonce "$DEPLOYER_ADDRESS" --rpc-url "$RPC")
SETTLEMENT_TOKEN="$USDC_TESTNET" forge script script/Deploy.s.sol:Deploy --rpc-url "$RPC" --broadcast --slow
wait_nonce $((START + 1))
forge script script/DeployAnchor.s.sol:DeployAnchor --rpc-url "$RPC" --broadcast --slow
DELEGATION=$(receipt Deploy.s.sol contractAddress); DELEGATION_TX=$(receipt Deploy.s.sol transactionHash); DELEGATION_BLOCK=$(receipt Deploy.s.sol blockNumber)
ANCHOR=$(receipt DeployAnchor.s.sol contractAddress); ANCHOR_TX=$(receipt DeployAnchor.s.sol transactionHash); ANCHOR_BLOCK=$(receipt DeployAnchor.s.sol blockNumber)
for a in "$DELEGATION" "$ANCHOR"; do [ "$(cast code "$a" --rpc-url "$RPC")" != "0x" ] || { echo "no code at $a"; exit 1; }; done

cat > deployments/xlayer-testnet.json <<JSON
{
  "network": "xlayer-testnet",
  "chainId": 1952,
  "deployer": "$DEPLOYER_ADDRESS",
  "sourceCommit": "$(git rev-parse HEAD)",
  "deployedAt": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  "contracts": {
    "XorrDelegation": { "address": "$DELEGATION", "deployTx": "$DELEGATION_TX", "blockNumber": $DELEGATION_BLOCK, "constructorArgs": { "settlementToken": "$USDC_TESTNET" } },
    "XorrAuditAnchor": { "address": "$ANCHOR", "deployTx": "$ANCHOR_TX", "blockNumber": $ANCHOR_BLOCK }
  },
  "explorer": "https://www.oklink.com/xlayer-test/address/$DELEGATION"
}
JSON
echo
echo "DELEGATION_ADDRESS=$DELEGATION"
echo "EXPO_PUBLIC_DELEGATION_ADDRESS=$DELEGATION"
echo "ANCHOR_ADDRESS=$ANCHOR"
echo "wrote deployments/xlayer-testnet.json"
