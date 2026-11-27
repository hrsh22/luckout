import { Context, Schema, Struct } from "effect"
import { HttpApi, HttpApiEndpoint, HttpApiGroup, HttpApiMiddleware, HttpApiSchema, HttpApiSecurity, OpenApi } from "effect/http-api"

export * from "./intents.ts"
export * from "./limits.ts"
export * from "./redemption.ts"

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
  tooSmall: Schema.optional(Schema.Array(VoucherPackage)),
  /** Bitrefill's one-line pitch for the card. */
  subtitle: Schema.optional(Schema.String),
  /**
   * Bitrefill's steps to redeem the card, and its terms (validity, refunds, where it works), as lines:
   * "# " a title, "1. " a step, "- " an item (two spaces more per nested list), anything else a paragraph.
   */
  howToRedeem: Schema.optional(Schema.String),
  terms: Schema.optional(Schema.String),
  /** Bitrefill's customer rating: out of 5, from `count` ratings. */
  rating: Schema.optional(Schema.Struct({ value: Schema.Number, count: Schema.Int })),
  /** ISO date: the use-by date on the last of these delivered through Luckout in the last 60 days. Cards come in batches, so the next is usually the same. */
  useBy: Schema.optional(Schema.String)
}) {}

/** One page of the catalog. `next` is the `start` of the following page; absent on the last. */
export class CatalogPage extends Schema.Class<CatalogPage>("CatalogPage")({
  items: Schema.Array(VoucherSummary),
  next: Schema.optional(Schema.Number),
  /** The country the page is for, when there is one: the one asked for, or the visitor's own (`near`). */
  country: Schema.optional(Schema.String)
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

/** The signed-in account (their Privy Solana wallet), provided to authenticated endpoints. */
export class CurrentAccount extends Context.Service<CurrentAccount, { readonly accountId: string; readonly wallet: Wallet }>()(
  "luckout/CurrentAccount"
) {}

export class Unauthorized extends Schema.TaggedError<Unauthorized>()(
  "Unauthorized",
  { message: Schema.String },
  { httpApiStatus: 401 }
) {}

/**
 * The session token travels only in this cookie, set by the server as HttpOnly, so no script on the page can
 * read it. The API is on a subdomain of the Web App's own domain (api.luckout.wtf next to www.luckout.wtf),
 * which makes the cookie first-party. `__Host-`: browsers take it only Secure, for path /, and for the API's own
 * host, so no sibling site (a page on www., staging.) can set one for the API in its place. Chrome takes it over
 * http://localhost too, as it does any Secure cookie.
 */
export const sessionCookie = HttpApiSecurity.apiKey({ key: "__Host-luckout_session", in: "cookie" })

export class Authorization extends HttpApiMiddleware.Service<Authorization, { provides: CurrentAccount; requires: never }>()(
  "luckout/Authorization",
  { security: { cookie: sessionCookie }, error: Unauthorized }
) {}

/** How the customer signed in. A Solana account is named like a NEAR implicit one, so only this tells them apart. */
export const Wallet = Schema.Literals(["near", "evm", "solana"])
export type Wallet = typeof Wallet.Type

/** Who signed in, with which kind of wallet, and until when. The token itself is only ever in the `sessionCookie`. */
export class Session extends Schema.Class<Session>("Session")({
  accountId: Schema.String,
  wallet: Wallet,
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
  /** The checkout it was bought in: the cards confirmed together (ADR-0013). */
  checkoutId: Schema.optional(Schema.String),
  voucherId: Schema.String,
  voucherName: Schema.String,
  /** The card's logo and brand colour, when we know them. */
  image: Schema.optional(Schema.String),
  background: Schema.optional(Schema.String),
  value: Schema.String,
  /** The currency `value` is in (the card's own, e.g. INR); missing on purchases made before it was kept. */
  currency: Schema.optional(Schema.String),
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
  createdAt: Schema.String,
  /** When the customer marked this delivered card used (ISO); absent while unused. Only their own note. */
  usedAt: Schema.optional(Schema.String)
}) {}

/** One page of a customer's purchases, newest first. `next` is the `before` of the following page; absent on the last. */
export class PurchasePage extends Schema.Class<PurchasePage>("PurchasePage")({
  items: Schema.Array(Purchase),
  next: Schema.optional(Schema.String)
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

/** The most cards one Cart holds: Bitrefill's own cart size, and a guest email's cards a day (GUEST_LIMITS.orders). */
export const MAX_CART = 15

/** Several cards confirmed at once. Each is its own purchase, with its own key, Draw and refund. */
export class NewCart extends Schema.Class<NewCart>("NewCart")({
  items: Schema.Array(NewPurchase).check(Schema.isMinLength(1), Schema.isMaxLength(MAX_CART))
}) {}

/** The cards of a Cart to price: each card's voucher, amount and mode. */
export class CartQuoteRequest extends Schema.Class<CartQuoteRequest>("CartQuoteRequest")({
  items: Schema.Array(Schema.Struct({ voucherId: Schema.String, value: Schema.String, mode: Mode })).check(
    Schema.isMinLength(1),
    Schema.isMaxLength(MAX_CART)
  )
}) {}

export class PurchaseInvalid extends Schema.TaggedError<PurchaseInvalid>()(
  "PurchaseInvalid",
  { message: Schema.String },
  { httpApiStatus: 400 }
) {}

export class NotFound extends Schema.TaggedError<NotFound>()("NotFound", {}, { httpApiStatus: 404 }) {}

/**
 * Whether new purchases can start: "stopped" by an admin on the server, "paused" in the contract by the owner,
 * or "limit": Bitrefill's orders for the last 24 hours are used up until `reopensAt` (ms).
 */
export class ShopStatus extends Schema.Class<ShopStatus>("ShopStatus")({
  open: Schema.Boolean,
  reason: Schema.optional(Schema.Literals(["stopped", "paused", "limit"])),
  reopensAt: Schema.optional(Schema.Number)
}) {}

/**
 * The latest check that the Telegram Agent's model runs inside NEAR AI Cloud's attested TEE, and how
 * many of its replies were verified against it since the server started.
 */
export class AgentAttestation extends Schema.Class<AgentAttestation>("AgentAttestation")({
  model: Schema.String,
  ok: Schema.Boolean,
  checkedAt: Schema.Number,
  nonce: Schema.String,
  modelKeys: Schema.Array(Schema.String),
  gatewayKey: Schema.String,
  checks: Schema.Array(Schema.Struct({ name: Schema.String, ok: Schema.Boolean })),
  replies: Schema.Struct({ verified: Schema.Number, refused: Schema.Number })
}) {}

/** The program's public state, for pages anyone can open (ADR-0015). Read on the server and kept about 30 seconds. */
export class ProgramInfo extends Schema.Class<ProgramInfo>("ProgramInfo")({
  cluster: Schema.Literals(["localnet", "devnet", "mainnet"]),
  programId: Schema.String,
  usdcMint: Schema.String,
  /** The Game Versions, by number: each one's premium, and every Final Price on the Lucky Amount with its chance (basis points). */
  versions: Schema.Array(Schema.Struct({
    name: Schema.String,
    premiumBps: Schema.Int,
    outcomes: Schema.Array(Schema.Struct({ finalBps: Schema.Int, chanceBps: Schema.Int }))
  })),
  reserve: Schema.Struct({
    free: MicroUsdc,
    /** Held for Lucky Buys in progress, until their Draws run. */
    locked: MicroUsdc,
    /** The most Cashback one card can pay now: the lower of the Cashback Cap's limits. */
    maxCashback: MicroUsdc,
    /** The owner's Cashback Cap: a fixed amount (null is off) and a share of Free Reserve (basis points). */
    cashbackCap: Schema.Struct({ fixed: Schema.NullOr(MicroUsdc), reserveBps: Schema.Int })
  }),
  /** A Checkout with Lucky cards plays at least this much Lucky Amount. */
  minLuckyCheckout: MicroUsdc,
  /** For the Live Average: settled Lucky Buys, their Lucky Amounts, and what was paid for them. */
  stats: Schema.Struct({ luckySettled: Schema.Int, luckyAmountTotal: MicroUsdc, luckyPaidTotal: MicroUsdc })
}) {}

export class ChainUnavailable extends Schema.TaggedError<ChainUnavailable>()(
  "ChainUnavailable",
  { message: Schema.String },
  { httpApiStatus: 503 }
) {}

export class SystemApi extends HttpApiGroup.make("system", { topLevel: true }).add(
  HttpApiEndpoint.get("health", "/health", { success: HttpApiSchema.NoContent }),
  HttpApiEndpoint.get("status", "/status", { success: ShopStatus }),
  HttpApiEndpoint.get("program", "/program", { success: ProgramInfo, error: ChainUnavailable }),
  /** NotFound while the Agent is off (no bot or NEAR AI key) or before its first check. */
  HttpApiEndpoint.get("attestation", "/attestation", { success: AgentAttestation, error: NotFound })
) {}

export class CatalogApi extends HttpApiGroup.make("catalog").add(
  HttpApiEndpoint.get("search", "/catalog", {
    query: { q: Schema.String },
    success: Schema.Array(VoucherSummary),
    error: BitrefillUnavailable
  }),
  /**
   * The whole catalog, a page at a time, filtered only by what the customer chose: a search, a
   * country (its own cards plus worldwide ones), a category. Nothing chosen lists everything. `near`, with no
   * country, is for the visitor's own when Cloudflare knows it, so the shop's first page needs no second ask.
   */
  HttpApiEndpoint.get("browse", "/browse", {
    query: {
      q: Schema.optional(Schema.String.check(Schema.isMaxLength(100))),
      country: Schema.optional(Schema.String.check(Schema.isPattern(/^[A-Z]{2}$/))),
      near: Schema.optional(Schema.Literal("1")),
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
  /** NotFound for a card Bitrefill doesn't sell; BitrefillUnavailable when its price can't be had right now. */
  HttpApiEndpoint.get("voucher", "/catalog/:id", {
    params: { id: Schema.String },
    success: Voucher,
    error: [BitrefillUnavailable, NotFound]
  }),
  /** The contract's quote for one package; `game` omitted means Normal. */
  HttpApiEndpoint.get("quote", "/quote", {
    query: { voucherId: Schema.String, value: Schema.String, game: Schema.optional(Schema.NumberFromString) },
    success: Quote,
    error: [BitrefillUnavailable, PurchaseInvalid]
  }),
  /**
   * A Cart's terms, card by card, as the contract would admit it now (ADR-0013): each Lucky card priced on the reserve
   * the cards before it left. A Lucky card the reserve can't cover at all comes back Normal.
   */
  HttpApiEndpoint.post("quoteCart", "/quote/cart", {
    payload: CartQuoteRequest,
    success: Schema.Array(Quote),
    error: [BitrefillUnavailable, PurchaseInvalid]
  })
) {}

/** Privy's tokens after a sign-in (ADR-0015): the access token says who, the identity token what they linked. */
export class PrivySignIn extends Schema.Class<PrivySignIn>("PrivySignIn")({
  accessToken: Schema.String.check(Schema.isMaxLength(8192)),
  identityToken: Schema.String.check(Schema.isMaxLength(16384))
}) {}

export class AuthApi extends HttpApiGroup.make("auth").add(
  HttpApiEndpoint.post("privy", "/auth/privy", { payload: PrivySignIn, success: Session, error: Unauthorized })
) {}

/** Ends the session the request came with, or every session of the signed-in account, on every device (a lost phone, a shared computer). */
export class SessionApi extends HttpApiGroup.make("session").add(
  HttpApiEndpoint.post("signOut", "/session/sign-out", { success: HttpApiSchema.NoContent }),
  HttpApiEndpoint.post("signOutEverywhere", "/session/sign-out-everywhere", { success: HttpApiSchema.NoContent })
).middleware(Authorization) {}

/**
 * The email Bitrefill gets with each of the customer's cards (the Checkout Email, ADR-0012). `needed`: buying
 * a card needs one here (guest checkout, not connected); `email` is unset until they give one. `bitrefill`:
 * they've connected their own Bitrefill account, whose limits their cards are then bought under; missing
 * where connecting isn't offered.
 */
export class CheckoutEmail extends Schema.Class<CheckoutEmail>("CheckoutEmail")({
  needed: Schema.Boolean,
  email: Schema.optional(Schema.String),
  bitrefill: Schema.optional(Schema.Boolean),
  /**
   * What this email has used of a guest's limits (GUEST_LIMITS) through Luckout: cards in the last 24 hours, and
   * micro-USDC in the last 24 hours and 30 days. Only with an email that orders need.
   */
  used: Schema.optional(Schema.Struct({ orders: Schema.Int, day: MicroUsdc, month: MicroUsdc }))
}) {}

export class PurchasesApi extends HttpApiGroup.make("purchases").add(
  HttpApiEndpoint.post("create", "/purchases", {
    payload: NewPurchase,
    success: Purchase,
    error: [BitrefillUnavailable, PurchaseInvalid]
  }),
  /** Buys every card in a Cart, or none: the purchases come back in the Cart's order and run on their own. */
  HttpApiEndpoint.post("createCart", "/purchases/cart", {
    payload: NewCart,
    success: Schema.Array(Purchase),
    error: [BitrefillUnavailable, PurchaseInvalid]
  }),
  /** Newest first, a page at a time. `before` is the `next` of the page before: the id of its last purchase. */
  HttpApiEndpoint.get("list", "/purchases", {
    query: { before: Schema.optional(Schema.String.check(Schema.isPattern(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i))) },
    success: PurchasePage
  }),
  HttpApiEndpoint.get("get", "/purchases/:id", { params: { id: Schema.String }, success: Purchase, error: NotFound }),
  /** Cancels a purchase still waiting for credit; nothing was charged. */
  HttpApiEndpoint.post("cancel", "/purchases/:id/cancel", { params: { id: Schema.String }, success: Purchase, error: [NotFound, PurchaseInvalid] }),
  /**
   * Marks the customer's own delivered card used, or unused again. Their own note: it changes nothing about money, the
   * Draw, Cashback or Reclaim. Marking it used again keeps when it was first marked.
   */
  HttpApiEndpoint.put("setUsed", "/purchases/:id/used", {
    params: { id: Schema.String },
    payload: Schema.Struct({ used: Schema.Boolean }),
    success: Purchase,
    error: [NotFound, PurchaseInvalid]
  }),
  HttpApiEndpoint.get("checkoutEmail", "/checkout-email", { success: CheckoutEmail }),
  HttpApiEndpoint.put("setCheckoutEmail", "/checkout-email", {
    payload: Schema.Struct({ email: Schema.String }),
    success: CheckoutEmail,
    error: PurchaseInvalid
  }),
  /** Where the customer logs in to their own Bitrefill account; Bitrefill sends them back through /bitrefill/callback to the Wallet page. */
  HttpApiEndpoint.post("connectBitrefill", "/bitrefill/connect", { success: Schema.Struct({ url: Schema.String }), error: PurchaseInvalid }),
  /** Back from Bitrefill: the Wallet page hands over the code, which is exchanged only for the account that started connecting. */
  HttpApiEndpoint.post("finishBitrefill", "/bitrefill/finish", {
    payload: Schema.Struct({ code: Schema.String, state: Schema.String }),
    success: CheckoutEmail,
    error: PurchaseInvalid
  }),
  /** Revokes and forgets their Bitrefill login: their cards go back to guest checkout with the Checkout Email. */
  HttpApiEndpoint.post("disconnectBitrefill", "/bitrefill/disconnect", { success: CheckoutEmail })
).middleware(Authorization) {}

/**
 * The customer's Telegram link (ADR-0015): made by signing in with Telegram in Privy, which the server reads at sign-in.
 * Unlinking here stops the bot buying for them at once; unlinking in Privy too keeps the next sign-in from linking it again.
 */
export class TelegramApi extends HttpApiGroup.make("telegram").add(
  HttpApiEndpoint.get("status", "/telegram", {
    success: Schema.Struct({ linked: Schema.Boolean, telegramName: Schema.optional(Schema.String), botUrl: Schema.optional(Schema.String) })
  }),
  HttpApiEndpoint.post("unlink", "/telegram/unlink", { success: HttpApiSchema.NoContent })
).middleware(Authorization) {}

// ---------- top-ups (ADR-0015): 1Click from other chains, swaps from the customer's own wallet ----------

export class TopUpAsset extends Schema.Class<TopUpAsset>("TopUpAsset")({
  assetId: Schema.String,
  symbol: Schema.String,
  chain: Schema.String,
  /** The token's contract on an EVM chain (its mint on Solana), so the wallet can send it; absent for the chain's own coin. */
  contract: Schema.optional(Schema.String),
  decimals: Schema.optional(Schema.Number),
  /** 1Click's price in USD (Jupiter's for a swapped token), for showing what a wallet's holding is worth. */
  price: Schema.optional(Schema.Number),
  /**
   * Swapped from the customer's own wallet (their Deposit Address) by a transaction they sign (TopUpApi.swap): sent
   * there as it is, never to a 1Click address.
   */
  swap: Schema.optional(Schema.Boolean)
}) {}

export class TopUpQuote extends Schema.Class<TopUpQuote>("TopUpQuote")({
  /** Send `amountIn` of `symbol` on `chain` here (empty for a price check). */
  depositAddress: Schema.String,
  depositMemo: Schema.optional(Schema.String),
  amountIn: Schema.String,
  amountInFormatted: Schema.String,
  /** The least that is swapped (base units): anything above it is, the extra included; less goes back to `refundTo`. */
  minAmountIn: Schema.optional(Schema.String),
  symbol: Schema.String,
  chain: Schema.String,
  /** USDC (micro) that `amountIn` delivers to the customer's Deposit Address, which moves it into their Balance. */
  usdcOut: MicroUsdc,
  timeEstimateSeconds: Schema.Number,
  deadline: Schema.String,
  /** Where 1Click sends back what it can't swap, on `chain`. */
  refundTo: Schema.String
}) {}

/** A swap of a token in the customer's wallet into their Balance, for them to sign and send to /transactions/submit. */
export class SwapTx extends Schema.Class<SwapTx>("SwapTx")({
  transaction: Schema.String,
  token: Schema.String,
  /** Exactly what it swaps (base units of the token). */
  spend: Schema.String,
  /** USDC (micro) the route gives, and the least it may, or nothing happens. */
  usdcOut: MicroUsdc,
  minUsdcOut: MicroUsdc
}) {}

export class TopUpStatus extends Schema.Class<TopUpStatus>("TopUpStatus")({ status: Schema.String }) {}

/**
 * Where a Top-Up is, in the customer's words: their money is never out of sight. awaiting-transfer: we're waiting for
 * them to send. incomplete: 1Click got less than the quote's minimum and waits for the rest until the deadline, then
 * sends it back. swapping: 1Click has it and is converting it. done: delivered to their Deposit Address, from where it
 * moves into their Balance. refunded: 1Click sent it back to the refund address.
 */
export const TransferPhase = Schema.Literals(["awaiting-transfer", "incomplete", "swapping", "done", "refunded"])
export type TransferPhase = typeof TransferPhase.Type

/** One of the customer's 1Click Top-Ups. */
export class Transfer extends Schema.Class<Transfer>("Transfer")({
  depositAddress: Schema.String,
  depositMemo: Schema.optional(Schema.String),
  /** USDC (micro) it delivers. */
  usdc: MicroUsdc,
  /** The token and chain it comes from. */
  symbol: Schema.String,
  chain: Schema.String,
  /** What the customer sends, formatted. */
  amountIn: Schema.optional(Schema.String),
  /** What 1Click has received so far, formatted (a Top-Up short of its minimum). */
  deposited: Schema.optional(Schema.String),
  /** The customer's own transfer to the deposit address, when the app sent it. */
  depositTx: Schema.optional(Schema.String),
  phase: TransferPhase,
  /** Taking longer than usual: safe, but say so. */
  late: Schema.Boolean,
  createdAt: Schema.String,
  /** Until when 1Click takes the deposit (a Top-Up awaiting the customer's transfer). */
  deadline: Schema.optional(Schema.String),
  timeEstimateSeconds: Schema.optional(Schema.Number),
  /** The delivery to the Deposit Address, on Solana. */
  deliveredTx: Schema.optional(Schema.String),
  /** What 1Click sent back, formatted, where, and why. */
  refunded: Schema.optional(Schema.String),
  refundTo: Schema.optional(Schema.String),
  detail: Schema.optional(Schema.String),
  /** NEAR Intents explorer page for this swap. */
  explorer: Schema.String
}) {}

export class TopUpUnavailable extends Schema.TaggedError<TopUpUnavailable>()(
  "TopUpUnavailable",
  { message: Schema.String },
  { httpApiStatus: 400 }
) {}

export class TopUpApi extends HttpApiGroup.make("topup").add(
  HttpApiEndpoint.get("assets", "/topup/assets", { success: Schema.Array(TopUpAsset), error: TopUpUnavailable }),
  /** `dry`: a price check only, with no deposit address and nothing recorded. `refundTo`: an address on the token's chain. */
  HttpApiEndpoint.post("quote", "/topup/quote", {
    payload: Schema.Struct({
      originAsset: Schema.String,
      usdc: MicroUsdc,
      refundTo: Schema.String.check(Schema.isMaxLength(128)),
      dry: Schema.optional(Schema.Boolean)
    }),
    success: TopUpQuote,
    error: TopUpUnavailable
  }),
  HttpApiEndpoint.get("status", "/topup/status", {
    query: { depositAddress: Schema.String },
    success: TopUpStatus,
    error: TopUpUnavailable
  }),
  /** USDT or ORE in the customer's wallet into their Balance: `amount` in the token's base units, all of it by default. */
  HttpApiEndpoint.post("swap", "/topup/swap", {
    payload: Schema.Struct({ assetId: Schema.String, amount: Schema.optional(Schema.String.check(Schema.isPattern(/^[1-9]\d{0,29}$/))) }),
    success: SwapTx,
    error: TopUpUnavailable
  }),
  /** The app paid this Top-Up from the customer's wallet: its transaction, kept and passed on to 1Click. */
  HttpApiEndpoint.post("sent", "/topup/sent", {
    payload: Schema.Struct({ depositAddress: Schema.String, txHash: Schema.String }),
    success: HttpApiSchema.NoContent,
    error: TopUpUnavailable
  }),
  /** A Top-Up the customer hasn't paid into leaves their list. Money sent anyway still arrives, and it's listed again. */
  HttpApiEndpoint.post("dismiss", "/topup/dismiss", {
    payload: Schema.Struct({ depositAddress: Schema.String }),
    success: HttpApiSchema.NoContent,
    error: TopUpUnavailable
  }),
  /** The customer's Top-Ups still on their way, and those that ended in the last day. */
  HttpApiEndpoint.get("transfers", "/topup/transfers", { success: Schema.Array(Transfer), error: TopUpUnavailable })
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

/**
 * What an admin changes in the relayer's settings: only the fields sent. The server keeps the rest as they are
 * now, so a panel opened before another admin's change can't undo it.
 */
export const RelayChange = Schema.Struct(RelaySettings.fields).mapFields(Struct.map(Schema.optionalKey))
export type RelayChange = typeof RelayChange.Type

const Yocto = Schema.String

const Usd = MicroUsdc.check(Schema.isBetween({ minimum: 0, maximum: 2_000_000_000 }))

/** How much Bitrefill credit to keep (ADR-0009). All amounts micro-USDC. */
export class CreditSettings extends Schema.Class<CreditSettings>("CreditSettings")({
  /** Refill by itself; off, the panel and alerts only say when to. */
  autoRefill: Schema.Boolean,
  /** Refills top up to at least this, whatever sales did ("Top up to at least"). */
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
  baseFloat: Schema.optional(Usd),
  /**
   * A refill starts once credit falls under this, so a big card's worth stays ready without every small
   * sale starting a refill. Kept at least the smallest refill under the target. Missing or 0: half the target,
   * or the biggest recent card if that's more.
   */
  refillBelow: Schema.optional(Usd),
  /**
   * The smallest refill: one for less costs relatively more in swap fees. At least $2, the smallest swap.
   * Missing (saved before it existed): $10.
   */
  minRefill: Schema.optional(Usd)
}) {}

/** What an admin changes in the credit settings: only the fields sent, as with RelayChange. */
export const CreditChange = Schema.Struct(CreditSettings.fields).mapFields(Struct.map(Schema.optionalKey))
export type CreditChange = typeof CreditChange.Type

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

/** Rows the admin's Purchases and Users pages get at most, newest first. */
export const ADMIN_LIST_LIMIT = 300

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
  cluster: Schema.Literals(["localnet", "devnet", "mainnet"]),
  program: Schema.Struct({
    id: Schema.String,
    owner: Schema.String,
    /** Proposed by the owner; becomes the owner when it accepts. */
    pendingOwner: Schema.optional(Schema.String),
    operator: Schema.String,
    usdcMint: Schema.String,
    vault: Schema.String,
    /** The Pay Wallet's USDC account, which `settle` repays. */
    payWallet: Schema.String,
    paused: Schema.Boolean
  }),
  /** An admin stopped new purchases on the server (any admin can, unlike the program's pause). */
  salesStopped: Schema.Boolean,
  reserve: Schema.Struct({
    free: MicroUsdc,
    locked: MicroUsdc,
    proceeds: MicroUsdc,
    /** The most Cashback one card can pay now: the lower of the Cashback Cap's limits. */
    maxCashback: MicroUsdc,
    /** The owner's Cashback Cap: a fixed amount (null is off) and a share of Free Reserve (basis points). */
    cashbackCap: Schema.Struct({ fixed: Schema.NullOr(MicroUsdc), reserveBps: Schema.Int }),
    /** A Checkout with Lucky cards plays at least this much Lucky Amount (ADR-0015). */
    minLuckyCheckout: MicroUsdc,
    /** USDC the Vault holds in all. */
    held: MicroUsdc,
    /** Customers' money in the Vault: what it holds minus the reserve and Proceeds. Negative means it holds less than it owes. */
    customers: Schema.Int
  }),
  /** `settle` repays the Pay Wallet up to this much a day; past it, prices wait as Proceeds. */
  repay: Schema.Struct({ dailyCap: MicroUsdc, repaidToday: MicroUsdc }),
  stats: Schema.Struct({ luckySettled: Schema.Int, luckyAmountTotal: MicroUsdc, luckyPaidTotal: MicroUsdc }),
  /** Our keys' balances and where the Monitor alerts: the fee payer's SOL (lamports), the Pay Wallet's USDC. */
  keys: Schema.Array(Schema.Struct({
    role: Schema.Literals(["feePayer", "payWallet"]),
    address: Schema.String,
    balance: Schema.String,
    alertBelow: Schema.String
  })),
  purchases: Schema.Struct({
    today: Schema.Int,
    deliveredToday: Schema.Int,
    /** The oldest purchases that need a look (closest to the customer's Reclaim), at most 20 of them... */
    attention: Schema.Array(AttentionPurchase),
    /** ...and how many need one in all. */
    attentionTotal: Schema.Int
  }),
  /** How cards are bought (ADR-0012): as a guest with the customer's Checkout Email, or on their own Bitrefill account. */
  checkout: Schema.Struct({
    guest: Schema.Boolean,
    /** Customers who have given a Checkout Email. */
    emails: Schema.Int,
    /** Customers whose cards are bought on their own Bitrefill account (Connect Bitrefill). */
    connected: Schema.Int,
    /** Bitrefill's limits for one Checkout Email: cards a day, and USD a day and a month. */
    limits: Schema.Struct({ orders: Schema.Int, daily: MicroUsdc, monthly: MicroUsdc }),
    /** The busiest Checkout Email: its cards and spend in the last 24 hours, and its spend in 30 days. */
    busiest: Schema.Struct({ orders: Schema.Int, daily: MicroUsdc, monthly: MicroUsdc })
  }),
  /** What every guest card has used of our paying address's own limits at Bitrefill (ADR-0015). */
  paying: Schema.Struct({ daily: MicroUsdc, monthly: MicroUsdc, limits: Schema.Struct({ daily: MicroUsdc, monthly: MicroUsdc }) })
}) {}

/** One purchase as the admin's Purchases page lists it: everything but the Redemption Data. */
export class AdminPurchase extends Schema.Class<AdminPurchase>("AdminPurchase")({
  id: Schema.String,
  /** The checkout it was bought in. A Cart's cards share one invoice and one Base payment: `payAmount` is the checkout's. */
  checkoutId: Schema.String,
  accountId: Schema.String,
  voucherName: Schema.String,
  value: Schema.String,
  /** The currency `value` is in, as on Purchase; missing on purchases made before it was kept. */
  currency: Schema.optional(Schema.String),
  step: Schema.String,
  mode: Schema.optional(Mode),
  referencePrice: MicroUsdc,
  maxPrice: Schema.optional(MicroUsdc),
  /** What the customer finally paid and got back: set once a Lucky Buy draws, or a Normal one is delivered. */
  paid: Schema.optional(MicroUsdc),
  cashback: Schema.optional(MicroUsdc),
  error: Schema.optional(Schema.String),
  attempts: Schema.Int,
  invoiceId: Schema.optional(Schema.String),
  /** A guest order's payment from the Pay Wallet (ADR-0015): its transaction, and the USDC it sends. */
  payTx: Schema.optional(Schema.String),
  payAmount: Schema.optional(MicroUsdc),
  admitTx: Schema.optional(Schema.String),
  settleTx: Schema.optional(Schema.String),
  createdAt: Schema.String,
  updatedAt: Schema.String
}) {}

/** One customer as the admin's Users page lists it. `balance` is missing when the chain didn't answer. */
export class AdminUser extends Schema.Class<AdminUser>("AdminUser")({
  accountId: Schema.String,
  firstSeen: Schema.String,
  balance: Schema.optional(MicroUsdc),
  perPurchaseLimit: Schema.optional(Schema.String),
  dailyLimit: Schema.optional(Schema.String),
  telegram: Schema.optional(Schema.String),
  purchases: Schema.Int,
  delivered: Schema.Int,
  /** Paid for delivered cards, and Cashback they got back. */
  spent: MicroUsdc,
  cashback: MicroUsdc,
  lastPurchaseAt: Schema.optional(Schema.String),
  /** They've given a Checkout Email (ADR-0012); the email itself stays sealed. */
  checkoutEmail: Schema.Boolean,
  /** Their cards are bought on their own Bitrefill account. */
  bitrefillConnected: Schema.Boolean
}) {}

// Left out of /openapi.json: to anyone but an admin, these endpoints don't exist.
export class AdminApi extends HttpApiGroup.make("admin").add(
  /** 204 for an admin, NotFound for everyone else: decides whether the menu shows the Admin link. */
  HttpApiEndpoint.get("me", "/admin/me", { success: HttpApiSchema.NoContent, error: NotFound }),
  HttpApiEndpoint.get("overview", "/admin", { success: AdminOverview, error: NotFound }),
  /** The latest 300 purchases (ADMIN_LIST_LIMIT), or one account's latest 300; with `id`, only that purchase, however old. */
  HttpApiEndpoint.get("purchases", "/admin/purchases", {
    query: { account: Schema.optional(Schema.String), id: Schema.optional(Schema.String) },
    success: Schema.Array(AdminPurchase),
    error: NotFound
  }),
  HttpApiEndpoint.get("users", "/admin/users", { success: Schema.Array(AdminUser), error: NotFound }),
  /** Stops or restarts new purchases on the server, at once, without the owner's wallet. */
  HttpApiEndpoint.post("sales", "/admin/sales", { payload: Schema.Struct({ open: Schema.Boolean }), success: ShopStatus, error: NotFound }),
  HttpApiEndpoint.post("retry", "/admin/purchases/:id/retry", {
    params: { id: Schema.String },
    success: HttpApiSchema.NoContent,
    error: [NotFound, PurchaseInvalid]
  })
).middleware(Authorization).annotate(OpenApi.Exclude, true) {}

// ---------- deposits and customer-signed transactions (ADR-0015) ----------

/** A transaction the customer signs and we pay for: unsigned, with the token that binds its bytes. */
export class PreparedTransaction extends Schema.Class<PreparedTransaction>("PreparedTransaction")({
  transaction: Schema.String.check(Schema.isMaxLength(4096)),
  token: Schema.String.check(Schema.isMaxLength(128))
}) {}

/** A swap-paid token (USDT, ORE) sitting at the Deposit Address: one tap swaps it into the Balance (TopUpApi.swap). */
export class HeldToken extends Schema.Class<HeldToken>("HeldToken")({
  /** As in TopUpAsset and TopUpApi.swap. */
  assetId: Schema.String,
  symbol: Schema.String,
  /** Base units. */
  amount: Schema.String,
  decimals: Schema.Number
}) {}

/**
 * The customer's Deposit Address (their Privy wallet), whether its one-time approval stands, USDC waiting there, and
 * any swap-paid token there (none when swaps are off).
 */
export class DepositAddress extends Schema.Class<DepositAddress>("DepositAddress")({
  address: Schema.String,
  approved: Schema.Boolean,
  waiting: Schema.Number,
  held: Schema.Array(HeldToken)
}) {}

export class Submitted extends Schema.Class<Submitted>("Submitted")({ signature: Schema.String }) {}

/**
 * The customer's Customer account in the program, amounts in micro-USDC as strings ("No limit" is u64's maximum).
 * `day` is days since 1970 (UTC): `spent_today` counts only on that day.
 */
export const CustomerAccount = Schema.Struct({
  balance: Schema.String,
  per_purchase_limit: Schema.String,
  daily_limit: Schema.String,
  day: Schema.Number,
  spent_today: Schema.String,
  default_mode: Mode,
  premiums_paid: Schema.String,
  cashback_received: Schema.String
})
export type CustomerAccount = typeof CustomerAccount.Type

export class DepositsApi extends HttpApiGroup.make("deposits").add(
  /** null until the one-time approval opens it. */
  HttpApiEndpoint.get("account", "/account", { success: Schema.NullOr(CustomerAccount), error: ChainUnavailable }),
  HttpApiEndpoint.get("address", "/deposits/address", { success: DepositAddress, error: PurchaseInvalid }),
  HttpApiEndpoint.post("approval", "/deposits/approval", { payload: Schema.Struct({ mode: Mode }), success: PreparedTransaction, error: PurchaseInvalid }),
  HttpApiEndpoint.post("submit", "/transactions/submit", { payload: PreparedTransaction, success: Submitted, error: PurchaseInvalid }),
  HttpApiEndpoint.post("withdrawal", "/transactions/withdrawal", {
    payload: Schema.Struct({ amount: Schema.Int.check(Schema.isGreaterThan(0)), to: Schema.String.check(Schema.isMaxLength(64)) }),
    success: PreparedTransaction,
    error: PurchaseInvalid
  }),
  HttpApiEndpoint.post("limits", "/transactions/limits", {
    payload: Schema.Struct({ perPurchase: Schema.String.check(Schema.isPattern(/^\d{1,20}$/)), daily: Schema.String.check(Schema.isPattern(/^\d{1,20}$/)) }),
    success: PreparedTransaction,
    error: PurchaseInvalid
  }),
  HttpApiEndpoint.post("defaultMode", "/transactions/default-mode", { payload: Schema.Struct({ mode: Mode }), success: PreparedTransaction, error: PurchaseInvalid }),
  HttpApiEndpoint.post("reclaim", "/transactions/reclaim", { payload: Schema.Struct({ purchaseId: Schema.String.check(Schema.isMaxLength(64)) }), success: PreparedTransaction, error: PurchaseInvalid })
).middleware(Authorization) {}

export class Api extends HttpApi.make("luckout").add(SystemApi).add(CatalogApi).add(AuthApi).add(SessionApi).add(PurchasesApi).add(TelegramApi).add(TopUpApi).add(AdminApi).add(DepositsApi) {}
