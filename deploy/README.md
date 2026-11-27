# Deploying

Luckout runs on Solana (ADR-0015): one program per environment, a server on our VM, and the web on Vercel.

## Environments

| | Staging | Production |
|---|---|---|
| Branch | `staging` (PRs from feature branches, with CI passing) | `main` (only by PR from `staging`, with CI passing) |
| Program | `FM2mRU3R8jtCArHTK4fYiSseDmR9vjhJfPa9D5A2sv3F` (build `--features staging`) | `GCeZ67ann5G1hzNijYtqFiHyAJ4dJy2mwFA6g2eQfssr` (build `--features production`) |
| Owner and upgrade authority | `CXob1pBz6wDrZ3Jys3L2vw2MWAMha3B49zMC9mH5psQb`, a key on the operator's Mac until the owner has backed it up | a key in the owner's own wallet |
| Operator, fee payer | `B6iF2cR8KUeQNS3Gqd6CskP48UZaqbtFa5eHe6KxfuEc`, `Ex44UESieWATsL8JngBeSi8uEKMTBWeMuAH1bPChVQcH`, made on the VM | made on the VM |
| Pay Wallet | `9vQpDTkUwS8C4o3jpfS1FjdMoyvpbcyfx4UXgNRYq1RP`, made on the VM; Bitrefill tags it | made on the VM; Bitrefill tags it |
| Web (Vercel) | Preview env vars for branch `staging`, domain `staging.luckout.wtf` | Production env vars, `www.luckout.wtf` (`luckout.wtf` redirects to it) |
| API | `staging-api.luckout.wtf`, VM user `luckout-staging-api`, port 8791 | `api.luckout.wtf`, VM user `luckout-api`, port 8788 |
| Database | `luckout_staging_solana` (role `luckout_staging`) | its own, new for Solana |
| Privy app | `cmwz7cuc801kz0gjsauacf152` | `cmwz93eyl01fi0hgud1cnlncc` |
| Telegram | the staging bot | the mainnet bot |
| Bitrefill | its own guest client; its account's key reads the catalog | its own guest client; its account's key reads the catalog |

Devnet is for local development: the program at `4Tziwbh1vEDremxPViXgEa91FP3Nv4hUyNmLXMzRK2Z3` (built with no feature), a test USDC mint, and only Bitrefill's free test cards.

Staging is a small copy of production on mainnet (ADR-0010): real money in small amounts, its own program, keys and caps, so a release is tried there before it reaches `main`. Nothing is shared that could move money across: each environment has its own program, database, keys, bot, Privy app and Bitrefill client. The NEAR databases and their `.env` backups (`.env.near-<date>`) stay on the VM.

A merge into `staging` deploys staging's server, and a merge into `main` deploys production's, once the `DEPLOY_STAGING` / `DEPLOY_MAINNET` repository variables are `on`. Each site's CI key in `~/.ssh/authorized_keys` runs only `deploy/remote-deploy.sh` with that site's branch, and the script refuses a branch that doesn't match the site's `SOLANA_CLUSTER` and VM user, or one that has moved past the commit CI tested. By hand: `pnpm deploy:staging` or `pnpm deploy:mainnet`. **Programs are deployed by hand, never from CI.**

**The web follows the API.** Vercel doesn't deploy `main` or `staging` by itself (`apps/web/vercel.json`). CI's `web` job, which runs only after the `deploy` job succeeds, calls that branch's Vercel Deploy Hook (the `VERCEL_DEPLOY_HOOK_MAIN` and `VERCEL_DEPLOY_HOOK_STAGING` secrets), so the web goes live only once the API it calls has. With `DEPLOY_MAINNET` or `DEPLOY_STAGING` off, that branch's web isn't deployed either: use Redeploy in Vercel, or `curl -X POST` the hook's URL. A hook URL is as good as a password.

**Vercel builds the web only when it changed** (`ignoreCommand` in `apps/web/vercel.json`): `apps/web`, `packages`, the root `package.json`, `pnpm-lock.yaml`, `pnpm-workspace.yaml` or `tsconfig.base.json`. A `NEXT_PUBLIC_*` variable is baked in at build time, so after changing one in Vercel, Redeploy and untick **Use project's Ignore Build Step**.

SSH (22) and CloudPanel (8443) are open only to our Tailscale tailnet; only 80 and 443 are public. The VM is `milesvm` (100.85.5.47, `tag:server`). CI joins as `tag:ci` and reaches only port 22.

## Keys

| Key | Holds | Lives |
|---|---|---|
| Owner (also the upgrade authority) | the pause, the reserve, Proceeds, the caps, the operator, the Pay Wallet, ownership, upgrades | the owner's wallet, never on the VM. The server refuses to start if any of its keys is the owner's. |
| Program keypair | only the program's address, used once by the first deploy | the operator's Mac; worthless after the first deploy |
| Operator | admits and settles Checkouts | the VM's `.env` (`SOLANA_OPERATOR_SECRET_KEY`) |
| Fee payer | pays every transaction's fee and the rent of customers' accounts | the VM's `.env` (`SOLANA_FEE_PAYER_SECRET_KEY`); holds SOL |
| Pay Wallet | pays Bitrefill's invoices in USDC; `settle` repays it | the VM's `.env` (`SOLANA_PAY_WALLET_SECRET_KEY`); holds USDC and a little SOL |

The VM's keys are made on the VM, so their secrets never travel: an ed25519 key in Solana's 64-byte form, base58, in `.env` (mode 600). Print only public keys when checking them.

## A new program (staging, then production)

Once per environment. Needs the Solana CLI (Agave 4.4.1) and `solana-verify` on the machine with the owner's key.

1. **The build.** CI's `program-build` job builds each environment reproducibly and uploads `luckout-so-<environment>-<commit>`; its summary shows each build's executable hash. Download it from the green run of the commit being released and check the hash:
   ```sh
   gh run download <run id> -n luckout-so-staging-<commit> -D ~/luckout-so/staging-<commit>
   solana-verify get-executable-hash ~/luckout-so/staging-<commit>/luckout.so   # = the hash in the run's summary
   ```
2. **SOL for the owner.** The program locks about 2.42 SOL of rent (477 KB; refundable if it's ever closed), and the deploy needs as much again for a buffer while it uploads, returned when it finishes: send the owner about 5 SOL. Check with `solana rent <bytes of luckout.so>`.
3. **Deploy**, as the owner, through a paid RPC (the public one drops many of the deploy's transactions):
   ```sh
   solana program deploy ~/luckout-so/staging-<commit>/luckout.so \
     --program-id ~/.luckout/solana-staging-program.json \
     --upgrade-authority ~/.luckout/solana-staging-owner.json --keypair ~/.luckout/solana-staging-owner.json \
     --url "$RPC" --with-compute-unit-price 20000 --max-sign-attempts 50 --use-rpc
   solana program show FM2mRU3R8jtCArHTK4fYiSseDmR9vjhJfPa9D5A2sv3F --url "$RPC"   # authority = the owner
   ```
   If it stops midway, `solana program show --buffers --url "$RPC"` lists the buffer; resume with `--buffer <its keypair>` or close it to get the SOL back (`solana program close <buffer>`).
4. **Anyone can check it** against the source: `solana-verify verify-from-repo -u "$RPC" --program-id <program> https://github.com/hrsh22/luckout --commit-hash <commit> --library-name luckout --mount-path programs -- --features staging`.
5. **Set it up** with `apps/server/scripts/solana-init.ts`, which opens the Pay Wallet's USDC account and calls `initialize` as the upgrade authority. It simulates first, including an initialize with USDT, which a mainnet build must refuse:
   ```sh
   RPC_URL="$RPC" PROGRAM_ID=FM2mRU3R8jtCArHTK4fYiSseDmR9vjhJfPa9D5A2sv3F OWNER_KEY=~/.luckout/solana-staging-owner.json \
     OPERATOR=B6iF2cR8KUeQNS3Gqd6CskP48UZaqbtFa5eHe6KxfuEc PAY_WALLET=9vQpDTkUwS8C4o3jpfS1FjdMoyvpbcyfx4UXgNRYq1RP \
     node apps/server/scripts/solana-init.ts          # then again with --send
   ```
   The program starts unpaused, with a $500 daily repay cap, a 2.5 USDC smallest Lucky Checkout, a Cashback Cap of the lower of $50 and 20% of the free reserve, and an empty reserve.
6. **Money in place:**
   - the fee payer: about 0.1 SOL for staging (each new customer's account costs about 0.0017 SOL of rent, and each Draw 0.0018 SOL for ORAO's request);
   - the Pay Wallet: USDC for about a day of sales (its float) and about 0.01 SOL;
   - the reserve, from the owner's USDC, in the Admin panel (Fund).
7. **The server** ([Server settings](#server-settings)), then merge the release into the branch and turn its `DEPLOY_*` variable `on`.
8. **Prove it** with small money: a deposit from an exchange and from a wallet, a Normal card, a Lucky card and a Cart of two, a card through the bot, a Top-Up from another chain, a withdrawal, and the owner actions in the Admin panel.

## Server settings

The `.env` in the repo root on the site user (mode 600). On mainnet the server refuses to start with any required value missing or weak (`MAINNET_REQUIRES` in `apps/server/src/main.ts`), and with keys that don't match the program (`checkKeys`): an operator or Pay Wallet that isn't the program's, or any key that is the owner's. The key check comes before the database, so a server refused there has run no migration.

- `PORT`, `DATABASE_URL`, `WEB_ORIGIN` (and `CORS_ORIGINS` for any other origin)
- `SESSION_SECRET` and `REDEMPTION_KEY` (`openssl rand -hex 32` each; back up `REDEMPTION_KEY`: without it, stored codes can't be read)
- `SOLANA_CLUSTER=mainnet`, `SOLANA_PROGRAM_ID`, `SOLANA_RPC_URL` (a paid RPC; never Reown's, which answers `getBlockHeight` with the slot), and the three keys above. `SOLANA_PRIORITY_MICROLAMPORTS` (default 10,000) raises the priority fee when mainnet is busy.
- `PRIVY_APP_ID`: the environment's Privy app. In Privy's dashboard, "Return user data in an identity token" must be on, and the site's domain allowed.
- `ALCHEMY_WEBHOOK_SIGNING_KEY` (optional): Alchemy's Address Activity webhook to `https://<api>/webhooks/deposits` sweeps a deposit at once. Without it, the sweep every two minutes does the work.
- Bitrefill: `BITREFILL_API_KEY` (reads the catalog), and a guest client ([below](#a-bitrefill-client-for-guest-checkout-adr-0012)).
- `JUPITER_API_KEY` (USDT and ORE swaps; each environment its own), `ONECLICK_API_KEY` (Top-Ups from other chains)
- `TELEGRAM_BOT_TOKEN`, `ALERT_TELEGRAM_CHAT_ID` (alerts reach a human), `NEAR_AI_API_KEY` (the bot's model)
- `ADMIN_ACCOUNTS`: the Privy wallet addresses (comma-separated) that may open `/admin`

The database records its cluster and program on first start and refuses another (`DeploymentLock`), so a NEAR database or another program's can't be reused by mistake.

**Web (Vercel)**, per environment: `NEXT_PUBLIC_API_URL`, `NEXT_PUBLIC_SOLANA_CLUSTER=mainnet`, `NEXT_PUBLIC_SOLANA_PROGRAM_ID` (the Admin panel signs owner transactions only for this program) and `NEXT_PUBLIC_PRIVY_APP_ID`.

## Once per site

1. **Site.** In CloudPanel: Add Site → Create a Node.js Site with the site user and app port. Point the API's name at the VM (proxied by Cloudflare), then issue a Let's Encrypt certificate for it.
2. **Timeout, body size and client address.** In the Vhost tab, `proxy_read_timeout 120s;` in `location /`, and under `server_name`:
   ```nginx
   client_max_body_size 64k;
   set_real_ip_from 127.0.0.1;
   ```
   A purchase request waits up to a minute for the card (`PURCHASE_REQUEST_WAIT_MS`), under Cloudflare's 100 s. The second line stops a caller that skips Cloudflare from naming its own address and slipping past the rate limits.
3. **Postgres**, as the admin (`ssh postgres-milesvm`): `createdb -O <role> <database>`, or a new role first.
4. **Node and code**, as the site user:
   ```sh
   git clone git@github.com:hrsh22/luckout.git .   # with a read-only deploy key
   nvm install && nvm alias default "$(cat .nvmrc)"
   pnpm install --frozen-lockfile --filter @luckout/server...
   ```
5. **`.env`** as in [Server settings](#server-settings).
6. **Run:** `pm2 start deploy/ecosystem.config.cjs && pm2 save`; `https://<api>/health` answers 204.
7. **Reboots and backups**, in `crontab -e` (pm2 and pnpm live in `/usr/local/bin`):
   ```cron
   PATH=/usr/local/bin:/usr/bin:/bin
   @reboot bash -c '. ~/.nvm/nvm.sh && cd ~/htdocs/<site> && pm2 resurrect'
   0 3 * * * bash ~/htdocs/<site>/deploy/backup.sh -h 127.0.0.1 -U <role> <database> >> ~/backups/backup.log 2>&1
   ```
   `deploy/backup.sh` keeps a dump only if it is complete, prunes after a good one, and alerts the admin chat when a night's dump fails. Restoring: [RUNBOOK.md](RUNBOOK.md#restoring-from-a-dump).

## A Bitrefill client for guest checkout (ADR-0012)

Staging and production each buy as a guest through their own Bitrefill client. **Registering one:** at `https://api.bitrefill.com/oauth/mcp/register`, client name `Luckout` (staging: `Luckout (staging)`), `redirect_uris: ["https://api.luckout.wtf/bitrefill/callback"]` (staging: `https://staging-api.luckout.wtf/bitrefill/callback`), `grant_types: ["client_credentials", "authorization_code", "refresh_token"]`, `token_endpoint_auth_method: "client_secret_post"`. The reply holds the secret. The `.env` takes `BITREFILL_CLIENT_ID`, `BITREFILL_CLIENT_SECRET`, `BITREFILL_CLIENT_SECRET_EXPIRES_AT` (the reply's seconds since 1970, as given) and `BITREFILL_REDIRECT_URI`.

**Every 90 days** the secret expires; the server alerts daily from two weeks before. Register a new client, replace the three values, restart. Customers' Bitrefill Connections belong to the old client, so they connect again.

## Updating

CI deploys each branch once its tests pass. By hand, as the site user: `bash deploy/remote-deploy.sh staging` (or `main`). The script refuses if a tracked file was edited on the VM, installs dependencies before restarting anything (and puts the old source back if that fails), reloads, and passes only if `/health` answers from one steady process it started. Its last line names the commit and the one it replaced. The first deploy after this script changes still runs the old copy, which bash already has open.

The server runs database migrations on start. Keep it at one instance (a second process against the same database refuses to start). A reload waits for purchases in progress, up to pm2's `kill_timeout` of 3 minutes. After changing `deploy/ecosystem.config.cjs`: `pm2 startOrReload deploy/ecosystem.config.cjs && pm2 save`.

**Going back:** a failed deploy prints the command, `bash deploy/remote-deploy.sh <branch> <earlier commit>`. Migrations stay: check `git diff <earlier> <failed> -- apps/server/src/Db.ts` first. A new table, or a new nullable or defaulted column, doesn't bother the old code; anything else means fixing forward.

## Upgrading a program

In place: same address, same accounts, new code, so balances never move. The program reserves spare bytes in its accounts and records a layout number, so an upgrade may add a field in the spare bytes; one that changes a layout must also make the older build refuse the new accounts. A release goes to staging's program first, and to production's only after staging has sold with it.

1. **Keep the build running now:** `solana program dump <program> ~/luckout-so/<environment>-before-<date>.so --url "$RPC"`.
2. **The new build** from CI, its hash checked (step 1 of [A new program](#a-new-program-staging-then-production)).
3. **Stop sales** (Admin → Stop sales), and wait until nothing is at `admit`. The owner's pause also works and refuses every new Checkout on chain.
4. **Deploy** as the upgrade authority: the same `solana program deploy` command with `--program-id <program address>` (no keypair needed now). It writes a buffer, then swaps it in; the program's rent grows only if the build is bigger.
5. **Check:** `solana program show <program>`; the Admin panel reads the reserve, the caps and a customer as before; a small purchase settles and draws.
6. **Restart sales.** If anything is wrong: deploy the dumped build from step 1 the same way.

## Logs

`pm2 logs luckout-api` (add `--lines 200` for more). pm2-logrotate is installed per site user (`pm2 install pm2-logrotate`, `max_size 20M`, `retain 14`, `compress true`).

When something goes wrong with a purchase, see [RUNBOOK.md](RUNBOOK.md).
