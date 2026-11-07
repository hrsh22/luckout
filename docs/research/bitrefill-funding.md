# Bitrefill funding without BTC exposure

Researched 2026-11-07 against Bitrefill's public docs (docs.bitrefill.com, help.bitrefill.com, github.com/bitrefill) and the live API with our Personal API key. No funds were sent and no settings were changed. Request bodies are shown in full; the API key, the account email and the user id are redacted.

## Answer in one paragraph

Our account **already has three store-credit sub-accounts: USD, EUR and BTC**. BTC is marked `primary`, and REST v2 (`/accounts/balance`, `/products*`, `POST /invoices` with `payment_method: "balance"`) only ever sees the primary one. We can fund the **USD** sub-account with USDC via `POST /v2/accounts/deposit {"currency":"USD","payment_method":"usdc_base"}`, which works on our key. REST v2 cannot spend from it: it ignores `balance_currency`. Bitrefill's **eCommerce MCP server** (`https://api.bitrefill.com/mcp`, same Bearer key) can: `buy-products` with `payment_method: "balance", balance_currency: "USD"`, and it quotes prices in USD/USDC. Alternatively, every invoice can be paid directly in USDC on Base, Arbitrum, Solana or Polygon (no float at all), at about 1% more than the balance price and with on-chain latency. USDC on NEAR is not supported anywhere.

Separately, we found a pricing bug in the current server: see [Side finding](#side-finding-the-current-rate-understates-cost-by-about-4).

---

## Q1. Can the balance be held in USD (or a stablecoin)?

**Yes, as a USD (or EUR) store-credit sub-account. It exists on our account today, with a zero balance.**

Evidence. MCP `tools/call get-balances {}` (trimmed):

```yaml
balances[4]:
  - payment_method: balance
    balance_currency: BTC
    amount: "0.00000000"
    primary: true
  - payment_method: balance
    balance_currency: EUR
    amount: "0.00"
  - payment_method: balance
    balance_currency: USD
    amount: "0.00"
    decimals: 2
  - payment_method: cashback
    balance_currency: BTC
top_up[3]:
  - currency: USD
    product_id: bitrefill-deposit-usd
    max_amount: { amount: "2000.00", currency: USD }
    payment_methods: crypto
  - currency: EUR  ...  product_id: bitrefill-deposit-eur
  - currency: BTC  ...  product_id: bitrefill-deposit-btc, payment_methods: "bitcoin, lightning"
agent_instructions: "... Each entry is a separate sub-account and a purchase debits one of them. ...
  Pay from one with buy-products payment_method \"balance\" plus balance_currency ...
  max_amount is the room left under one limit shared by all sub-accounts ...
  above it the credit is held for manual review. Crypto payment only; the BTC top-up only with bitcoin or lightning."
```

How each surface behaves:

| Surface | Sees USD sub-account? | Evidence |
|---|---|---|
| REST `GET /v2/accounts/balance` | **No**, primary only | `{"balance":0,"currency":"BTC"}`. Same result with `?currency=USD` and `?balance_currency=USD`. No `/accounts`, `/accounts/balances`, `/account`, `/user` routes (all 404). |
| REST `POST /v2/invoices` `payment_method:"balance"` | **No**, always debits primary | Bodies with `"balance_currency":"USD"`, `"currency":"USD"`, `"payment_currency":"USD"`, `"balance":"USD"` or `"wallet":"USD"` (test product, `auto_pay:false`) all came back as `"payment":{"method":"balance","currency":"BTC","price":13833,...}`. |
| MCP `get-balances` | **Yes**, per sub-account | above |
| MCP `buy-products` | **Yes** | Schema: `balance_currency`: *"Which currency sub-account to debit when payment_method is "balance". One of: EUR, USD, BTC. If omitted, uses the user's primary currency. ... multi-balance payments (combining multiple sub-accounts) are not supported yet."* |

**Switching the primary sub-account to USD.** The OpenAPI spec implies prices follow the primary currency: package `price` is *"Price of the package in the user's currency"*, `range.price_rate` is the *"Price rate between the product currency and the user's currency"*, and the `/accounts/balance` example is `{"balance":10,"currency":"EUR"}` ([get_products-id](https://docs.bitrefill.com/reference/get_products-id.md), [get_accounts-balance](https://docs.bitrefill.com/reference/get_accounts-balance.md)). So if the primary were USD, REST would likely return USD prices and debit USD with no other change. **I found no API, MCP tool or help article that changes the primary currency.** It may be a website account setting; I couldn't check, because the website needs a logged-in session, not the API key. Worth a 2-minute look at bitrefill.com account settings. If such a setting exists, note it may not be reversible.

Caveats from the help center:
- *"Unfortunately, it is not possible to convert or exchange USD or EUR store credit to Bitcoin."* ([6262200463890](https://help.bitrefill.com/hc/en-us/articles/6262200463890-Can-I-convert-or-exchange-my-USD-or-EUR-store-credit-to-Bitcoin))
- *"Unfortunately, we are unable to offer refunds purchased store credit in USD or EUR."* ([6262162349202](https://help.bitrefill.com/hc/en-us/articles/6262162349202-Is-it-possible-to-get-a-reimbursement-for-my-prepaid-store-credit-in-USD-and-EUR)). USD credit is a one-way door, so keep the float small.
- There is a $2,000 cap shared across all sub-accounts (from `get-balances`). Above it, credit is held for manual review.
- There is no stablecoin-denominated balance (USDC/USDT). Deposit `currency` accepts only `EUR|USD|BTC`: `"currency":"USDC"` → `400 Invalid option: expected one of "EUR"|"USD"|"BTC"`.

## Q2. Can product prices or invoices be quoted in USD?

**REST v2: no. Prices follow the primary sub-account (BTC, in sats). MCP: yes.**

- REST: `currency`, `payment_currency` (already tried) and `balance_currency` on `/products/{id}` have no effect, and the spec lists no such param on `/products`, `/products/{id}` or `/products/search` ([spec](https://docs.bitrefill.com/reference/get_products.md)).
- A REST invoice with a stablecoin `payment_method` is quoted in that coin's base units. This is effectively a USD quote, but it costs an invoice per quote (see Q3).
- MCP `get-product-details` takes `currency` ∈ `BTC, ETH, USDT, USDC, SOL, USD, EUR, GBP, AUD, CAD, INR, BRL` and returns `payment_price` per package:

```text
tools/call get-product-details {"product_id":"amazon-south-africa","currency":"USD"}
packages[6]{package_value,package_currency,payment_price,payment_currency}:
  "500",ZAR,"30.88",USD
  "100",ZAR,"6.17",USD
  ...
```

  `currency:"USDC"` gives the same numbers. Note that `payment_price` is the **crypto-checkout price**, not the balance price: with `currency:"BTC"`, 500 ZAR = 41,124 sats, which matches the REST `bitcoin` invoice (41,081), not the REST balance price (40,674). So it is about 1% above what the balance pays (see the price table below).
- MCP does **not** expose test products: `get-product-details {"product_id":"test-gift-card-code"}` → `Product 'test-gift-card-code' was not found.`

**Could not determine:** the exact amount the **USD sub-account** is charged for a product. It is probably the sats balance price converted at Bitrefill's rate (about $30.57 for 500 ZAR) or the checkout price ($30.88). Settling it needs a small USD deposit and one real purchase.

## Q3. Can an invoice be paid directly with a stablecoin?

**Yes, with USDC/USDT on several chains, via REST v2 or MCP. Not on NEAR.**

`POST /v2/invoices` `payment_method` values per the spec ([post_invoices](https://docs.bitrefill.com/reference/post_invoices.md)): `balance, bitcoin, lightning, ethereum, usdc_base, eth_base, usdt_erc20, usdc_erc20, usdt_trc20, usdc_polygon, usdt_polygon, usdc_arbitrum, usdt_arbitrum, eth_arbitrum, usdc_solana, usdt_solana, solana, usdt_lightning, dogecoin, dash, litecoin, ton, usdt_ton`. MCP `buy-products` additionally lists `usdc_bsc, usdt_bsc, usdc_sui, usdt_sui, usdc_tempo, usdt_tempo, brusd_*, ark, …`.

Live checks (test product `test-gift-card-code<&>10`, left unpaid):

| `payment_method` | Result |
|---|---|
| `usdc_base`, `usdc_polygon`, `usdc_solana`, `usdc_arbitrum`, `usdt_ton` | 200, `"currency":"USDC"`/`"USDT"`, `"price":10500000` (10.50, 6-decimal base units) |
| `usdc_bsc` | 400 `unsupported_payment_method` on REST (listed only by MCP) |
| `usdc_near`, `usdt_near`, `near` | 400 `unsupported_payment_method` |

Request and trimmed response:

```text
POST /v2/invoices
{"products":[{"product_id":"test-gift-card-code","package_id":"test-gift-card-code<&>10","quantity":1}],"payment_method":"usdc_base"}

{"data":{"id":"0ece36ef-…","status":"not_delivered",
 "payment":{"method":"usdc_base","address":"0xA0D6…095b","currency":"USDC","price":10500000,"status":"unpaid","commission":0},
 "orders":[{"status":"created","product":{"id":"test-gift-card-code","value":"10","currency":"USD"}}]}}
```

- **Returned:** the payment `address`, `currency`, and `price` in base units. REST returns **no expiry field**. The MCP `buy-products` response for the same kind of invoice includes `"expiration_minutes": 60` and `payment_info` with `address`, `altcoinPrice: "0.64"`, `altBasePrice: 640000`, `contractAddress` (Base USDC `0x8335…2913`) and an EIP-681 `paymentUri`.
- **`refund_address`:** the docs say it is *"Required for crypto payments"* ([integration-flow](https://docs.bitrefill.com/docs/integration-flow.md)), but our invoices were accepted without one. Send one anyway.
- **Delivery speed after payment:** I couldn't measure it without sending funds. The docs only say: *"Lightning: Instant · Bitcoin: 10-60 minutes · Ethereum/L2: 1-5 minutes · Stablecoins: Varies by network"* ([crypto-payments](https://docs.bitrefill.com/docs/crypto-payments.md)). Completion arrives through `webhook_url` or by polling.
- **Cost:** about 1% more than paying from balance (table below).
- **NEAR:** not supported. It is not in the docs, not in the MCP enum, and the API rejects it. A NEAR-side flow would need to bridge USDC out first (e.g. via NEAR Intents to Base). I haven't verified that path here.
- There is also an x402 checkout (`POST /x402/invoice/pay`, USDC on EVM/Solana) documented in [bitrefill/agents](https://github.com/bitrefill/agents/blob/main/skills/bitrefill/references/touchpoints/x402.md). I didn't test it; it doesn't help beyond the plain USDC invoice.

### Price of the same item by payment method (2026-11-07, about 12:39 UTC)

USD equivalents use Bitrefill's own deposit rate: 13,306 sats per $10 (see Q5).

| Item | Balance (sats) | ≈ USD | `bitcoin` invoice (sats) | `usdc_base` invoice | USDC vs balance |
|---|---:|---:|---:|---:|---:|
| test-gift-card-code $10 | 13,833 | $10.40 | — | 10.50 | +1.0% |
| amazon-fresh-india 500 INR | 7,376 | $5.54 | 7,450 | 5.60 | +1.0% |
| amazon-south-africa 500 ZAR | 40,674 | $30.57 | 41,081 | 30.87 | +1.0% |

## Q4. How is the balance topped up?

**`POST /v2/accounts/deposit`. It works on our Personal Bearer key**, although the docs say *"Account deposits via API are only available to Business API accounts"* ([account-deposits](https://docs.bitrefill.com/docs/account-deposits.md)).

Spec ([post_accounts-deposit](https://docs.bitrefill.com/reference/post_accounts-deposit.md)): body `{currency: "EUR"|"USD"|"BTC", payment_method, amount?}`. If `amount` is omitted, the deposit is flexible-amount. Supported methods:
> - BTC: bitcoin, lightning, ethereum, litecoin, dogecoin, dash, solana
> - ETH: ethereum, eth_base, eth_arbitrum
> - USDT: usdt_trc20, usdt_erc20, usdt_polygon, usdt_solana, usdt_bsc, usdt_arbitrum
> - USDC: usdc_erc20, usdc_polygon, usdc_solana, usdc_base, usdc_bsc, usdc_arbitrum

Live (all left unpaid):

```text
POST /v2/accounts/deposit {"currency":"USD","payment_method":"usdc_base","amount":10}
→ 200 {"data":{"id":"2bc854fa-…","status":"not_delivered",
        "payment":{"method":"usdc_base","address":"0x45ec…e9f1","currency":"USDC","price":10000000,"status":"unpaid","commission":0}}}
GET /v2/invoices/2bc854fa-… → orders[0].product = {"id":"bitrefill-deposit-usd","name":"USD Store Credit","value":"10","currency":"USD"}

POST … {"currency":"USD","payment_method":"bitcoin","amount":10}    → 200, BTC price 13306 (sats)
POST … {"currency":"USD","payment_method":"bitcoin","amount":100}   → 200, BTC price 133057
POST … {"currency":"USD","payment_method":"lightning","amount":10}  → 200, BOLT11 for 13306 sats
POST … {"currency":"BTC","payment_method":"bitcoin","amount":0.0001}→ 200, price 10000
POST … {"currency":"BTC","payment_method":"usdc_base","amount":10}  → 400 "BTC top-ups can only be purchased with Bitcoin or Lightning."
POST … {"currency":"USDC",…}                                         → 400 expected one of "EUR"|"USD"|"BTC"
POST … {"currency":"USD","payment_method":"usdc_near",…}            → 400 "This payment method is not available for adding balance."
```

Findings:
- A deposit is just a purchase of the product `bitrefill-deposit-usd` / `-eur` / `-btc`. Those products are not fetchable via REST `/products/{id}` (403 `not_available`) but are accepted by the deposit endpoint and by MCP `buy-products`.
- **$10 USD of credit paid in USDC costs exactly 10.000000 USDC**: no spread, `commission: 0`.
- The deposit's `payment.price` is in base units (USDC 6 decimals, BTC sats), though the docs example shows `0.00234567`.
- The docs say the status becomes `complete` once credited. Our unpaid deposits sit at `not_delivered` with `payment.status: "unpaid"`.
- The deposit order echoes the account email in a `phone_number` field. Don't log it.
- Help center: store credit can also be added on the website, including LI.FI swaps (*"Transactions are automatically swapped to USDC and then used to add USD or EUR store credit."*, [11163727483538](https://help.bitrefill.com/hc/en-us/articles/11163727483538)).

## Q5. Is there an exchange-rate endpoint or a USD price field?

**There is no rate endpoint.** `/rates`, `/exchange-rates` and `/currencies` all return 404, and the OpenAPI spec has none.

USD prices we can get today:
1. **MCP `get-product-details` with `currency:"USD"`.** Gives a USD `payment_price` per package. It is the checkout price (about 1% above balance), so it is a conservative Reference Price.
2. **Use `range.price_rate`** (`test-gift-card-code`: `1383.26` sats per USD). It includes that product's markup, so it has the same flaw as today's method.
3. **Bitrefill's clean BTC/USD rate:** `POST /accounts/deposit {"currency":"USD","payment_method":"bitcoin","amount":100}` → `payment.price` sats. It is accurate, but creates a junk unpaid invoice each time (rate limit: 60 per 10 min). Not recommended as a feed.

With a USD balance (Q1) none of these matter: prices come in USD.

## Side finding: the current rate understates cost by about 4%

`apps/server/src/Bitrefill.ts` treats the sat price of the $10 test card as "$10 of BTC". But the test card costs 13,833 sats, while $10 of USD credit costs 13,306 sats: the test card carries about a 4% markup. Every converted price is therefore about 3.8% too low. For example, 500 ZAR = 40,674 sats → the server's formula gives **$29.40**, but the purchase really costs about **$30.57** from balance, or **$30.87** in USDC. The rounding up in `satsToMicroUsdc` doesn't help, because the rate itself undercuts. Moving to USD prices fixes this. Otherwise, at minimum, derive the rate from the deposit quote, not from the test card.

## Recommendation

**Hold the float in the USD sub-account, fund it with USDC, and buy through the MCP endpoint with `balance_currency: "USD"`.** This keeps sub-second delivery from balance and removes BTC exposure. Deposits in USDC are 1:1, and prices come in USD.

Concrete calls (same `Authorization: Bearer $BITREFILL_API_KEY` throughout):

1. **Top up (ops, occasionally).** `POST https://api.bitrefill.com/v2/accounts/deposit` `{"currency":"USD","payment_method":"usdc_base","amount":200}`. Send exactly `data.payment.price` USDC base units on Base to `data.payment.address`, then poll `GET /v2/invoices/{id}` until it is credited. Our USDC lives on NEAR, so this needs a bridge step (e.g. NEAR Intents → Base). Keep the float well under the $2,000 cap; USD credit can't be refunded.
2. **Check the float.** MCP JSON-RPC `POST https://api.bitrefill.com/mcp`: `{"method":"tools/call","params":{"name":"get-balances","arguments":{"currency":"USD"}}}`.
3. **Price for the catalog (Reference Price).** MCP `get-product-details` `{"product_id":…, "currency":"USD"}` → `packages[].payment_price`. Keep REST `/products/search` for search if we want, but take USD prices from MCP. Mind the product quota.
4. **Buy.** MCP `buy-products` `{"cart_items":[{"product_id":…, "package_value":…}], "payment_method":"balance", "balance_currency":"USD"}`, then poll MCP `get-invoice-by-id` (or REST `GET /v2/invoices/{id}`; I haven't verified that it returns MCP-created invoices).
5. **Testnet demo.** MCP has no test products, so keep the current REST `POST /v2/invoices` path for `test-gift-card-*`.

**Simpler variant, if available.** If the bitrefill.com account settings let us make USD the *primary* currency, REST v2 should price and debit in USD and `Bitrefill.ts` only needs a units change (sats → cents), with no MCP. I couldn't verify that such a setting exists. Check it by hand and confirm `/accounts/balance` then reports `"currency":"USD"`.

**Zero-float alternative.** Pay each invoice in USDC: `POST /v2/invoices` `{"products":[…],"payment_method":"usdc_base","refund_address":"0x…","webhook_url":"…"}`, then send `payment.price` to `payment.address` within 60 minutes. It costs about 1% more per purchase, needs an EVM hot wallet plus a bridge from NEAR, and delivery is "1–5 minutes" for L2s per the docs instead of under a second. That breaks the plan's assumption that the draw follows quickly. Choose this only if holding any float is unacceptable.

## Open questions (need money or the website)

1. What the USD sub-account is actually charged per product (balance price or checkout price). Needs a small USD deposit and one cheap real purchase.
2. Whether the primary currency can be switched to USD on the website, and whether REST then returns USD prices.
3. Real delivery latency after a USDC (Base) invoice payment.
4. Whether REST `GET /v2/invoices/{id}` returns invoices created through MCP `buy-products` (expected, since the IDs are the same format, but not tested).

## Housekeeping: invoices created during this research

All 23 were checked with `GET /v2/invoices?limit=50` and are `not_delivered` / `unpaid`. No funds were sent. Five are deposit invoices (USD via usdc_base, bitcoin ×2 and lightning; BTC via bitcoin). Eleven are test-product invoices. Seven are for real products with crypto methods, left unpaid. **Two of those seven (`203b6e2f`, `94548b59`) used `payment_method:"balance"` with `auto_pay:false` on real products.** That is outside the brief's rule. Both are unpaid, and every balance is 0 so they can't be paid, but don't call `POST /invoices/{id}/pay` on them. The USDC invoices expire after 60 minutes (per MCP); REST doesn't say when the others expire.

## Addendum (2026-11-07): Bitrefill's own agent tooling, and what Luckout borrows

Sources: [bitrefill.com/assistant](https://www.bitrefill.com/assistant/?hl=en), [MCP partner integration guide](https://docs.bitrefill.com/docs/mcp-partner-integration-guide), [github.com/bitrefill/agents](https://github.com/bitrefill/agents) (an agent skill, `skills/bitrefill/`), [github.com/bitrefill/cli](https://github.com/bitrefill/cli).

**USD instead of BTC.** No API or tool changes the primary sub-account. The MCP guide documents only the per-purchase `balance_currency` and the `currency` filter on `get-balances`. Bitrefill's own skill does what we do: *"Without `--balance_currency` the buy debits the primary sub-account, which can be BTC."* So `buy-products` with `balance_currency: "USD"` is the supported path. Changing a website setting won't change what the API uses (we checked after the switch: still BTC). Their top-up path for USD credit is a Bitrefill Gift Card (`bitrefill-giftcard-usd`) or `POST /accounts/deposit`.

**Rules from their guide and skill that we now follow:**
- **Charge `payment_price` from `get-product-details` in the right currency, never the face value.** That is our Reference Price.
- **Retry only `SERVICE_UNAVAILABLE`, and never retry `PAYMENT_UNCERTAIN`.** The server retries reads only. A tool error with any other code means nothing was created, so the purchase can be failed and refunded. `PAYMENT_UNCERTAIN`, network errors and a stuck invoice are left to the reconciler, never treated as failed.
- **MCP allows 30 requests a minute per key.** Prices are cached for a minute per product.
- **Balance payments debit at once.** A balance purchase is final as soon as `buy-products` returns, so the server must record the invoice id before doing anything else.
- **Their test products differ from ours.** MCP test products (`*-syldavia`) must be enabled by Bitrefill, and on MCP a balance payment debits the real balance even for a test product. Our REST `test-gift-card-*` products are free, so the testnet demo stays on REST.

**References for the Agent (Day 4).** Bitrefill runs a Telegram assistant, [@BitrefillAssistantBot](https://t.me/BitrefillAssistantBot), with the same search → quote → confirm → deliver-in-chat loop we're building. Their skill's confirm line is a good template: *"[Product] — [amount]: [total] USDC. Confirm?"* Their `references/safeguards.md` covers spending caps and logging for agents. Luckout's differences are the Lucky modes and the Spending Limits enforced onchain, which their assistant doesn't have; worth saying in the pitch.

**Not useful for us:** x402 (USDC on EVM/Solana per request, no NEAR), OAuth or guest checkout (we buy from our own account with an API key), and their CLI (the server calls MCP directly in a few lines).
