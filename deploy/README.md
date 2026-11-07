# Deploying the server

The VM runs the server, Postgres (with daily dumps in `deploy/backups/`) and Caddy, which gets the HTTPS certificate for the API's subdomain automatically. The web app deploys to Vercel separately.

1. Point an `A` record for the API subdomain (e.g. `api.example.com`) at the VM, and open ports 80 and 443.
2. Install Docker with the Compose plugin, then clone the repo.
3. Create `deploy/.env` from the repo's `.env.example`, plus:
   - `API_DOMAIN=api.example.com`
   - `POSTGRES_PASSWORD=` a long random string (`openssl rand -hex 24`)
   - `WEB_ORIGIN=` the Vercel URL, for CORS
   - `SESSION_SECRET` and `REDEMPTION_KEY` (`openssl rand -hex 32` each). Back up `REDEMPTION_KEY`: without it, stored voucher codes can't be decrypted.
   - the NEAR, Bitrefill, Telegram and NEAR AI values. Leave `DATABASE_URL` out; Compose sets it.
4. `cd deploy && docker compose up -d --build`
5. Check that `https://api.example.com/health` returns 204, then set `NEXT_PUBLIC_API_URL` on Vercel to that URL.

Update with `git pull && docker compose up -d --build`. The server runs database migrations on start.
