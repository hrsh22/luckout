#!/usr/bin/env bash
# Deploys the server on the VM, as the site user. Runs from the CI deploy key's forced command in
# ~/.ssh/authorized_keys (which fixes the branch per site, so CI can't choose it), or by hand:
#   bash deploy/remote-deploy.sh testnet     # luckout-testnet-api.gamified.trade
#   bash deploy/remote-deploy.sh main        # luckout-api.gamified.trade (mainnet)
set -euo pipefail
branch="${1:?usage: remote-deploy.sh <branch>}"
cd "$(dirname "$0")/.."
. ~/.nvm/nvm.sh >/dev/null
port=$(grep -E '^PORT=' .env | cut -d= -f2)
network=$(grep -E '^NEAR_NETWORK=' .env | cut -d= -f2)
# A site only ever runs its own branch: testnet code on mainnet (or the reverse) is refused.
case "$branch:$network" in
  testnet:testnet | main:mainnet) ;;
  *) echo "refusing to deploy $branch on a $network site" >&2; exit 1 ;;
esac
git fetch -q origin "$branch"
git checkout -q -B "$branch" "origin/$branch"
pnpm install --frozen-lockfile --filter @luckout/server... >/dev/null
pm2 startOrReload deploy/ecosystem.config.cjs --update-env >/dev/null && pm2 save >/dev/null
sleep 5
curl -fsS -o /dev/null -w "$network $branch $(git rev-parse --short HEAD): health %{http_code}\n" "http://127.0.0.1:$port/health"
