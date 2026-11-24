# Deploying the server

## Three environments

| | Testnet | Staging | Production (mainnet) |
|---|---|---|---|
| Branch | `testnet` | `staging` (PRs from feature branches, with CI passing) | `main` (changes only by PR from `staging`, with CI passing) |
| Web (Vercel) | Preview env vars, domain `testnet.luckout.wtf` on branch `testnet` | Preview env vars for branch `staging`, domain `staging.luckout.wtf` on branch `staging` | Production env vars, `www.luckout.wtf` (`luckout.wtf` redirects to it) |
| API | `testnet-api.luckout.wtf` (its certificate is still issued under the old `luckout-testnet-api.gamified.trade`, so that DNS record stays until the certificate is reissued for `testnet-api.luckout.wtf` alone), VM user `luckout-testnet-api`, port 8789 | `staging-api.luckout.wtf`, VM user `luckout-staging-api`, port 8791 | `api.luckout.wtf`, VM user `luckout-api`, port 8788 |
| NEAR accounts | `*.luckout.testnet` | `*.staging.luckout.near` (`ROOT=staging.luckout.near`, smaller amounts: see `contract/deploy-mainnet.sh`) | `*.luckout.near` |
| Database | `luckout_testnet` (role `luckout_testnet`) | `luckout_staging` (role `luckout_staging`) | `luckout_mainnet` (role `luckout_mainnet`) |
| Telegram | the testnet bot | the staging bot | the mainnet bot |
| Bitrefill | its own account (test cards are free) | its own guest client for orders (ADR-0012); the testnet account's key ($0 credit) reads the catalog | its own guest client for orders; its account's key reads the catalog |

Staging is a small copy of production on mainnet (ADR-0010): real money in small amounts, its own contract and caps, so a release is tried there before it reaches `main`. Its accounts hold about a fifth of production's NEAR, so its server sets `GAS_ALERT_PERCENT=20` to scale the low-NEAR alerts to match. After the hackathon's judging, hosted testnet retires and runs locally instead.

Nothing is shared that could move money across: each server has its own database, keys, contract, bot and Bitrefill account. A push to `testnet` deploys the testnet API after CI passes, a merge into `staging` deploys staging, and a merge into `main` deploys mainnet, once the `DEPLOY_TESTNET` / `DEPLOY_STAGING` / `DEPLOY_MAINNET` repository variables are `on`. Each site's CI key in `~/.ssh/authorized_keys` runs only `deploy/remote-deploy.sh` with that site's branch, and the script refuses a branch that doesn't match the site's `NEAR_NETWORK` and VM user, or one that has moved past the commit CI tested. By hand: `pnpm deploy:testnet`, `pnpm deploy:staging` or `pnpm deploy:mainnet`. Contracts are deployed by hand, never from CI.

**The web follows the API.** Vercel doesn't deploy `main` or `staging` by itself (`apps/web/vercel.json`). CI's `web` job, which runs only after the `deploy` job succeeds, calls that branch's Vercel Deploy Hook (the `VERCEL_DEPLOY_HOOK_MAIN` and `VERCEL_DEPLOY_HOOK_STAGING` secrets), so the web goes live only once the API it calls has, and not at all when the API's deploy fails. So with `DEPLOY_MAINNET` or `DEPLOY_STAGING` off, that branch's web isn't deployed either: use Redeploy in Vercel, or `curl -X POST` the hook's URL. A hook URL is as good as a password: to replace one, create a new hook for the branch in Vercel (Project → Settings → Git → Deploy Hooks), update the secret, then delete the old hook. Testnet and preview branches keep Vercel's own deploys.

**Vercel builds the web only when it changed.** Every deployment keeps its own copy of the web's functions, and Hobby allows 10 GB in all. So on every branch Vercel skips the build (it shows as Canceled) unless `apps/web`, `packages`, the root `package.json`, `pnpm-lock.yaml`, `pnpm-workspace.yaml` or `tsconfig.base.json` changed since that branch's last successful deployment (`ignoreCommand` in `apps/web/vercel.json`). A `NEXT_PUBLIC_*` variable is baked in at build time, so after changing one in Vercel, use Redeploy and untick **Use project's Ignore Build Step**. Project → Settings → Build and Deployment → Deployment Retention Policy keeps previews, canceled and errored deployments for 1 day and production for 1 week.

SSH (22) and CloudPanel (8443) are open only to our Tailscale tailnet; only 80 and 443 are public. The VM is `milesvm` (100.85.5.47, `tag:server`). The tailnet policy lets our own devices reach it, lets CI reach only its port 22, and lets the VM itself open no connections into the tailnet. CI joins as `tag:ci` with the `TS_OAUTH_CLIENT_ID` / `TS_OAUTH_SECRET` OAuth client. The CloudPanel firewall page shows these rules; keep 22 and 8443 limited to `100.64.0.0/10` and `fd7a:115c:a1e0::/48` there. SSH takes keys only, and root logs in by key only.

The steps below set up one site; repeat them per environment with its own user, port, database and `.env`.

## Mainnet launch

1. **Money in place.** `luckout.near` (the owner's wallet unless `OWNER` names another) with about 5.7 NEAR and about $75 of USDC on NEAR, and a full-access key for it in `~/.near-credentials/mainnet` on the machine that deploys.
2. **Accounts and contract.** `./contract/deploy-mainnet.sh` shows every step; run it again with `GO=1`. It creates `app.`, `server.`, `relayer.` and `treasury.luckout.near`, deploys the contract owned by `OWNER`, registers the contract and the treasury on USDC, and limits the server's key to the purchase methods. Afterwards, remove the deploying machine's key from `luckout.near`.
3. **Database.** As the Postgres admin: `CREATE ROLE luckout_mainnet LOGIN PASSWORD '…'; CREATE DATABASE luckout_mainnet OWNER luckout_mainnet;` The server records the database's network on first start.
4. **Server `.env`** on the `luckout-api` user (port 8788): `NEAR_NETWORK=mainnet`, the mainnet ids and keys from step 2, a new `SESSION_SECRET` and `REDEMPTION_KEY` (back the key up), the mainnet Bitrefill key (it only reads the catalog), a Bitrefill guest client for orders (`BITREFILL_CLIENT_ID`, `BITREFILL_CLIENT_SECRET`; registered as under "A Bitrefill client for guest checkout" below), `BASE_RPC_URL` (an Alchemy Base mainnet URL), the mainnet Telegram bot, `ALERT_TELEGRAM_CHAT_ID`, `ADMIN_ACCOUNTS`, `WEB_ORIGIN=https://www.luckout.wtf`, `CORS_ORIGINS=https://luckout.wtf`. It refuses to start with any of these missing or pointing at testnet.
5. **CI.** Add a forced-command key for `main` to that user's `authorized_keys`, the `MAINNET_DEPLOY_KEY` secret and `MAINNET_SSH_TARGET` variable, then set `DEPLOY_MAINNET=on`.
6. **Vercel Production env:** `NEXT_PUBLIC_NEAR_NETWORK=mainnet`, `NEXT_PUBLIC_LUCKOUT_CONTRACT_ID=app.luckout.near`, `NEXT_PUBLIC_USDC_CONTRACT_ID=17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1`, `NEXT_PUBLIC_API_URL=https://api.luckout.wtf`. The testnet server then drops the mainnet site from `CORS_ORIGINS`.
7. **Merge** the PR from `testnet` into `main`: the web and the API go live.
8. **As the owner, in the admin panel:** Treasury → Automatic (up to $40 a day), fund the reserve ($50), and send the treasury about $25 of USDC from the wallet, because proceeds start empty: the first refill swaps it into the Base wallet, whose USDC (the Base Float) pays every card. Send about $1 of ETH on Base to the Base wallet the panel shows (gas for those payments).
9. **Prove it cheaply:** a $2–5 Normal purchase with a Checkout Email (it waits a few minutes for the first refill of the Base Float), a small Lucky Buy, a relayed deposit and withdrawal, a $2 top-up from another chain. Raise the limits in the panel as it holds up.

The server runs on our VM as a CloudPanel Node.js site under pm2. CloudPanel's nginx handles HTTPS (Let's Encrypt) and proxies to the server on `127.0.0.1:8788` (8787 is taken by another site on our VM). Postgres is the VM's existing server, with its own role and database. The web app deploys to Vercel separately.

## Once

1. **Site.** In CloudPanel: Add Site → Create a Node.js Site, site user `luckout-api`, app port `8788`. The site was created under the retired domain `luckout-api.gamified.trade`, which is why its folder is `~/htdocs/luckout-api.gamified.trade`; it answers on `api.luckout.wtf`, which is on the `server_name` line in the Vhost tab. Point that name's `A` record at the VM (proxied by Cloudflare), then issue a Let's Encrypt certificate for it under SSL/TLS.
2. **Timeout, body size and client address.** A purchase request waits up to a minute for the card (`PURCHASE_REQUEST_WAIT_MS`, 60 s), then answers "pending" and the page follows it, which keeps it under Cloudflare's 100 s. In the site's Vhost tab, set `proxy_read_timeout 120s;` in the `location /` block, and add these two lines under `server_name`:
   ```nginx
   client_max_body_size 64k;
   set_real_ip_from 127.0.0.1;
   ```
   The first refuses a body over 64 KiB before the server reads it (the server refuses it too). The second matters because the VM's `nginx.conf` trusts `X-Real-IP` from `0.0.0.0/0`: without it, a caller that reaches the VM directly, skipping Cloudflare, names its own address and slips past the rate limits.
3. **Postgres.** As the Postgres admin:
   ```sql
   CREATE ROLE luckout LOGIN PASSWORD '<openssl rand -hex 24>';
   CREATE DATABASE luckout OWNER luckout;
   ```
4. **Node and code.** SSH in as `luckout-api`:
   ```sh
   cd ~/htdocs/luckout-api.gamified.trade
   # the repo is private: add ~/.ssh/github_deploy.pub as a read-only deploy key
   git clone git@github.com:hrsh22/luckout.git .
   nvm install && nvm alias default "$(cat .nvmrc)"   # the Node version in .nvmrc, the one CI tests on
   npm i -g pnpm@11 pm2
   pnpm install --frozen-lockfile --filter @luckout/server...
   ```
   To move to another Node version, change `.nvmrc` in a PR. Before that release deploys, on each site: `nvm install <version> --reinstall-packages-from=current && nvm alias default <version>`, then `pm2 update` at a quiet moment (it restarts the server on the new Node). The deploy script and the `@reboot` line both use nvm's `default`.
5. **Secrets.** Copy `.env.example` to `.env` in the repo root, then `chmod 600 .env`. Fill in:
   - `PORT=8788` and `DATABASE_URL=postgres://luckout:<password>@127.0.0.1:5432/luckout`
   - `WEB_ORIGIN=` the web app's URL, for CORS
   - `SESSION_SECRET` and `REDEMPTION_KEY` (`openssl rand -hex 32` each). Back up `REDEMPTION_KEY` somewhere safe: without it, stored voucher codes can't be decrypted.
   - the NEAR, Bitrefill, Telegram and NEAR AI values. On mainnet, the operator account should hold only a function-call key for the contract, and the server refuses to start if any required value is missing.
   - optionally `BITREFILL_REDIRECT_URI=https://<this API's domain>/bitrefill/callback`, once Bitrefill has that exact URI on our client: customers can then connect their own Bitrefill account for higher limits (ADR-0012). Staging's is `https://staging-api.luckout.wtf/bitrefill/callback`.
   - `ALERT_TELEGRAM_CHAT_ID`, so alerts (low gas, contract storage, stuck or late purchases) reach you in Telegram. They're always in the logs too.
6. **Run.**
   ```sh
   pm2 start deploy/ecosystem.config.cjs
   pm2 save
   ```
   `https://api.luckout.wtf/health` should return 204. Set `NEXT_PUBLIC_API_URL` on Vercel to `https://api.luckout.wtf`.
7. **Reboots and backups.** Put the password in `~/.pgpass` (`127.0.0.1:5432:luckout:luckout:<password>`, then `chmod 600`). Run `mkdir -p ~/backups`, then add to `crontab -e`. The `@reboot` line brings pm2 back without root, so `pm2 startup` isn't needed:
   ```cron
   # pm2 and pnpm are installed system-wide in /usr/local/bin, which cron's own PATH lacks; Node comes from nvm
   PATH=/usr/local/bin:/usr/bin:/bin
   # bash, because cron's sh can't load nvm; nvm's default Node is the one in .nvmrc (step 4)
   @reboot bash -c '. ~/.nvm/nvm.sh && cd ~/htdocs/luckout-api.gamified.trade && pm2 resurrect'
   0 3 * * * bash ~/htdocs/luckout-api.gamified.trade/deploy/backup.sh -h 127.0.0.1 -U luckout luckout >> ~/backups/backup.log 2>&1
   ```
   `deploy/backup.sh` keeps a dump only if it is complete and of this site's database, deletes dumps older than 14 days only after a good one, and alerts the admin chat (`TELEGRAM_BOT_TOKEN`, `ALERT_TELEGRAM_CHAT_ID` from `.env`) when a night's dump fails. Restoring one is in [RUNBOOK.md](RUNBOOK.md#restoring-from-a-dump).

## A Bitrefill client for guest checkout (ADR-0012)

Staging and production each buy as a guest through their own Bitrefill client, and a mainnet server won't start without one.

**Registering one.** At `https://api.bitrefill.com/oauth/mcp/register`: client name `Luckout` (staging: `Luckout (staging)`), `redirect_uris: ["https://api.luckout.wtf/bitrefill/callback"]` (staging: `https://staging-api.luckout.wtf/bitrefill/callback`), `grant_types: ["client_credentials", "authorization_code", "refresh_token"]`, `token_endpoint_auth_method: "client_secret_post"`. Keep the reply private: it holds the secret. The reply's `client_secret_expires_at` (seconds since 1970) says when the secret stops working, 90 days on. The server's `.env` takes `BITREFILL_CLIENT_ID`, `BITREFILL_CLIENT_SECRET`, `BITREFILL_CLIENT_SECRET_EXPIRES_AT` (that number of seconds exactly as Bitrefill returns it, e.g. `1802528701`, not an ISO date) and `BITREFILL_REDIRECT_URI` (the redirect URI above). `BITREFILL_API_KEY` stays: it only reads the catalog.

**When the client secret is about to expire.** Each deployment's Bitrefill client secret lasts 90 days, and the server alerts daily from two weeks before (`BITREFILL_CLIENT_SECRET_EXPIRES_AT`). Register a new client the same way, replace `BITREFILL_CLIENT_ID`, `BITREFILL_CLIENT_SECRET` and `BITREFILL_CLIENT_SECRET_EXPIRES_AT` in that deployment's `.env`, and restart the server. A customer's Bitrefill Connection belongs to the client it was made with, so after the change their cards go back to guest checkout with their Checkout Email until they connect again.

## Updating

CI deploys each branch once its tests pass. By hand, as the site user, run the same script (or `pnpm deploy:mainnet` / `pnpm deploy:staging` / `pnpm deploy:testnet` from a machine with the SSH aliases):

```sh
cd ~/htdocs/luckout-api.gamified.trade
bash deploy/remote-deploy.sh main
```

The script refuses to run if a tracked file was edited on the VM (`git status` shows it: bring the change in through a PR, or drop it with `git checkout -- .`). It installs the new dependencies before restarting anything; if that fails, nothing is restarted and the old source is put back. Then it reloads the server, and passes only if `/health` answers and pm2 runs one steady process that it started after checking out the new code. Node reads the code when it starts, so that process runs the new commit. The last line says so, with the commit it replaced: `mainnet main 1a2b3c4 (was 9f8e7d6): health 204, served by pid 12345, started by this deploy`. Any failure exits non-zero, so CI's deploy job goes red. The first deploy after this script changes still runs the old script, because bash already has the file open when `git checkout` replaces it, so the new script's output first appears on the second deploy, and before that one `git status --porcelain --untracked-files=no` must print nothing on the VM.

The server runs database migrations on start. Keep it at one instance: never use pm2 cluster mode or `-i` (a second process against the same database refuses to start). A reload waits for purchases in progress to finish, up to pm2's `kill_timeout` of 3 minutes. A server that dies while starting is started again after 1 s, then a little longer each time, up to every 15 s (`exp_backoff_restart_delay`); `pm2 list` shows it as `waiting restart` in between. After changing `deploy/ecosystem.config.cjs`, apply it with `pm2 startOrReload deploy/ecosystem.config.cjs` and then `pm2 save` (the next deploy does the same).

**The CI key.** Each site's line for CI in `~/.ssh/authorized_keys` is exactly `restrict,command="bash ~/htdocs/<site>/deploy/remote-deploy.sh <branch>" ssh-ed25519 …`. `restrict` turns off port and agent forwarding and the terminal; the forced command fixes the branch, and CI's own command (the commit it tested) reaches the script only as `SSH_ORIGINAL_COMMAND`. So the key can run this deploy and nothing else, and can't go back.

### Going back

Once the old server has been stopped, a failed deploy prints the command to go back, for example `to go back: bash deploy/remote-deploy.sh main 9f8e7d6…`. Run it as the site user. It checks out that earlier commit of the same branch, installs its dependencies, reloads and checks it the same way. It is never automatic, because of migrations:

- **Migrations stay.** One the new code ran isn't undone, and the old code then runs on the newer tables (it runs no migration itself). Check `git diff <earlier commit> <failed commit> -- apps/server/src/Db.ts` first: a new table, or a new column that is nullable or has a default, doesn't bother the old code; a renamed or dropped column, or a new `NOT NULL` one without a default, does, and then fix forward instead.
- **Not past migration 0025** (Carts' `checkouts`): it adds a required column to `purchases` that earlier code doesn't fill, so an earlier commit can't record a purchase on the migrated tables. Once a release with it has started, fix forward; the last resort is in [RUNBOOK.md](RUNBOOK.md#rolling-back-a-release).
- **Until the next deploy.** CI deploys the branch again on its next push, so revert or fix the bad commit on the branch through a PR.

## Releasing staging to production

A release is `staging` merged into `main` by PR, and merging deploys production's server and then its web (CI). So everything the new code needs is in place before the merge, and sales stop around it. The steps below run in this order. **Owner's wallet** marks a step only the owner can sign; **owner** one that needs the owner's accounts; the rest are the operator's.

**There is no going back past migration 0025.** It moves every purchase into a Checkout (`checkouts`) and adds a column that earlier code doesn't fill, so once the new server has started, an earlier commit can't record a purchase. If the release goes wrong after the merge, fix it forward: a PR to `staging`, then to `main`. The dump in step 15 is the last resort, and it loses everything after it ([RUNBOOK.md](RUNBOOK.md#rolling-back-a-release)). The release that brings guest checkout, Carts, Solana wallets and ORE Top-Ups to production runs migrations 0018 to 0027 when the server starts.

### Days before

1. **Staging has sold with it.** On staging.luckout.wtf: a Standard Purchase and a Lucky Buy with a Checkout Email, a Cart of two, a card through the Agent, Connect Bitrefill, a Top-Up from a Solana wallet and one paid in ORE, a relayed deposit and withdrawal. The `staging` push run of the commit being released is green (`gh run list --branch staging --event push --limit 1`); note its id, the contract's build comes from it. Merge nothing else into `staging` until the release is done: `contract/upgrade.sh` takes only the run of the branch's current commit.
2. **A Bitrefill client for production** (owner): registered as in [A Bitrefill client for guest checkout](#a-bitrefill-client-for-guest-checkout-adr-0012), with `https://api.luckout.wtf/bitrefill/callback`.
3. **Jupiter and a Solana RPC** (owner): production's own `JUPITER_API_KEY` and `SOLANA_RPC_URL`, as in [ORE Top-Ups](#ore-top-ups-adr-0014).
4. **Room for the new code** (owner's wallet). The contract's code grows by about 22 KB, and NEAR locks 10^19 yoctoNEAR (0.00001 NEAR) a byte of storage. Free NEAR is the balance less what storage locks:
   ```sh
   curl -s https://rpc.mainnet.fastnear.com -H 'Content-Type: application/json' \
     -d '{"jsonrpc":"2.0","id":1,"method":"query","params":{"request_type":"view_account","finality":"final","account_id":"app.luckout.near"}}' |
     python3 -c 'import json,sys; r=json.load(sys.stdin)["result"]; print((int(r["amount"]) - r["storage_usage"] * 10**19) / 1e24, "NEAR free")'
   ```
   On 2026-11-25: 4.092 NEAR − 292,283 bytes × 0.00001 = 1.17 NEAR free; the new code's 21,956 more bytes lock 0.22, leaving 0.95, under the Monitor's 1 NEAR alert. Send about 0.3 NEAR to `app.luckout.near`, so it reads at least 1.4 before the upgrade.
5. **The Base Wallet and the Treasury** (owner, Admin → Gas). From the merge, every card is paid from the Base Float: the Base Wallet holds about a day of sales in USDC and about $1 of ETH for gas (the low-ETH alert fires under 0.0001 ETH, and payments stop under 0.00005 ETH plus a payment's small L1 fee), and the Treasury at least 0.1 NEAR, with proceeds to pull (Automatic) or USDC of its own for Refills.
6. **The web's Deploy Hook for `main`** (owner). CI deploys production's web only through it, and this release is its first. Copy its URL from Vercel → Project → Settings → Git → Deploy Hooks; the URL is as good as a password, so paste it where it isn't echoed or kept in shell history: `read -rs HOOK && curl -fsS -X POST "$HOOK"; unset HOOK`. A Production deployment of `main`'s current commit appears in Vercel (it redeploys what is live). If none does, create a new hook for `main`, put it in the `VERCEL_DEPLOY_HOOK_MAIN` secret (`gh secret set VERCEL_DEPLOY_HOOK_MAIN` asks for it without echoing) and delete the old one.
7. **The VM**, as `luckout-api`: `git status --porcelain --untracked-files=no` prints nothing. The first deploy of this release still runs the previous `deploy/remote-deploy.sh` (see [Updating](#updating)), which doesn't check it.
8. **About a day before** (any admin, optional): in Admin's **Bitrefill credit** section, switch **Auto** off (the switch at the top right of the "USD credit at Bitrefill" card), so sales spend the Bitrefill Credit down; whatever is left stays on the Bitrefill account. Step 21 turns it back on.

### Before the merge, sales still open

9. **The new server key** (owner's wallet). Production's operator key predates Carts and can't call `purchase_many` or `settle`, which every Checkout now uses. A key's methods can't be changed, so a new one goes alongside it:
   ```sh
   near account add-key server.luckout.near grant-function-call-access --allowance unlimited \
     --contract-account-id app.luckout.near --function-names 'purchase, confirm_delivery, fail_purchase, purchase_many, settle' \
     autogenerate-new-keypair save-to-legacy-keychain network-config mainnet sign-with-seed-phrase send
   ```
   It is signed with `server.luckout.near`'s full-access key, which only the owner's wallet holds. `sign-with-seed-phrase` with no phrase on the command line makes the CLI ask for it (with a Ledger, `sign-with-ledger` instead). Never use `sign-with-plaintext-private-key`: it puts the key in shell history. The new key is saved under `~/.near-credentials/mainnet/server.luckout.near/` on the machine that ran the command. `near account list-keys server.luckout.near network-config mainnet now` then shows two function-call keys for `app.luckout.near`, the new one with all five methods, besides the full-access key. It keeps the three old methods, so the server running now works with it too.
10. **Server `.env`**, as `luckout-api` (copy it to `.env.bak-<date>` first):
    - `OPERATOR_PRIVATE_KEY`: the `private_key` from step 9's key file, pasted in with an editor (not through a shell command, which history would keep).
    - `BITREFILL_CLIENT_ID`, `BITREFILL_CLIENT_SECRET`, `BITREFILL_CLIENT_SECRET_EXPIRES_AT`, `BITREFILL_REDIRECT_URI=https://api.luckout.wtf/bitrefill/callback`. `BITREFILL_API_KEY` stays.
    - `JUPITER_API_KEY` and `SOLANA_RPC_URL`.

    Check that `.env` now holds the new key by printing only its public key, which must be the new one in step 9's key list:
    ```sh
    (cd ~/htdocs/luckout-api.gamified.trade/apps/server && node --env-file=../../.env --input-type=module \
      -e 'import {KeyPair} from "near-api-js"; console.log(KeyPair.fromString(process.env.OPERATOR_PRIVATE_KEY).getPublicKey().toString())')
    ```
    The running server reads none of this until it restarts. The new one refuses to start without the Bitrefill client, or with a key that can't call `purchase_many` and `settle` (`OPERATOR_PRIVATE_KEY: …` in `pm2 logs luckout-api`); the key check comes before the database, so a server refused there has run no migration.
11. **Contract dry run:** `CHECK_ACCOUNT=<your account on production> CHECK_PURCHASE=<one of its settled purchases> ./contract/upgrade.sh production <run id from step 1>` ([Upgrading the contract](#upgrading-the-contract)). It checks the run, downloads its build, shows both code hashes, and saves the code on chain now to `~/luckout-wasm/production-<hash>.wasm`.

### The sales pause (about half an hour)

12. **Admin → Stop sales** (any admin). `curl -s https://api.luckout.wtf/status` then answers `{"open":false,"reason":"stopped"}`. Withdrawals and Reclaims keep working, and purchases under way finish.
13. **Let purchases under way finish.** On the VM, repeat until nothing is at `admit` or `ordering` (`<role>` and `<db>` as in `DATABASE_URL`; `~/.pgpass` has the password):
    ```sh
    psql -h 127.0.0.1 -U <role> <db> -c "SELECT step, count(*) FROM purchases WHERE step NOT IN ('settled', 'failed', 'rejected', 'stuck') GROUP BY step"
    ```
    One still at `ordering` a minute later may already be ordered on Bitrefill Credit, and the new server orders afresh: park it for a hand check (RUNBOOK.md, "Bitrefill order outcome unknown"):
    ```sh
    psql -h 127.0.0.1 -U <role> <db> -c "UPDATE purchases SET step = 'stuck', error = 'At ordering on Bitrefill Credit when guest checkout came in: check the Bitrefill account' WHERE step = 'ordering' AND updated_at < now() - interval '1 minute'"
    ```
    The rest (`waiting`, `restock`, `delivery`, `confirm`, `fail`) carry on under the new server. Admin → Bitrefill credit shows no Refill running: one started for the credit would end in the Base Float.
14. **Upgrade the contract:** the command from step 11 with `GO=1` in front, on the machine with `app.luckout.near`'s key. It refuses while sales are open, and ends "The account, the purchase and the Game Versions read the same as before." **Leave sales stopped:** they reopen at step 22, after the merge has been checked. The server and web running now keep working with the new code; the new ones need it (Checkouts, Solana Top-Ups, a first deposit's Default Mode). If it fails, roll back with the command it prints, run the check it prints, Restart sales, and stop the release here.
15. **Dump the database**, on the VM, now that nothing changes it:
    ```sh
    umask 077; set -o pipefail
    f=~/backups/prerelease-$(date +%F-%H%M).sql.gz
    pg_dump -h 127.0.0.1 -U <role> <db> | gzip > "$f" && gzip -dc "$f" | tail -n 3
    ```
    It ends `-- PostgreSQL database dump complete`. Only the site user can read it (`umask 077`), and its name keeps it out of the nightly backup's pruning of `luckout-*.sql.gz`. Copy it off the VM (`scp luckout-milesvm:backups/prerelease-<…>.sql.gz .`): it is the only way back past migration 0025.
16. **Merge** the release PR from `staging` into `main` once its checks are green, and only while Admin → Bitrefill credit still shows no Refill running (look again now: with Auto on, one can have started since step 13).
17. **The server deploys** (CI's `deploy` job). The old server finishes its purchases first (up to three minutes), then the new one starts and runs the migrations. This deploy runs the previous script, so its last line is the old `mainnet main <commit>: health 204`. On the VM:
    - `git rev-parse --short HEAD` is the merge commit, and `pm2 describe luckout-api` shows it online and started minutes ago.
    - `psql -h 127.0.0.1 -U <role> <db> -c "SELECT max(migration_id) FROM effect_sql_migrations"` reads 27 (it read 17 before).
    - pm2 has this release's restart backoff (`deploy/ecosystem.config.cjs`): `pm2 jlist | tail -n 1 | python3 -c 'import json,sys; print([a["pm2_env"].get("exp_backoff_restart_delay") for a in json.load(sys.stdin) if a["name"] == "luckout-api"])'` prints `[1000]`. If it prints `[None]`, apply it while sales are still stopped: `cd ~/htdocs/luckout-api.gamified.trade && pm2 delete luckout-api && pm2 start deploy/ecosystem.config.cjs && pm2 save`.

    If the job is red, read `pm2 logs luckout-api --lines 100`: a missing or wrong `.env` value is fixed in `.env`, then `pm2 restart luckout-api` (Node reads `.env` when it starts). Anything else: [RUNBOOK.md](RUNBOOK.md#rolling-back-a-release).
18. **The web deploys** (CI's `web` job, after the server): Vercel shows a Production deployment of the merge commit as Ready, and www.luckout.wtf has the Cart. Everyone signs in again once, as expected: this release moves the session from a token the page kept to an HttpOnly cookie the server sets, named `__Host-luckout_session`, and each session token now names the contract it was issued for, so the server accepts no session from before. If the job failed, call the hook from step 6 at once (`read -rs HOOK && curl -fsS -X POST "$HOOK"; unset HOOK`): until the new web is live, nobody can sign in.

### After the merge

19. **Admin** (signed in again): the Base Float shows its balance and the Checkout card, Gas is green, and the Treasury card doesn't say "Check the server".
20. **Purchases under way went on:** `psql -h 127.0.0.1 -U <role> <db> -c "SELECT step, count(*) FROM checkouts WHERE step NOT IN ('done', 'rejected', 'stuck', 'waiting') GROUP BY step"` empties within minutes. `waiting` is left out: those wait, uncharged, until sales reopen. One at `restock` waits for the Base Float (Admin → Base Float).
21. **Auto back on** (any admin), if step 8 turned it off: in Admin's **Base Float** section, switch **Auto** on (the switch at the top right of the "USDC in our Base Wallet" card). Otherwise nothing refills the Base Float.
22. **Admin → Restart sales.**
23. **Prove it:** a ₹50 card on the site with a Checkout Email, a Lucky Buy, a Cart of two, a card through the Agent, Connect Bitrefill from Wallet, a relayed deposit and withdrawal, a small Top-Up from a Solana wallet and one in ORE. Admin → Purchases shows each card's Base payment; on nearblocks the admission is `purchase_many` and the settlement `settle`. If a purchase waits at `admit` for more than a minute, Stop sales and read `pm2 logs luckout-api`.
24. **Delete the old server key** (owner's wallet), once a card has settled with the new one: `near account delete-keys server.luckout.near public-keys <old key> network-config mainnet sign-with-seed-phrase send`, signed at the prompt as in step 9. `list-keys` then shows the new function-call key and the full-access key; the old function-call key is gone.
25. **The nightly backup**, as `luckout-api`: in `crontab -e`, replace the `pg_dump … | gzip …` line with the `deploy/backup.sh` line from [Once](#once), step 7, with this site's role and database. Run that command once by hand (`~/backups/backup.log` says `saved …`), and once with a wrong database name to see the alert reach the admin chat.
26. **Before the next deploy:** `git status --porcelain --untracked-files=no` prints nothing on the VM. That deploy is the first to run the new `deploy/remote-deploy.sh`.

## Upgrading the contract

Upgrades happen in place: same account, same state, new code, so balances never move. The new code must read the old state as it is (no change to the stored types). A release goes to staging's contract (`app.staging.luckout.near`) first, and to production's (`app.luckout.near`) only after staging has sold with it. `contract/upgrade.sh` takes the contract by name, `testnet`, `staging` or `production`, so production is never reached by accident, and it sends nothing without `GO=1`.

1. **The build.** When the release merges into `staging`, CI's `contract-wasm` job builds the contract reproducibly and uploads it as `luckout-wasm-<commit>`; its summary shows the code hash. `upgrade.sh` takes that run's id (`gh run list --branch staging --event push`), checks that the run was a successful push to `staging` or `main` at that branch's current commit, and downloads the build itself. The build embeds the commit it came from (`contract_source_metadata` links it), so the same code built from another commit has another code hash, and a PR's run builds GitHub's temporary merge commit, which no branch has: the script refuses it.
2. **What to check against.** Pick an account with a Balance on that contract and a settled purchase there, a Lucky Buy if you have one. Your own test account and one of its purchases are best: nothing else changes them during the upgrade.
3. **Dry run.** `CHECK_ACCOUNT=<account> CHECK_PURCHASE=<id> ./contract/upgrade.sh staging <run id>` shows both code hashes, the reserve, whether sales are open, the account, the purchase and the Game Versions, and saves the code on chain now to `~/luckout-wasm/staging-<code hash>.wasm`.
4. **Admin → Stop sales first**, on that environment's site, so no purchase is admitted while the code changes. Confirmations, failures, withdrawals and Reclaims keep working. The script won't deploy while the API's `/status` says sales are open; when `/status` doesn't answer, it says so and goes on.
5. **Deploy:** the same command with `GO=1` in front. It checks the chain reports the new hash, then reads the account, the purchase and the Game Versions again and fails if any can't be read or reads differently. **Start sales again after the checks** pass (Admin → Restart sales); in a release, at the release's own step instead.
6. **If it fails,** it prints the command to roll back, which deploys the saved code directly: `near contract deploy app.staging.luckout.near use-file ~/luckout-wasm/staging-<hash>.wasm without-init-call network-config mainnet sign-with-legacy-keychain send` (not the script itself: it would first try to read the records with the failing code). Then it prints the check: a dry run on the saved file (the script takes a file only for a dry run), `CHECK_ACCOUNT=… CHECK_PURCHASE=… ./contract/upgrade.sh staging ~/luckout-wasm/staging-<hash>.wasm`, which should end "Already deployed.". Restart sales once it does, and find out why before trying again.
7. **Production** goes with the release ([Releasing staging to production](#releasing-staging-to-production), steps 11 and 14). When depends on what the release's apps send the contract, because merging into `main` deploys the web and the server at once:
   - **The apps send something the code on chain refuses** (a new deposit message, method or argument): upgrade production **before** merging into `main`, with the `staging` run from step 1. Merged first, the apps would send it to the old code, and a deposit it refuses goes back to the customer.
   - **Otherwise:** upgrade after merging, with the run of `main`'s merge commit. Its code hash isn't staging's, because it embeds `main`'s commit.

`./contract/upgrade.sh testnet <wasm>` upgrades the local testnet contract with any build; it says nothing about mainnet's stored records.

## EVM wallets (ADR-0011)

- **Nothing to configure on the server:** the NEAR Intents account is fixed per network (`intents.near`, `intents.luckout.testnet`), as in the contract, and EVM customers' intents go through the existing relayer, so it needs gas money on both networks. One relayed intent burns about 17 Tgas (about 0.002 NEAR).
- **Web:** the Reown (WalletConnect) project id defaults to Luckout's; `NEXT_PUBLIC_REOWN_PROJECT_ID` overrides it. In the Reown dashboard, the project's allowed domains must include `www.luckout.wtf`, `luckout.wtf`, `staging.luckout.wtf`, `testnet.luckout.wtf` and `localhost`, or WalletConnect refuses to connect there.
- **Testnet NEAR Intents** at `intents.luckout.testnet` is the exact wasm `intents.near` runs, deployed with `new({config:{wnear_id:"wrap.testnet",fees:{fee:0,fee_collector:"luckout.testnet"},roles:{super_admins:["luckout.testnet"]}}})` and registered on test USDC. To redeploy it after `intents.near` upgrades: fetch the code with the RPC's `view_code`, check its hash, and deploy it without an init call.

## Solana wallets (ADR-0011, amended 2026-11-18)

Staging has had them since 2026-11-18; production gets them with the release that brings them ([Releasing staging to production](#releasing-staging-to-production)), whose contract upgrade comes before the merge: production's apps then send Solana ids (64 hex), which the earlier contract doesn't credit, so a Solana customer's Top-Up would go back to their Intents Account. To prove them on staging: a small Top-Up from a real Solana wallet (USDC on Solana, plus about 0.002 SOL for the fee and the deposit address's token account), a settings change, and a withdrawal back to the Solana address.

Nothing else to configure: no new environment variables, Solana wallets use the same Reown project and allowed domains as EVM wallets (one AppKit modal), and their intents go through the existing relayer and its caps.

## ORE Top-Ups (ADR-0014)

A Solana token 1Click doesn't take (ORE) is paid through a Jupiter swap that Luckout builds and the customer's wallet signs. Two server settings:

- `JUPITER_API_KEY`: a key from portal.jup.ag. Staging and production each have their own. Without one, ORE isn't offered.
- `SOLANA_RPC_URL`: where the server simulates each swap before handing it out, and finds payments made by scanning a code. It defaults to the public `https://api.mainnet-beta.solana.com`, which is enough for staging. Production should use its own (Helius, for example). Never use Reown's: it answers `getBlockHeight` with the slot.

Solana Pay wallets call `/solana-pay/<deposit address>` on the API's own domain. nginx already passes every path to the server, so nothing changes there. No contract change.

When something goes wrong with a purchase, see [RUNBOOK.md](RUNBOOK.md).

## Logs

`pm2 logs luckout-api` (add `--lines 200` for more). pm2 writes them to `~/.pm2/logs/`, on the disk Postgres uses, and doesn't rotate them by itself. Once per site user:

```sh
pm2 install pm2-logrotate
pm2 set pm2-logrotate:max_size 20M
pm2 set pm2-logrotate:retain 14
pm2 set pm2-logrotate:compress true
```

Each log is then rotated daily, or at 20 MB if sooner, and 14 compressed old files are kept. `pm2 list` shows `pm2-logrotate` as a module.
