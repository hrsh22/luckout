#!/usr/bin/env bash
# Checks that a contract account runs exactly this wasm: the wasm's code hash (code-hash.py) must equal
# the code hash the chain reports for the account. Exits 1, loudly, if they differ.
#
#   gh run download <run id> -n luckout-wasm-<commit>     # CI's reproducible build of that commit
#   ./check-deployed.sh mainnet luckout.wasm               # or: ./check-deployed.sh testnet <wasm>
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
NETWORK=${1:?usage: check-deployed.sh testnet|mainnet <wasm>}
WASM=${2:?usage: check-deployed.sh testnet|mainnet <wasm>}
case "$NETWORK" in
  testnet) APP=${APP:-app.luckout.testnet} RPC=https://rpc.testnet.fastnear.com ;;
  mainnet) APP=${APP:-app.luckout.near} RPC=https://rpc.mainnet.fastnear.com ;;
  *) echo "network must be testnet or mainnet" >&2; exit 1 ;;
esac

built=$(python3 "$here/code-hash.py" "$WASM" | awk '/^code_hash/ {print $2}')
deployed=$(curl -fsS --max-time 20 "$RPC" -H 'Content-Type: application/json' \
  -d "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"query\",\"params\":{\"request_type\":\"view_account\",\"finality\":\"final\",\"account_id\":\"$APP\"}}" |
  python3 -c 'import json,sys; print(json.load(sys.stdin)["result"]["code_hash"])')
echo "built:    $built  ($WASM)"
echo "deployed: $deployed  ($APP on $NETWORK)"
if [ "$built" != "$deployed" ]; then
  echo "MISMATCH: $APP does not run this wasm" >&2
  exit 1
fi
echo "MATCH: $APP runs exactly this wasm"
