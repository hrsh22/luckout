import { siteUrl } from "@/lib/site"
import type { MetadataRoute } from "next"

export default function robots(): MetadataRoute.Robots {
  // Only the real shop is indexed. Staging, the testnet demo and preview deployments look the same to a search
  // engine, and a customer who lands on one from a search result is in the wrong place.
  if (siteUrl !== "https://www.luckout.wtf") return { rules: { userAgent: "*", disallow: "/" } }
  return { rules: { userAgent: "*", allow: "/", disallow: ["/purchases", "/wallet", "/admin"] }, sitemap: `${siteUrl}/sitemap.xml` }
}
