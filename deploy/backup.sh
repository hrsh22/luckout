#!/usr/bin/env bash
# The nightly database dump, run by cron as the site user (deploy/README.md). Its arguments go to pg_dump as
# they are, e.g. `bash deploy/backup.sh -h 127.0.0.1 -U luckout luckout`; the password comes from ~/.pgpass.
# A dump is kept only if it is complete, old dumps are pruned only after a good one, and a failure alerts
# the admin chat in Telegram, the way the server's own alerts do.
set -uo pipefail
# A dump is the site's whole database: only the site user may read it.
umask 077
cd "$(dirname "$0")/.."
dir=~/backups
out="$dir/luckout-$(date +%F).sql.gz"
part="$out.partial"
# One value from the site's .env, without surrounding quotes (double or single).
setting() { local v; v=$(grep -E "^$1=" .env 2>/dev/null | tail -n 1 | cut -d= -f2-); v=${v%[\"\']}; v=${v#[\"\']}; echo "$v"; }
fail() {
  rm -f "$part"
  local last where text token chat
  last=$(ls -1 "$dir"/luckout-*.sql.gz 2>/dev/null | tail -n 1); last=${last##*/}
  # Tagged as the server tags its alerts (Alerts.ts): the cluster and the start of the program's address.
  local cluster program
  cluster=$(setting SOLANA_CLUSTER); program=$(setting SOLANA_PROGRAM_ID)
  where="${cluster:-devnet}${program:+ ${program:0:4}}"
  text="⚠️ Luckout [$where]: the nightly database dump failed ($1). The newest one kept is ${last:-missing}. See deploy/RUNBOOK.md, \"Restoring from a dump\"."
  echo "$(date -u +%FT%TZ) $text" >&2
  token=$(setting TELEGRAM_BOT_TOKEN); chat=$(setting ALERT_TELEGRAM_CHAT_ID)
  if [ -n "$token" ] && [ -n "$chat" ]; then
    # The URL holds the bot token: it goes to curl on stdin, never on the command line other users can see.
    printf 'url = "https://api.telegram.org/bot%s/sendMessage"\n' "$token" |
      curl -fsS -m 20 -K - -o /dev/null --data-urlencode "chat_id=$chat" --data-urlencode "text=$text" \
      || echo "the Telegram alert could not be sent either" >&2
  fi
  exit 1
}
mkdir -p "$dir" || fail "can't create $dir"
# pipefail: a pg_dump that fails halfway fails the pipeline, even though gzip succeeds.
pg_dump "$@" | gzip > "$part" || fail "pg_dump or gzip exited with an error"
# Complete means the right database (the purchases table is in it) and pg_dump's closing line. awk reads it all,
# so nothing in this pipe stops early.
seen=$(gzip -dc "$part" | awk '/^CREATE TABLE public\.purchases /{t=1} /^-- PostgreSQL database dump complete/{e=1} END{print t+0 e+0}')
[ "$seen" = "11" ] || fail "the dump is incomplete or isn't this site's database"
mv "$part" "$out" || fail "can't save $out"
# Only after a good dump, so failing nights never eat into the good ones.
find "$dir" -name 'luckout-*.sql.gz' -mtime +14 -delete
echo "$(date -u +%FT%TZ) saved $out ($(wc -c < "$out" | tr -d ' ') bytes)"
