import { BitrefillUnavailable, CatalogPage, type Category, Voucher, VoucherSummary } from "@luckout/api"
import { decode as decodeToon } from "@toon-format/toon"
import { Cache, Clock, Config, Context, Data, Effect, Exit, flow, Layer, Option, Redacted, Schedule, Schema } from "effect"
import { FetchHttpClient, HttpClient, HttpClientError, HttpClientRequest, HttpClientResponse } from "effect/http"
import { Network } from "./Near.ts"
import { readSetting, writeSetting } from "./Settings.ts"

// On mainnet, cards are bought as a guest through Bitrefill's MCP endpoint with the customer's Checkout
// Email, or on their own Bitrefill account once they've connected it (Connect.ts), and each invoice is paid
// in USDC on Base from our Base Wallet (ADR-0012). The API key only reads:
// the catalog, logos and prices. Testnet buys Bitrefill's free test cards on REST with its own account,
// since a guest can't buy those. Without a guest client (BITREFILL_CLIENT_ID), real cards are bought from the
// account's USD store credit (ADR-0009), but a mainnet server no longer starts without one (main.ts).

const Product = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  country_code: Schema.String,
  country_name: Schema.optional(Schema.String),
  currency: Schema.String,
  /** The brand without its country: "Steam", "Amazon.de", "PlayStation Store". */
  base_name: Schema.optional(Schema.String),
  categories: Schema.optional(Schema.Array(Schema.String)),
  /** "none" for a code; "phone_number" or "account" for top-ups that need one, which we can't send. */
  recipient_type: Schema.optional(Schema.String),
  in_stock: Schema.optional(Schema.Boolean),
  image: Schema.optional(Schema.String),
  logo_background: Schema.optional(Schema.String),
  packages: Schema.optional(Schema.Array(Schema.Struct({ value: Schema.String, amount: Schema.optional(Schema.Number) })))
})
const Balances = Schema.Struct({
  balances: Schema.Array(Schema.Struct({ payment_method: Schema.String, balance_currency: Schema.String, amount: Schema.String })),
  /** How much more each sub-account may take before Bitrefill holds a deposit for review. */
  top_up: Schema.optional(Schema.Array(Schema.Struct({
    currency: Schema.String,
    max_amount: Schema.optional(Schema.Struct({ amount: Schema.String, currency: Schema.String }))
  })))
})
const Deposit = Schema.Struct({
  id: Schema.String,
  status: Schema.String,
  payment: Schema.Struct({
    method: Schema.String,
    address: Schema.String,
    currency: Schema.String,
    /** Base units of `currency`. */
    price: Schema.Number,
    commission: Schema.optional(Schema.Number)
  })
})
const InvoiceState = Schema.Struct({ id: Schema.String, status: Schema.String })

const McpProduct = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  country_code: Schema.String,
  currency: Schema.String,
  packages: Schema.Array(Schema.Struct({
    package_value: Schema.String,
    payment_price: Schema.String,
    payment_currency: Schema.Literal("USD")
  })),
  // What Bitrefill's own page for the card shows; steps and terms are HTML.
  subtitles: Schema.optional(Schema.String),
  instructions: Schema.optional(Schema.String),
  termsConditions: Schema.optional(Schema.String),
  ratings: Schema.optional(Schema.Struct({ rating_value: Schema.Number, rating_count: Schema.Number }))
})

const ENTITIES: Record<string, string> = {
  nbsp: " ", lt: "<", gt: ">", quot: "\"", apos: "'", amp: "&", ldquo: "“", rdquo: "”", lsquo: "‘", rsquo: "’",
  ndash: "–", mdash: "—", hellip: "…", bull: "•", middot: "·", trade: "™", reg: "®", copy: "©", euro: "€", pound: "£", times: "×"
}
const entity = (m: string, e: string) =>
  e.startsWith("#")
    ? String.fromCodePoint(...[Number(e[1] === "x" || e[1] === "X" ? `0x${e.slice(2)}` : e.slice(1))].filter((n) => Number.isInteger(n) && n > 0 && n <= 0x10ffff)) || m
    : ENTITIES[e.toLowerCase()] ?? m
const host = (url: string) => URL.parse(url)?.hostname.replace(/^www\./, "")

/**
 * Bitrefill's HTML (a card's steps and terms) as lines a page can lay out: "# " a title, "1. " a step,
 * "- " an item (two spaces more for each list it sits in), anything else a paragraph. Links keep their
 * words and name their site, never a clickable address; every other tag is dropped.
 */
export const readableText = (html: string) => {
  const lines: Array<string> = []
  const lists: Array<{ ordered: boolean; n: number }> = []
  let text = ""
  let bold = 0
  /** Whether the line so far has any words outside <strong>: an all-bold line is a title. */
  let plain = false
  let link: { href: string; at: number } | undefined
  const end = () => {
    const t = text.replace(/\s+/g, " ").trim()
    const allBold = !plain
    text = ""
    plain = false
    if (!t) return
    const list = lists.at(-1)
    if (list) return void lines.push(`${"  ".repeat(lists.length - 1)}${list.ordered ? `${++list.n}.` : "-"} ${t}`)
    // "Validity:" on its own, or a short all-bold line, titles what follows.
    if (t.length <= 60 && (allBold || /^[^.!?]+:$/.test(t))) return void lines.push(`# ${t.replace(/:$/, "")}`)
    lines.push(t.replace(/^(\d+)[.)]\s+/, "$1. "))
  }
  for (const [, close, tag, attrs, words] of html.matchAll(/<(\/?)([a-zA-Z][\w-]*)([^>]*)>|([^<]+)/g)) {
    if (words !== undefined) {
      const t = words.replace(/&(#?\w+);/g, entity)
      if (t.trim() && bold === 0) plain = true
      text += t
      continue
    }
    const name = tag!.toLowerCase()
    if (name === "ol" || name === "ul") {
      end()
      if (close) lists.pop()
      else lists.push({ ordered: name === "ol", n: 0 })
    } else if (["br", "p", "div", "li", "tr"].includes(name) || /^h\d$/.test(name)) end()
    else if (name === "strong" || name === "b") bold = Math.max(0, bold + (close ? -1 : 1))
    else if (name === "a" && !close) {
      const href = attrs?.match(/href="([^"]*)"/)?.[1]
      link = href ? { href, at: text.length } : undefined
    } else if (name === "a" && link) {
      const words = text.slice(link.at).trim()
      const site = host(link.href)
      // "flipkart.com" or a bare address reads as the site; "here" keeps its word and says where.
      if (site && (!words || /^(https?:\/\/|www\.)|^[\w-]+(\.[\w-]+)+\/?$/i.test(words))) text = text.slice(0, link.at) + site
      else if (site && !words.toLowerCase().includes(site)) text += ` (${site})`
      link = undefined
    }
  }
  end()
  // Addresses typed out as text read as their site too.
  return lines.map((l) => l.replace(/https?:\/\/[^\s)]+/g, (u) => host(u) ?? u)).join("\n")
}

/** What Bitrefill says about a card besides its prices, for the card's page. */
const about = (p: typeof McpProduct.Type) => {
  const text = (html: string | undefined) => (html && readableText(html)) || undefined
  return {
    subtitle: text(p.subtitles),
    howToRedeem: text(p.instructions),
    terms: text(p.termsConditions),
    ...(p.ratings && p.ratings.rating_count > 0 ? { rating: { value: p.ratings.rating_value, count: Math.round(p.ratings.rating_count) } } : {})
  }
}
const McpPurchase = Schema.Struct({ response: Schema.Struct({ invoice_id: Schema.String }) })
/** A guest invoice to pay in USDC on Base: exactly `altBasePrice` base units of `contractAddress`, to `address`. */
const GuestPurchase = Schema.Struct({
  response: Schema.Struct({
    invoice_id: Schema.String,
    invoice_access_token: Schema.String,
    payment_info: Schema.Struct({ address: Schema.String, altBasePrice: Schema.Number, contractAddress: Schema.String })
  })
})
/** What an order says it is: Bitrefill lists a cart's orders in cart order, each with its product and amount. */
const OrderProduct = Schema.optional(Schema.Struct({ id: Schema.String, value: Schema.optional(Schema.Unknown) }))
/** An order's Redemption Data: missing or null until it's delivered. One order's null must not fail its whole cart's read. */
const RedemptionInfo = Schema.optional(Schema.NullOr(Schema.Record(Schema.String, Schema.Unknown)))
/** A guest invoice as get-invoice-by-id reads it back. */
const GuestInvoice = Schema.Struct({
  invoice_status: Schema.String,
  orders: Schema.Array(Schema.Struct({
    order_id: Schema.String,
    status: Schema.String,
    product: OrderProduct,
    redemption_info: RedemptionInfo
  }))
})
const Token = Schema.Struct({ access_token: Schema.String, expires_in: Schema.Number })
/** Native USDC on Base: the only coin a guest invoice is paid in. */
const BASE_USDC = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913"
export const MCP_RESOURCE = "https://api.bitrefill.com/mcp"
/** A guest invoice that ended without delivering; anything else unfinished is still on its way. */
const GUEST_FAILED = /expired|refunded|blocked|error|failed|cancel/i
const Invoice = Schema.Struct({
  id: Schema.String,
  status: Schema.String,
  orders: Schema.Array(Schema.Struct({
    id: Schema.String,
    redemption_info: RedemptionInfo
  }))
})
const data = <A, I>(s: Schema.Codec<A, I>) => Schema.Struct({ data: s })

/** Redemption Data exactly as Bitrefill sends it (code, link, pin, instructions…). */
export type Redemption = Readonly<Record<string, unknown>>

/** One card of an order: its product and amount. */
export interface Card {
  readonly id: string
  readonly value: string
}

/** Where one card of an invoice is. */
export type CardDelivery =
  | { readonly _tag: "Delivered"; readonly orderId: string; readonly redemption: Redemption }
  /** Bitrefill definitely did not deliver it, so it can be failed and refunded. */
  | { readonly _tag: "Failed"; readonly reason: string }
  /** Not yet: still on its way, or not found in the invoice (a human looks once the retries run out). */
  | { readonly _tag: "Pending" }

/**
 * Each card's order in an invoice. A card delivered in an earlier round (`orderId`, saved by Purchases) takes the order
 * it holds, wherever Bitrefill lists it now, and no other. The rest take the first order left with the card's product
 * and amount; an order that names no product (Bitrefill's REST invoices) is taken by its place in the cart, which is
 * the order Bitrefill keeps.
 */
export const matchOrders = <
  O extends { readonly product?: { readonly id: string; readonly value?: unknown } | undefined; readonly order_id?: string; readonly id?: string }
>(
  cards: ReadonlyArray<Card & { readonly orderId?: string | undefined }>,
  orders: ReadonlyArray<O>
): Array<O | undefined> => {
  const taken = new Set<number>()
  const held = cards.map((card) => {
    const k = card.orderId === undefined ? -1 : orders.findIndex((o) => (o.order_id ?? o.id) === card.orderId)
    if (k >= 0) taken.add(k)
    return k
  })
  return cards.map((card, i) => {
    if (card.orderId !== undefined) return held[i]! >= 0 ? orders[held[i]!] : undefined
    let k = orders.findIndex((o, j) => !taken.has(j) && o.product?.id === card.id && (o.product.value === undefined || String(o.product.value) === card.value))
    if (k < 0 && !taken.has(i) && orders[i] && !orders[i].product) k = i
    if (k < 0) return undefined
    taken.add(k)
    return orders[k]
  })
}

export type Order =
  | { readonly _tag: "Ordered"; readonly invoiceId: string }
  /** A guest invoice, unpaid: pay exactly `amount` (USDC base units) to `payTo` on Base; read it back with `accessToken`. */
  | { readonly _tag: "Invoiced"; readonly invoiceId: string; readonly accessToken: string; readonly payTo: string; readonly amount: number }
  /** Our USD credit can't cover it; nothing was created or paid, so it can be ordered again later. */
  | { readonly _tag: "NoCredit"; readonly reason: string }
  /** Bitrefill refused before creating or paying anything. */
  | { readonly _tag: "Refused"; readonly reason: string }

/** Who an order is placed for: a guest with their Checkout Email, or the customer's own Bitrefill login (Connect.ts). */
export type Buyer = { readonly email: string } | { readonly token: string }

/** A USD credit deposit: sending exactly `price` (USDC base units) to `address` on Base buys `amount` of credit. */
export interface CreditDeposit {
  readonly invoiceId: string
  readonly address: string
  readonly price: number
}
/** Where a credit deposit is. "failed" means Bitrefill gave up on it after we may have paid: a human must look. */
export type DepositState = "pending" | "credited" | "failed"

const EVM_ADDRESS = /^0x[0-9a-fA-F]{40}$/
/** Bitrefill's words for a balance that can't cover an order. */
const NO_CREDIT = /balance|insufficient|not enough|top ?up/i
/** Bitrefill's words for an order past its limit (`purchase_limit_reached`): nothing was created or paid. */
export const ORDER_LIMIT = /purchase[_ ]?limit/i

const DAY_MS = 24 * 60 * 60 * 1000
/** Bitrefill takes this many invoices from our account (orders and credit top-ups) in any 24 hours. */
export const ORDERS_PER_DAY = 15
/**
 * How many orders the last 24 hours used, counting `inFlight` ones about to be placed, and when they're
 * all used, when the next fits: each invoice frees its slot 24 hours after it was created.
 */
export const orderRoom = (invoices: ReadonlyArray<number>, inFlight: number, now: number) => {
  const recent = invoices.filter((t) => t > now - DAY_MS).sort((a, b) => a - b)
  const over = recent.length + inFlight - ORDERS_PER_DAY
  return { used: recent.length + inFlight, reopensAt: over < 0 ? undefined : (recent[over] ?? now) + DAY_MS }
}
export type OrderRoom = ReturnType<typeof orderRoom>

/** Bitrefill refused before creating or paying anything (e.g. balance too low). */
class Rejected extends Data.TaggedError("Rejected")<{ readonly reason: string }> {}
// Only codes that mean "rejected before anything was paid" count as a refusal. Anything else,
// including codes we haven't seen, is an unknown outcome left to the reconciler: guessing
// "not paid" would refund the customer for a voucher we may already have paid for.
const REFUSED_BEFORE_PAYMENT = new Set(["INVALID_INPUT", "PRODUCT_NOT_FOUND", "NOT_FOUND", "OUT_OF_STOCK"])
// HTTP statuses that mean the MCP endpoint turned the request away without running the tool.
const REFUSED_STATUS = new Set([400, 401, 403, 404, 429])
const httpStatus = (e: unknown) => (HttpClientError.isHttpClientError(e) ? e.response?.status ?? 0 : 0)
/** A refusal with its status and the start of Bitrefill's reply, which says why (e.g. purchase_limit_reached). */
const refusal = (e: unknown) =>
  (HttpClientError.isHttpClientError(e) && e.response ? e.response.text : Effect.succeed("")).pipe(
    Effect.orElseSucceed(() => ""),
    Effect.flatMap((body) => Effect.fail(new Rejected({ reason: `HTTP ${httpStatus(e)} ${body.slice(0, 300)}`.trim() })))
  )

// MCP allows 30 calls a minute per key. A mainnet server needs a guest client to start (main.ts), so there the key
// makes only these price lookups: orders and delivery polls use the guest login or the customer's own Bitrefill
// login, each with its own limit. The catalog is read over REST, which we don't count here: the documented 30 is
// MCP's (docs/research/bitrefill-funding.md). Lookups take at most 27 a minute, leaving 3 spare.
// A purchase's price check may use 24, browsing (catalog pages, quotes) at most 16, so browsing can never starve a
// purchase. Of browsing's 16, refreshing a price we could already show stops while 6 are left, kept for cards never
// priced yet. A page for a card no listing knows (see `isListed`) looks it up from 3 more of its own: the first 3 such
// ids in a minute get Bitrefill's answer (a 404 if it doesn't have them), and any more that minute answer busy, unasked
// (or 404 if Bitrefill already said so, see `missing`). So a card newer than our catalog copy still loads, and made-up
// ids can't use up anyone else's lookups.
const LOOKUPS_PER_MINUTE = 24
const BROWSE_LOOKUPS_PER_MINUTE = 16
const FIRST_VIEW_LOOKUPS = 6
const UNLISTED_LOOKUPS_PER_MINUTE = 3
/**
 * How old a price may be. A quote (what the customer confirms) and Buy take one at most a minute old. A card's page
 * may show one up to 10 minutes old. When the minute's lookups are used up or Bitrefill doesn't answer, pages and
 * quotes show the last one we had, up to an hour old, instead of failing. That's safe because no purchase is priced
 * from those: Buy takes a price at most a minute old, or looks one up live on the whole budget, and the most the
 * contract debits is the Maximum Price the customer confirmed (`max_debit`, ADR-0007).
 */
const FRESH_PRICE_MS = 60_000
const PAGE_PRICE_MS = 10 * 60_000
const LAST_PRICE_MS = 60 * 60_000
/** What `voucher` fails with for a card Bitrefill doesn't sell: the card's page answers 404 for it. */
export const NO_SUCH_VOUCHER = "No such voucher"
/** Bitrefill's answer for a card it doesn't have: "Product 'x' was not found.", or a tool error coded so. */
const NO_SUCH_PRODUCT = /was not found|NOT_FOUND/
/** The least time between two delivery polls on the guest login, across all purchases: 20 a minute. */
export const GUEST_POLL_GAP_MS = 3_000
/** When the next guest delivery poll may go out, given when the last one was allowed to. */
export const nextGuestPoll = (lastAt: number, now: number) => Math.max(now, lastAt + GUEST_POLL_GAP_MS)
/** What a customer chose to filter the catalog by; nothing chosen lists everything. */
export interface BrowseOptions {
  readonly q?: string | undefined
  readonly country?: string | undefined
  readonly category?: Category | undefined
  readonly start?: number | undefined
}

/**
 * Bitrefill's categories behind each of the shop's. Bitrefill refuses a whole request naming one it
 * doesn't know (music, pizza, voucher and other aren't), so only names checked against its API go here.
 */
const CATEGORY_MAP: Record<Category, ReadonlyArray<string>> = {
  shopping: ["online-marketplaces", "department-stores", "ecommerce", "retail", "apparel", "electronics", "home", "health-beauty", "cosmetics", "sports-n-outdoors", "gifts", "multi-brand"],
  food: ["food", "restaurants", "groceries", "food-delivery"],
  games: ["games", "game-stores"],
  entertainment: ["entertainment", "streaming", "experiences"],
  travel: ["travel", "accommodation", "flights", "online-travel-agencies", "cruises", "transportation"]
}
/** EU members: Bitrefill's Europe-wide cards ("EU") work in each of them too. */
const EU_MEMBERS = new Set("AT BE BG HR CY CZ DK EE FI FR DE GR HU IE IT LV LT LU MT NL PL PT RO SK SI ES SE".split(" "))
/** Whose cards work in a country: its own, Europe-wide ones in an EU member, and worldwide ones ("XI"). */
export const regionsFor = (country: string) => [country, ...(EU_MEMBERS.has(country) ? ["EU"] : []), "XI"]

/** "All" is every gift card: these plus the rest, but not phone credit (pin, refill, data), which would fill the first pages. */
const ALL_GIFT_CARDS = [...Object.values(CATEGORY_MAP).flat(), "pets", "pharmacy", "payment-cards"]
/** Bitrefill's page size, and the fewest cards a catalog page tries to return after filtering. */
const PAGE = 50
const MIN_PAGE_ITEMS = 12

/**
 * The brands customers look for first, most wanted first. Bitrefill has no popularity data, so this list
 * is ours. Each pattern matches Bitrefill's brand name (`base_name`), leaving out look-alikes (Applebee's,
 * Steamrex), subscriptions, Uber's vouchers in another country's currency, and Riot's Latin America cards,
 * which Bitrefill marks worldwide. A country gets whichever of these Bitrefill sells there.
 */
const POPULAR_BRANDS: ReadonlyArray<RegExp> = [
  // Known everywhere.
  /^amazon(\.[a-z.]+)?$/i,
  /^steam( usd)?$/i,
  /^(apple( itunes| sa)?|app store & itunes( uae)?)$/i,
  /^google play\b/i,
  /^(sony )?playstation( store)?$/i,
  /^xbox( live)?$/i,
  /^netflix\b/i,
  /^uber( eats| money [a-z]{3})?$/i,
  /^airbnb\b/i,
  // Each country's own favourites.
  /^flipkart\b/i, /^swiggy\b/i, /^zomato\b/i, /^myntra\b/i, /^bigbasket\b/i, /^makemytrip\b/i,
  /^tesco\b/i, /^argos\b/i, /^deliveroo\b/i, /^just eat\b/i,
  /^zalando\b/i, /^media ?markt\b/i, /^lieferando\b/i,
  /^target\b/i, /^best buy\b/i, /^tim hortons\b/i, /^woolworths\b/i, /^coles\b/i,
  /^shopee\b/i, /^grab/i, /^carrefour\b/i, /^ikea\b/i,
  // Then games and other brands people know.
  /^nintendo eshop\b/i, /^roblox\b/i, /^valorant\b(?!.*latam)/i, /^league of legends\b(?!.*latam)/i, /^fortnite\b/i,
  /^minecraft\b/i, /^pubg\b/i, /^razer gold\b/i,
  /^starbucks\b/i, /^hotels\.com\b/i, /^nike\b/i, /^adidas\b/i, /^sephora\b/i, /^decathlon\b/i, /^disney\b/i
]
const POPULAR_LIMIT = 12

interface Branded {
  readonly name: string
  readonly base_name?: string | undefined
  readonly country_code: string
  readonly categories?: ReadonlyArray<string> | undefined
}
/** Gift cards grouped by popular brand, in POPULAR_BRANDS order. */
export const popularBrands = <P extends Branded>(cards: ReadonlyArray<P>) =>
  POPULAR_BRANDS.map((brand) => cards.filter((p) => brand.test(p.base_name ?? p.name)))

/**
 * Up to 12 popular cards, one per brand: the country's own card, else a Europe-wide one in an EU member,
 * else a worldwide one (as regionsFor). With no country, worldwide cards only.
 */
export const pickPopular = <P extends Branded>(brands: ReadonlyArray<ReadonlyArray<P>>, country?: string, category?: Category) => {
  const regions = country ? regionsFor(country) : ["XI"]
  const cats = category ? CATEGORY_MAP[category] : undefined
  const picks: Array<P> = []
  for (const brand of brands) {
    const cards = cats ? brand.filter((p) => (p.categories ?? []).some((c) => cats.includes(c))) : brand
    const pick = regions.map((r) => cards.find((p) => p.country_code === r)).find((p) => p !== undefined)
    if (pick) picks.push(pick)
    if (picks.length === POPULAR_LIMIT) break
  }
  return picks
}

/**
 * Bitrefill's own test merchants, listed among real cards: its fictional Syldavia (filed as KN) and its testers.
 * A real brand with "test" in its name (Test Kitchen Philippines) isn't one.
 */
export const isTestMerchant = (p: { readonly id: string; readonly name: string; readonly country_code: string }) =>
  p.id.endsWith("-syldavia") || (p.country_code === "KN" && /test/i.test(`${p.id} ${p.name}`))

/** Only cards delivered as a code can be bought here: top-ups need a phone number or account we can't send. */
const sellable = (p: { id: string; name: string; country_code: string; recipient_type?: string | undefined; in_stock?: boolean | undefined }) =>
  (p.recipient_type ?? "none") === "none" && p.in_stock !== false && !isTestMerchant(p)

/**
 * What a Bitrefill product id looks like; anything else is refused before spending a lookup. Some carry an underscore
 * where the brand's name has an apostrophe or a dot (papa-john_s-usa, battle_net-usa).
 */
const PRODUCT_ID = /^[a-z0-9][a-z0-9_-]{0,99}$/
/**
 * A CSS hex colour: "#" and 3, 4, 6 or 8 hex digits. A card's `logo_background` ends up in a `background` style
 * on every shop tile, where anything else (a `url(...)`, say) would make each visitor's browser fetch an
 * address of someone else's choosing.
 */
const HEX_COLOUR = /^#(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i

/** "5.53" → 5_530_000, with no floating point (ADR-0004). */
export const usdToMicro = (usd: string): number => {
  const m = /^(\d+)(?:\.(\d{1,6}))?$/.exec(usd)
  if (!m) throw new Error(`Not a USD amount: ${usd}`)
  return Number(m[1]) * 1_000_000 + Number((m[2] ?? "").padEnd(6, "0"))
}

/** The contract refuses purchases under 0.5 USDC (MIN_REFERENCE_PRICE), so smaller amounts are never offered. */
export const MIN_PRICE = 500_000
export const forSale = <P extends { priceMicroUsdc: number }>(packages: ReadonlyArray<P>) => packages.filter((p) => p.priceMicroUsdc >= MIN_PRICE)
/** Amounts Bitrefill sells that Luckout can't, because they're under the minimum. */
export const tooSmall = <P extends { priceMicroUsdc: number }>(packages: ReadonlyArray<P>) => packages.filter((p) => p.priceMicroUsdc < MIN_PRICE)

export class Bitrefill extends Context.Service<Bitrefill, {
  /** Orders are guest invoices paid from the Base Wallet (ADR-0012), not store credit. */
  readonly guest: boolean
  search(q: string): Effect.Effect<ReadonlyArray<VoucherSummary>, BitrefillUnavailable>
  /** The catalog a page at a time, filtered only by what the customer chose. */
  browse(opts: BrowseOptions): Effect.Effect<CatalogPage, BitrefillUnavailable>
  /** Up to 12 popular cards that work in `country` (see pickPopular); none on testnet or before the first catalog copy. */
  popular(country?: string, category?: Category): Effect.Effect<ReadonlyArray<VoucherSummary>>
  /** A card's logo and its brand colour, from our catalog copy: nothing if it isn't there (yet). */
  logo(id: string): { readonly image?: string; readonly background?: string }
  /**
   * Packages with their current USD price, the Reference Price (see FRESH_PRICE_MS for how current). `purchase`: a
   * customer is buying, so the lookup may use the whole budget, not just browsing's share. `page`: only to show on the
   * card's page, so a price up to 10 minutes old will do.
   */
  voucher(id: string, options?: { readonly purchase?: boolean; readonly page?: boolean }): Effect.Effect<Voucher, BitrefillUnavailable>
  /**
   * Orders a card. With guest checkout it's an unpaid invoice to pay from the Base Wallet, placed as a guest
   * with the customer's Checkout Email or on their own Bitrefill account; otherwise it's paid at once from the
   * USD balance. Save the invoice before going on.
   */
  order(cards: ReadonlyArray<Card>, buyer?: Buyer): Effect.Effect<Order, BitrefillUnavailable>
  /**
   * Polls an invoice for up to ~1 minute, until every card is delivered or failed, and says where each of `cards` is.
   * Nothing settled yet is an error (unknown, not failed). A guest invoice needs its access token.
   */
  delivery(invoiceId: string, accessToken: string | undefined, cards: ReadonlyArray<Card>): Effect.Effect<ReadonlyArray<CardDelivery>, BitrefillUnavailable>
  /** Our USD store credit, and how much more Bitrefill lets us hold (micro-USDC). */
  readonly credit: Effect.Effect<{ readonly balance: number; readonly room: number }, BitrefillUnavailable>
  /** Asks for `amount` (micro-USDC, whole cents) of USD credit, paid 1:1 in USDC on Base. */
  deposit(amount: number): Effect.Effect<CreditDeposit, BitrefillUnavailable>
  depositState(invoiceId: string): Effect.Effect<{ readonly state: DepositState; readonly status: string }, BitrefillUnavailable>
  /** Bitrefill's order limit with `inFlight` orders about to be placed (see orderRoom); undefined if its invoices can't be read. */
  orderLimit(inFlight: number): Effect.Effect<OrderRoom | undefined>
}>()("luckout/Bitrefill") {
  static readonly layer = Layer.effect(
    Bitrefill,
    Effect.gen(function*() {
      const apiKey = yield* Config.option(Config.Redacted("BITREFILL_API_KEY"))
      const restUrl = yield* Config.String("BITREFILL_API_URL").pipe(Config.withDefault("https://api.bitrefill.com/v2"))
      const testnet = (yield* Network) === "testnet"
      const isTest = (id: string) => testnet && id.startsWith("test-")
      // Our OAuth client for guest checkout (ADR-0012), registered with Bitrefill once per deployment.
      const clientId = yield* Config.option(Config.String("BITREFILL_CLIENT_ID"))
      const clientSecret = yield* Config.option(Config.Redacted("BITREFILL_CLIENT_SECRET"))
      const guest = !testnet && Option.isSome(clientId)

      const http = (yield* HttpClient.HttpClient).pipe(HttpClient.filterStatusOk)
      const base = http.pipe(HttpClient.mapRequest(Option.isSome(apiKey) ? HttpClientRequest.bearerToken(apiKey.value) : (r) => r))
      const rest = base.pipe(
        HttpClient.mapRequest(flow(HttpClientRequest.prependUrl(restUrl), HttpClientRequest.acceptJson)),
        HttpClient.timeout("15 seconds")
      )
      // A timed-out buy is an unknown outcome (left to the reconciler), so this one is generous.
      const mcpClient = base.pipe(HttpClient.timeout("45 seconds"))
      // A guest's calls carry the guest login instead of the API key.
      const guestClient = http.pipe(HttpClient.timeout("45 seconds"))
      const mcpUrl = new URL("/mcp", restUrl).href
      // Only reads are retried: retrying a purchase could buy twice.
      const retry = <A, E>(self: Effect.Effect<A, E>) => Effect.retry(self, { schedule: Schedule.exponential(200), times: 3 })

      const unavailable = (cause: unknown) =>
        new BitrefillUnavailable({
          message: Option.isNone(apiKey) ? "BITREFILL_API_KEY is not set" : `Bitrefill request failed: ${cause}`
        })

      const get = <A, I>(path: string, schema: Schema.Codec<A, I>, urlParams?: Record<string, string>) =>
        rest.get(path, urlParams ? { urlParams } : undefined).pipe(
          Effect.flatMap(HttpClientResponse.schemaBodyJson(data(schema))),
          Effect.map((r) => r.data),
          retry,
          Effect.mapError(unavailable)
        )

      // MCP tools reply over SSE with one text result: JSON for buy-products, TOON for the rest.
      // With `token` (a guest login) the call is a guest's; otherwise it's the API key's.
      const mcp = <A, I>(name: string, args: object, schema: Schema.Codec<A, I>, token?: string) =>
        HttpClientRequest.post(mcpUrl).pipe(
          HttpClientRequest.setHeader("Accept", "application/json, text/event-stream"),
          HttpClientRequest.bodyJsonUnsafe({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
          token === undefined ? mcpClient.execute : (r) => guestClient.execute(HttpClientRequest.bearerToken(r, token)),
          Effect.flatMap((r) => r.text),
          Effect.catch((e): Effect.Effect<never, Rejected | BitrefillUnavailable> => (REFUSED_STATUS.has(httpStatus(e)) ? refusal(e) : Effect.fail(unavailable(e)))),
          Effect.flatMap((body) =>
            Effect.try({
              try: () => {
                const line = body.split("\n").find((l) => l.startsWith("data: ")) ?? body
                const { result, error } = JSON.parse(line.replace(/^data: /, ""))
                const text: string = result?.content?.[0]?.text ?? ""
                const parse = () => (text.trimStart().startsWith("{") ? JSON.parse(text) : decodeToon(text))
                if (error) throw new Error(`${name}: ${error.message}`)
                if (result?.isError) {
                  // Tool errors read like `error: Balance too low / code: INVALID_INPUT`.
                  const e = (() => { try { return parse() } catch { return {} } })() as { error?: string; code?: string }
                  if ((e.code && REFUSED_BEFORE_PAYMENT.has(e.code)) || ORDER_LIMIT.test(text)) throw new Rejected({ reason: `${e.error ?? text} (${e.code})` })
                  throw new Error(`${name}: ${text}`)
                }
                return parse()
              },
              catch: (e) => (e instanceof Rejected ? e : unavailable(e))
            })
          ),
          Effect.flatMap((u) => Schema.decodeUnknownEffect(schema)(u).pipe(Effect.mapError(unavailable)))
        )

      // The guest login lasts 6 hours (expires_in); it's renewed 5 minutes early, or at once when Bitrefill
      // stops taking it (a 401 means the tool didn't run, so the call is safe to make again).
      let login: { readonly token: string; readonly until: number } | undefined
      const guestToken = Effect.suspend(() =>
        login && login.until > Date.now()
          ? Effect.succeed(login.token)
          : HttpClientRequest.post(new URL("/oauth/mcp/token", restUrl).href).pipe(
            HttpClientRequest.bodyUrlParams({
              grant_type: "client_credentials",
              client_id: Option.getOrElse(clientId, () => ""),
              client_secret: Option.match(clientSecret, { onNone: () => "", onSome: Redacted.value }),
              scope: "mcp",
              resource: MCP_RESOURCE
            }),
            http.execute,
            Effect.flatMap(HttpClientResponse.schemaBodyJson(Token)),
            Effect.tap((t) => Effect.sync(() => void (login = { token: t.access_token, until: Date.now() + (t.expires_in - 300) * 1000 }))),
            Effect.map((t) => t.access_token),
            Effect.mapError((e) => new BitrefillUnavailable({ message: `Bitrefill guest login failed: ${e}` }))
          )
      )
      const asGuest = <A, I>(name: string, args: object, schema: Schema.Codec<A, I>) => {
        const once = Effect.flatMap(guestToken, (token) => mcp(name, args, schema, token))
        return once.pipe(
          Effect.catchTag("Rejected", (e) => (e.reason.startsWith("HTTP 401") ? Effect.andThen(Effect.sync(() => void (login = undefined)), once) : Effect.fail(e)))
        )
      }

      const images = (p: { image?: string | undefined; logo_background?: string | undefined }) => ({
        ...(p.image ? { image: p.image } : {}),
        // Bitrefill's string is used only if it is a colour (HEX_COLOUR); otherwise the card goes without one.
        ...(p.logo_background && HEX_COLOUR.test(p.logo_background) ? { background: p.logo_background } : {})
      })

      /** Cards a listing showed or Bitrefill priced since the server started: real, whether or not our catalog copy has them yet. */
      const listed = new Set<string>()
      const summary = (p: typeof Product.Type) => {
        listed.add(p.id)
        return new VoucherSummary({
          id: p.id,
          name: p.name,
          countryCode: p.country_code,
          ...(p.country_name ? { countryName: p.country_name } : {}),
          currency: p.currency,
          ...images(p)
        })
      }
      // On testnet only test products can be bought, so nothing else is offered (web or bot).
      const offered = (p: typeof Product.Type) => (testnet ? p.id.startsWith("test-") : sellable(p))

      const search = Effect.fn("Bitrefill.search")(function*(q: string) {
        // Nothing typed finds nothing: Bitrefill refuses an empty search, which would read as an outage.
        if (!q.trim()) return []
        const products = yield* get("/products/search", Schema.Array(Product), { q, include_test_products: String(testnet) })
        return products.filter(offered).map(summary)
      })

      const browsePage = Effect.fn("Bitrefill.browse")(function*(opts: BrowseOptions) {
        const q = opts.q?.trim()
        // A country shows the cards that work there (regionsFor); nothing else is assumed.
        const regions = opts.country ? regionsFor(opts.country) : undefined
        const inCountry = (p: typeof Product.Type) => !regions || regions.includes(p.country_code)
        const cats = opts.category ? CATEGORY_MAP[opts.category] : undefined
        const inCategory = (p: typeof Product.Type) => !cats || (p.categories ?? []).some((c) => cats.includes(c))
        // Testnet sells only a handful of test cards: one search finds them all.
        if (testnet) return new CatalogPage({ items: (yield* search(q || "test")) })
        const items: Array<VoucherSummary> = []
        let start = opts.start ?? 0
        let next: number | undefined
        // Filtering drops top-ups, so a thin page is topped up from the next one or two.
        for (let i = 0; i < 3 && items.length < MIN_PAGE_ITEMS; i++) {
          const params: Record<string, string> = { start: String(start), limit: String(PAGE) }
          const products = yield* (q
            ? get("/products/search", Schema.Array(Product), { ...params, q })
            : get("/products", Schema.Array(Product), {
              ...params,
              ...(regions ? { country: regions.join(",") } : {}),
              category: (cats ?? ALL_GIFT_CARDS).join(",")
            }))
          // Search can't filter by country or category itself, so those are applied here.
          items.push(...products.filter((p) => offered(p) && inCountry(p) && inCategory(p)).map(summary))
          next = products.length === PAGE ? start + PAGE : undefined
          if (next === undefined) break
          start = next
        }
        return new CatalogPage({ items, ...(next !== undefined ? { next } : {}) })
      })
      // Pages are cached for 10 minutes: browsing must not use up Bitrefill's product quota.
      const browseCache = yield* Cache.makeWith((key: string) => browsePage(JSON.parse(key) as BrowseOptions), {
        capacity: 500,
        timeToLive: (exit) => (Exit.isSuccess(exit) ? "10 minutes" : "10 seconds")
      })
      const browse = (opts: BrowseOptions) =>
        Cache.get(browseCache, JSON.stringify({ q: opts.q?.trim().toLowerCase() || undefined, country: opts.country, category: opts.category, start: opts.start ?? 0 }))

      // Popular cards come from our own copy of the gift-card catalog (about 100 pages), refreshed twice a
      // day instead of read on every visit. Testnet sells only test cards, so it has none. What the copy gives
      // is saved with the settings too, so a restart (every deploy) starts with it instead of waiting for the next copy.
      const Brands = Schema.Array(Schema.Array(Product))
      let brands: ReadonlyArray<ReadonlyArray<typeof Product.Type>> = yield* readSetting("popular_brands", Brands, [])
      /** Each card's logo, from the same copy: Bitrefill's price lookup (MCP) has none. */
      const Logos = Schema.Record(Schema.String, Schema.Struct({ image: Schema.optionalKey(Schema.String), background: Schema.optionalKey(Schema.String) }))
      // Saved logos pass the same check as fresh ones: a colour saved before the check existed isn't trusted either.
      let logos = new Map<string, ReturnType<typeof images>>(
        Object.entries(yield* readSetting("card_logos", Logos, {})).map(([id, l]) => [id, images({ image: l.image, logo_background: l.background })])
      )
      const copyCatalog = Effect.gen(function*() {
        const cards: Array<typeof Product.Type> = []
        for (let start = 0;; start += PAGE) {
          const page = yield* get("/products", Schema.Array(Product), { start: String(start), limit: String(PAGE), category: ALL_GIFT_CARDS.join(",") })
          cards.push(...page.filter(sellable))
          if (page.length < PAGE) break
        }
        brands = popularBrands(cards)
        logos = new Map(cards.map((c) => [c.id, images(c)]))
        yield* writeSetting("popular_brands", Brands, brands, "server")
        yield* writeSetting("card_logos", Logos, Object.fromEntries(logos), "server")
      })
      if (!testnet && Option.isSome(apiKey)) {
        yield* copyCatalog.pipe(
          Effect.tapCause((cause) => Effect.logWarning("copying Bitrefill's catalog for popular cards failed", cause)),
          Effect.retry({ schedule: Schedule.spaced("5 minutes") }),
          Effect.repeat(Schedule.spaced("12 hours")),
          Effect.forkScoped
        )
      }
      const popular = (country?: string, category?: Category) => Effect.sync(() => pickPopular(brands, country, category).map(summary))

      // ponytail: fixed one-minute window in memory, one process. Across a window's edge up to twice the budget can go
      // out within 60 seconds; if Bitrefill then refuses one (429), that lookup fails like an outage and no order is
      // touched. A sliding window if those refusals show up in the logs.
      let budget = { used: 0, unlisted: 0, resetAt: 0 }
      const spendLookup = (limit: number, unlisted: boolean) =>
        Effect.flatMap(Clock.currentTimeMillis, (now) => {
          if (budget.resetAt <= now) budget = { used: 0, unlisted: 0, resetAt: now + 60_000 }
          if (unlisted ? budget.unlisted >= UNLISTED_LOOKUPS_PER_MINUTE : budget.used >= limit) {
            return Effect.fail(new BitrefillUnavailable({ message: "Prices are busy right now; try again in a minute" }))
          }
          if (unlisted) budget.unlisted++
          else budget.used++
          return Effect.void
        })
      /** The last price Bitrefill gave for each card, and when: what a page shows when no newer one can be had. */
      const lastKnown = new Map<string, { readonly product: typeof McpProduct.Type; readonly at: number }>()
      /** When Bitrefill last said it doesn't have a card. */
      const missing = new Map<string, number>()
      // Re-added at the end, so the oldest entry goes first once there are too many.
      const remember = <V>(m: Map<string, V>, id: string, v: V) => {
        m.delete(id)
        m.set(id, v)
        if (m.size > 1_000) m.delete(m.keys().next().value!)
      }
      const lookup = (id: string, limit: number, unlisted = false) =>
        spendLookup(limit, unlisted).pipe(
          Effect.andThen(mcp("get-product-details", { product_id: id, currency: "USD" }, McpProduct)),
          Effect.mapError((e) => {
            const why = e._tag === "Rejected" ? e.reason : e.message
            // A refusal of the whole request (an HTTP status) says nothing about the card.
            if (NO_SUCH_PRODUCT.test(why) && !why.startsWith("HTTP ")) return new BitrefillUnavailable({ message: NO_SUCH_VOUCHER })
            return e._tag === "Rejected" ? unavailable(e.reason) : e
          }),
          Effect.tapError((e) => (e.message === NO_SUCH_VOUCHER ? Effect.map(Clock.currentTimeMillis, (at) => remember(missing, id, at)) : Effect.void)),
          Effect.tap((product) =>
            Effect.map(Clock.currentTimeMillis, (at) => {
              listed.add(id)
              remember(lastKnown, id, { product, at })
            })
          )
        )

      /**
       * Whether a listing knows the card: our catalog copy has it, or a search or catalog page showed it. Before the
       * first copy, every card counts. Only a card newer than the copy and unseen since the server started doesn't.
       */
      const isListed = (id: string) => logos.size === 0 || logos.has(id) || listed.has(id)
      /** A card's last price while it's under an hour old: one a page or quote could still show. */
      const recent = (id: string, now: number) => {
        const last = lastKnown.get(id)
        return last && now - last.at < LAST_PRICE_MS ? last : undefined
      }
      // Browsing's lookups, one at a time per card. A failure is kept 5 seconds, so a busy minute isn't asked again at once.
      // A card no listing knows that Bitrefill said it doesn't have answers 404 again for 10 minutes, unasked, so a
      // mistyped id reads "not found" even in a minute whose unknown-id lookups are used up. Not for a listed card: our
      // catalog copy leaves out cards (other categories, out of stock when copied, newer than the copy), so it can't
      // say a card is missing, and a listing that shows the card later lets it be asked again.
      // ponytail: an unknown id never asked about still answers busy once the minute's 3 are used.
      const browseLookups = yield* Cache.makeWith(
        (id: string) =>
          Effect.flatMap(Clock.currentTimeMillis, (now) => {
            const unlisted = !isListed(id)
            const gone = missing.get(id)
            if (unlisted && gone !== undefined && now - gone < PAGE_PRICE_MS) return Effect.fail(new BitrefillUnavailable({ message: NO_SUCH_VOUCHER }))
            return lookup(id, recent(id, now) ? BROWSE_LOOKUPS_PER_MINUTE - FIRST_VIEW_LOOKUPS : BROWSE_LOOKUPS_PER_MINUTE, unlisted)
          }),
        { capacity: 1_000, timeToLive: (exit) => (Exit.isSuccess(exit) ? "1 minute" : "5 seconds") }
      )
      // A page or quote takes a price at most `maxAge` old; past that, a new one if a lookup is free, else (or when
      // Bitrefill doesn't answer) the last one we had while it's under an hour old.
      // ponytail: when more than 10 cards in view need a new price in one minute, the rest show their last one, and cards
      // never priced since the server started share what's left of browsing's 16 (at least 6); past that they answer
      // busy until the next minute. The key already uses most of Bitrefill's 30; a higher limit from Bitrefill would lift both.
      const shownPrice = (id: string, maxAge: number) =>
        Effect.flatMap(Clock.currentTimeMillis, (now) => {
          const last = recent(id, now)
          if (last && now - last.at < maxAge) return Effect.succeed(last.product)
          return Cache.get(browseLookups, id).pipe(
            Effect.catch((e) => (last && e.message !== NO_SUCH_VOUCHER ? Effect.succeed(last.product) : Effect.fail(e)))
          )
        })
      // A purchase takes a price at most a minute old, and otherwise looks it up on the whole budget: a browsing
      // failure kept for this card never blocks it. Pages and quotes show the price it found from then on.
      const purchasePrice = (id: string) =>
        Effect.flatMap(Clock.currentTimeMillis, (now) => {
          const last = lastKnown.get(id)
          return last && now - last.at < FRESH_PRICE_MS ? Effect.succeed(last.product) : lookup(id, LOOKUPS_PER_MINUTE)
        })

      const voucher = Effect.fn("Bitrefill.voucher")(function*(id: string, options?: { readonly purchase?: boolean; readonly page?: boolean }) {
        // Refused before anything is spent, so junk ids can't use up the lookups.
        if (!PRODUCT_ID.test(id)) return yield* new BitrefillUnavailable({ message: NO_SUCH_VOUCHER })
        if (testnet && !isTest(id)) {
          return yield* new BitrefillUnavailable({ message: "This is the testnet demo: only Bitrefill's test cards can be bought here." })
        }
        if (isTest(id)) {
          const p = yield* get(`/products/${encodeURIComponent(id)}`, Product)
          return new Voucher({
            id: p.id,
            name: p.name,
            countryCode: p.country_code,
            currency: p.currency,
            ...images(p),
            // Test products are free on Bitrefill; price them at their USD face value.
            packages: forSale((p.packages ?? []).flatMap((pkg) =>
              pkg.amount === undefined ? [] : [{ value: pkg.value, priceMicroUsdc: Math.round(pkg.amount * 1_000_000) }]
            ))
          })
        }
        const p = yield* (options?.purchase ? purchasePrice(id) : shownPrice(id, options?.page ? PAGE_PRICE_MS : FRESH_PRICE_MS))
        if (isTestMerchant(p)) return yield* new BitrefillUnavailable({ message: NO_SUCH_VOUCHER })
        const all = p.packages.map((pkg) => ({ value: pkg.package_value, priceMicroUsdc: usdToMicro(pkg.payment_price) }))
        return new Voucher({
          id: p.id,
          name: p.name,
          countryCode: p.country_code,
          currency: p.currency,
          ...logos.get(p.id),
          packages: forSale(all),
          tooSmall: tooSmall(all),
          ...about(p)
        })
      })

      const createInvoice = (cards: ReadonlyArray<Card>) =>
        cards.every((c) => isTest(c.id))
          ? HttpClientRequest.post("/invoices").pipe(
            HttpClientRequest.bodyJsonUnsafe({
              products: cards.map((c) => ({ product_id: c.id, package_id: `${c.id}<&>${c.value}`, quantity: 1 })),
              payment_method: "balance",
              auto_pay: true
            }),
            rest.execute,
            Effect.flatMap(HttpClientResponse.schemaBodyJson(data(Invoice))),
            Effect.map((r) => r.data.id),
            // A 4xx (e.g. 403 not_available, 400 purchase_limit_reached) means no invoice was created.
            Effect.catch((e): Effect.Effect<never, Rejected | BitrefillUnavailable> => (httpStatus(e) >= 400 && httpStatus(e) < 500 ? refusal(e) : Effect.fail(unavailable(e))))
          )
          : mcp("buy-products", {
            cart_items: cards.map((c) => ({ product_id: c.id, package_value: c.value })),
            payment_method: "balance",
            balance_currency: "USD"
          }, McpPurchase).pipe(Effect.map((r) => r.response.invoice_id))

      // Bitrefill's own list of our invoices, which also counts any we didn't create. It's read at most every
      // 5 minutes, and again after each invoice we create; the 24-hour window is applied when it's used.
      const InvoiceTime = Schema.Struct({ created_time: Schema.String })
      const invoiceTimes = yield* Cache.makeWith(
        (_: "recent") => get("/invoices", Schema.Array(InvoiceTime), { limit: "50" }).pipe(Effect.map((l) => l.map((i) => Date.parse(i.created_time)))),
        { capacity: 1, timeToLive: (exit) => (Exit.isSuccess(exit) ? "5 minutes" : "30 seconds") }
      )
      const invoiced = Cache.invalidate(invoiceTimes, "recent")
      // ponytail: in memory, one process. If Bitrefill refuses for its limit while our count says there's
      // room, the count is missing something: hold new orders for an hour rather than charge and refund each.
      let refusedUntil = 0
      // A guest has no account-wide limit: Bitrefill's limits are per Checkout Email (Purchases counts them).
      const orderLimit = (inFlight: number) =>
        guest ? Effect.succeed(undefined) : Cache.get(invoiceTimes, "recent").pipe(
          Effect.map((times): OrderRoom => {
            const room = orderRoom(times, inFlight, Date.now())
            return room.reopensAt === undefined && refusedUntil > Date.now() ? { ...room, reopensAt: refusedUntil } : room
          }),
          Effect.tapError((e) => Effect.logWarning(`couldn't read Bitrefill's invoices for its order limit: ${e.message}`)),
          Effect.orElseSucceed(() => undefined)
        )

      // A guest invoice is paid by us afterwards, so creating one moves no money: one we can't use (wrong coin,
      // a malformed address) is simply refused here and expires unpaid. On the customer's own account it's the
      // same invoice, without an email (the receipt goes to the account's); a 401 there means their login lapsed.
      // A guest's card is also sent to their Checkout Email as a Bitrefill gift, so the code reaches them outside Luckout too.
      const invoiceOrder = (cards: ReadonlyArray<Card>, buyer: Buyer) => {
        const items = cards.map((c) => ({ product_id: c.id, package_value: c.value }))
        const args = { payment_method: "usdc_base", return_payment_link: false }
        return ("email" in buyer
          ? asGuest("buy-products", {
            ...args,
            cart_items: items.map((item) => ({ ...item, gift: { recipient_email: buyer.email, recipient_name: buyer.email.split("@")[0]!.slice(0, 100), sender_name: "Luckout" } })),
            email: buyer.email
          }, GuestPurchase)
          : mcp("buy-products", { ...args, cart_items: items }, GuestPurchase, buyer.token)).pipe(
          Effect.flatMap(({ response: r }): Effect.Effect<Order, Rejected> => {
            const pay = r.payment_info
            if (pay.contractAddress.toLowerCase() !== BASE_USDC) return Effect.fail(new Rejected({ reason: `invoice ${r.invoice_id} wants ${pay.contractAddress}, not USDC on Base` }))
            if (!EVM_ADDRESS.test(pay.address)) return Effect.fail(new Rejected({ reason: `invoice ${r.invoice_id} has a malformed address` }))
            if (!Number.isSafeInteger(pay.altBasePrice) || pay.altBasePrice <= 0) return Effect.fail(new Rejected({ reason: `invoice ${r.invoice_id} has no usable amount` }))
            return Effect.succeed({ _tag: "Invoiced", invoiceId: r.invoice_id, accessToken: r.invoice_access_token, payTo: pay.address, amount: pay.altBasePrice })
          })
        )
      }

      const order = Effect.fn("Bitrefill.order")(function*(cards: ReadonlyArray<Card>, buyer?: Buyer) {
        if (guest) {
          if (!buyer) return { _tag: "Refused", reason: "no Checkout Email" } as Order
          return yield* invoiceOrder(cards, buyer).pipe(
            // A 429 is Bitrefill's rate limit, not a verdict on the order: the tool never ran and no invoice exists,
            // so it's an unknown to try again (the reconciler does), never a refusal that refunds the customer.
            Effect.catchTag("Rejected", (e): Effect.Effect<Order, BitrefillUnavailable> =>
              e.reason.startsWith("HTTP 429")
                ? Effect.fail(new BitrefillUnavailable({ message: `Bitrefill is rate limiting us; the order is tried again: ${e.reason}` }))
                : Effect.succeed({ _tag: "Refused", reason: e.reason }))
          )
        }
        return yield* createInvoice(cards).pipe(
          Effect.map((invoiceId): Order => ({ _tag: "Ordered", invoiceId })),
          Effect.catchTag("Rejected", (e) => {
            const limit = ORDER_LIMIT.test(e.reason)
            if (limit) refusedUntil = Date.now() + 60 * 60 * 1000
            return Effect.succeed<Order>(!limit && NO_CREDIT.test(e.reason) ? { _tag: "NoCredit", reason: e.reason } : { _tag: "Refused", reason: e.reason })
          }),
          Effect.ensuring(invoiced)
        )
      })

      // Every guest's delivery is polled on the one guest login, which Bitrefill allows 30 calls a minute. Polls
      // from all deliveries are spaced GUEST_POLL_GAP_MS apart, so however many cards are on their way they use
      // at most 20 of those calls, and the rest stay free for placing orders.
      // ponytail: one process, in memory (ADR-0006); a shared limiter if the server ever scales out.
      let pollAt = 0
      const pollSlot = Effect.suspend(() => {
        const now = Date.now()
        pollAt = nextGuestPoll(pollAt, now)
        return Effect.sleep(pollAt - now)
      })
      /**
       * Where each card is, from the invoice's orders: delivered with its code, failed (the order or the whole invoice
       * ended without one), or still pending. Nothing settled at all is an unknown, tried again later.
       */
      const cardsIn = <O extends { readonly product?: { readonly id: string; readonly value?: unknown } | undefined; readonly redemption_info?: Redemption | null | undefined }>(
        invoiceId: string,
        cards: ReadonlyArray<Card>,
        orders: ReadonlyArray<O>,
        failed: (o: O | undefined) => string | undefined,
        orderId: (o: O) => string,
        status: string
      ): Effect.Effect<ReadonlyArray<CardDelivery>, BitrefillUnavailable> => {
        const found = matchOrders(cards, orders).map((o): CardDelivery => {
          if (o?.redemption_info) return { _tag: "Delivered", orderId: orderId(o), redemption: o.redemption_info }
          const why = failed(o)
          return why ? { _tag: "Failed", reason: why } : { _tag: "Pending" }
        })
        return found.every((d) => d._tag === "Pending")
          ? Effect.fail(unavailable(`invoice ${invoiceId} is still ${status}`))
          : Effect.succeed(found)
      }
      const settled = (cards: ReadonlyArray<Card>, orders: ReadonlyArray<{ readonly product?: { readonly id: string; readonly value?: unknown } | undefined; readonly redemption_info?: Redemption | null | undefined; readonly status?: string }>, invoiceFailed: boolean) =>
        invoiceFailed || matchOrders(cards, orders).every((o) => !!o && (!!o.redemption_info || GUEST_FAILED.test(o.status ?? "")))

      // A guest invoice is delivered once Bitrefill sees our Base payment, usually within a minute.
      const guestDelivery = (invoiceId: string, accessToken: string, cards: ReadonlyArray<Card>) =>
        Effect.andThen(pollSlot, asGuest("get-invoice-by-id", { invoice_id: invoiceId, invoice_access_token: accessToken }, GuestInvoice)).pipe(
          Effect.mapError((e) => (e instanceof BitrefillUnavailable ? e : unavailable(e.reason))),
          retry,
          Effect.repeat({
            schedule: Schedule.spaced("5 seconds"),
            until: (i) => settled(cards, i.orders, GUEST_FAILED.test(i.invoice_status)),
            times: 12
          }),
          Effect.flatMap((i) =>
            cardsIn(
              invoiceId,
              cards,
              i.orders,
              (o) =>
                GUEST_FAILED.test(i.invoice_status) || GUEST_FAILED.test(o?.status ?? "")
                  ? `invoice ${invoiceId} is ${i.invoice_status}, order ${o?.status ?? "missing"}`
                  : undefined,
              (o) => o.order_id,
              i.invoice_status
            )
          )
        )

      const delivery = Effect.fn("Bitrefill.delivery")(function*(invoiceId: string, accessToken: string | undefined, cards: ReadonlyArray<Card>) {
        if (accessToken !== undefined) return yield* guestDelivery(invoiceId, accessToken, cards)
        // Delivery normally takes well under a second; poll for up to ~1 minute.
        const invoice = yield* get(`/invoices/${invoiceId}`, Invoice).pipe(
          Effect.repeat({
            schedule: Schedule.spaced("1 second"),
            until: (i) => i.status !== "not_delivered",
            times: 60
          })
        )
        return yield* cardsIn(
          invoiceId,
          cards,
          invoice.orders,
          () => (invoice.status === "all_error" ? `invoice ${invoiceId} is all_error` : undefined),
          (o) => o.id,
          invoice.status
        )
      })

      // Only MCP sees the USD sub-account; REST reports the primary (BTC) one.
      const credit = mcp("get-balances", {}, Balances).pipe(
        Effect.mapError((e) => (e instanceof BitrefillUnavailable ? e : unavailable(e.reason))),
        Effect.flatMap((r) =>
          Effect.try({
            try: () => {
              const usd = r.balances.find((b) => b.payment_method === "balance" && b.balance_currency === "USD")
              const room = r.top_up?.find((t) => t.currency === "USD")?.max_amount
              return {
                balance: usdToMicro(usd?.amount ?? "0"),
                // Without a reported room, assume Bitrefill's usual $2,000 limit on what the account holds.
                room: room?.currency === "USD" ? usdToMicro(room.amount) : Math.max(0, 2_000_000_000 - usdToMicro(usd?.amount ?? "0"))
              }
            },
            catch: (e) => unavailable(`unreadable balances: ${e}`)
          })
        )
      )

      // Never retried: each call creates an invoice. An unpaid one simply expires.
      const deposit = Effect.fn("Bitrefill.deposit")(function*(amount: number) {
        if (!Number.isInteger(amount) || amount <= 0 || amount % 10_000 !== 0) {
          return yield* unavailable(`a credit deposit must be whole cents, not ${amount}`)
        }
        const d = yield* HttpClientRequest.post("/accounts/deposit").pipe(
          HttpClientRequest.bodyJsonUnsafe({ currency: "USD", payment_method: "usdc_base", amount: amount / 1_000_000 }),
          rest.execute,
          // The response echoes the account's email; it's decoded here and never logged.
          Effect.flatMap(HttpClientResponse.schemaBodyJson(data(Deposit))),
          Effect.map((r) => r.data),
          Effect.mapError(unavailable),
          Effect.ensuring(invoiced)
        )
        // Pay only what buys exactly this much credit, in USDC on Base, to a well-formed address.
        if (d.payment.method !== "usdc_base" || d.payment.currency !== "USDC") {
          return yield* unavailable(`deposit ${d.id} wants ${d.payment.method}/${d.payment.currency}, not USDC on Base`)
        }
        if (d.payment.price !== amount || (d.payment.commission ?? 0) !== 0) {
          return yield* unavailable(`deposit ${d.id} costs ${d.payment.price} for ${amount} of credit; refusing to pay more than 1:1`)
        }
        if (!EVM_ADDRESS.test(d.payment.address)) return yield* unavailable(`deposit ${d.id} has a malformed address`)
        return { invoiceId: d.id, address: d.payment.address, price: d.payment.price }
      })

      const depositState = (invoiceId: string) =>
        get(`/invoices/${encodeURIComponent(invoiceId)}`, InvoiceState).pipe(
          Effect.map((i) => ({
            status: i.status,
            state: (["all_delivered", "complete", "delivered"].includes(i.status)
              ? "credited"
              : ["all_error", "payment_error", "refunded"].includes(i.status)
              ? "failed"
              : "pending") as DepositState
          }))
        )

      const logo = (id: string) => logos.get(id) ?? {}
      return Bitrefill.of({ guest, search, browse, popular, logo, voucher, order, delivery, credit, deposit, depositState, orderLimit })
    })
  ).pipe(Layer.provide(FetchHttpClient.layer))
}
