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

run() { # script contract
  SETTLEMENT_TOKEN="$USDC_TESTNET" forge script "$1" --rpc-url "$RPC" --broadcast --slow 2>&1 | tee /dev/stderr \
    | sed -n "s/.*$2 deployed to: \(0x[0-9a-fA-F]\{40\}\).*/\1/p" | tail -1
}
DELEGATION=$(run script/Deploy.s.sol:Deploy XorrDelegation)
ANCHOR=$(run script/DeployAnchor.s.sol:DeployAnchor XorrAuditAnchor)
[ -n "$DELEGATION" ] && [ -n "$ANCHOR" ] || { echo "a deploy did not report its address"; exit 1; }

cat > deployments/xlayer-testnet.json <<JSON
{
  "network": "xlayer-testnet",
  "chainId": 1952,
  "deployer": "$DEPLOYER_ADDRESS",
  "sourceCommit": "$(git rev-parse HEAD)",
  "deployedAt": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  "contracts": {
    "XorrDelegation": { "address": "$DELEGATION", "constructorArgs": { "settlementToken": "$USDC_TESTNET" } },
    "XorrAuditAnchor": { "address": "$ANCHOR" }
  },
  "explorer": "https://www.oklink.com/xlayer-test/address/$DELEGATION"
}
JSON
echo
echo "DELEGATION_ADDRESS=$DELEGATION"
echo "EXPO_PUBLIC_DELEGATION_ADDRESS=$DELEGATION"
echo "ANCHOR_ADDRESS=$ANCHOR"
echo "wrote deployments/xlayer-testnet.json"
