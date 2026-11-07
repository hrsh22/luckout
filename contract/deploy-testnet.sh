#!/usr/bin/env bash
# Deploys Luckout and the test-USDC token to NEAR testnet under a fresh faucet account.
# Usage: OWNER=luckout.testnet ./deploy-testnet.sh   (needs cargo-near and near-cli-rs)
# Keys land in ~/.near-credentials (legacy keychain), never in the repo.
set -euo pipefail
cd "$(dirname "$0")"
OWNER=${OWNER:?set OWNER, e.g. luckout.testnet}
APP=app.$OWNER USDC=usdc.$OWNER SERVER=server.$OWNER
NET=(network-config testnet)
SIGN=(sign-with-legacy-keychain send)

call() { # contract method args deposit gas signer
  near contract call-function as-transaction "$1" "$2" json-args "$3" prepaid-gas "$5" attached-deposit "$4" sign-as "$6" "${NET[@]}" "${SIGN[@]}"
}

cargo near build non-reproducible-wasm
(cd test-usdc && cargo near build non-reproducible-wasm)

near account create-account sponsor-by-faucet-service "$OWNER" autogenerate-new-keypair save-to-legacy-keychain "${NET[@]}" create
for sub in "$APP:3.5" "$USDC:2.5" "$SERVER:1"; do
  near account create-account fund-myself "${sub%%:*}" "${sub##*:} NEAR" autogenerate-new-keypair save-to-legacy-keychain sign-as "$OWNER" "${NET[@]}" "${SIGN[@]}"
done

near contract deploy "$USDC" use-file target/near/test_usdc/test_usdc.wasm with-init-call new json-args '{}' prepaid-gas '30 Tgas' attached-deposit '0 NEAR' "${NET[@]}" "${SIGN[@]}"
near contract deploy "$APP" use-file target/near/luckout.wasm with-init-call new \
  json-args "{\"owner\":\"$OWNER\",\"operator\":\"$SERVER\",\"usdc\":\"$USDC\"}" prepaid-gas '100 Tgas' attached-deposit '0 NEAR' "${NET[@]}" "${SIGN[@]}"

# The contract must be registered on the token to receive deposits.
call "$USDC" storage_deposit "{\"account_id\":\"$APP\",\"registration_only\":true}" '0.01 NEAR' '30 Tgas' "$OWNER"

# Refund Reserve: 500 tUSDC from the faucet (100 per call), giving a Discount Cap of 100.
for _ in 1 2 3 4 5; do call "$USDC" faucet '{}' '0 NEAR' '30 Tgas' "$OWNER"; done
call "$USDC" ft_transfer_call "{\"receiver_id\":\"$APP\",\"amount\":\"500000000\",\"msg\":\"reserve\"}" '1 yoctoNEAR' '100 Tgas' "$OWNER"

# The server's key can only call the purchase methods (ADR-0001).
near account add-key "$SERVER" grant-function-call-access --allowance unlimited --contract-account-id "$APP" \
  --function-names 'purchase, confirm_delivery, fail_purchase' autogenerate-new-keypair save-to-legacy-keychain "${NET[@]}" "${SIGN[@]}"

echo "Done. Put the new function-call key from ~/.near-credentials/testnet/$SERVER/ into OPERATOR_PRIVATE_KEY in .env."
