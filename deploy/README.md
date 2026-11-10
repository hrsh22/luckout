# Deploying the server

## Two environments

| | Testnet | Mainnet |
|---|---|---|
| Branch | `testnet` (where development happens) | `main` (changes only by PR from `testnet`, with CI passing) |
| Web (Vercel) | Preview env vars, domain `testnet.luckout.gamified.trade` on branch `testnet` | Production env vars, `luckout.gamified.trade` |
| API | `luckout-testnet-api.gamified.trade`, VM user `luckout-testnet-api`, port 8789 | `luckout-api.gamified.trade`, VM user `luckout-api`, port 8788 |
| Database | `luckout_testnet` (role `luckout_testnet`) | `luckout_mainnet` (role `luckout_mainnet`) |
| Telegram | the testnet bot | the mainnet bot |
| Bitrefill | its own account (test cards are free) | its own account and key |

Nothing is shared that could move money across: each server has its own database, keys, contract, bot and Bitrefill account. A push to `testnet` deploys the testnet API after CI passes, and a merge into `main` deploys mainnet, once the `DEPLOY_TESTNET` / `DEPLOY_MAINNET` repository variables are `on`. Each site's CI key in `~/.ssh/authorized_keys` runs only `deploy/remote-deploy.sh` with that site's branch, and the script refuses a branch that doesn't match the site's `NEAR_NETWORK`. By hand: `pnpm deploy:testnet` or `pnpm deploy:mainnet`. Contracts are deployed by hand, never from CI.

The steps below set up one site; repeat them per environment with its own user, port, database and `.env`.

The server runs on our VM as a CloudPanel Node.js site under pm2. CloudPanel's nginx handles HTTPS (Let's Encrypt) and proxies to the server on `127.0.0.1:8788` (8787 is taken by another site on our VM). Postgres is the VM's existing server, with its own role and database. The web app deploys to Vercel separately.

## Once

1. **Site.** In CloudPanel: Add Site → Create a Node.js Site. Domain `luckout-api.gamified.trade`, site user `luckout-api`, app port `8788`. Point the domain's `A` record at the VM, then issue a Let's Encrypt certificate under SSL/TLS.
2. **Timeout.** A purchase request waits for the voucher to be delivered. In the site's Vhost tab, set `proxy_read_timeout 120s;` in the `location /` block.
3. **Postgres.** As the Postgres admin:
   ```sql
   CREATE ROLE luckout LOGIN PASSWORD '<openssl rand -hex 24>';
   CREATE DATABASE luckout OWNER luckout;
   ```
4. **Node and code.** SSH in as `luckout-api`:
   ```sh
   nvm install 24 && nvm alias default 24   # the server needs Node 24
   npm i -g pnpm@11 pm2
   cd ~/htdocs/luckout-api.gamified.trade
   # the repo is private: add ~/.ssh/github_deploy.pub as a read-only deploy key
   git clone git@github.com:hrsh22/luckout.git .
   pnpm install --frozen-lockfile --filter @luckout/server...
   ```
5. **Secrets.** Copy `.env.example` to `.env` in the repo root, then `chmod 600 .env`. Fill in:
   - `PORT=8788` and `DATABASE_URL=postgres://luckout:<password>@127.0.0.1:5432/luckout`
   - `WEB_ORIGIN=` the web app's URL, for CORS
   - `SESSION_SECRET` and `REDEMPTION_KEY` (`openssl rand -hex 32` each). Back up `REDEMPTION_KEY` somewhere safe: without it, stored voucher codes can't be decrypted.
   - the NEAR, Bitrefill, Telegram and NEAR AI values. On mainnet, the operator account should hold only a function-call key for the contract, and the server refuses to start if any required value is missing.
   - `ALERT_TELEGRAM_CHAT_ID`, so alerts (low gas, contract storage, stuck or late purchases) reach you in Telegram. They're always in the logs too.
6. **Run.**
   ```sh
   pm2 start deploy/ecosystem.config.cjs
   pm2 save
   ```
   `https://luckout-api.gamified.trade/health` should return 204. Set `NEXT_PUBLIC_API_URL` on Vercel to `https://luckout-api.gamified.trade`.
7. **Reboots and backups.** Put the password in `~/.pgpass` (`127.0.0.1:5432:luckout:luckout:<password>`, then `chmod 600`). Run `mkdir -p ~/backups`, then add to `crontab -e`. The `@reboot` line brings pm2 back without root, so `pm2 startup` isn't needed:
   ```cron
   PATH=/home/luckout-api/.nvm/versions/node/v24.22.2/bin:/usr/local/bin:/usr/bin:/bin
   @reboot cd ~/htdocs/luckout-api.gamified.trade && pm2 resurrect
   0 3 * * * pg_dump -h 127.0.0.1 -U luckout luckout | gzip > ~/backups/luckout-$(date +\%F).sql.gz && find ~/backups -name 'luckout-*.sql.gz' -mtime +14 -delete
   ```

## Updating

```sh
cd ~/htdocs/luckout-api.gamified.trade
git pull && pnpm install --frozen-lockfile --filter @luckout/server... && pm2 reload luckout-api
```

From a machine with the `luckout-milesvm` / `luckout-testnet-api-milesvm` SSH aliases, `pnpm deploy:mainnet` / `pnpm deploy:testnet` does the same and checks health. The server runs database migrations on start. Keep it at one instance: never use pm2 cluster mode or `-i` (a second process against the same database refuses to start). A reload waits for purchases in progress to finish, up to pm2's `kill_timeout` of 3 minutes. After changing `deploy/ecosystem.config.cjs`, apply it with `pm2 startOrReload deploy/ecosystem.config.cjs && pm2 save`.

When something goes wrong with a purchase, see [RUNBOOK.md](RUNBOOK.md).

Logs: `pm2 logs luckout-api`.
