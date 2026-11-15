# Run testnet and mainnet as separate deployments

Luckout moves real money on mainnet while the testnet demo stays open to anyone. Switching one deployment between the two networks was rejected: a single server and database flipping between test and real money could point a real purchase at the test contract, mix test orders into real accounting, or use a testnet key on mainnet. The wallet's network and the contract ids are also built into the web app at build time.

So the deployments never share anything that could move money:

| | Testnet | Staging | Production (mainnet) |
|---|---|---|---|
| Network | testnet | mainnet | mainnet |
| Branch | `testnet` | `staging`, changed only by a PR with CI passing | `main`, changed only by a PR from `staging` with CI passing (enforced for admins too) |
| Web | Vercel Preview env, `testnet.luckout.wtf` pinned to branch `testnet` | Vercel Preview env for branch `staging`, `staging.luckout.wtf` | Vercel Production env, `www.luckout.wtf` |
| API | `testnet-api.luckout.wtf`, VM user `luckout-testnet-api` | `staging-api.luckout.wtf`, VM user `luckout-staging-api`, port 8791 | `api.luckout.wtf`, VM user `luckout-api` |
| Contract and NEAR accounts | `*.luckout.testnet` | `*.staging.luckout.near` | `*.luckout.near` |
| Database, Telegram bot | each its own | each its own | each its own |
| Bitrefill | its own account (free test cards) | its own guest client for orders (ADR-0012); reads the catalog with the testnet account's key, which holds $0 | its own guest client for orders; its account's key reads the catalog |

**Staging (added 2026-11-15).** Testnet can't exercise what only exists on mainnet: 1Click top-ups and send-backs (NEAR Intents has no testnet), real Bitrefill delivery, and refills through our Base wallet. Staging is a smaller copy of production on mainnet, with its own contract, accounts and small caps, so a release meets real money there before it reaches `main`. Tests spend small amounts of real money; that is accepted.

**Testnet becomes local (planned).** Once the hackathon's judging is over, the hosted testnet (its VM user, Vercel domain and the `testnet` branch) retires, and testnet runs on a developer's machine, shared over Tailscale when needed. Luckout then has no free public demo, which is accepted. Releases go feature branch → `staging` → `main`.

Guards make a mix-up fail loudly instead of quietly:
- Each database records the network and the contract it belongs to, and a server for another deployment refuses to start against it.
- A server refuses to start if its `.env` names accounts from the other network (`.testnet` on mainnet, `.near` on testnet).
- The web build fails if its network and its contract ids or API disagree, or if it pairs production's contract with another API (or the reverse).
- The deploy script refuses a branch that doesn't match the site's network and VM user.
- Each site's CI key can only run that site's deploy script.

A push to `testnet` deploys the testnet API after CI passes, merging into `staging` deploys staging, and merging into `main` deploys production. Contracts are deployed by hand (`contract/deploy-testnet.sh`, `contract/deploy-mainnet.sh`), never from CI. Mainnet starts with small limits (Bitrefill credit up to $30, $15 largest order, $40 of refills a day, 5 free relays per account) that admins raise as it proves itself.

Every alert says which network it's about, so both can share one alert chat. Vercel's Hobby plan covers this layout, but is limited to non-commercial use; the plan is to move to Pro as sales grow.
