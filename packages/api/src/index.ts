import { Context, Schema } from "effect"
import { HttpApi, HttpApiEndpoint, HttpApiGroup, HttpApiMiddleware, HttpApiSchema, HttpApiSecurity, OpenApi } from "effect/http-api"

export * from "./intents.ts"

/** Whole micro-USDC (6 decimals), never floats (ADR-0004). */
export const MicroUsdc = Schema.Int

export class VoucherSummary extends Schema.Class<VoucherSummary>("VoucherSummary")({
  id: Schema.String,
  name: Schema.String,
  /** ISO 3166-1 alpha-2, or "XI" for a card that works worldwide. A card only works in its own country. */
  countryCode: Schema.String,
  countryName: Schema.optional(Schema.String),
  currency: Schema.String,
  /** Bitrefill image path and its brand colour, for the product logo. */
  image: Schema.optional(Schema.String),
  background: Schema.optional(Schema.String)
}) {}

export class VoucherPackage extends Schema.Class<VoucherPackage>("VoucherPackage")({
  /** Bitrefill package value, e.g. "500" or "Dinner for One". */
  value: Schema.String,
  /** Current Bitrefill USD price: the Reference Price. */
  priceMicroUsdc: MicroUsdc
}) {}

export class Voucher extends Schema.Class<Voucher>("Voucher")({
  ...VoucherSummary.fields,
  packages: Schema.Array(VoucherPackage),
  /** Amounts Bitrefill sells that Luckout can't: under the 0.5 USDC minimum purchase. */
  tooSmall: Schema.optional(Schema.Array(VoucherPackage))
}) {}

/** One page of the catalog. `next` is the `start` of the following page; absent on the last. */
export class CatalogPage extends Schema.Class<CatalogPage>("CatalogPage")({
  items: Schema.Array(VoucherSummary),
  next: Schema.optional(Schema.Number)
}) {}

/** Popular cards, most wanted first. `country` is the one they were picked for: the one asked for, or the visitor's own. */
export class PopularCards extends Schema.Class<PopularCards>("PopularCards")({
  country: Schema.optional(Schema.String),
  items: Schema.Array(VoucherSummary)
}) {}

/** The shop's categories, each a set of Bitrefill's own. */
export const CATEGORIES = ["shopping", "food", "games", "entertainment", "travel"] as const
export type Category = typeof CATEGORIES[number]

export class BitrefillUnavailable extends Schema.TaggedError<BitrefillUnavailable>()(
  "BitrefillUnavailable",
  { message: Schema.String },
  { httpApiStatus: 503 }
) {}

/** Normal is a Standard Purchase; `{ lucky: n }` is a Lucky Buy on Game Version n. */
export const Mode = Schema.Union([Schema.Literal("normal"), Schema.Struct({ lucky: Schema.Int })])
export type Mode = typeof Mode.Type

// ---------- auth ----------

/** The signed-in NEAR account, provided to authenticated endpoints. */
export class CurrentAccount extends Context.Service<CurrentAccount, { readonly accountId: string }>()(
  "luckout/CurrentAccount"
) {}

export class Unauthorized extends Schema.TaggedError<Unauthorized>()(
  "Unauthorized",
  { message: Schema.String },
  { httpApiStatus: 401 }
) {}

export class Authorization extends HttpApiMiddleware.Service<Authorization, { provides: CurrentAccount; requires: never }>()(
  "luckout/Authorization",
  { security: { bearer: HttpApiSecurity.bearer }, error: Unauthorized }
) {}

/** NEP-413 sign-in: the wallet signs `message` for `recipient` with this single-use `nonce`. */
export class Challenge extends Schema.Class<Challenge>("Challenge")({
  message: Schema.String,
  recipient: Schema.String,
  /** base64, 32 bytes */
  nonce: Schema.String
}) {}

export class SignedChallenge extends Schema.Class<SignedChallenge>("SignedChallenge")({
  accountId: Schema.String,
  publicKey: Schema.String,
  /** base64 */
  signature: Schema.String,
  nonce: Schema.String
}) {}

/** EVM sign-in (ADR-0011): the wallet signs this text with `personal_sign`; it can't move money. */
export const evmSignInMessage = (challenge: { message: string; nonce: string }) =>
  `${challenge.message}\n\nThis only signs you in. It can't move money.\n\nNonce: ${challenge.nonce}`

export class SignedEvmChallenge extends Schema.Class<SignedEvmChallenge>("SignedEvmChallenge")({
  /** 0x address, any case */
  address: Schema.String,
  /** 0x hex of the 65-byte personal_sign signature */
  signature: Schema.String,
  nonce: Schema.String
}) {}

/** One NEAR Intents payload an EVM wallet signed with personal_sign (ERC-191), as `intents.near` takes it. */
export const SignedIntent = Schema.Struct({
  standard: Schema.Literal("erc191"),
  /** The signed JSON text: signer_id, verifying_contract, deadline, nonce, intents. */
  payload: Schema.String.check(Schema.isMaxLength(4096)),
  /** secp256k1:<base58 of r, s and a recovery bit> */
  signature: Schema.String.check(Schema.isMaxLength(200))
})
export type SignedIntent = typeof SignedIntent.Type

export class Session extends Schema.Class<Session>("Session")({
  accountId: Schema.String,
  token: Schema.String,
  expiresAt: Schema.Number
}) {}

// ---------- purchases ----------

export class Quote extends Schema.Class<Quote>("Quote")({
  mode: Mode,
  referencePrice: MicroUsdc,
  /** The part of the price the Game Version applies to (0 for Normal). */
  luckyAmount: MicroUsdc,
  maxPrice: MicroUsdc
}) {}

/** One Draw, enough to recompute it in the browser (ADR-0005). */
export class Draw extends Schema.Class<Draw>("Draw")({
  gameVersion: Schema.Int,
  seed: Schema.String,
  random: Schema.String,
  roll: Schema.Int,
  finalBps: Schema.Int,
  finalPrice: MicroUsdc,
  cashback: MicroUsdc
}) {}

/** "waiting": we're topping up our Bitrefill credit for this card; the customer isn't charged until it's ordered. */
export const PurchaseStatus = Schema.Literals(["pending", "waiting", "delivered", "failed", "rejected"])

export class Purchase extends Schema.Class<Purchase>("Purchase")({
  id: Schema.String,
  voucherId: Schema.String,
  voucherName: Schema.String,
  value: Schema.String,
  status: PurchaseStatus,
  /** Why it was rejected or failed, in plain words. */
  error: Schema.optional(Schema.String),
  mode: Schema.optional(Mode),
  referencePrice: MicroUsdc,
  maxPrice: Schema.optional(MicroUsdc),
  luckyAmount: Schema.optional(MicroUsdc),
  draw: Schema.optional(Draw),
  /** Redemption Data, only ever sent to its owner. */
  redemption: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
  admitTx: Schema.optional(Schema.String),
  settleTx: Schema.optional(Schema.String),
  /** The purchase's id in the contract, once admitted: what reclaim and retry_draw take. */
  contractPurchaseId: Schema.optional(Schema.Int),
  createdAt: Schema.String
}) {}

export class NewPurchase extends Schema.Class<NewPurchase>("NewPurchase")({
  voucherId: Schema.String,
  value: Schema.String,
  /** Omit to use the customer's Default Mode. */
  mode: Schema.optional(Mode),
  /** The most the customer agreed to pay (the quote they saw). The contract refuses to debit more. */
  maxPrice: MicroUsdc,
  /** A Lucky Buy's Lucky Amount in the quote they saw: the purchase plays exactly that, or is refused. */
  luckyAmount: Schema.optional(MicroUsdc),
  /** Client-generated; retrying with the same key never buys twice. */
  idempotencyKey: Schema.String.check(Schema.isMinLength(8), Schema.isMaxLength(64))
}) {}

export class PurchaseInvalid extends Schema.TaggedError<PurchaseInvalid>()(
  "PurchaseInvalid",
  { message: Schema.String },
  { httpApiStatus: 400 }
) {}

export class NotFound extends Schema.TaggedError<NotFound>()("NotFound", {}, { httpApiStatus: 404 }) {}

/** Whether new purchases can start: "stopped" by an admin on the server, or "paused" in the contract by the owner. */
export class ShopStatus extends Schema.Class<ShopStatus>("ShopStatus")({
  open: Schema.Boolean,
  reason: Schema.optional(Schema.Literals(["stopped", "paused"]))
}) {}

export class SystemApi extends HttpApiGroup.make("system", { topLevel: true }).add(
  HttpApiEndpoint.get("health", "/health", { success: HttpApiSchema.NoContent }),
  HttpApiEndpoint.get("status", "/status", { success: ShopStatus })
) {}

export class CatalogApi extends HttpApiGroup.make("catalog").add(
  HttpApiEndpoint.get("search", "/catalog", {
    query: { q: Schema.String },
    success: Schema.Array(VoucherSummary),
    error: BitrefillUnavailable
  }),
  /**
   * The whole catalog, a page at a time, filtered only by what the customer chose: a search, a
   * country (its own cards plus worldwide ones), a category. Nothing chosen lists everything.
   */
  HttpApiEndpoint.get("browse", "/browse", {
    query: {
      q: Schema.optional(Schema.String.check(Schema.isMaxLength(100))),
      country: Schema.optional(Schema.String.check(Schema.isPattern(/^[A-Z]{2}$/))),
      category: Schema.optional(Schema.Literals(CATEGORIES)),
      start: Schema.optional(Schema.NumberFromString)
    },
    success: CatalogPage,
    error: BitrefillUnavailable
  }),
  /** Popular cards for a country; with none given, for the visitor's own country when Cloudflare knows it. */
  HttpApiEndpoint.get("popular", "/popular", {
    query: {
      country: Schema.optional(Schema.String.check(Schema.isPattern(/^[A-Z]{2}$/))),
      category: Schema.optional(Schema.Literals(CATEGORIES))
    },
    success: PopularCards
  }),
  HttpApiEndpoint.get("voucher", "/catalog/:id", {
    params: { id: Schema.String },
    success: Voucher,
    error: BitrefillUnavailable
  }),
  /** The contract's quote for one package; `game` omitted means Normal. */
  HttpApiEndpoint.get("quote", "/quote", {
    query: { voucherId: Schema.String, value: Schema.String, game: Schema.optional(Schema.NumberFromString) },
    success: Quote,
    error: [BitrefillUnavailable, PurchaseInvalid]
  })
) {}

export class AuthApi extends HttpApiGroup.make("auth").add(
  HttpApiEndpoint.post("challenge", "/auth/challenge", { success: Challenge }),
  HttpApiEndpoint.post("verify", "/auth/verify", { payload: SignedChallenge, success: Session, error: Unauthorized }),
  HttpApiEndpoint.post("verifyEvm", "/auth/verify-evm", { payload: SignedEvmChallenge, success: Session, error: Unauthorized })
) {}

/** Ends every session of the signed-in account, on every device (a lost phone, a shared computer). */
export class SessionApi extends HttpApiGroup.make("session").add(
  HttpApiEndpoint.post("signOutEverywhere", "/session/sign-out-everywhere", { success: HttpApiSchema.NoContent })
).middleware(Authorization) {}

export class PurchasesApi extends HttpApiGroup.make("purchases").add(
  HttpApiEndpoint.post("create", "/purchases", {
    payload: NewPurchase,
    success: Purchase,
    error: [BitrefillUnavailable, PurchaseInvalid]
  }),
  HttpApiEndpoint.get("list", "/purchases", { success: Schema.Array(Purchase) }),
  HttpApiEndpoint.get("get", "/purchases/:id", { params: { id: Schema.String }, success: Purchase, error: NotFound }),
  /** Cancels a purchase still waiting for credit; nothing was charged. */
  HttpApiEndpoint.post("cancel", "/purchases/:id/cancel", { params: { id: Schema.String }, success: Purchase, error: [NotFound, PurchaseInvalid] })
).middleware(Authorization) {}

export class LinkInvalid extends Schema.TaggedError<LinkInvalid>()(
  "LinkInvalid",
  { message: Schema.String },
  { httpApiStatus: 400 }
) {}

/**
 * Telegram linking (ADR-0001, ADR-0007): the signed-in web session issues a one-time code and
 * opens the bot with it, so only the wallet owner decides which Telegram account gets access.
 */
export class TelegramApi extends HttpApiGroup.make("telegram").add(
  HttpApiEndpoint.get("status", "/telegram", {
    success: Schema.Struct({ linked: Schema.Boolean, telegramName: Schema.optional(Schema.String), botUrl: Schema.optional(Schema.String) })
  }),
  HttpApiEndpoint.post("linkCode", "/telegram/link-code", {
    success: Schema.Struct({ url: Schema.String, expiresAt: Schema.Number }),
    error: LinkInvalid
  }),
  HttpApiEndpoint.post("unlink", "/telegram/unlink", { success: HttpApiSchema.NoContent })
).middleware(Authorization) {}

// ---------- top-ups (NEAR Intents 1Click, mainnet) ----------

export class TopUpAsset extends Schema.Class<TopUpAsset>("TopUpAsset")({
  assetId: Schema.String,
  symbol: Schema.String,
  chain: Schema.String
}) {}

export class TopUpQuote extends Schema.Class<TopUpQuote>("TopUpQuote")({
  /** Send exactly `amountIn` of `symbol` on `chain` here. */
  depositAddress: Schema.String,
  depositMemo: Schema.optional(Schema.String),
  amountIn: Schema.String,
  amountInFormatted: Schema.String,
  symbol: Schema.String,
  chain: Schema.String,
  /** USDC (micro) that lands in the customer's NEAR account, or their NEAR Intents account for an EVM wallet. */
  usdcOut: MicroUsdc,
  timeEstimateSeconds: Schema.Number,
  deadline: Schema.String
}) {}

/** Where an EVM customer's money leaves for (ADR-0011): send `usdcIn` from their NEAR Intents account to `depositAddress`. */
export class ExitQuote extends Schema.Class<ExitQuote>("ExitQuote")({
  depositAddress: Schema.String,
  usdcIn: MicroUsdc,
  amountOutFormatted: Schema.String,
  symbol: Schema.String,
  chain: Schema.String,
  timeEstimateSeconds: Schema.Number
}) {}

/** 1Click's status, and for an EVM Top-Up, whether its USDC has moved on into Luckout. */
export class TopUpStatus extends Schema.Class<TopUpStatus>("TopUpStatus")({
  status: Schema.String,
  move: Schema.optional(Schema.Literals(["waiting", "moved", "failed"]))
}) {}

export class TopUpUnavailable extends Schema.TaggedError<TopUpUnavailable>()(
  "TopUpUnavailable",
  { message: Schema.String },
  { httpApiStatus: 400 }
) {}

export class TopUpApi extends HttpApiGroup.make("topup").add(
  HttpApiEndpoint.get("assets", "/topup/assets", { success: Schema.Array(TopUpAsset), error: TopUpUnavailable }),
  HttpApiEndpoint.post("quote", "/topup/quote", {
    payload: Schema.Struct({ originAsset: Schema.String, usdc: MicroUsdc }),
    success: TopUpQuote,
    error: TopUpUnavailable
  }),
  HttpApiEndpoint.get("status", "/topup/status", {
    query: { depositAddress: Schema.String },
    success: TopUpStatus,
    error: TopUpUnavailable
  }),
  /** EVM wallets: the signed intent that moves this Top-Up into Luckout once it lands; the server sends it then. */
  HttpApiEndpoint.post("move", "/topup/move", {
    payload: Schema.Struct({ depositAddress: Schema.String, signed: SignedIntent }),
    success: HttpApiSchema.NoContent,
    error: TopUpUnavailable
  }),
  /** EVM wallets: a quote to send USDC from their NEAR Intents account to `destinationAsset` on its own chain. */
  HttpApiEndpoint.post("exit", "/topup/exit", {
    payload: Schema.Struct({ destinationAsset: Schema.String, usdc: MicroUsdc }),
    success: ExitQuote,
    error: TopUpUnavailable
  })
).middleware(Authorization) {}

// ---------- relayer (NEP-366, ADR-0008) ----------

/** We won't pay for this one, or it ran and failed: nothing to retry with the wallet as is. */
export class RelayFailed extends Schema.TaggedError<RelayFailed>()(
  "RelayFailed",
  { message: Schema.String },
  { httpApiStatus: 400 }
) {}

/** Not paying fees right now (switched off, or today's free relays are used): send it from the wallet instead. */
export class RelayUnavailable extends Schema.TaggedError<RelayUnavailable>()(
  "RelayUnavailable",
  { message: Schema.String },
  { httpApiStatus: 503 }
) {}

export class RelayApi extends HttpApiGroup.make("relay").add(
  HttpApiEndpoint.get("status", "/relay", { success: Schema.Struct({ available: Schema.Boolean }) }),
  HttpApiEndpoint.post("send", "/relay", {
    /** base64 of a borsh SignedDelegate, as the wallet's signDelegateActions returns it. */
    payload: Schema.Struct({ signedDelegate: Schema.String.check(Schema.isMaxLength(8192)) }),
    success: Schema.Struct({ hash: Schema.String }),
    error: [RelayFailed, RelayUnavailable]
  }),
  /** EVM wallets (ADR-0011): one signed NEAR Intents payload, sent by our relayer to `intents.near`. */
  HttpApiEndpoint.post("intent", "/relay/intent", {
    payload: Schema.Struct({ signed: SignedIntent }),
    success: Schema.Struct({ hash: Schema.String }),
    error: [RelayFailed, RelayUnavailable]
  })
).middleware(Authorization) {}

// ---------- admin (whitelisted accounts only; everyone else gets NotFound) ----------

/** The relayer's switch and free-relay caps, changed from the admin panel. */
export class RelaySettings extends Schema.Class<RelaySettings>("RelaySettings")({
  enabled: Schema.Boolean,
  /** Free relays per account per rolling day. */
  perAccountDaily: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 1000 })),
  /** Free relays for everyone together per rolling day. */
  allDaily: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 100_000 }))
}) {}

const Yocto = Schema.String

const Usd = MicroUsdc.check(Schema.isBetween({ minimum: 0, maximum: 2_000_000_000 }))

/** How much Bitrefill credit to keep (ADR-0009). All amounts micro-USDC. */
export class CreditSettings extends Schema.Class<CreditSettings>("CreditSettings")({
  /** Refill by itself; off, the panel and alerts only say when to. */
  autoRefill: Schema.Boolean,
  /** Keep at least this much, whatever sales did. */
  floor: Usd,
  /**
   * Idle credit never goes above this: the most that can sit unused at Bitrefill. A refill for
   * purchases already waiting may go past it, since that credit is spent within minutes.
   */
  ceiling: Usd,
  /** The most the server refills in a rolling day. */
  dailyRefill: Usd,
  /** How long a purchase may wait for credit before it's cancelled, uncharged (up to a day). */
  waitMinutes: Schema.Int.check(Schema.isBetween({ minimum: 5, maximum: 1440 })),
  /**
   * USDC kept ready in our Base wallet, so a refill pays Bitrefill in about a minute instead of waiting
   * on a swap; topped back up in the background. 0 turns it off. Missing (saved before it existed): the
   * network's default.
   */
  baseFloat: Schema.optional(Usd)
}) {}

/** One top-up of our Bitrefill credit, paid from the treasury through NEAR Intents. */
export class RefillView extends Schema.Class<RefillView>("RefillView")({
  id: Schema.String,
  amount: MicroUsdc,
  /** target, waiting (a purchase needed it), manual, or float (tops up the Base wallet; no Bitrefill credit). */
  reason: Schema.String,
  /** fund, quote, send, swapping, invoice, pay, crediting, done, refunded, failed, stuck, resolved, or cancelled (a float top-up that gave way). */
  step: Schema.String,
  error: Schema.optional(Schema.String),
  /** The treasury's NEAR transfer into the swap. */
  sendTx: Schema.optional(Schema.String),
  /** The swap's NEAR Intents deposit address (its explorer page). */
  swap: Schema.optional(Schema.String),
  /** The Base wallet's payment to Bitrefill. */
  payTx: Schema.optional(Schema.String),
  invoiceId: Schema.optional(Schema.String),
  createdAt: Schema.String,
  updatedAt: Schema.String
}) {}

export class AdminInvalid extends Schema.TaggedError<AdminInvalid>()(
  "AdminInvalid",
  { message: Schema.String },
  { httpApiStatus: 400 }
) {}

/** A purchase that needs a look: stuck for a human, or open longer than it should be. */
export class AttentionPurchase extends Schema.Class<AttentionPurchase>("AttentionPurchase")({
  id: Schema.String,
  accountId: Schema.String,
  voucherName: Schema.String,
  value: Schema.String,
  step: Schema.String,
  error: Schema.optional(Schema.String),
  attempts: Schema.Int,
  createdAt: Schema.String,
  /** "Retry now" is safe for it: an open purchase, or one that gave up at a step NEAR can repeat. */
  retryable: Schema.Boolean
}) {}

export class AdminOverview extends Schema.Class<AdminOverview>("AdminOverview")({
  network: Schema.Literals(["testnet", "mainnet"]),
  contract: Schema.Struct({
    id: Schema.String,
    owner: Schema.String,
    /** Proposed by the owner; becomes the owner when it accepts. */
    pendingOwner: Schema.optional(Schema.String),
    operator: Schema.String,
    usdc: Schema.String,
    paused: Schema.Boolean
  }),
  /** An admin stopped new purchases on the server (any admin can, unlike the contract's pause). */
  salesStopped: Schema.Boolean,
  reserve: Schema.Struct({
    free: MicroUsdc,
    locked: MicroUsdc,
    discountCap: MicroUsdc,
    proceeds: MicroUsdc,
    maxCashback: MicroUsdc,
    /** USDC the contract holds in all. */
    held: MicroUsdc,
    /** Customers' money in the contract: what it holds minus the reserve and proceeds. Negative means it holds less than it owes. */
    customers: Schema.Int
  }),
  stats: Schema.Struct({ luckySettled: Schema.Int, luckyAmountTotal: MicroUsdc, luckyPaidTotal: MicroUsdc }),
  /** NEAR each of our accounts can spend (yoctoNEAR, after storage), and where the Monitor alerts. */
  gas: Schema.Array(Schema.Struct({
    role: Schema.Literals(["operator", "relayer", "treasury", "contract"]),
    accountId: Schema.String,
    spendable: Yocto,
    alertBelow: Yocto
  })),
  relay: Schema.Struct({
    configured: Schema.Boolean,
    settings: RelaySettings,
    usedToday: Schema.Int,
    topAccounts: Schema.Array(Schema.Struct({ accountId: Schema.String, count: Schema.Int }))
  }),
  purchases: Schema.Struct({
    today: Schema.Int,
    deliveredToday: Schema.Int,
    /** Bitrefill orders placed in the last 24 hours, against the account's daily cap. */
    bitrefillOrders: Schema.Int,
    bitrefillCap: Schema.Int,
    attention: Schema.Array(AttentionPurchase)
  }),
  credit: Schema.Struct({
    settings: CreditSettings,
    /** Last balance Bitrefill reported, and when; missing if it hasn't answered yet. */
    balance: Schema.optional(MicroUsdc),
    readAt: Schema.optional(Schema.String),
    /** How much more Bitrefill lets the account hold. */
    room: MicroUsdc,
    free: MicroUsdc,
    held: MicroUsdc,
    waitingCount: Schema.Int,
    waitingTotal: MicroUsdc,
    avgDaily: MicroUsdc,
    target: MicroUsdc,
    refillBelow: MicroUsdc,
    refilledToday: MicroUsdc,
    /** Why automatic refills are paused, if they are. */
    paused: Schema.optional(Schema.String),
    /** Refills need NEAR Intents, which only runs on mainnet. */
    refillsAvailable: Schema.Boolean
  }),
  treasury: Schema.Struct({
    /** The account the server signs refills with. */
    accountId: Schema.optional(Schema.String),
    /** The account the contract lets pull proceeds; it should match. */
    contractTreasury: Schema.optional(Schema.String),
    dailyCap: MicroUsdc,
    sweptToday: MicroUsdc,
    usdc: MicroUsdc,
    /** In manual mode: what an open refill is waiting for you to move in. */
    needs: Schema.optional(MicroUsdc),
    /** Our Base wallet, which refills swap into and pay Bitrefill from; missing when Base doesn't answer. */
    wallet: Schema.optional(Schema.Struct({
      address: Schema.String,
      usdc: MicroUsdc,
      /** ETH for gas, in wei, and where the Monitor alerts. */
      eth: Schema.String,
      alertBelow: Schema.String
    }))
  }),
  refills: Schema.Array(RefillView)
}) {}

// Left out of /openapi.json: to anyone but an admin, these endpoints don't exist.
export class AdminApi extends HttpApiGroup.make("admin").add(
  /** 204 for an admin, NotFound for everyone else: decides whether the menu shows the Admin link. */
  HttpApiEndpoint.get("me", "/admin/me", { success: HttpApiSchema.NoContent, error: NotFound }),
  HttpApiEndpoint.get("overview", "/admin", { success: AdminOverview, error: NotFound }),
  HttpApiEndpoint.post("relay", "/admin/relay", { payload: RelaySettings, success: RelaySettings, error: NotFound }),
  /** Stops or restarts new purchases on the server, at once, without the owner's wallet. */
  HttpApiEndpoint.post("sales", "/admin/sales", { payload: Schema.Struct({ open: Schema.Boolean }), success: ShopStatus, error: NotFound }),
  HttpApiEndpoint.post("credit", "/admin/credit", { payload: CreditSettings, success: CreditSettings, error: [NotFound, AdminInvalid] }),
  /** Refill now, outside the schedule; `amount` defaults to what the target and waiting purchases need. */
  HttpApiEndpoint.post("refill", "/admin/refills", {
    payload: Schema.Struct({ amount: Schema.optional(Usd) }),
    success: RefillView,
    error: [NotFound, AdminInvalid]
  }),
  /** After checking a stuck refill by hand: closes it, which lets automatic refills run again. */
  HttpApiEndpoint.post("resolveRefill", "/admin/refills/:id/resolve", {
    params: { id: Schema.String },
    payload: Schema.Struct({ note: Schema.String.check(Schema.isMinLength(3), Schema.isMaxLength(500)) }),
    success: HttpApiSchema.NoContent,
    error: [NotFound, AdminInvalid]
  }),
  HttpApiEndpoint.post("retry", "/admin/purchases/:id/retry", {
    params: { id: Schema.String },
    success: HttpApiSchema.NoContent,
    error: [NotFound, PurchaseInvalid]
  })
).middleware(Authorization).annotate(OpenApi.Exclude, true) {}

export class Api extends HttpApi.make("luckout").add(SystemApi).add(CatalogApi).add(AuthApi).add(SessionApi).add(PurchasesApi).add(TelegramApi).add(TopUpApi).add(RelayApi).add(AdminApi) {}
