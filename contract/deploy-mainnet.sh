#!/usr/bin/env bash
# Deploys Luckout to NEAR mainnet under luckout.near. Real money: by default it only prints what it
# would do; run with GO=1 to send. New keys go to ~/.near-credentials/mainnet (legacy keychain).
#
#   ./deploy-mainnet.sh                               # dry run
#   GO=1 [OWNER=<owner wallet>] ./deploy-mainnet.sh   # for real
#
# ROOT (luckout.near) must already exist with about 5.4 NEAR and a full-access key in
# ~/.near-credentials/mainnet: it pays for and creates every other account. OWNER, luckout.near
# unless given, alone can pause the contract, fund or withdraw the reserve and proceeds, and set the
# treasury (ADR-0009); it signs those in the admin panel.
set -euo pipefail
cd "$(dirname "$0")"

ROOT=${ROOT:-luckout.near}
OWNER=${OWNER:-$ROOT}
APP=app.$ROOT SERVER=server.$ROOT RELAYER=relayer.$ROOT TREASURY=treasury.$ROOT
# Native USDC on NEAR (Circle).
USDC=17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1
NET=(network-config mainnet)
SIGN=(sign-with-legacy-keychain send)

for a in "$OWNER" "$ROOT"; do
  case "$a" in *.testnet) echo "$a is a testnet account; this deploys to mainnet" >&2; exit 1 ;; esac
done
if [ "${GO:-}" = 1 ]; then echo "Sending to mainnet."; else echo "Dry run: nothing is sent. Re-run with GO=1 to deploy."; fi

run() {
  printf '+ near'; printf ' %q' "$@"; printf '\n'
  if [ "${GO:-}" = 1 ]; then near "$@"; fi
}

cargo near build non-reproducible-wasm

# 1. The accounts under luckout.near. Balances leave room above each account's alert line (Monitor):
#    the contract's storage holds its ~250 KB of code (~2.5 NEAR) plus a NEAR free for records.
for sub in "$APP:3.6" "$SERVER:0.7" "$RELAYER:0.7" "$TREASURY:0.3"; do
  run account create-account fund-myself "${sub%%:*}" "${sub##*:} NEAR" autogenerate-new-keypair save-to-legacy-keychain sign-as "$ROOT" "${NET[@]}" "${SIGN[@]}"
done

# 2. The contract, owned by OWNER, with the server as operator.
run contract deploy "$APP" use-file target/near/luckout.wasm with-init-call new \
  json-args "{\"owner\":\"$OWNER\",\"operator\":\"$SERVER\",\"usdc\":\"$USDC\"}" prepaid-gas '100 Tgas' attached-deposit '0 NEAR' "${NET[@]}" "${SIGN[@]}"

# 3. USDC accounts for the contract (deposits) and the treasury (pulls and refunds).
for who in "$APP" "$TREASURY"; do
  run contract call-function as-transaction "$USDC" storage_deposit json-args "{\"account_id\":\"$who\",\"registration_only\":true}" \
    prepaid-gas '30 Tgas' attached-deposit '0.00125 NEAR' sign-as "$ROOT" "${NET[@]}" "${SIGN[@]}"
done

# 4. The server's key can only call the purchase methods (ADR-0001). Its full-access key stays on
#    this machine; the VM gets only this one.
run account add-key "$SERVER" grant-function-call-access --allowance unlimited --contract-account-id "$APP" \
  --function-names 'purchase, confirm_delivery, fail_purchase' autogenerate-new-keypair save-to-legacy-keychain "${NET[@]}" "${SIGN[@]}"

cat <<NEXT

Next (see deploy/README.md, "Mainnet launch"):
- Mainnet server .env: NEAR_NETWORK=mainnet, LUCKOUT_CONTRACT_ID=$APP, USDC_CONTRACT_ID=$USDC,
  OPERATOR_ACCOUNT_ID=$SERVER with the function-call key from ~/.near-credentials/mainnet/$SERVER/,
  RELAYER_ACCOUNT_ID=$RELAYER and TREASURY_ACCOUNT_ID=$TREASURY with their keys.
- As $OWNER in the admin panel: Treasury → Automatic (\$40 a day), then fund the reserve (\$50).
- Send the treasury its first USDC (about \$25) from the owner wallet: proceeds start empty.
- Remove this machine's key from $ROOT once the launch is done, unless more setup is coming.
NEXT
