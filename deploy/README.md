# Deploying the server

## Two environments

| | Testnet | Mainnet |
|---|---|---|
| Branch | `testnet` (where development happens) | `main` (changes only by PR from `testnet`, with CI passing) |
| Web (Vercel) | Preview env vars, domain `testnet.luckout.gamified.trade` on branch `testnet` | Production env vars, `www.luckout.wtf` (`luckout.wtf` redirects to it; the old `luckout.gamified.trade` still works) |
| API | `luckout-testnet-api.gamified.trade`, VM user `luckout-testnet-api`, port 8789 | `api.luckout.wtf` (also `luckout-api.gamified.trade`, same vhost and certificate), VM user `luckout-api`, port 8788 |
| Database | `luckout_testnet` (role `luckout_testnet`) | `luckout_mainnet` (role `luckout_mainnet`) |
| Telegram | the testnet bot | the mainnet bot |
| Bitrefill | its own account (test cards are free) | its own account and key |

Nothing is shared that could move money across: each server has its own database, keys, contract, bot and Bitrefill account. A push to `testnet` deploys the testnet API after CI passes, and a merge into `main` deploys mainnet, once the `DEPLOY_TESTNET` / `DEPLOY_MAINNET` repository variables are `on`. Each site's CI key in `~/.ssh/authorized_keys` runs only `deploy/remote-deploy.sh` with that site's branch, and the script refuses a branch that doesn't match the site's `NEAR_NETWORK`, or one that has moved past the commit CI tested. By hand: `pnpm deploy:testnet` or `pnpm deploy:mainnet`. Contracts are deployed by hand, never from CI.

SSH (22) and CloudPanel (8443) are open only to our Tailscale tailnet; only 80 and 443 are public. The VM is `milesvm` (100.85.5.47, `tag:server`). The tailnet policy lets our own devices reach it, lets CI reach only its port 22, and lets the VM itself open no connections into the tailnet. CI joins as `tag:ci` with the `TS_OAUTH_CLIENT_ID` / `TS_OAUTH_SECRET` OAuth client. The CloudPanel firewall page shows these rules; keep 22 and 8443 limited to `100.64.0.0/10` and `fd7a:115c:a1e0::/48` there. SSH takes keys only, and root logs in by key only.

The steps below set up one site; repeat them per environment with its own user, port, database and `.env`.

## Mainnet launch

1. **Money in place.** `luckout.near` (the owner's wallet unless `OWNER` names another) with about 5.7 NEAR and about $75 of USDC on NEAR, and a full-access key for it in `~/.near-credentials/mainnet` on the machine that deploys.
2. **Accounts and contract.** `./contract/deploy-mainnet.sh` shows every step; run it again with `GO=1`. It creates `app.`, `server.`, `relayer.` and `treasury.luckout.near`, deploys the contract owned by `OWNER`, registers the contract and the treasury on USDC, and limits the server's key to the purchase methods. Afterwards, remove the deploying machine's key from `luckout.near`.
3. **Database.** As the Postgres admin: `CREATE ROLE luckout_mainnet LOGIN PASSWORD '…'; CREATE DATABASE luckout_mainnet OWNER luckout_mainnet;` The server records the database's network on first start.
4. **Server `.env`** on the `luckout-api` user (port 8788): `NEAR_NETWORK=mainnet`, the mainnet ids and keys from step 2, a new `SESSION_SECRET` and `REDEMPTION_KEY` (back the key up), the mainnet Bitrefill key, `BASE_RPC_URL` (an Alchemy Base mainnet URL), the mainnet Telegram bot, `ALERT_TELEGRAM_CHAT_ID`, `ADMIN_ACCOUNTS`, `WEB_ORIGIN=https://www.luckout.wtf`, `CORS_ORIGINS=https://luckout.wtf,https://luckout.gamified.trade`. It refuses to start with any of these missing or pointing at testnet.
5. **CI.** Add a forced-command key for `main` to that user's `authorized_keys`, the `MAINNET_DEPLOY_KEY` secret and `MAINNET_SSH_TARGET` variable, then set `DEPLOY_MAINNET=on`.
6. **Vercel Production env:** `NEXT_PUBLIC_NEAR_NETWORK=mainnet`, `NEXT_PUBLIC_LUCKOUT_CONTRACT_ID=app.luckout.near`, `NEXT_PUBLIC_USDC_CONTRACT_ID=17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1`, `NEXT_PUBLIC_API_URL=https://api.luckout.wtf`. The testnet server then drops the mainnet site from `CORS_ORIGINS`.
7. **Merge** the PR from `testnet` into `main`: the web and the API go live.
8. **As the owner, in the admin panel:** Treasury → Automatic (up to $40 a day), fund the reserve ($50), and send the treasury about $25 of USDC from the wallet, because proceeds start empty. Send about $1 of ETH on Base to the Base wallet the panel shows (gas for paying Bitrefill).
9. **Prove it cheaply:** a $2–5 Normal purchase (which triggers the first refill), a small Lucky Buy, a relayed deposit and withdrawal, a $2 top-up from another chain. Raise the limits in the panel as it holds up.

The server runs on our VM as a CloudPanel Node.js site under pm2. CloudPanel's nginx handles HTTPS (Let's Encrypt) and proxies to the server on `127.0.0.1:8788` (8787 is taken by another site on our VM). Postgres is the VM's existing server, with its own role and database. The web app deploys to Vercel separately.

## Once

1. **Site.** In CloudPanel: Add Site → Create a Node.js Site. Domain `luckout-api.gamified.trade`, site user `luckout-api`, app port `8788`. Point the domain's `A` record at the VM, then issue a Let's Encrypt certificate under SSL/TLS. Mainnet also answers on `api.luckout.wtf`: it is on the `server_name` line in the Vhost tab, and the certificate covers both names (`clpctl lets-encrypt:install:certificate --domainName=luckout-api.gamified.trade --subjectAlternativeName=api.luckout.wtf`).
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
   `https://luckout-api.gamified.trade/health` should return 204. Set `NEXT_PUBLIC_API_URL` on Vercel to `https://api.luckout.wtf`.
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

## Upgrading the contract

Upgrades happen in place: same account, same state, new code, so balances never move. The new code must read the old state as it is (no change to the stored types).

1. Merge the release into `main`. CI's `contract-wasm` job builds the contract reproducibly and uploads it as `luckout-wasm-<commit>`; its summary shows the code hash.
2. `gh run download <run id> -n luckout-wasm-<commit>`.
3. `./contract/upgrade.sh mainnet luckout.wasm` shows the current and new code hashes and the reserve; `GO=1` deploys, then checks the chain reports the new hash and still reads the state. Keep the previous wasm to roll back with the same script. Testnet first: `./contract/upgrade.sh testnet <wasm>`.

## EVM wallets (ADR-0011)

- **Nothing to configure on the server:** the NEAR Intents account is fixed per network (`intents.near`, `intents.luckout.testnet`), as in the contract, and EVM customers' intents go through the existing relayer, so it needs gas money on both networks. One relayed intent burns about 17 Tgas (about 0.002 NEAR).
- **Web:** the Reown (WalletConnect) project id defaults to Luckout's; `NEXT_PUBLIC_REOWN_PROJECT_ID` overrides it. In the Reown dashboard, the project's allowed domains must include `www.luckout.wtf`, `luckout.wtf`, `luckout.gamified.trade`, `testnet.luckout.gamified.trade` and `localhost`, or WalletConnect refuses to connect there.
- **Testnet NEAR Intents** at `intents.luckout.testnet` is the exact wasm `intents.near` runs, deployed with `new({config:{wnear_id:"wrap.testnet",fees:{fee:0,fee_collector:"luckout.testnet"},roles:{super_admins:["luckout.testnet"]}}})` and registered on test USDC. To redeploy it after `intents.near` upgrades: fetch the code with the RPC's `view_code`, check its hash, and deploy it without an init call.

When something goes wrong with a purchase, see [RUNBOOK.md](RUNBOOK.md).

Logs: `pm2 logs luckout-api`.
