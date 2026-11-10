# Run testnet and mainnet as separate deployments

Luckout moves real money on mainnet while the testnet demo stays open to anyone. Switching one deployment between the two networks was rejected: a single server and database flipping between test and real money could point a real purchase at the test contract, mix test orders into real accounting, or use a testnet key on mainnet. The wallet's network and the contract ids are also built into the web app at build time.

So the two networks never share anything that could move money:

| | Testnet | Mainnet |
|---|---|---|
| Branch | `testnet`, where development happens | `main`, changed only by a PR from `testnet` with CI passing (enforced for admins too) |
| Web | Vercel Preview env, `testnet.luckout.gamified.trade` pinned to branch `testnet` | Vercel Production env, `luckout.gamified.trade` |
| API | `luckout-testnet-api.gamified.trade`, its own VM user | `luckout-api.gamified.trade`, its own VM user |
| Database, Telegram bot, Bitrefill account, NEAR accounts | each its own | each its own |

Guards make a mix-up fail loudly instead of quietly:
- Each database records the network it belongs to, and a server for the other network refuses to start against it.
- A server refuses to start if its `.env` names accounts from the other network (`.testnet` on mainnet, `.near` on testnet).
- The web build fails if its network and its contract ids or API disagree.
- The deploy script refuses to deploy a branch that doesn't match the site's network.
- Each site's CI key can only run that site's deploy script.

A push to `testnet` deploys the testnet API after CI passes, and merging into `main` deploys mainnet. Contracts are deployed by hand (`contract/deploy-testnet.sh`, `contract/deploy-mainnet.sh`), never from CI. Mainnet starts with small limits (Bitrefill credit up to $30, $15 largest order, $40 of refills a day, 5 free relays per account) that admins raise as it proves itself.

Every alert says which network it's about, so both can share one alert chat. Vercel's Hobby plan covers this layout, but is limited to non-commercial use; the plan is to move to Pro as sales grow.
