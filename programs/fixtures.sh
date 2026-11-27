#!/bin/sh
# Copies ORAO's VRF program and its network state from mainnet into the tests' fixtures, so the tests run
# against ORAO's real code (ADR-0015). Run once before `cargo test`; CI runs it too.
set -eu
cd "$(dirname "$0")/luckout/tests/fixtures"
VRF=VRFzZoJdhFWL8rkvu87LpKM3RbcVezpMEc6X5GVDr7y
STATE=$(solana find-program-derived-address "$VRF" string:orao-vrf-network-configuration | cut -d' ' -f1)
solana program dump -u m "$VRF" orao_vrf.so >/dev/null
solana account -u m "$STATE" --output json-compact -o orao_network_state.json >/dev/null
echo "ORAO program $(wc -c < orao_vrf.so | tr -d ' ') bytes; network state $STATE"
