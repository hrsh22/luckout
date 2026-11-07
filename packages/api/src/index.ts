import { Schema } from "effect"
import { HttpApi, HttpApiEndpoint, HttpApiGroup, HttpApiSchema } from "effect/http-api"

/** Whole micro-USDC (6 decimals), never floats (ADR-0004). */
export const MicroUsdc = Schema.Int

export class VoucherPackage extends Schema.Class<VoucherPackage>("VoucherPackage")({
  /** Bitrefill package value, e.g. "500" or "Dinner for One". */
  value: Schema.String,
  /** Current Bitrefill price, the basis of the Reference Price. */
  priceMicroUsdc: MicroUsdc
}) {}

export class Voucher extends Schema.Class<Voucher>("Voucher")({
  id: Schema.String,
  name: Schema.String,
  countryCode: Schema.String,
  currency: Schema.String,
  image: Schema.String,
  packages: Schema.Array(VoucherPackage)
}) {}

export class BitrefillUnavailable extends Schema.TaggedError<BitrefillUnavailable>()(
  "BitrefillUnavailable",
  { message: Schema.String },
  { httpApiStatus: 502 }
) {}

export class SystemApi extends HttpApiGroup.make("system", { topLevel: true }).add(
  HttpApiEndpoint.get("health", "/health", { success: HttpApiSchema.NoContent })
) {}

export class CatalogApi extends HttpApiGroup.make("catalog").add(
  HttpApiEndpoint.get("search", "/catalog", {
    query: { q: Schema.String },
    success: Schema.Array(Voucher),
    error: BitrefillUnavailable
  })
) {}

export class Api extends HttpApi.make("luckout").add(SystemApi).add(CatalogApi) {}
