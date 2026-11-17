#!/usr/bin/env bash
# Deploys the server on the VM, as the site user. Runs from the CI deploy key's forced command in
# ~/.ssh/authorized_keys (which fixes the branch per site, so CI can't choose it), or by hand:
#   bash deploy/remote-deploy.sh testnet     # luckout-testnet-api.gamified.trade
#   bash deploy/remote-deploy.sh main        # luckout-api.gamified.trade (mainnet)
#   bash deploy/remote-deploy.sh staging     # staging-api.luckout.wtf (mainnet, its own contract)
# CI sends the commit it tested as the SSH command, which the forced command leaves in
# SSH_ORIGINAL_COMMAND; then the branch must still point at it. By hand, there's no such check.
# Going back, by hand only: a second argument names an earlier commit of the same branch to run instead,
#   bash deploy/remote-deploy.sh staging <commit>
set -euo pipefail
branch="${1:?usage: remote-deploy.sh <branch> [earlier commit to go back to]}"
back="${2:-}"
cd "$(dirname "$0")/.."
. ~/.nvm/nvm.sh >/dev/null
port=$(grep -E '^PORT=' .env | cut -d= -f2)
network=$(grep -E '^NEAR_NETWORK=' .env | cut -d= -f2)
# A site only ever runs its own branch: testnet code on mainnet (or the reverse) is refused, and so is
# staging code on production (or the reverse), which share a network but never a site user.
case "$branch:$network:$(id -un)" in
  testnet:testnet:luckout-testnet-api | main:mainnet:luckout-api | staging:mainnet:luckout-staging-api) ;;
  *) echo "refusing to deploy $branch on $(id -un), a $network site" >&2; exit 1 ;;
esac
# A file edited by hand on the VM would ride along into the new checkout unseen, and the commit this
# script reports would no longer be what runs.
edited=$(git status --porcelain --untracked-files=no)
if [ -n "$edited" ]; then
  echo "refusing: tracked files were edited on this site; commit them through a PR or drop them (git checkout -- .):" >&2
  echo "$edited" >&2
  exit 1
fi
git fetch -q origin "$branch"
tested="${SSH_ORIGINAL_COMMAND:-}"
if [[ "$tested" =~ ^[0-9a-f]{40}$ ]] && [ "$(git rev-parse "origin/$branch")" != "$tested" ]; then
  echo "refusing: origin/$branch is no longer $tested, the commit CI tested" >&2; exit 1
fi
target="origin/$branch"
if [ -n "$back" ]; then
  # Going back is only ever to an earlier commit of this site's own branch.
  target=$(git rev-parse --verify -q "$back^{commit}") || { echo "refusing: $back is not a commit in this clone" >&2; exit 1; }
  git merge-base --is-ancestor "$target" "origin/$branch" || { echo "refusing: $back is not an earlier commit of origin/$branch" >&2; exit 1; }
fi
previous=$(git rev-parse HEAD)
git checkout -q -B "$branch" "$target"
commit=$(git rev-parse HEAD)
if ! pnpm install --frozen-lockfile --filter @luckout/server... >/dev/null; then
  # The running server still has the old code loaded. Put the old source back, so that if it restarts
  # by itself it doesn't start the new source on the old dependencies.
  git checkout -q -B "$branch" "$previous"
  pnpm install --frozen-lockfile --filter @luckout/server... >/dev/null || true
  echo "failed: installing dependencies for $commit failed; nothing was restarted, and the source is back at $previous" >&2
  exit 1
fi
# From here the old process is stopped, so a failure says how to go back. Going back is a human's call,
# not this script's: a migration the new code already ran stays in the database (deploy/README.md).
failed() {
  echo "failed: $1" >&2
  [ "$previous" = "$commit" ] || echo "to go back: bash deploy/remote-deploy.sh $branch $previous   (deploy/README.md, \"Going back\")" >&2
  exit 1
}
# "pm2 pid" can print notices first (its daemon starting, a version mismatch); the pid is its last line.
before=$(pm2 pid luckout-api | tail -n 1)
# Never "a && b" here: under "set -e" a failing "a" in such a list doesn't stop the script, and the old
# process went on answering /health while the deploy reported success.
pm2 startOrReload deploy/ecosystem.config.cjs --update-env >/dev/null || failed "pm2 could not reload the server for $commit"
pm2 save >/dev/null || failed "pm2 save failed, so after a reboot pm2 would bring back its old process list"
started=$(pm2 pid luckout-api | tail -n 1)
sleep 5
# The port opens a few seconds before the server answers, and a request in that gap is never answered:
# without a timeout this waited forever and held up every later deploy. Up to about two minutes in all.
health=$(curl -fsS -m 10 --retry 10 --retry-delay 3 --retry-all-errors -o /dev/null -w '%{http_code}' "http://127.0.0.1:$port/health") \
  || failed "the server at $commit did not answer /health (pm2 logs luckout-api --lines 100)"
# /health says a server answers, not which one. Node reads the source when it starts, so the answer comes
# from this commit only if pm2 is running a process it started after the checkout, and still the same one.
[ -n "$started" ] && [ "$started" != 0 ] && [ "$started" != "$before" ] && [ "$(pm2 pid luckout-api | tail -n 1)" = "$started" ] \
  || failed "pm2 is not running one steady new process for $commit (pid before $before, after ${started:-none}): pm2 list"
echo "$network $branch ${commit:0:7} (was ${previous:0:7}): health $health, served by pid $started, started by this deploy"
