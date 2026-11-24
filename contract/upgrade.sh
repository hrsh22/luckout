#!/usr/bin/env bash
# Upgrades a live contract in place: same account, same state, new code, so every balance stays where
# it is. The new code must read the old state as is (no change to the stored types; see the migrate
# feature for when one is unavoidable). By default it only prints what it would do; GO=1 sends.
#
#   CHECK_ACCOUNT=<account> CHECK_PURCHASE=<id> ./upgrade.sh staging <CI run id>          # dry run
#   GO=1 CHECK_ACCOUNT=<account> CHECK_PURCHASE=<id> ./upgrade.sh staging <CI run id>     # for real
#   GO=1 CHECK_ACCOUNT=<account> CHECK_PURCHASE=<id> ./upgrade.sh production <CI run id>  # then this
#   CHECK_ACCOUNT=<account> CHECK_PURCHASE=<id> ./upgrade.sh testnet <wasm>               # testnet: any build
#
# Targets (ADR-0010): testnet is app.luckout.testnet, staging is app.staging.luckout.near (real money,
# small amounts), production is app.luckout.near (every customer's Balance). Staging and production
# are both on mainnet, so the target names the contract, never the network: production is reached
# only by its own name.
#
# On staging and production the code is CI's reproducible build (the contract-wasm job), so the code hash
# onchain is one anyone can rebuild (README "Upgrades"). The script takes the CI run's id, checks that run
# was a successful push to staging or main at that branch's current commit (a PR's run builds a merge commit
# no branch has, so its code hash can't be rebuilt), and downloads its luckout-wasm-<commit> itself. A wasm
# file is taken there only for a dry run, such as the check after a rollback.
#
# CHECK_ACCOUNT is an account with a Balance on that contract, CHECK_PURCHASE a settled purchase (a
# Lucky Buy is best): neither should change during the upgrade, so pick your own. They and the Game
# Versions are read before and after; reading them differently, or not at all, means the new code
# misreads the stored records.
#
# GO=1 refuses while the API's public /status says sales are open: Stop sales in Admin first. When /status
# can't be read it says so and goes on.
#
# Before deploying, the code on chain is saved to $SAVE_DIR (default ~/luckout-wasm), named by target
# and code hash. Rolling back is deploying that file with `near contract deploy`, whose exact command is
# printed when a check fails; not with this script, which first reads the records with the code on chain.
#
# Needs gh (signed in) for a run id. Signs as the contract account with its key in ~/.near-credentials/<network>
# (legacy keychain).
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
usage="usage: upgrade.sh staging|production <CI run id>, or testnet <wasm>"
TARGET=${1:?$usage}
FROM=${2:?$usage}
case "$TARGET" in
  testnet) APP=app.luckout.testnet NETWORK=testnet RPC=https://rpc.testnet.fastnear.com STATUS= ;;
  staging) APP=app.staging.luckout.near NETWORK=mainnet RPC=https://rpc.mainnet.fastnear.com STATUS=https://staging-api.luckout.wtf/status ;;
  production) APP=app.luckout.near NETWORK=mainnet RPC=https://rpc.mainnet.fastnear.com STATUS=https://api.luckout.wtf/status ;;
  mainnet) echo "mainnet runs two contracts: say staging or production" >&2; exit 1 ;;
  *) echo "$usage" >&2; exit 1 ;;
esac
: "${CHECK_ACCOUNT:?set CHECK_ACCOUNT to an account with a Balance on $APP}"
: "${CHECK_PURCHASE:?set CHECK_PURCHASE to the id of a settled purchase on $APP}"
SAVE_DIR=${SAVE_DIR:-$HOME/luckout-wasm}

if [[ "$FROM" =~ ^[0-9]+$ ]]; then
  # gh finds the repository from the clone this script is in.
  run=$(cd "$here" && gh run view "$FROM" --json event,headBranch,headSha,conclusion --jq '[.event, .headBranch, .headSha, .conclusion] | join(" ")') || run=""
  read -r event branch sha conclusion <<<"$run"
  if [ "${event:-}" != push ] || { [ "${branch:-}" != staging ] && [ "${branch:-}" != main ]; } || [ "${conclusion:-}" != success ]; then
    echo "CI run $FROM isn't a successful push to staging or main (${run:-gh found no such run}); nothing was sent." >&2; exit 1
  fi
  tip=$(cd "$here" && gh api "repos/{owner}/{repo}/commits/$branch" --jq .sha)
  if [ "$sha" != "$tip" ]; then
    echo "CI run $FROM built $sha, but $branch is now at $tip: use the run of the commit being released; nothing was sent." >&2; exit 1
  fi
  dl=$(mktemp -d)
  trap 'rm -rf "$dl"' EXIT
  (cd "$here" && gh run download "$FROM" -n "luckout-wasm-$sha" -D "$dl")
  WASM="$dl/luckout.wasm"
  echo "CI run $FROM: push to $branch at $sha"
elif [ "$TARGET" = testnet ] || [ "${GO:-}" != 1 ]; then
  WASM=$FROM
else
  echo "On $TARGET, GO=1 deploys only CI's build: give the CI run's id (gh run list --branch staging --event push); nothing was sent." >&2; exit 1
fi
[ -f "$WASM" ] || { echo "No wasm at $WASM" >&2; exit 1; }

# Asks the chain about the contract account: its code hash, its code, or a view method's result.
rpc() {
  curl -fsS --max-time 30 "$RPC" -H 'Content-Type: application/json' \
    -d "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"query\",\"params\":{\"request_type\":\"$1\",\"finality\":\"final\",\"account_id\":\"$APP\"${2:-}}}"
}
code_hash() {
  rpc view_account | python3 -c 'import json,sys; print(json.load(sys.stdin)["result"]["code_hash"])'
}
# A view method's result as compact JSON. It fails, with the chain's error, if the code can't run it.
view() {
  local args
  args=$(python3 -c 'import base64,sys; print(base64.b64encode(sys.argv[1].encode()).decode())' "$2")
  rpc call_function ",\"method_name\":\"$1\",\"args_base64\":\"$args\"" | python3 -c '
import json, sys
r = json.load(sys.stdin)
res = r.get("result") or {}
if "result" not in res:
    sys.exit(sys.argv[1] + " failed: " + json.dumps(r.get("error") or res.get("error")))
print(json.dumps(json.loads(bytes(res["result"])), sort_keys=True, separators=(",", ":")))' "$1"
}
# What the stored records read as: one account, one purchase, the Game Versions. get_reserve alone
# isn't enough: it reads the contract's root, never an Account or a Purchase.
records() {
  view get_account "{\"account_id\":\"$CHECK_ACCOUNT\"}" || return 1
  view get_purchase "{\"purchase_id\":$CHECK_PURCHASE}" || return 1
  view get_game_versions '{}' || return 1
}
hash_of() {
  python3 "$here/code-hash.py" "$1" | awk '/^code_hash/ {print $2}'
}

want=$(hash_of "$WASM")
before=$(code_hash)
echo "$APP ($TARGET, on $NETWORK)"
echo "  onchain now:  $before"
echo "  deploying:    $want   ($(wc -c < "$WASM" | tr -d ' ') bytes)"
reserve=$(view get_reserve '{}')
echo "  reserve now:  $reserve"
# Whether new purchases may start, from the API's public /status: open, closed, or unknown when it can't be read.
sales=unknown
if [ -n "$STATUS" ]; then
  sales=$(curl -fsS --max-time 15 "$STATUS" | python3 -c 'import json,sys; print("open" if json.load(sys.stdin)["open"] else "closed")' 2>/dev/null) || sales=unknown
  echo "  sales:        $sales   ($STATUS)"
fi
old=$(records) || { echo "Can't read the records to compare; nothing was sent." >&2; exit 1; }
if [ "$(sed -n 1p <<<"$old")" = null ] || [ "$(sed -n 2p <<<"$old")" = null ]; then
  echo "$CHECK_ACCOUNT or purchase $CHECK_PURCHASE doesn't exist on $APP: pick ones that do." >&2; exit 1
fi
echo "  account:      $(sed -n 1p <<<"$old")"
echo "  purchase:     $(sed -n 2p <<<"$old")"
echo "  versions:     $(sed -n 3p <<<"$old" | python3 -c 'import json,sys; print(", ".join(v["name"] for v in json.load(sys.stdin)))')"
if [ "$before" = "$want" ]; then echo "Already deployed."; exit 0; fi

# The code being replaced, kept by its hash: the only way back if the new code misreads the state.
mkdir -p "$SAVE_DIR"
saved="$SAVE_DIR/$TARGET-$before.wasm"
rpc view_code | python3 -c 'import base64,json,sys; open(sys.argv[1], "wb").write(base64.b64decode(json.load(sys.stdin)["result"]["code_base64"]))' "$saved"
[ "$(hash_of "$saved")" = "$before" ] || { echo "The saved code's hash isn't $before; nothing was sent." >&2; exit 1; }
echo "  saved:        $saved   (the code to roll back to)"
if [ "${GO:-}" != 1 ]; then echo "Dry run: nothing sent. Stop sales in Admin, then re-run with GO=1 to deploy."; exit 0; fi
# Nothing is admitted while the code changes. An API that doesn't answer doesn't hold up an upgrade the owner needs now.
if [ "$sales" = open ]; then echo "Sales are open on $TARGET: Stop sales in Admin first; nothing was sent." >&2; exit 1; fi
if [ -n "$STATUS" ] && [ "$sales" = unknown ]; then echo "  (couldn't read whether sales are stopped; going on)"; fi

# The way back: deploy the saved code directly, then let a dry run on it prove the records read again.
way_back() {
  echo "Roll back now: near contract deploy $APP use-file \"$saved\" without-init-call network-config $NETWORK sign-with-legacy-keychain send" >&2
  echo "Then check it: CHECK_ACCOUNT=$CHECK_ACCOUNT CHECK_PURCHASE=$CHECK_PURCHASE $0 $TARGET \"$saved\" (a dry run; it should end \"Already deployed.\")" >&2
}

near contract deploy "$APP" use-file "$WASM" without-init-call network-config "$NETWORK" sign-with-legacy-keychain send
# The new hash shows only once the deploy is final, a few seconds after it lands.
for _ in 1 2 3 4 5; do
  sleep 3
  after=$(code_hash) || after="unreadable"
  [ "$after" = "$want" ] && break
done
[ "$after" = "$want" ] || { echo "Onchain code hash is still $after, expected $want. If the new code is running anyway:" >&2; way_back; exit 1; }
echo "  deployed:     $after"
new=$(records) || { echo "The new code can't read the stored records." >&2; way_back; exit 1; }
if [ "$new" != "$old" ]; then
  diff <(echo "$old") <(echo "$new") >&2 || true
  echo "The records read differently after the upgrade. Unless they changed on chain in the meantime:" >&2
  way_back
  exit 1
fi
reserve=$(view get_reserve '{}') || { echo "The new code can't read the contract's state." >&2; way_back; exit 1; }
echo "  reserve now:  $reserve"
echo "The account, the purchase and the Game Versions read the same as before. Restart sales in Admin."
