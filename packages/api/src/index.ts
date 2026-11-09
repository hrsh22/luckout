import { Context, Schema } from "effect"
import { HttpApi, HttpApiEndpoint, HttpApiGroup, HttpApiMiddleware, HttpApiSchema, HttpApiSecurity } from "effect/http-api"

/** Whole micro-USDC (6 decimals), never floats (ADR-0004). */
export const MicroUsdc = Schema.Int

export class VoucherSummary extends Schema.Class<VoucherSummary>("VoucherSummary")({
  id: Schema.String,
  name: Schema.String,
  countryCode: Schema.String,
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
  /** Amounts Bitrefill sells that Luckout can't: under the 1 USDC minimum purchase. */
  tooSmall: Schema.optional(Schema.Array(VoucherPackage))
}) {}

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

export const PurchaseStatus = Schema.Literals(["pending", "delivered", "failed", "rejected"])

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
  createdAt: Schema.String
}) {}

export class NewPurchase extends Schema.Class<NewPurchase>("NewPurchase")({
  voucherId: Schema.String,
  value: Schema.String,
  /** Omit to use the customer's Default Mode. */
  mode: Schema.optional(Mode),
  /** The most the customer agreed to pay (the quote they saw). The contract refuses to debit more. */
  maxPrice: MicroUsdc,
  /** Client-generated; retrying with the same key never buys twice. */
  idempotencyKey: Schema.String.check(Schema.isMinLength(8), Schema.isMaxLength(64))
}) {}

export class PurchaseInvalid extends Schema.TaggedError<PurchaseInvalid>()(
  "PurchaseInvalid",
  { message: Schema.String },
  { httpApiStatus: 400 }
) {}

export class NotFound extends Schema.TaggedError<NotFound>()("NotFound", {}, { httpApiStatus: 404 }) {}

export class SystemApi extends HttpApiGroup.make("system", { topLevel: true }).add(
  HttpApiEndpoint.get("health", "/health", { success: HttpApiSchema.NoContent })
) {}

export class CatalogApi extends HttpApiGroup.make("catalog").add(
  HttpApiEndpoint.get("search", "/catalog", {
    query: { q: Schema.String },
    success: Schema.Array(VoucherSummary),
    error: BitrefillUnavailable
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
  HttpApiEndpoint.post("verify", "/auth/verify", { payload: SignedChallenge, success: Session, error: Unauthorized })
) {}

export class PurchasesApi extends HttpApiGroup.make("purchases").add(
  HttpApiEndpoint.post("create", "/purchases", {
    payload: NewPurchase,
    success: Purchase,
    error: [BitrefillUnavailable, PurchaseInvalid]
  }),
  HttpApiEndpoint.get("list", "/purchases", { success: Schema.Array(Purchase) }),
  HttpApiEndpoint.get("get", "/purchases/:id", { params: { id: Schema.String }, success: Purchase, error: NotFound })
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
  /** USDC (micro) that lands in the customer's NEAR account. */
  usdcOut: MicroUsdc,
  timeEstimateSeconds: Schema.Number,
  deadline: Schema.String
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
    success: Schema.Struct({ status: Schema.String }),
    error: TopUpUnavailable
  })
).middleware(Authorization) {}

export class Api extends HttpApi.make("luckout").add(SystemApi).add(CatalogApi).add(AuthApi).add(PurchasesApi).add(TelegramApi).add(TopUpApi) {}
