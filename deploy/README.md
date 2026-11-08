# Deploying the server

The server runs on our VM as a CloudPanel Node.js site under pm2. CloudPanel's nginx handles HTTPS (Let's Encrypt) and proxies to the server on `127.0.0.1:8787`. Postgres is the VM's existing server, with its own role and database. The web app deploys to Vercel separately.

## Once

1. **Site.** In CloudPanel: Add Site → Create a Node.js Site. Domain `luckout-api.gamified.trade`, site user `luckout-api`, app port `8787`. Point the domain's `A` record at the VM, then issue a Let's Encrypt certificate under SSL/TLS.
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
   git clone https://github.com/hrsh22/luckout.git .
   pnpm install --frozen-lockfile --filter @luckout/server...
   ```
5. **Secrets.** Copy `.env.example` to `.env` in the repo root, then `chmod 600 .env`. Fill in:
   - `DATABASE_URL=postgres://luckout:<password>@127.0.0.1:5432/luckout`
   - `WEB_ORIGIN=` the web app's URL, for CORS
   - `SESSION_SECRET` and `REDEMPTION_KEY` (`openssl rand -hex 32` each). Back up `REDEMPTION_KEY` somewhere safe: without it, stored voucher codes can't be decrypted.
   - the NEAR, Bitrefill, Telegram and NEAR AI values. On mainnet, the operator account should hold only a function-call key for the contract.
6. **Run.**
   ```sh
   pm2 start deploy/ecosystem.config.cjs
   pm2 install pm2-logrotate
   pm2 startup   # prints one sudo command; run it as root, then:
   pm2 save
   ```
   `https://luckout-api.gamified.trade/health` should return 204. Set `NEXT_PUBLIC_API_URL` on Vercel to `https://luckout-api.gamified.trade`.
7. **Backups.** Put the password in `~/.pgpass` (`127.0.0.1:5432:luckout:luckout:<password>`, then `chmod 600`). Run `mkdir ~/backups`, then add a line to `crontab -e`:
   ```cron
   0 3 * * * pg_dump -h 127.0.0.1 -U luckout luckout | gzip > ~/backups/luckout-$(date +\%F).sql.gz && find ~/backups -name 'luckout-*.sql.gz' -mtime +14 -delete
   ```

## Updating

```sh
cd ~/htdocs/luckout-api.gamified.trade
git pull && pnpm install --frozen-lockfile --filter @luckout/server... && pm2 reload luckout-api
```

The server runs database migrations on start. Keep it at one instance: never use pm2 cluster mode or `-i`.

Logs: `pm2 logs luckout-api`.
