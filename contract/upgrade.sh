#!/usr/bin/env bash
# Upgrades the live contract in place: same account, same state, new code, so every balance stays where
# it is. The new code must read the old state as is (no change to the stored types; see the migrate
# feature for when one is unavoidable). By default it only prints what it would do; GO=1 sends.
#
#   ./upgrade.sh testnet target/near/luckout.wasm         # dry run
#   GO=1 ./upgrade.sh mainnet ~/Downloads/luckout.wasm    # for real
#
# On mainnet, deploy the reproducible build CI made for the commit being released, so the code hash
# onchain is one anyone can rebuild (README "Upgrades"):
#   gh run download <run id> -n luckout-wasm-<commit>
# Signs as the contract account with its key in ~/.near-credentials/<network> (legacy keychain).
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
NETWORK=${1:?usage: upgrade.sh testnet|mainnet <wasm>}
WASM=${2:?usage: upgrade.sh testnet|mainnet <wasm>}
case "$NETWORK" in
  testnet) APP=${APP:-app.luckout.testnet} RPC=https://rpc.testnet.fastnear.com ;;
  mainnet) APP=${APP:-app.luckout.near} RPC=https://rpc.mainnet.fastnear.com ;;
  *) echo "network must be testnet or mainnet" >&2; exit 1 ;;
esac

# Asks the chain: view_account's code hash, or a view method's result.
rpc() {
  curl -fsS --max-time 20 "$RPC" -H 'Content-Type: application/json' -d "$1"
}
code_hash() {
  rpc "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"query\",\"params\":{\"request_type\":\"view_account\",\"finality\":\"final\",\"account_id\":\"$APP\"}}" |
    python3 -c 'import json,sys; print(json.load(sys.stdin)["result"]["code_hash"])'
}
# A view that reads the whole contract state: it fails if the new code can't read the old state.
reserve() {
  rpc "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"query\",\"params\":{\"request_type\":\"call_function\",\"finality\":\"final\",\"account_id\":\"$APP\",\"method_name\":\"get_reserve\",\"args_base64\":\"e30=\"}}" |
    python3 -c 'import json,sys; r=json.load(sys.stdin); print(bytes(r["result"]["result"]).decode()) if "result" in r and "result" in r["result"] else sys.exit("get_reserve failed: " + json.dumps(r.get("error") or r["result"].get("error")))'
}

want=$(python3 "$here/code-hash.py" "$WASM" | awk '/^code_hash/ {print $2}')
before=$(code_hash)
echo "$APP on $NETWORK"
echo "  onchain now:  $before   (keep this wasm to roll back)"
echo "  deploying:    $want   ($(wc -c < "$WASM" | tr -d ' ') bytes)"
echo "  reserve now:  $(reserve)"
if [ "$before" = "$want" ]; then echo "Already deployed."; exit 0; fi
if [ "${GO:-}" != 1 ]; then echo "Dry run: nothing sent. Re-run with GO=1 to deploy."; exit 0; fi

near contract deploy "$APP" use-file "$WASM" without-init-call network-config "$NETWORK" sign-with-legacy-keychain send
sleep 3
after=$(code_hash)
[ "$after" = "$want" ] || { echo "Onchain code hash is $after, expected $want" >&2; exit 1; }
echo "  deployed:     $after"
echo "  reserve now:  $(reserve)"
