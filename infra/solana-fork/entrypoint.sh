#!/bin/bash
#
# The Solana mainnet fork behind the xorr-solana fork executor (PLAN.md §11).
#
# Starts solana-test-validator cloning real Solana mainnet state:
# - Circle USDC mint: EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v
# - Jupiter v6 program: JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4
# - Token-2022 program: TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb
# - xStocks mints (Backed Finance): NVDAx, TSLAx, AAPLx, MSFTx

set -euo pipefail

DATA="${FORK_DATA_DIR:-/data}"
LEDGER="$DATA/test-ledger"
PORT="${PORT:-8899}"
RPC_URL="${MAINNET_RPC:-https://api.mainnet-beta.solana.com}"

mkdir -p "$DATA"

echo "=========================================================="
echo " Starting Solana Mainnet Fork Validator"
echo " Upstream RPC: $RPC_URL"
echo " Listening on: http://0.0.0.0:$PORT"
echo " Ledger dir:   $LEDGER"
echo "=========================================================="

exec solana-test-validator \
  --url "$RPC_URL" \
  --ledger "$LEDGER" \
  --rpc-port "$PORT" \
  --bind-address 0.0.0.0 \
  --clone EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v \
  --clone-upgradeable-program JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4 \
  --clone-upgradeable-program TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb \
  --clone Xsc9qvGR1efVDFGLrVsmkzv3qi45LTBjeUKSPmx9qEh \
  --clone XsDoVfqeBukxuZHWhdvWHBhgEHjGNst4MLodqsJHzoB \
  --clone XsbEhLAtcf6HdfpFZ5xEMdqW8nfAvcsP5bdudRLJzJp \
  --clone XspzcW1PRtgf6Wj92HCiZdjzKCyFekVD8P5Ueh3dRMX \
  --reset \
  --quiet
